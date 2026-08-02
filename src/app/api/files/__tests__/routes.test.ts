// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createFileCompletionHandler } from '@/app/api/files/[id]/complete/route';
import { createFileDownloadHandler } from '@/app/api/files/[id]/download/route';
import { createSignUploadHandler } from '@/app/api/files/sign-upload/route';
import { FileValidationError, MAX_FILE_BYTES } from '@/domain/files';
import {
  FileNotFoundError,
  FileNotReadyError,
  ParentNotFoundError,
  type PrivateFileStore,
  SIGNED_DOWNLOAD_SECONDS,
} from '@/server/files/file-store';
import type { FileRouteDependencies } from '@/server/files/file-api';

const actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  membershipId: '22222222-2222-4222-8222-222222222222',
};
const parentId = '44444444-4444-4444-8444-444444444444';
const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const textBytes = Buffer.from('Регламент смены.\n', 'utf8');

function store(): PrivateFileStore {
  return {
    signUpload: vi.fn().mockResolvedValue({
      id: attachmentId,
      name: 'policy.txt',
      mimeType: 'text/plain',
      size: textBytes.length,
      uploadUrl: `https://storage.example/storage/v1/object/upload/sign/workspace-files/${attachmentId}?token=ephemeral`,
      expiresAt: '2026-08-02T14:05:00.000Z',
    }),
    completeUpload: vi.fn().mockResolvedValue({
      id: attachmentId, name: 'policy.txt', mimeType: 'text/plain', size: textBytes.length,
    }),
    signDownload: vi.fn().mockResolvedValue({
      id: attachmentId,
      name: 'policy.txt',
      mimeType: 'text/plain',
      size: textBytes.length,
      url: `https://storage.example/storage/v1/object/sign/workspace-files/${attachmentId}?token=ephemeral`,
      expiresIn: 60,
    }),
    cleanupExpiredUploads: vi.fn().mockResolvedValue({ removed: 0, failed: 0 }),
  };
}

