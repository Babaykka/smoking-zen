// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createContactItemHandler } from '@/app/api/contacts/[id]/route';
import { createContactsHandler } from '@/app/api/contacts/route';
import { createKnowledgeItemHandler } from '@/app/api/knowledge/[id]/route';
import { createKnowledgeHandler } from '@/app/api/knowledge/route';
import { createSearchHandler } from '@/app/api/search/route';
import {
  ConflictError,
  RestoreExpiredError,
  RestoreNotDeletedError,
  RestoreNotFoundError,
} from '@/data/workspace-repository';
import { demoSeed } from '@/data/demo-seed';
import type { KnowledgeContactApiStore, KnowledgeContactRouteDependencies } from '@/server/knowledge-contact-api';

const actor = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '33333333-3333-4333-8333-333333333333', membershipId: '22222222-2222-4222-8222-222222222222' };
const knowledgeId = '55555555-5555-4555-8555-555555555555';
const contactId = '66666666-6666-4666-8666-666666666666';
const request = (path: string, method: string, body?: unknown, origin = 'https://app.example') => new Request(`https://app.example${path}`, {
  method, headers: { 'content-type': 'application/json', origin }, body: body === undefined ? undefined : JSON.stringify(body),
});

function store(): KnowledgeContactApiStore {
  return {
    createKnowledge: vi.fn().mockResolvedValue(demoSeed.knowledge[0]), updateKnowledge: vi.fn().mockResolvedValue({ ...demoSeed.knowledge[0], version: 2 }),
    deleteKnowledge: vi.fn().mockResolvedValue({ ...demoSeed.knowledge[0], version: 2, deletedAt: '2026-08-02T12:00:00.000Z' }),
    restoreKnowledge: vi.fn().mockResolvedValue({ ...demoSeed.knowledge[0], version: 3 }),
    createContact: vi.fn().mockResolvedValue(demoSeed.contacts[0]), updateContact: vi.fn().mockResolvedValue({ ...demoSeed.contacts[0], version: 2 }),
    deleteContact: vi.fn().mockResolvedValue({ ...demoSeed.contacts[0], version: 2, deletedAt: '2026-08-02T12:00:00.000Z' }),
    restoreContact: vi.fn().mockResolvedValue({ ...demoSeed.contacts[0], version: 3 }), search: vi.fn().mockResolvedValue([{ entity: 'knowledge', id: 'knowledge-bowl', title: 'Чаша' }]),
  };
}

function dependencies(value = store()): KnowledgeContactRouteDependencies {
  return { appOrigin: 'https://app.example', store: value, authenticate: async () => actor, requestId: () => 'request-1' };
}

