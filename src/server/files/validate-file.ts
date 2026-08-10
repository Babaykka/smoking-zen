import { createHash, randomUUID } from 'node:crypto';

import { fileTypeFromBuffer } from 'file-type';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { AnnotationType, getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import {
  containsMarkupLikeText,
  FILE_MIME_BY_EXTENSION,
  FileValidationError,
  MAX_FILE_BYTES,
  type AllowedFileExtension,
  type AllowedFileMime,
  validateUpload,
} from '@/domain/files';

export type ValidateFileInput = {
  name: string;
  declaredMime: string;
  declaredSize: number;
  bytes: Uint8Array;
};

export type ValidatedFile = {
  name: string;
  extension: AllowedFileExtension;
  mimeType: AllowedFileMime;
  size: number;
  sha256: string;
  bytes: Buffer;
};

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_OOXML_ENTRIES = 2_048;
const MAX_OOXML_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_OOXML_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;
const MAX_OOXML_XML_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_PDF_INDIRECT_OBJECTS = 100_000;
const MAX_PDF_ARRAY_ENTRIES = 100_000;
const MAX_PDF_DICTIONARY_ENTRIES = 100_000;
const MAX_PDF_TRAVERSAL_NODES = 200_000;
const MAX_PDF_TRAVERSAL_DEPTH = 128;

const FORBIDDEN_XLM_FORMULA_COMMAND = /(?:^|[^a-z0-9_.])(?:_xlfn\.)?(?:app\.activate|call|evaluate|exec|f(?:close|open|readln|writeln)|formula(?:\.array|\.fill)?|get\.(?:cell|workspace)|goto|halt|on\.(?:error|key|time)|register(?:\.id)?|run|set\.name|workbook\.hide)\s*\(/iu;
const FORBIDDEN_EXTERNAL_FORMULA_FUNCTION = /(?:^|[^a-z0-9_.])(?:(?:_xlfn|_xlws)\.)*(?:image|webservice)\s*\(/iu;

const OOXML_XML_PARSER = new XMLParser({
  allowBooleanAttributes: false,
  ignoreAttributes: false,
  maxNestedTags: 256,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxEntityCount: 32,
    maxEntitySize: 256,
    maxExpandedLength: 4_096,
    maxExpansionDepth: 8,
    maxTotalExpansions: 128,
  },
  removeNSPrefix: true,
  trimValues: false,
});

const PASSIVE_PDF_ANNOTATION_TYPES = new Set<number>([
  AnnotationType.TEXT,
  AnnotationType.FREETEXT,
  AnnotationType.LINE,
  AnnotationType.SQUARE,
  AnnotationType.CIRCLE,
  AnnotationType.POLYGON,
  AnnotationType.POLYLINE,
  AnnotationType.HIGHLIGHT,
  AnnotationType.UNDERLINE,
  AnnotationType.SQUIGGLY,
  AnnotationType.STRIKEOUT,
  AnnotationType.STAMP,
  AnnotationType.CARET,
  AnnotationType.INK,
  AnnotationType.POPUP,
  AnnotationType.PRINTERMARK,
  AnnotationType.TRAPNET,
  AnnotationType.WATERMARK,
  AnnotationType.REDACT,
]);

const FORBIDDEN_PDF_DICTIONARY_KEYS = new Set([
  'AA',
  'AcroForm',
  'AF',
  'CO',
  'EmbeddedFiles',
  'EF',
  'Fields',
  'FT',
  'JS',
  'JavaScript',
  'OpenAction',
  'RichMediaContent',
  'RichMediaSettings',
  'SigFlags',
  'URI',
  'XFA',
]);

const FORBIDDEN_PDF_ACTION_NAMES = new Set([
  'GoTo3DView',
  'GoToE',
  'GoToR',
  'Hide',
  'ImportData',
  'JavaScript',
  'Launch',
  'Movie',
  'Named',
  'Rendition',
  'ResetForm',
  'SetOCGState',
  'Sound',
  'SubmitForm',
  'Thread',
  'Trans',
  'URI',
]);

const FORBIDDEN_PDF_OBJECT_TYPES = new Set([
  'Action',
  'EmbeddedFile',
  'Filespec',
]);

const FORBIDDEN_PDF_ANNOTATION_SUBTYPES = new Set([
  '3D',
  'FileAttachment',
  'Link',
  'Movie',
  'RichMedia',
  'Screen',
  'Sound',
  'Widget',
]);

const DOCX_MIME = FILE_MIME_BY_EXTENSION.docx;
const XLSX_MIME = FILE_MIME_BY_EXTENSION.xlsx;
const PDF_MIME = FILE_MIME_BY_EXTENSION.pdf;

function invalid(message: string): never {
  throw new FileValidationError(message);
}

function assertActualSize(input: ValidateFileInput, bytes: Buffer): void {
  if (bytes.length === 0) invalid('Файл пуст.');
  if (bytes.length > MAX_FILE_BYTES) invalid('Размер файла не должен превышать 25 МиБ.');
  if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize !== bytes.length) {
    invalid('Фактический размер файла не совпадает с заявленным.');
  }
}

function validateStrictText(bytes: Buffer): Buffer {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('TXT должен содержать корректный текст UTF-8.');
  }

  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    invalid('TXT содержит недопустимые управляющие символы.');
  }
  if (containsMarkupLikeText(text)) {
    invalid('HTML, XML и SVG нельзя загружать как TXT.');
  }
  return bytes;
}