function dependencies(fileStore = store(), authenticate: FileRouteDependencies['authenticate'] = async () => actor): FileRouteDependencies {
  return {
    appOrigin: 'https://app.example',
    store: fileStore,
    authenticate,
    requestId: () => 'request-files',
  };
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { origin: 'https://app.example', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function downloadRequest(origin = 'https://app.example') {
  return new Request(`https://app.example/api/files/${attachmentId}/download`, { headers: { origin } });
}

function signBody(overrides: Record<string, unknown> = {}) {
  return {
    parentType: 'task',
    parentId,
    name: 'policy.txt',
    declaredMime: 'text/plain',
    size: textBytes.length,
    headerBase64: textBytes.toString('base64'),
    ...overrides,
  };
}

describe('private file routes', () => {
  it('fails closed before issuing upload or download URLs without a current workspace membership', async () => {
    const fileStore = store();
    const sign = createSignUploadHandler(dependencies(fileStore, async () => null));
    const download = createFileDownloadHandler(dependencies(fileStore, async () => null));

    expect((await sign(jsonRequest('https://app.example/api/files/sign-upload', 'POST', signBody()))).status).toBe(401);
    expect((await download(downloadRequest(), {
      params: Promise.resolve({ id: attachmentId }),
    })).status).toBe(401);
    expect(fileStore.signUpload).not.toHaveBeenCalled();
    expect(fileStore.signDownload).not.toHaveBeenCalled();
  });

  it('normalizes a preflight inside the session workspace and returns only an ephemeral signed upload URL', async () => {
    const fileStore = store();
    const handler = createSignUploadHandler(dependencies(fileStore));
    const response = await handler(jsonRequest('https://app.example/api/files/sign-upload', 'POST', signBody({ name: '..\\policy.txt' })));

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fileStore.signUpload).toHaveBeenCalledWith(actor.workspaceId, actor.userId, {
      parent: { type: 'task', id: parentId },
      file: expect.objectContaining({ name: 'policy.txt', declaredMime: 'text/plain', size: textBytes.length }),
    });
    expect(fileStore.cleanupExpiredUploads).toHaveBeenCalledWith(expect.any(Date), 20);
    const payload = await response.json();
    expect(payload.data.uploadUrl).toContain('token=ephemeral');
    expect(JSON.stringify(payload)).not.toMatch(/\/quarantine\/|\/ready\/|33333333-3333-4333-8333-333333333333/iu);
    expect(payload.data).not.toHaveProperty('storagePath');
  });

  it.each([
    ['cross-site origin', signBody(), 'https://evil.example'],
    ['oversize', signBody({ size: MAX_FILE_BYTES + 1 }), 'https://app.example'],
    ['MIME mismatch', signBody({ declaredMime: 'application/pdf' }), 'https://app.example'],
    ['spoofed header', signBody({ headerBase64: Buffer.from('<html/>').toString('base64') }), 'https://app.example'],
    ['forged workspace', signBody({ workspaceId: '55555555-5555-4555-8555-555555555555' }), 'https://app.example'],
  ])('rejects an invalid sign-upload request: %s', async (_label, body, origin) => {
    const fileStore = store();
    const handler = createSignUploadHandler(dependencies(fileStore));
    const request = jsonRequest('https://app.example/api/files/sign-upload', 'POST', body);
    request.headers.set('origin', origin);
    const response = await handler(request);
    expect([400, 403]).toContain(response.status);
    expect(fileStore.signUpload).not.toHaveBeenCalled();
  });

  it('completes validation server-side and maps unsafe bytes to a recovery-safe 422 response', async () => {
    const fileStore = store();
    const handler = createFileCompletionHandler(dependencies(fileStore));
    const context = { params: Promise.resolve({ id: attachmentId }) };
    const completed = await handler(jsonRequest(`https://app.example/api/files/${attachmentId}/complete`, 'POST'), context);
    expect(completed.status).toBe(200);
    expect(fileStore.completeUpload).toHaveBeenCalledWith(actor.workspaceId, attachmentId);

    vi.mocked(fileStore.completeUpload).mockRejectedValueOnce(new FileValidationError('HTML нельзя загружать как TXT.'));
    const rejected = await handler(jsonRequest(`https://app.example/api/files/${attachmentId}/complete`, 'POST'), context);
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ data: null, error: { code: 'file_rejected', message: 'HTML нельзя загружать как TXT.' } });

    vi.mocked(fileStore.completeUpload).mockRejectedValueOnce(new ParentNotFoundError());
    const missingParent = await handler(jsonRequest(`https://app.example/api/files/${attachmentId}/complete`, 'POST'), context);
    expect(missingParent.status).toBe(404);
    expect(await missingParent.json()).toMatchObject({ data: null, error: { code: 'parent_not_found' } });
  });

  it('redirects ready-only downloads for exactly 60 seconds without serializing the provider URL', async () => {
    const fileStore = store();
    const handler = createFileDownloadHandler(dependencies(fileStore));
    const response = await handler(downloadRequest(), {
      params: Promise.resolve({ id: attachmentId }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fileStore.signDownload).toHaveBeenCalledWith(actor.workspaceId, attachmentId, SIGNED_DOWNLOAD_SECONDS);
    expect(response.headers.get('location')).toBe(`https://storage.example/storage/v1/object/sign/workspace-files/${attachmentId}?token=ephemeral`);
    expect(await response.text()).toBe('');
  });

  it('rejects a cross-site request before creating a signed download grant', async () => {
    const fileStore = store();
    const handler = createFileDownloadHandler(dependencies(fileStore));
    const response = await handler(downloadRequest('https://evil.example'), { params: Promise.resolve({ id: attachmentId }) });

    expect(response.status).toBe(403);
    expect(fileStore.signDownload).not.toHaveBeenCalled();
  });

  it('does not expose a URL for missing or quarantined files and keeps provider details out of errors', async () => {
    const fileStore = store();
    const handler = createFileDownloadHandler(dependencies(fileStore));
    const context = { params: Promise.resolve({ id: attachmentId }) };

    vi.mocked(fileStore.signDownload).mockRejectedValueOnce(new FileNotReadyError());
    const pending = await handler(downloadRequest(), context);
    expect(pending.status).toBe(409);
    expect(JSON.stringify(await pending.json())).not.toContain('url');

    vi.mocked(fileStore.signDownload).mockRejectedValueOnce(new FileNotFoundError());
    expect((await handler(downloadRequest(), context)).status).toBe(404);

    vi.mocked(fileStore.signDownload).mockRejectedValueOnce(new Error('provider token=secret at workspace/ready/private-key'));
    const failed = await handler(downloadRequest(), context);
    const raw = JSON.stringify(await failed.json());
    expect(failed.status).toBe(500);
    expect(raw).not.toMatch(/token=secret|private-key|workspace\/ready/iu);
  });
});
