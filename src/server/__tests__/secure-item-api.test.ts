// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createSupabaseSecureItemStore, SECURE_ITEM_SUMMARY_COLUMNS } from '@/server/secure-item-api';

const workspaceId = '33333333-3333-4333-8333-333333333333';
const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = {
  id: itemId,
  workspace_id: workspaceId,
  title: 'Касса',
  purpose: 'Операционная касса',
  owner: 'Управляющий',
  review_date: null,
  card_bank: null,
  card_holder: null,
  card_purpose: null,
  last_four: '4242',
  external_url: 'https://vault.bitwarden.com/#/items/private',
  version: 1,
  created_at: '2026-08-02T12:00:00.000Z',
  updated_at: '2026-08-02T12:00:00.000Z',
  deleted_at: null,
};

function query(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'insert', 'update', 'single', 'maybeSingle']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;
}

describe('Supabase secure-item adapter', () => {
  it('uses a summary-only projection for list results even if a backend row contains a reveal URL', async () => {
    const builder = query({ data: [row], error: null });
    const client = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
    const store = createSupabaseSecureItemStore(client);
    const summaries = await store.listSecureItems(workspaceId);

    expect(builder.select).toHaveBeenCalledWith(SECURE_ITEM_SUMMARY_COLUMNS);
    expect(SECURE_ITEM_SUMMARY_COLUMNS).not.toContain('external_url');
    expect(summaries).toEqual([expect.objectContaining({ title: 'Касса', lastFour: '4242' })]);
    expect(summaries[0]).not.toHaveProperty('externalUrl');
  });

  it('writes the URL but selects only the safe summary after create and non-defaulting update', async () => {
    const createBuilder = query({ data: row, error: null });
    const updateBuilder = query({ data: { ...row, owner: 'Старший смены', version: 2 }, error: null });
    const actorClient = {
      from: vi.fn()
        .mockReturnValueOnce(createBuilder)
        .mockReturnValueOnce(updateBuilder),
    } as unknown as SupabaseClient;
    const store = createSupabaseSecureItemStore(actorClient);

    await store.createSecureItem(workspaceId, {
      title: 'Касса', purpose: 'Операционная касса', owner: 'Управляющий',
      reviewDate: null, cardBank: null, cardHolder: null, cardPurpose: null, lastFour: '4242',
      externalUrl: row.external_url,
    }, '11111111-1111-4111-8111-111111111111');
    expect(createBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({ external_url: row.external_url }));
    expect(createBuilder.select).toHaveBeenCalledWith(SECURE_ITEM_SUMMARY_COLUMNS);

    await store.updateSecureItem(workspaceId, itemId, { owner: 'Старший смены' }, 1, '11111111-1111-4111-8111-111111111111');
    expect(updateBuilder.update).toHaveBeenCalledWith({ owner: 'Старший смены' });
    expect(updateBuilder.select).toHaveBeenCalledWith(SECURE_ITEM_SUMMARY_COLUMNS);
  });

  it('selects the reveal column only for the explicit reveal operation', async () => {
    const builder = query({ data: { external_url: row.external_url }, error: null });
    const client = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
    const store = createSupabaseSecureItemStore(client);
    await expect(store.revealSecureItem(workspaceId, itemId)).resolves.toEqual({ externalUrl: row.external_url });
    expect(builder.select).toHaveBeenCalledWith('external_url');
  });

  it('restores through the database-clock RPC and returns a summary without the reveal URL', async () => {
    const actorClient = {
      rpc: vi.fn().mockResolvedValue({ data: [{ ...row, version: 3, deleted_at: null }], error: null }),
    } as unknown as SupabaseClient;
    const store = createSupabaseSecureItemStore({} as SupabaseClient, () => actorClient);

    const restored = await store.restoreSecureItem(workspaceId, itemId, 2, '11111111-1111-4111-8111-111111111111');

    expect(actorClient.rpc).toHaveBeenCalledWith('restore_secure_item_record', {
      p_workspace_id: workspaceId,
      p_secure_item_id: itemId,
      p_expected_version: 2,
    });
    expect(restored).toMatchObject({ id: itemId, version: 3, deletedAt: null });
    expect(restored).not.toHaveProperty('externalUrl');
  });
});
