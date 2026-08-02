import { createHash, randomUUID } from 'node:crypto';

import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import {
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
  if (/(?:<!doctype\s+html\b|<\?xml\b|<!--|<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*?)?\s*\/?>)/iu.test(text)) {
    invalid('HTML, XML и SVG нельзя загружать как TXT.');
  }
  return bytes;
}

function validatePdf(bytes: Buffer): Buffer {
  const source = bytes.toString('latin1');
  if (!source.startsWith('%PDF-') || !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r?\n|\r)/u.test(source)) {
    invalid('Содержимое файла не соответствует PDF.');
  }
  if (!/startxref\s+\d+\s+%%EOF[\t \r\n]*$/u.test(source)) {
    invalid('PDF повреждён или содержит данные после завершающей метки.');
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
  let totalExpanded = 0;

  for (const entry of entries) {
    const originalPath = entry.fileName.normalize('NFC');
    const path = originalPath.toLowerCase();
    const pathSegments = originalPath.split('/');

    if (
      originalPath.includes('\\')
      || originalPath.includes('\u0000')
      || originalPath.startsWith('/')
      || /^[a-z]:/iu.test(originalPath)
      || pathSegments.some((segment, index) => segment === '..' || segment === '.' || (segment === '' && index !== pathSegments.length - 1))
    ) {
      invalid('Документ Office содержит небезопасный путь.');
    }
    if (byPath.has(path)) invalid('Документ Office содержит дублирующиеся части.');
    byPath.set(path, entry);

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
      /(?:^|\/)vbaproject\.bin$/iu.test(path)
      || /(?:^|\/)activex(?:\/|$)/iu.test(path)
      || /(?:^|\/)embeddings(?:\/|$)/iu.test(path)
      || /(?:^|\/)oleobject[^/]*$/iu.test(path)
    ) {
      invalid('Документы Office с макросами и встроенными объектами запрещены.');
    }
  }

  return byPath;
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
    const contentTypes = (await readEntryBytes(zipFile, contentTypesEntry, MAX_CONTENT_TYPES_BYTES)).toString('utf8');
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
      safeBytes = validatePdf(bytes);
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