function hasStructuredContent(value: unknown): boolean {
  if (!value) return false;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsPdfOutlineAction(value: unknown): boolean {
  if (!Array.isArray(value)) return hasStructuredContent(value);
  for (const node of value) {
    if (!isRecord(node)) return true;
    if (hasStructuredContent(node.url) || hasStructuredContent(node.unsafeUrl) || hasStructuredContent(node.action)) {
      return true;
    }
    if (containsPdfOutlineAction(node.items ?? [])) return true;
  }
  return false;
}

function isActivePdfAnnotation(value: unknown): boolean {
  if (!isRecord(value) || !Number.isInteger(value.annotationType)) return true;
  if (!PASSIVE_PDF_ANNOTATION_TYPES.has(value.annotationType as number)) return true;
  return [
    'action',
    'actions',
    'attachment',
    'file',
    'jsActions',
    'newWindow',
    'unsafeUrl',
    'url',
  ].some((key) => hasStructuredContent(value[key]));
}

function canonicalPdfName(name: PDFName): string {
  let decoded = name.decodeText();
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/#([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function parsedPdfName(object: PDFObject | undefined, context: PDFContext): string | undefined {
  const resolved = object instanceof PDFRef ? context.lookup(object) : object;
  return resolved instanceof PDFName ? canonicalPdfName(resolved) : undefined;
}

type PdfInspectionBudget = {
  arrayEntries: number;
  dictionaryEntries: number;
  nodes: number;
};

function inspectParsedPdfObject(
  object: PDFObject,
  context: PDFContext,
  inspected: Set<PDFObject>,
  budget: PdfInspectionBudget,
  depth = 0,
): void {
  if (depth > MAX_PDF_TRAVERSAL_DEPTH) invalid('PDF имеет чрезмерно сложную структуру объектов.');
  const resolved = object instanceof PDFRef ? context.lookup(object) : object;
  if (!resolved) invalid('PDF содержит повреждённую ссылку на объект.');
  if (inspected.has(resolved)) return;
  inspected.add(resolved);
  budget.nodes += 1;
  if (budget.nodes > MAX_PDF_TRAVERSAL_NODES) invalid('PDF имеет чрезмерно сложную структуру объектов.');

  if (resolved instanceof PDFStream) {
    inspectParsedPdfObject(resolved.dict, context, inspected, budget, depth + 1);
    return;
  }
  if (resolved instanceof PDFArray) {
    const children = resolved.asArray();
    budget.arrayEntries += children.length;
    if (budget.arrayEntries > MAX_PDF_ARRAY_ENTRIES) invalid('PDF имеет чрезмерно сложную структуру массивов.');
    for (const child of children) inspectParsedPdfObject(child, context, inspected, budget, depth + 1);
    return;
  }
  if (!(resolved instanceof PDFDict)) return;

  const entries = resolved.entries();
  budget.dictionaryEntries += entries.length;
  if (budget.dictionaryEntries > MAX_PDF_DICTIONARY_ENTRIES) {
    invalid('PDF имеет чрезмерно сложную структуру словарей.');
  }
  if (entries.some(([key]) => FORBIDDEN_PDF_DICTIONARY_KEYS.has(canonicalPdfName(key)))) {
    invalid('PDF содержит активный словарь или форму.');
  }
  const objectType = parsedPdfName(resolved.get(PDFName.of('Type')), context);
  const subtype = parsedPdfName(resolved.get(PDFName.of('Subtype')), context);
  const action = parsedPdfName(resolved.get(PDFName.of('S')), context);
  if (
    (objectType && FORBIDDEN_PDF_OBJECT_TYPES.has(objectType))
    || (subtype && FORBIDDEN_PDF_ANNOTATION_SUBTYPES.has(subtype))
    || (action && FORBIDDEN_PDF_ACTION_NAMES.has(action))
  ) {
    invalid('PDF содержит активное действие или вложение.');
  }
  for (const [, child] of entries) inspectParsedPdfObject(child, context, inspected, budget, depth + 1);
}

async function assertNoActivePdfObjects(bytes: Buffer): Promise<void> {
  try {
    const parsed = await PDFDocument.load(new Uint8Array(bytes), {
      capNumbers: true,
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    const indirectObjects = [...parsed.context.enumerateIndirectObjects()];
    if (indirectObjects.length > MAX_PDF_INDIRECT_OBJECTS) {
      invalid('PDF содержит слишком много объектов.');
    }
    const inspected = new Set<PDFObject>();
    const budget: PdfInspectionBudget = { arrayEntries: 0, dictionaryEntries: 0, nodes: 0 };
    for (const [, object] of indirectObjects) {
      inspectParsedPdfObject(object, parsed.context, inspected, budget);
    }
  } catch (error) {
    if (error instanceof FileValidationError) throw error;
    invalid('PDF повреждён, зашифрован или содержит неподдерживаемые объекты.');
  }
}

async function validatePdf(bytes: Buffer): Promise<Buffer> {
  const source = bytes.toString('latin1');
  if (!source.startsWith('%PDF-') || !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r?\n|\r)/u.test(source)) {
    invalid('Содержимое файла не соответствует PDF.');
  }
  if (!/startxref\s+\d+\s+%%EOF[\t \r\n]*$/u.test(source)) {
    invalid('PDF повреждён или содержит данные после завершающей метки.');
  }

  await assertNoActivePdfObjects(bytes);

  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableAutoFetch: true,
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    enableXfa: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_IMAGE_PIXELS,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
      invalid(`PDF должен содержать от 1 до ${MAX_PDF_PAGES} страниц.`);
    }
    const [openAction, attachments, javaScriptActions, fieldObjects, outline] = await Promise.all([
      document.getOpenAction(),
      document.getAttachments(),
      document.getJSActions(),
      document.getFieldObjects(),
      document.getOutline(),
    ]);
    if (
      hasStructuredContent(openAction)
      || hasStructuredContent(attachments)
      || hasStructuredContent(javaScriptActions)
      || hasStructuredContent(fieldObjects)
      || document.isPureXfa
      || hasStructuredContent(document.allXfaHtml)
      || containsPdfOutlineAction(outline)
    ) {
      invalid('PDF содержит активное или встроенное содержимое.');
    }

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [annotations, pageJavaScriptActions] = await Promise.all([
        page.getAnnotations({ intent: 'display' }),
        page.getJSActions(),
      ]);
      if (hasStructuredContent(pageJavaScriptActions) || annotations.some(isActivePdfAnnotation)) {
        invalid('PDF содержит активные аннотации или сценарии.');
      }
    }
  } catch (error) {
    if (error instanceof FileValidationError) throw error;
    invalid('PDF повреждён, зашифрован или использует небезопасные возможности.');
  } finally {
    await loadingTask.destroy();
  }
  return bytes;
}

