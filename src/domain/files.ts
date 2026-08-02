export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.txt,.docx,.xlsx';

export const FILE_MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export type AllowedFileExtension = keyof typeof FILE_MIME_BY_EXTENSION;
export type AllowedFileMime = (typeof FILE_MIME_BY_EXTENSION)[AllowedFileExtension];
export type AttachmentTarget = { type: 'task' | 'knowledge'; id: string };

export type SignedAttachmentDownload = {
  url: string;
};

export type UploadPreflightInput = {
  name: string;
  declaredMime: string;
  size: number;
  headerBytes: Uint8Array;
};

export type ValidatedUploadPreflight = {
  name: string;
  extension: AllowedFileExtension;
  declaredMime: AllowedFileMime;
  size: number;
};

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileValidationError';
  }
}

const FORBIDDEN_TEXT_FRAGMENT = /<[^>]+>/u;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

export function normalizeFileName(name: string): string {
  const normalized = name
    .normalize('NFC')
    .replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+/u, '')
    .trim();

  if (!normalized) throw new FileValidationError('Введите имя файла.');

  if (normalized.length <= 255) return normalized;

  const dotIndex = normalized.lastIndexOf('.');
  const suffix = dotIndex > 0 ? normalized.slice(dotIndex) : '';
  const stemLimit = Math.max(1, 255 - suffix.length);
  return `${normalized.slice(0, stemLimit)}${suffix}`;
}

export function extensionForFileName(name: string): AllowedFileExtension {
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
  if (!(extension in FILE_MIME_BY_EXTENSION)) {
    throw new FileValidationError('Разрешены только JPEG, PNG, WebP, PDF, TXT, DOCX и XLSX.');
  }
  return extension as AllowedFileExtension;
}

function validateHeader(extension: AllowedFileExtension, bytes: Uint8Array): void {
  if (bytes.length === 0) throw new FileValidationError('Файл пуст.');

  switch (extension) {
    case 'jpg':
    case 'jpeg':
      if (!startsWith(bytes, [0xff, 0xd8, 0xff])) throw new FileValidationError('Содержимое файла не соответствует JPEG.');
      return;
    case 'png':
      if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        throw new FileValidationError('Содержимое файла не соответствует PNG.');
      }
      return;
    case 'webp':
      if (!asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WEBP')) {
        throw new FileValidationError('Содержимое файла не соответствует WebP.');
      }
      return;
    case 'pdf':
      if (!asciiAt(bytes, 0, '%PDF-')) throw new FileValidationError('Содержимое файла не соответствует PDF.');
      return;
    case 'docx':
    case 'xlsx':
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
        throw new FileValidationError('Содержимое файла не соответствует формату Office Open XML.');
      }
      return;
    case 'txt': {
      if (bytes.some((byte) => byte === 0)) throw new FileValidationError('TXT не должен содержать нулевые байты.');
      const text = new TextDecoder('utf-8').decode(bytes);
      if (FORBIDDEN_TEXT_FRAGMENT.test(text)) throw new FileValidationError('HTML, XML и SVG нельзя загружать как TXT.');
    }
  }
}

export function validateUpload(input: UploadPreflightInput): ValidatedUploadPreflight {
  const name = normalizeFileName(input.name);
  const extension = extensionForFileName(name);
  const expectedMime = FILE_MIME_BY_EXTENSION[extension];

  if (input.declaredMime !== expectedMime) {
    throw new FileValidationError('Тип файла не соответствует его расширению.');
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0) throw new FileValidationError('Файл пуст.');
  if (input.size > MAX_FILE_BYTES) throw new FileValidationError('Размер файла не должен превышать 25 МиБ.');

  validateHeader(extension, input.headerBytes);

  return {
    name,
    extension,
    declaredMime: expectedMime,
    size: input.size,
  };
}
