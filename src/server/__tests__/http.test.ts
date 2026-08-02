// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { readJsonObject, WORKSPACE_MAX_JSON_BYTES } from '@/server/http';

describe('readJsonObject', () => {
  it('accepts the largest Unicode knowledge body plus JSON overhead', async () => {
    const body = JSON.stringify({ title: 'Регламент', kind: 'note', body: 'я'.repeat(30_000) });
    const request = new Request('https://app.example/api/knowledge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await expect(readJsonObject(request, WORKSPACE_MAX_JSON_BYTES)).resolves.toMatchObject({ body: 'я'.repeat(30_000) });
  });

  it('keeps request bodies bounded', async () => {
    const body = JSON.stringify({ body: 'я'.repeat(100_000) });
    const request = new Request('https://app.example/api/knowledge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await expect(readJsonObject(request, WORKSPACE_MAX_JSON_BYTES)).resolves.toBeNull();
  });
});