export function assertSafeRasterMetadata(
  metadata: { format?: string; width?: number; height?: number; pages?: number; channels?: number },
  expectedFormat: string,
): void {
  if (
    metadata.format !== expectedFormat
    || !metadata.width
    || !metadata.height
    || metadata.width * metadata.height > MAX_IMAGE_PIXELS
    || (metadata.pages ?? 1) !== 1
  ) {
    invalid('Содержимое изображения не соответствует выбранному формату.');
  }
  if (!Number.isInteger(metadata.channels) || metadata.channels! < 1 || metadata.channels! > 4) {
    invalid('Изображение содержит небезопасное количество цветовых каналов.');
  }
}

async function sanitizeRaster(bytes: Buffer, extension: AllowedFileExtension): Promise<Buffer> {
  const expectedFormat = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension;
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch {
    invalid('Изображение повреждено или небезопасно.');
  }

  assertSafeRasterMetadata(metadata, expectedFormat);

  const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS }).rotate();
  let sanitized: Buffer;
  try {
    if (expectedFormat === 'jpeg') sanitized = await pipeline.jpeg({ quality: 88, progressive: true }).toBuffer();
    else if (expectedFormat === 'png') sanitized = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    else sanitized = await pipeline.webp({ quality: 88 }).toBuffer();
  } catch {
    invalid('Не удалось безопасно обработать изображение.');
  }

  if (sanitized.length === 0 || sanitized.length > MAX_FILE_BYTES) {
    invalid('Обработанное изображение превышает допустимый размер.');
  }
  return sanitized;
}

