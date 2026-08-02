// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createSecureItemRevealHandler } from '@/app/api/secure-items/[id]/reveal/route';
import { createSecureItemHandler } from '@/app/api/secure-items/[id]/route';
import { createSecureItemsHandler } from '@/app/api/secure-items/route';
import { ConflictError, RestoreExpiredError } from '@/data/workspace-repository';
import { unsafeSafeTextFixtures, unsafeSafeUrlFixtures } from '@/domain/__tests__/safe-content-fixtures';
import type { SecureItemSummary } from '@/domain/types';
import {
  SecureItemUrlNotAllowedError,
  type SecureItemApiStore,
  type SecureItemRouteDependencies,
} from '@/server/secure-item-api';

const actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  membershipId: '22222222-2222-4222-8222-222222222222',
};
const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const summary: SecureItemSummary = {
  id: itemId,
  workspaceId: actor.workspaceId,
  title: 'Касса',
  purpose: 'Операционная касса',
  owner: 'Управляющий',
  reviewDate: '2026-09-01',
  cardBank: 'Банк',
  cardHolder: 'SMOKING ZEN',
  cardPurpose: 'Расходы',
  lastFour: '4242',
  version: 1,
  createdAt: '2026-08-02T12:00:00.000Z',
  updatedAt: '2026-08-02T12:00:00.000Z',
  deletedAt: null,
};
const validInput = {
  title: summary.title,
  purpose: summary.purpose,
  owner: summary.owner,
  reviewDate: summary.reviewDate,
  cardBank: summary.cardBank,
  cardHolder: summary.cardHolder,
  cardPurpose: summary.cardPurpose,
  lastFour: summary.lastFour,
  externalUrl: 'https://vault.bitwarden.com/#/items/example',
};

function store(): SecureItemApiStore {
  return {
    listSecureItems: vi.fn().mockResolvedValue([summary]),
    createSecureItem: vi.fn().mockResolvedValue(summary),
    updateSecureItem: vi.fn().mockResolvedValue({ ...summary, owner: 'Старший смены', version: 2 }),
    deleteSecureItem: vi.fn().mockResolvedValue({ ...summary, version: 2, deletedAt: '2026-08-02T13:00:00.000Z' }),
    restoreSecureItem: vi.fn().mockResolvedValue({ ...summary, version: 3, deletedAt: null }),
    revealSecureItem: vi.fn().mockResolvedValue({ externalUrl: validInput.externalUrl }),
  };
}

function dependencies(
  secureStore = store(),
  authenticate: SecureItemRouteDependencies['authenticate'] = async () => actor,
): SecureItemRouteDependencies {
  return {
    appOrigin: 'https://app.example',
    store: secureStore,
    authenticate,
    requestId: () => 'request-safe',
    selfHostedOrigins: ['https://vault.example.org'],
  };
}