describe('knowledge, contact and search routes', () => {
  it('derives the workspace from the authenticated actor and rejects cross-origin writes', async () => {
    const api = store();
    const handler = createKnowledgeHandler(dependencies(api));
    expect((await handler(request('/api/knowledge', 'POST', { title: 'Новая заметка', kind: 'note' }))).status).toBe(201);
    expect(api.createKnowledge).toHaveBeenCalledWith(actor.workspaceId, expect.objectContaining({ title: 'Новая заметка', linkUrl: null }), actor.userId);
    expect((await handler(request('/api/knowledge', 'POST', { title: 'Чужая', kind: 'note' }, 'https://evil.example'))).status).toBe(403);
  });

  it('rejects unsafe persisted knowledge and contact URLs before store access', async () => {
    const api = store();
    const knowledge = createKnowledgeHandler(dependencies(api));
    expect((await knowledge(request('/api/knowledge', 'POST', {
      title: 'Регламент', kind: 'note', body: 'https://example.com/guide#opening',
    }))).status).toBe(400);
    expect(api.createKnowledge).not.toHaveBeenCalled();

    const contacts = createContactsHandler(dependencies(api));
    expect((await contacts(request('/api/contacts', 'POST', {
      name: 'Мастер', notes: 'http://example.com/profile', methods: [{ kind: 'phone', value: '+79991234567' }],
    }))).status).toBe(400);
    expect(api.createContact).not.toHaveBeenCalled();
  });

  it('accepts the maximum schema-valid escaped knowledge envelope', async () => {
    const api = store();
    const handler = createKnowledgeHandler(dependencies(api));
    const escaped = '\u0001';
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      id: `${escaped.repeat(198)}${String(index).padStart(2, '0')}`,
      name: escaped.repeat(255),
      mimeType: escaped.repeat(200),
      size: 25 * 1024 * 1024,
    }));
    const urlPrefix = 'https://example.com/';
    const input = {
      title: escaped.repeat(280),
      kind: 'link' as const,
      body: escaped.repeat(30_000),
      linkUrl: `${urlPrefix}${'x'.repeat(2_000 - urlPrefix.length)}`,
      sectionId: escaped.repeat(200),
      attachments,
    };
    const raw = JSON.stringify(input);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(256 * 1024);
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(512 * 1024);
    expect((await handler(request('/api/knowledge', 'POST', input))).status).toBe(201);
    expect(api.createKnowledge).toHaveBeenCalledWith(actor.workspaceId, expect.objectContaining({
      body: input.body,
      linkUrl: input.linkUrl,
      attachments: attachments.map((attachment) => ({ ...attachment, version: 1 })),
    }), actor.userId);
  });

  it('keeps title-only patches non-defaulting and returns version conflicts', async () => {
    const api = store();
    const handler = createKnowledgeItemHandler(dependencies(api));
    const context = { params: Promise.resolve({ id: knowledgeId }) };
    expect((await handler(request(`/api/knowledge/${knowledgeId}`, 'PATCH', { input: { title: 'Новое имя' }, expectedVersion: 1 }), context)).status).toBe(200);
    expect(api.updateKnowledge).toHaveBeenCalledWith(actor.workspaceId, knowledgeId, { title: 'Новое имя' }, 1, actor.userId);
    vi.mocked(api.updateKnowledge).mockRejectedValueOnce(new ConflictError(1, 2));
    expect((await handler(request(`/api/knowledge/${knowledgeId}`, 'PATCH', { input: { title: 'Ещё раз' }, expectedVersion: 1 }), context)).status).toBe(409);
  });

  it('returns stable 400 responses for invalid knowledge transitions and store validation', async () => {
    const api = store();
    const handler = createKnowledgeItemHandler(dependencies(api));
    const context = { params: Promise.resolve({ id: knowledgeId }) };
    const invalidTransition = new z.ZodError([{ code: 'custom', path: ['linkUrl'], message: 'Некорректный переход типа.' }]);
    vi.mocked(api.updateKnowledge).mockRejectedValueOnce(invalidTransition).mockRejectedValueOnce(invalidTransition);
    expect((await handler(request(`/api/knowledge/${knowledgeId}`, 'PATCH', { input: { kind: 'link' }, expectedVersion: 1 }), context)).status).toBe(400);
    expect((await handler(request(`/api/knowledge/${knowledgeId}`, 'PATCH', { input: { linkUrl: 'https://example.com' }, expectedVersion: 1 }), context)).status).toBe(400);
    expect((await handler(request(`/api/knowledge/${knowledgeId}`, 'PATCH', { input: { kind: 'link', linkUrl: 'https://example.com' }, expectedVersion: 1 }), context)).status).toBe(200);
    vi.mocked(api.updateKnowledge).mockRejectedValueOnce(new z.ZodError([{ code: 'custom', path: ['kind'], message: 'Некорректный переход типа.' }]));
    const validation = await handler(request(`/api/knowledge/${knowledgeId}`, 'PATCH', { input: { kind: 'note' }, expectedVersion: 1 }), context);
    expect(validation.status).toBe(400);
    expect(await validation.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('uses atomic contact mutation through the actor workspace and supports delete/restore', async () => {
    const api = store();
    const list = createContactsHandler(dependencies(api));
    expect((await list(request('/api/contacts', 'POST', { name: 'Мастер', category: 'service', methods: [{ kind: 'phone', value: '+7 (999) 123-45-67' }] }))).status).toBe(201);
    expect(api.createContact).toHaveBeenCalledWith(actor.workspaceId, expect.objectContaining({ methods: [{ kind: 'phone', value: '+79991234567' }] }), actor.userId);
    const item = createContactItemHandler(dependencies(api));
    const context = { params: Promise.resolve({ id: contactId }) };
    expect((await item(request(`/api/contacts/${contactId}`, 'DELETE', { expectedVersion: 1 }), context)).status).toBe(200);
    expect((await item(request(`/api/contacts/${contactId}`, 'PATCH', { action: 'restore', expectedVersion: 2 }), context)).status).toBe(200);
    expect(api.deleteContact).toHaveBeenCalledWith(actor.workspaceId, contactId, 1, actor.userId);
    expect(api.restoreContact).toHaveBeenCalledWith(actor.workspaceId, contactId, 2, actor.userId);
  });

  it.each([
    { entity: 'knowledge', method: 'restoreKnowledge' as const, path: `/api/knowledge/${knowledgeId}`, id: knowledgeId },
    { entity: 'contact', method: 'restoreContact' as const, path: `/api/contacts/${contactId}`, id: contactId },
  ])('maps typed $entity restore failures to stable recovery responses', async ({ method, path, id }) => {
    const api = store();
    const handler = method === 'restoreKnowledge'
      ? createKnowledgeItemHandler(dependencies(api))
      : createContactItemHandler(dependencies(api));
    const failures = [
      { error: new RestoreNotFoundError(), status: 404, code: 'record_not_found' },
      { error: new RestoreNotDeletedError(), status: 409, code: 'restore_not_deleted' },
      { error: new RestoreExpiredError(), status: 410, code: 'restore_expired' },
    ];

    for (const failure of failures) {
      vi.mocked(api[method]).mockRejectedValueOnce(failure.error);
      const response = await handler(
        request(path, 'PATCH', { action: 'restore', expectedVersion: 2 }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(failure.status);
      expect(await response.json()).toMatchObject({ data: null, error: { code: failure.code } });
    }
  });

  it('does not search through a URL and fails closed for unauthenticated or invalid requests', async () => {
    const api = store();
    const handler = createSearchHandler(dependencies(api));
    const response = await handler(request('/api/search', 'POST', { query: 'уголь' }));
    expect(response.status).toBe(200);
    expect(api.search).toHaveBeenCalledWith(actor.workspaceId, 'уголь');
    expect((await handler(request('/api/search?q=уголь', 'POST', {}))).status).toBe(400);
    const unauthenticated = createSearchHandler({ ...dependencies(api), authenticate: async () => null });
    expect((await unauthenticated(request('/api/search', 'POST', { query: 'уголь' }))).status).toBe(401);
  });

  it('rejects malformed material and contact identifiers before store access', async () => {
    const api = store();
    const knowledge = createKnowledgeItemHandler(dependencies(api));
    const contact = createContactItemHandler(dependencies(api));
    expect((await knowledge(request('/api/knowledge/not-a-uuid', 'DELETE', { expectedVersion: 1 }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    })).status).toBe(400);
    expect((await contact(request('/api/contacts/not-a-uuid', 'DELETE', { expectedVersion: 1 }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    })).status).toBe(400);
    expect(api.deleteKnowledge).not.toHaveBeenCalled();
    expect(api.deleteContact).not.toHaveBeenCalled();
  });
});
