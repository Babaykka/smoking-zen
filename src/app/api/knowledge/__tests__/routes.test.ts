// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createContactItemHandler } from '@/app/api/contacts/[id]/route';
import { createContactsHandler } from '@/app/api/contacts/route';
import { createKnowledgeItemHandler } from '@/app/api/knowledge/[id]/route';
import { createKnowledgeHandler } from '@/app/api/knowledge/route';
import { createSearchHandler } from '@/app/api/search/route';
import { ConflictError } from '@/data/workspace-repository';
import { demoSeed } from '@/data/demo-seed';
import type { KnowledgeContactApiStore, KnowledgeContactRouteDependencies } from '@/server/knowledge-contact-api';

const actor = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '33333333-3333-4333-8333-333333333333', membershipId: '22222222-2222-4222-8222-222222222222' };
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

  it('keeps title-only patches non-defaulting and returns version conflicts', async () => {
    const api = store();
    const handler = createKnowledgeItemHandler(dependencies(api));
    const context = { params: Promise.resolve({ id: 'knowledge-bowl' }) };
    expect((await handler(request('/api/knowledge/knowledge-bowl', 'PATCH', { input: { title: 'Новое имя' }, expectedVersion: 1 }), context)).status).toBe(200);
    expect(api.updateKnowledge).toHaveBeenCalledWith(actor.workspaceId, 'knowledge-bowl', { title: 'Новое имя' }, 1, actor.userId);
    vi.mocked(api.updateKnowledge).mockRejectedValueOnce(new ConflictError(1, 2));
    expect((await handler(request('/api/knowledge/knowledge-bowl', 'PATCH', { input: { title: 'Ещё раз' }, expectedVersion: 1 }), context)).status).toBe(409);
  });

  it('uses atomic contact mutation through the actor workspace and supports delete/restore', async () => {
    const api = store();
    const list = createContactsHandler(dependencies(api));
    expect((await list(request('/api/contacts', 'POST', { name: 'Мастер', category: 'service', methods: [{ kind: 'phone', value: '+7 (999) 123-45-67' }] }))).status).toBe(201);
    expect(api.createContact).toHaveBeenCalledWith(actor.workspaceId, expect.objectContaining({ methods: [{ kind: 'phone', value: '+79991234567' }] }), actor.userId);
    const item = createContactItemHandler(dependencies(api));
    const context = { params: Promise.resolve({ id: 'contact-coal' }) };
    expect((await item(request('/api/contacts/contact-coal', 'DELETE', { expectedVersion: 1 }), context)).status).toBe(200);
    expect((await item(request('/api/contacts/contact-coal', 'PATCH', { action: 'restore', expectedVersion: 2 }), context)).status).toBe(200);
    expect(api.deleteContact).toHaveBeenCalledWith(actor.workspaceId, 'contact-coal', 1, actor.userId);
    expect(api.restoreContact).toHaveBeenCalledWith(actor.workspaceId, 'contact-coal', 2, actor.userId);
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
});