function request(url: string, method = 'GET', body?: unknown, origin = 'https://app.example') {
  return new Request(url, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('secure-item routes', () => {
  it('fails closed without current workspace membership', async () => {
    const secureStore = store();
    const handler = createSecureItemsHandler(dependencies(secureStore, async () => null));
    const response = await handler(request('https://app.example/api/secure-items'));
    expect(response.status).toBe(401);
    expect(secureStore.listSecureItems).not.toHaveBeenCalled();
  });

  it('lists only safe summaries and never includes the Bitwarden URL', async () => {
    const secureStore = store();
    const handler = createSecureItemsHandler(dependencies(secureStore));
    const response = await handler(request('https://app.example/api/secure-items'));
    const raw = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(secureStore.listSecureItems).toHaveBeenCalledWith(actor.workspaceId);
    expect(raw).toContain('Касса');
    expect(raw).not.toMatch(/externalUrl|vault\.bitwarden|#\/items/iu);
  });

  it.each([
    'https://vault.bitwarden.com/#/items/example',
    'https://vault.bitwarden.eu/#/items/example',
    'https://vault.example.org/#/items/example',
  ])('creates fixed metadata for an exact allowed origin without returning the URL: %s', async (externalUrl) => {
    const secureStore = store();
    const handler = createSecureItemsHandler(dependencies(secureStore));
    const response = await handler(request('https://app.example/api/secure-items', 'POST', { ...validInput, externalUrl }));
    expect(response.status).toBe(201);
    expect(secureStore.createSecureItem).toHaveBeenCalledWith(actor.workspaceId, expect.objectContaining({ externalUrl }), actor.userId);
    expect(JSON.stringify(await response.json())).not.toContain(externalUrl);
  });

  it.each([
    ['subdomain', { ...validInput, externalUrl: 'https://sub.vault.example.org/#/items/example' }],
    ['unknown host', { ...validInput, externalUrl: 'https://vault.attacker.example/#/items/example' }],
    ['credentials', { ...validInput, externalUrl: 'https://user:pass@vault.bitwarden.com/#/items/example' }],
    ['secret field', { ...validInput, password: 'hunter2' }],
    ['PAN', { ...validInput, cardHolder: '4242 4242 4242 4242' }],
    ['bad last four', { ...validInput, lastFour: '42424' }],
  ])('rejects unsafe or non-fixed create data: %s', async (_label, body) => {
    const secureStore = store();
    const handler = createSecureItemsHandler(dependencies(secureStore));
    const response = await handler(request('https://app.example/api/secure-items', 'POST', body));
    expect(response.status).toBe(400);
    expect(secureStore.createSecureItem).not.toHaveBeenCalled();
  });

  it.each(unsafeSafeUrlFixtures)(
    'returns stable 400 for every canonically unsafe create and update URL before the database: %s', async (externalUrl) => {
    const secureStore = store();
    const collection = createSecureItemsHandler(dependencies(secureStore));
    const created = await collection(request('https://app.example/api/secure-items', 'POST', { ...validInput, externalUrl }));
    expect(created.status).toBe(400);
    expect(secureStore.createSecureItem).not.toHaveBeenCalled();

    const item = createSecureItemHandler(dependencies(secureStore));
    const updated = await item(request(`https://app.example/api/secure-items/${itemId}`, 'PATCH', {
      input: { externalUrl }, expectedVersion: 1,
    }), { params: Promise.resolve({ id: itemId }) });
    expect(updated.status).toBe(400);
    expect(secureStore.updateSecureItem).not.toHaveBeenCalled();
    },
  );

  it.each(unsafeSafeTextFixtures)(
    'returns stable 400 for every canonically unsafe create and update summary before the database: %s', async (purpose) => {
      const secureStore = store();
      const collection = createSecureItemsHandler(dependencies(secureStore));
      const created = await collection(request('https://app.example/api/secure-items', 'POST', { ...validInput, purpose }));
      expect(created.status).toBe(400);
      expect(secureStore.createSecureItem).not.toHaveBeenCalled();

      const item = createSecureItemHandler(dependencies(secureStore));
      const updated = await item(request(`https://app.example/api/secure-items/${itemId}`, 'PATCH', {
        input: { purpose }, expectedVersion: 1,
      }), { params: Promise.resolve({ id: itemId }) });
      expect(updated.status).toBe(400);
      expect(secureStore.updateSecureItem).not.toHaveBeenCalled();
    },
  );

  it('keeps update patches non-defaulting and maps stale versions without overwriting', async () => {
    const secureStore = store();
    const handler = createSecureItemHandler(dependencies(secureStore));
    const context = { params: Promise.resolve({ id: itemId }) };
    const updated = await handler(request(`https://app.example/api/secure-items/${itemId}`, 'PATCH', {
      input: { owner: 'Старший смены' }, expectedVersion: 1,
    }), context);
    expect(updated.status).toBe(200);
    expect(secureStore.updateSecureItem).toHaveBeenCalledWith(
      actor.workspaceId, itemId, { owner: 'Старший смены' }, 1, actor.userId,
    );

    vi.mocked(secureStore.updateSecureItem).mockRejectedValueOnce(new ConflictError(1, 2));
    const conflict = await handler(request(`https://app.example/api/secure-items/${itemId}`, 'PATCH', {
      input: { owner: 'Директор' }, expectedVersion: 1,
    }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ data: { expectedVersion: 1, actualVersion: 2 }, error: { code: 'version_conflict' } });
  });

  it('soft-deletes with a version and rejects cross-site mutations', async () => {
    const secureStore = store();
    const handler = createSecureItemHandler(dependencies(secureStore));
    const context = { params: Promise.resolve({ id: itemId }) };
    const deleted = await handler(request(`https://app.example/api/secure-items/${itemId}`, 'DELETE', { expectedVersion: 1 }), context);
    expect(deleted.status).toBe(200);
    expect(secureStore.deleteSecureItem).toHaveBeenCalledWith(actor.workspaceId, itemId, 1, actor.userId);

    const denied = await handler(request(
      `https://app.example/api/secure-items/${itemId}`, 'DELETE', { expectedVersion: 1 }, 'https://evil.example',
    ), context);
    expect(denied.status).toBe(403);
  });

  it('restores a soft-deleted summary with optimistic concurrency and maps an expired recovery window', async () => {
    const secureStore = store();
    const handler = createSecureItemHandler(dependencies(secureStore));
    const context = { params: Promise.resolve({ id: itemId }) };
    const restored = await handler(request(`https://app.example/api/secure-items/${itemId}`, 'PATCH', {
      action: 'restore', expectedVersion: 2,
    }), context);

    expect(restored.status).toBe(200);
    expect(secureStore.restoreSecureItem).toHaveBeenCalledWith(actor.workspaceId, itemId, 2, actor.userId);
    expect(JSON.stringify(await restored.json())).not.toContain(validInput.externalUrl);

    vi.mocked(secureStore.restoreSecureItem).mockRejectedValueOnce(new RestoreExpiredError());
    const expired = await handler(request(`https://app.example/api/secure-items/${itemId}`, 'PATCH', {
      action: 'restore', expectedVersion: 2,
    }), context);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: { code: 'restore_expired' } });
  });

  it('reveals the URL only through an explicit same-origin POST and never through item GET', async () => {
    const secureStore = store();
    const reveal = createSecureItemRevealHandler(dependencies(secureStore));
    const context = { params: Promise.resolve({ id: itemId }) };

    const methodDenied = await reveal(request(`https://app.example/api/secure-items/${itemId}/reveal`, 'GET'), context);
    expect(methodDenied.status).toBe(405);
    expect(secureStore.revealSecureItem).not.toHaveBeenCalled();

    const response = await reveal(request(`https://app.example/api/secure-items/${itemId}/reveal`, 'POST'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(secureStore.revealSecureItem).toHaveBeenCalledWith(actor.workspaceId, itemId);
    expect(await response.json()).toMatchObject({ data: { externalUrl: validInput.externalUrl } });
  });

  it('maps canonical legacy reveal rejection to stable 422 without exposing the URL', async () => {
    const secureStore = store();
    vi.mocked(secureStore.revealSecureItem).mockRejectedValueOnce(new SecureItemUrlNotAllowedError());
    const reveal = createSecureItemRevealHandler(dependencies(secureStore));
    const response = await reveal(request(`https://app.example/api/secure-items/${itemId}/reveal`, 'POST'), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toMatch(/4111|hunter2|vault\.bitwarden/iu);
  });

  it('keeps raw database/provider details out of error envelopes', async () => {
    const secureStore = store();
    vi.mocked(secureStore.revealSecureItem).mockRejectedValueOnce(new Error('password=hunter2 url=https://private-vault.example/item'));
    const reveal = createSecureItemRevealHandler(dependencies(secureStore));
    const failed = await reveal(request(`https://app.example/api/secure-items/${itemId}/reveal`, 'POST'), {
      params: Promise.resolve({ id: itemId }),
    });
    const raw = JSON.stringify(await failed.json());
    expect(failed.status).toBe(500);
    expect(raw).not.toMatch(/hunter2|private-vault|password=/iu);
  });
});