function assertExactZipEnvelope(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
    invalid('Документ Office должен начинаться с ZIP-контейнера.');
  }

  const endOffset = bytes.length - 22;
  if (bytes.readUInt32LE(endOffset) !== 0x06054b50 || bytes.readUInt16LE(endOffset + 20) !== 0) {
    invalid('Документ Office повреждён или содержит посторонние данные.');
  }
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    invalid('ZIP-контейнер документа имеет некорректную структуру.');
  }
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      validateEntrySizes: false,
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new FileValidationError('Не удалось прочитать документ Office.'));
        return;
      }
      resolve(zipFile);
    });
  });
}

function readEntryBytes(zipFile: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (openError, stream) => {
      if (openError || !stream) {
        reject(new FileValidationError('Не удалось проверить структуру документа Office.'));
        return;
      }

      const chunks: Buffer[] = [];
      let length = 0;
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) {
          stream.destroy(new FileValidationError('Служебная часть документа Office слишком велика.'));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks, length)));
    });
  });
}

function collectZipEntries(zipFile: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof FileValidationError ? error : new FileValidationError('Документ Office повреждён.'));
    };

    zipFile.on('error', fail);
    zipFile.on('entry', (entry: Entry) => {
      if (settled) return;
      entries.push(entry);
      if (entries.length > MAX_OOXML_ENTRIES) {
        fail(new FileValidationError('В документе Office слишком много частей.'));
        return;
      }
      zipFile.readEntry();
    });
    zipFile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    zipFile.readEntry();
  });
}

