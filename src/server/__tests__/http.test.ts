// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { knowledgeInputSchema } from '@/domain/schemas';
import { readJsonObject, WORKSPACE_MAX_JSON_BYTES } from '@/server/http';

describe('readJsonObject', () => {
  it('accepts the maximum schema-valid escaped knowledge envelope', async () => {
    const escaped = '\u0001';
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      id: `${escaped.repeat(198)}${String(index).padStart(2, '0')}`,
      name: escaped.repeat(255),
      mimeType: escaped.repeat(200),
      size: 25 * 1024 * 1024,
      storagePath: escaped.repeat(1_000),
    }));
    const urlPrefix = 'https://example.com/';
    const payload = knowledgeInputSchema.parse({
      title: escaped.repeat(280),
      kind: 'link',
      body: escaped.repeat(30_000),
      linkUrl: `${urlPrefix}${escaped.repeat(2_000 - urlPrefix.length)}`,
      sectionId: escaped.repeat(200),
      attachments,
    });
    const body = JSON.stringify(payload);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(256 * 1024);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(WORKSPACE_MAX_JSON_BYTES);
    const request = new Request('https://app.example/api/knowledge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await expect(readJsonObject(request, WORKSPACE_MAX_JSON_BYTES)).resolves.toMatchObject(payload);
  });

  it('rejects request bodies above the workspace cap', async () => {
    const body = JSON.stringify({ body: '界'.repeat(200_000) });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(WORKSPACE_MAX_JSON_BYTES);
    const request = new Request('https://app.example/api/knowledge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await expect(readJsonObject(request, WORKSPACE_MAX_JSON_BYTES)).resolves.toBeNull();
  });

  it('keeps the default parser cap bounded for authentication requests', async () => {
    const body = JSON.stringify({ value: 'x'.repeat(20_000) });
    const request = new Request('https://app.example/api/session/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await expect(readJsonObject(request)).resolves.toBeNull();
  });
});
