// @vitest-environment node

import { createHash } from 'node:crypto';

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

function docx(extra: ZipEntry[] = []): Buffer {
  return createZip([
    { name: '[Content_Types].xml', data: contentTypes('word/document.xml') },
    { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
    { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
    ...extra,
  ]);
}

function xlsx(extra: ZipEntry[] = []): Buffer {
  return createZip([
    { name: '[Content_Types].xml', data: contentTypes('xl/workbook.xml') },
    { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet/>') },
    ...extra,
  ]);
}

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n');
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
    expect(key).toBe('33333333-3333-4333-8333-333333333333/quarantine/11111111-1111-4111-8111-111111111111');
    expect(key).not.toContain('bad');
  });

  it('treats header validation as preflight only and rejects a declared-size mismatch at completion', async () => {
    expect(validateUpload({ name: 'notes.txt', declaredMime: 'text/plain', size: txt.length, headerBytes: txt.subarray(0, 16) }))
      .toMatchObject({ name: 'notes.txt', extension: 'txt', declaredMime: 'text/plain', size: txt.length });
    await expect(validateFile({ name: 'notes.txt', declaredMime: 'text/plain', declaredSize: txt.length + 1, bytes: txt }))
      .rejects.toThrow(/размер/iu);
  });
});