function inspectEntryPathsAndSizes(entries: readonly Entry[]): Map<string, Entry> {
  const byPath = new Map<string, Entry>();
  const canonicalPaths = new Set<string>();
  let totalExpanded = 0;

  for (const entry of entries) {
    const originalPath = entry.fileName.normalize('NFC');
    const path = originalPath.toLowerCase();
    const canonicalPath = canonicalizeOoxmlSecurityValue(originalPath);
    const pathSegments = originalPath.split('/');
    const canonicalPathSegments = canonicalPath.split('/');

    if (
      originalPath.includes('\\')
      || originalPath.includes('\u0000')
      || originalPath.startsWith('/')
      || /^[a-z]:/iu.test(originalPath)
      || pathSegments.some((segment, index) => segment === '..' || segment === '.' || (segment === '' && index !== pathSegments.length - 1))
      || canonicalPath.includes('\\')
      || canonicalPath.includes('\u0000')
      || canonicalPath.startsWith('/')
      || /^[a-z]:/u.test(canonicalPath)
      || canonicalPathSegments.some((segment, index) => segment === '..' || segment === '.' || (segment === '' && index !== canonicalPathSegments.length - 1))
    ) {
      invalid('Документ Office содержит небезопасный путь.');
    }
    if (byPath.has(path) || canonicalPaths.has(canonicalPath)) invalid('Документ Office содержит дублирующиеся части.');
    byPath.set(path, entry);
    canonicalPaths.add(canonicalPath);

    if ((entry.generalPurposeBitFlag & 0x0001) !== 0) invalid('Зашифрованные документы Office не поддерживаются.');
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      invalid('Документ Office использует неподдерживаемое сжатие.');
    }
    if (entry.uncompressedSize > MAX_OOXML_ENTRY_BYTES) invalid('Часть документа Office слишком велика.');
    totalExpanded += entry.uncompressedSize;
    if (totalExpanded > MAX_OOXML_EXPANDED_BYTES) invalid('Распакованный документ Office слишком велик.');
    if (
      entry.uncompressedSize > 1024 * 1024
      && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > 100)
    ) {
      invalid('Документ Office имеет опасную степень сжатия.');
    }

    if (
      /(?:^|\/)vbaproject\.bin$/u.test(canonicalPath)
      || /(?:^|\/)activex(?:\/|$)/u.test(canonicalPath)
      || /(?:^|\/)embeddings(?:\/|$)/u.test(canonicalPath)
      || /(?:^|\/)oleobject[^/]*$/u.test(canonicalPath)
      || /^xl\/(?:dialog|macro)sheets(?:\/|$)/u.test(canonicalPath)
    ) {
      invalid('Документы Office с макросами и встроенными объектами запрещены.');
    }
  }

  return byPath;
}

function decodeOoxmlXml(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('XML-часть документа Office должна быть корректным UTF-8.');
  }
}

function xmlNodeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(xmlNodeText).join(' ');
  if (!isRecord(value)) return '';
  return Object.entries(value)
    .filter(([key]) => key === '#text' || !key.startsWith('@_'))
    .map(([, child]) => xmlNodeText(child))
    .join(' ');
}

function xmlAttribute(node: Record<string, unknown>, name: string): string {
  const value = node[`@_${name}`] ?? node[`@_${name.toLowerCase()}`];
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalizeOoxmlSecurityValue(value: string): string {
  let canonical = value.normalize('NFC');
  for (let pass = 0; pass < 4 && /%[0-9a-f]{2}/iu.test(canonical); pass += 1) {
    try {
      canonical = decodeURIComponent(canonical).normalize('NFC');
    } catch {
      invalid('Документ Office содержит некорректное percent-кодирование.');
    }
  }
  if (/%[0-9a-f]{2}/iu.test(canonical)) {
    invalid('Документ Office содержит чрезмерно вложенное percent-кодирование.');
  }
  return canonical.toLowerCase();
}

function inspectContentTypeNode(value: unknown): void {
  const declarations = Array.isArray(value) ? value : [value];
  for (const declaration of declarations) {
    if (!isRecord(declaration)) invalid('Тип содержимого документа Office имеет некорректную структуру.');
    const contentType = canonicalizeOoxmlSecurityValue(xmlAttribute(declaration, 'ContentType'));
    if (/(?:intl)?macrosheet|dialogsheet/u.test(contentType)) {
      invalid('Книга XLSX содержит лист Excel 4.0 или диалоговый лист.');
    }
  }
}

function inspectRelationshipNode(value: unknown): void {
  const relationships = Array.isArray(value) ? value : [value];
  for (const relationship of relationships) {
    if (!isRecord(relationship)) invalid('Relationship в документе Office имеет некорректную структуру.');
    const targetMode = xmlAttribute(relationship, 'TargetMode');
    const relationshipType = canonicalizeOoxmlSecurityValue(xmlAttribute(relationship, 'Type'));
    if (targetMode.toLowerCase() === 'external') {
      invalid('Документ Office содержит внешнюю ссылку.');
    }
    if (/(?:^|\/)(?:dialogsheet|xl(?:intl)?macrosheet)$/u.test(relationshipType)) {
      invalid('Книга XLSX содержит активную связь с листом Excel 4.0 или диалоговым листом.');
    }
    if (/(?:attachedtemplate|connections?|external(?:link|resource)|oleobject|package)$/iu.test(relationshipType)) {
      invalid('Документ Office содержит активную связь.');
    }
  }
}

function inspectOoxmlXmlNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) inspectOoxmlXmlNode(child);
    return;
  }
  if (!isRecord(value)) return;

  for (const [rawName, child] of Object.entries(value)) {
    if (rawName.startsWith('@_') || rawName === '#text' || rawName.startsWith('?')) continue;
    const name = rawName.split(':').at(-1)!.toLowerCase();
    if (name === 'relationship') inspectRelationshipNode(child);
    if (name === 'default' || name === 'override') inspectContentTypeNode(child);
    if (name === 'attachedtemplate' || name === 'ddelink' || name === 'ddeitem') {
      invalid('Документ Office содержит активное внешнее содержимое.');
    }
    if (name === 'instrtext' || name === 'fldsimple') {
      const instruction = `${xmlNodeText(child)} ${isRecord(child) ? xmlAttribute(child, 'instr') : ''}`;
      if (/\bDDE(?:AUTO)?\b/iu.test(instruction)) invalid('Документ Office содержит DDE-поле.');
    }
    if (name === 'f' || name === 'definedname') {
      const formula = xmlNodeText(child);
      if (FORBIDDEN_EXTERNAL_FORMULA_FUNCTION.test(formula)) {
        invalid('Книга XLSX содержит формулу с внешним сетевым содержимым.');
      }
      if (FORBIDDEN_XLM_FORMULA_COMMAND.test(formula)) {
        invalid('Книга XLSX содержит командную формулу Excel 4.0.');
      }
      if (name !== 'f') {
        inspectOoxmlXmlNode(child);
        continue;
      }
      const hasExternalWorkbookReference = /(?:^|[=+\-*/,(])'?\[[^\]\r\n]{1,1024}\][^!+\-*/(),{}\r\n]{1,255}'?!/u.test(formula);
      if (/\|[^!]{0,4096}!/u.test(formula) || hasExternalWorkbookReference) {
        invalid('Книга XLSX содержит внешнюю формулу.');
      }
    }
    inspectOoxmlXmlNode(child);
  }
}

function parseAndInspectOoxmlXml(path: string, bytes: Buffer): string {
  const xml = decodeOoxmlXml(bytes);
  if (/<!DOCTYPE/iu.test(xml)) invalid('XML-части документа Office не должны содержать DTD.');
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) invalid('Документ Office содержит повреждённую XML-часть.');

  let parsed: unknown;
  try {
    parsed = OOXML_XML_PARSER.parse(xml);
  } catch {
    invalid('Не удалось безопасно прочитать XML-часть документа Office.');
  }
  if (!hasStructuredContent(parsed)) invalid('XML-часть документа Office пуста.');
  if (/^xl\/(?:connections\.xml|externallinks\/)/u.test(path)) {
    invalid('Книга XLSX содержит внешние подключения.');
  }
  inspectOoxmlXmlNode(parsed);
  return xml;
}

async function validateOoxml(bytes: Buffer, extension: 'docx' | 'xlsx'): Promise<Buffer> {
  assertExactZipEnvelope(bytes);
  const zipFile = await openZip(bytes);
  try {
    const entries = await collectZipEntries(zipFile);
    const byPath = inspectEntryPathsAndSizes(entries);
    const contentTypesEntry = byPath.get('[content_types].xml');
    if (!contentTypesEntry || !byPath.has('_rels/.rels')) invalid('Документ Office не содержит обязательные служебные части.');

    const requiredMain = extension === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
    if (!byPath.has(requiredMain)) invalid('Расширение документа Office не соответствует его содержимому.');
    if (extension === 'xlsx' && ![...byPath.keys()].some((path) => /^xl\/worksheets\/[^/]+\.xml$/u.test(path))) {
      invalid('Книга XLSX не содержит листов.');
    }

    if (contentTypesEntry.uncompressedSize > MAX_CONTENT_TYPES_BYTES) {
      invalid('Описание типов документа Office слишком велико.');
    }
    let totalXmlBytes = 0;
    let contentTypes = '';
    for (const [path, entry] of byPath) {
      if (!path.endsWith('.xml') && !path.endsWith('.rels')) continue;
      totalXmlBytes += entry.uncompressedSize;
      if (totalXmlBytes > MAX_OOXML_XML_BYTES) invalid('XML-части документа Office слишком велики.');
      const limit = path === '[content_types].xml' ? MAX_CONTENT_TYPES_BYTES : MAX_OOXML_ENTRY_BYTES;
      const xml = parseAndInspectOoxmlXml(path, await readEntryBytes(zipFile, entry, limit));
      if (path === '[content_types].xml') contentTypes = xml;
    }
    if (/macroenabled|vbaproject|activex|oleobject/iu.test(contentTypes)) {
      invalid('Документы Office с макросами и встроенными объектами запрещены.');
    }
    const requiredContentType = extension === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
    if (!contentTypes.includes(requiredContentType)) {
      invalid('Тип содержимого документа Office не соответствует расширению.');
    }

    return bytes;
  } finally {
    zipFile.close();
  }
}

function assertDetectedType(
  extension: AllowedFileExtension,
  expectedMime: AllowedFileMime,
  detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>,
): void {
  if (extension === 'txt') {
    if (detected) invalid('Бинарный файл нельзя загружать как TXT.');
    return;
  }

  if (extension === 'docx' || extension === 'xlsx') {
    if (!detected || (detected.mime !== 'application/zip' && detected.mime !== expectedMime)) {
      invalid('Содержимое документа Office не соответствует расширению.');
    }
    return;
  }

  if (!detected || detected.mime !== expectedMime) invalid('Фактический тип файла не совпадает с заявленным.');
}

export async function validateFile(input: ValidateFileInput): Promise<ValidatedFile> {
  const bytes = Buffer.from(input.bytes);
  assertActualSize(input, bytes);

  const preflight = validateUpload({
    name: input.name,
    declaredMime: input.declaredMime,
    size: input.declaredSize,
    headerBytes: bytes.subarray(0, Math.min(bytes.length, 8_192)),
  });
  const detected = await fileTypeFromBuffer(bytes);
  assertDetectedType(preflight.extension, preflight.declaredMime, detected);

  let safeBytes: Buffer;
  switch (preflight.extension) {
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'webp':
      safeBytes = await sanitizeRaster(bytes, preflight.extension);
      break;
    case 'pdf':
      safeBytes = await validatePdf(bytes);
      break;
    case 'txt':
      safeBytes = validateStrictText(bytes);
      break;
    case 'docx':
    case 'xlsx':
      safeBytes = await validateOoxml(bytes, preflight.extension);
      break;
  }

  return {
    name: preflight.name,
    extension: preflight.extension,
    mimeType: preflight.declaredMime,
    size: safeBytes.length,
    sha256: createHash('sha256').update(safeBytes).digest('hex'),
    bytes: safeBytes,
  };
}

export function createRandomObjectKey(
  workspaceId: string,
  state: 'quarantine' | 'ready',
  randomId: () => string = randomUUID,
): string {
  const workspacePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const objectId = randomId();
  if (!workspacePattern.test(workspaceId) || !workspacePattern.test(objectId)) {
    invalid('Невозможно создать безопасный ключ файла.');
  }
  void state;
  return objectId;
}
