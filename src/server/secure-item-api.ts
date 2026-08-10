import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ConflictError } from '@/data/workspace-repository';
import { isAllowedBitwardenUrl, type ParsedSecureItemInput, type ParsedSecureItemPatchInput } from '@/domain/schemas';
import type { SecureItemReveal, SecureItemSummary } from '@/domain/types';
import { requireProductionEnvironment } from '@/server/env';
import { readSessionCookie } from '@/server/http';
import { isDatabaseVersionConflict, throwKnownRestoreDatabaseError } from '@/server/restore';
import { readSession } from '@/server/session';
import { createServiceSupabaseClient, createSupabaseAccessStore } from '@/server/supabase';

export type SecureItemSessionActor = { userId: string; workspaceId: string; membershipId: string };

export interface SecureItemApiStore {
  listSecureItems(workspaceId: string): Promise<SecureItemSummary[]>;
  createSecureItem(workspaceId: string, input: ParsedSecureItemInput, actorUserId: string): Promise<SecureItemSummary>;
  updateSecureItem(
    workspaceId: string,
    id: string,
    input: ParsedSecureItemPatchInput,
    expectedVersion: number,
    actorUserId: string,
  ): Promise<SecureItemSummary>;
  deleteSecureItem(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<SecureItemSummary>;
  restoreSecureItem(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<SecureItemSummary>;
  revealSecureItem(workspaceId: string, id: string): Promise<SecureItemReveal>;
}

export type SecureItemRouteDependencies = {
  appOrigin: string;
  store: SecureItemApiStore;
  authenticate: (request: Request) => Promise<SecureItemSessionActor | null>;
  requestId: () => string;
  selfHostedOrigins: readonly string[];
};

export class SecureItemNotFoundError extends Error {
  constructor() {
    super('Безопасная запись не найдена.');
    this.name = 'SecureItemNotFoundError';
  }
}

export class SecureItemUrlNotAllowedError extends Error {
  constructor() {
    super('Ссылка безопасной записи больше не разрешена. Обновите её.');
    this.name = 'SecureItemUrlNotAllowedError';
  }
}

type Result = { data: unknown; error: { code?: string; message?: string } | null };

function dataOrThrow(result: Result): unknown {
  if (result.error) throw new Error('Secure item database operation failed.');
  return result.data;
}

function metadata(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

export function secureItemSummaryFromRow(value: unknown): SecureItemSummary {
  const row = value as Record<string, unknown>;
  return {
    ...metadata(row),
    title: String(row.title),
    purpose: String(row.purpose),
    owner: String(row.owner),
    reviewDate: row.review_date === null ? null : String(row.review_date),
    cardBank: row.card_bank === null ? null : String(row.card_bank),
    cardHolder: row.card_holder === null ? null : String(row.card_holder),
    cardPurpose: row.card_purpose === null ? null : String(row.card_purpose),
    lastFour: row.last_four === null ? null : String(row.last_four),
  };
}

export const SECURE_ITEM_SUMMARY_COLUMNS = [
  'id', 'workspace_id', 'title', 'purpose', 'owner', 'review_date', 'card_bank', 'card_holder',
  'card_purpose', 'last_four', 'version', 'created_at', 'updated_at', 'deleted_at',
].join(',');

export function publicSecureItemSummary(item: SecureItemSummary): SecureItemSummary {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    title: item.title,
    purpose: item.purpose,
    owner: item.owner,
    reviewDate: item.reviewDate,
    cardBank: item.cardBank,
    cardHolder: item.cardHolder,
    cardPurpose: item.cardPurpose,
    lastFour: item.lastFour,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
}

function databaseInput(input: ParsedSecureItemInput) {
  return {
    title: input.title,
    purpose: input.purpose,
    owner: input.owner,
    review_date: input.reviewDate,
    card_bank: input.cardBank,
    card_holder: input.cardHolder,
    card_purpose: input.cardPurpose,
    last_four: input.lastFour,
    external_url: input.externalUrl,
  };
}

function databasePatch(input: ParsedSecureItemPatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ('title' in input) patch.title = input.title;
  if ('purpose' in input) patch.purpose = input.purpose;
  if ('owner' in input) patch.owner = input.owner;
  if ('reviewDate' in input) patch.review_date = input.reviewDate;
  if ('cardBank' in input) patch.card_bank = input.cardBank;
  if ('cardHolder' in input) patch.card_holder = input.cardHolder;
  if ('cardPurpose' in input) patch.card_purpose = input.cardPurpose;
  if ('lastFour' in input) patch.last_four = input.lastFour;
  if ('externalUrl' in input) patch.external_url = input.externalUrl;
  return patch;
}

export function createSupabaseSecureItemStore(
  client: SupabaseClient,
  createActorClient: (actorUserId: string) => SupabaseClient = () => client,
  selfHostedOrigins: readonly string[] = [],
): SecureItemApiStore {
  const currentVersion = async (workspaceId: string, id: string): Promise<number | null> => {
    const result = await client.from('secure_items').select('version')
      .eq('workspace_id', workspaceId).eq('id', id).maybeSingle() as Result;
    const data = dataOrThrow(result) as { version?: unknown } | null;
    return data && typeof data.version === 'number' ? data.version : null;
  };

  const conflictOrMissing = async (workspaceId: string, id: string, expectedVersion: number): Promise<never> => {
    const version = await currentVersion(workspaceId, id);
    if (version === null) throw new SecureItemNotFoundError();
    throw new ConflictError(expectedVersion, version);
  };

  return {
    async listSecureItems(workspaceId) {
      const result = await client.from('secure_items').select(SECURE_ITEM_SUMMARY_COLUMNS)
        .eq('workspace_id', workspaceId).is('deleted_at', null).order('updated_at', { ascending: false }) as Result;
      const data = dataOrThrow(result);
      return (Array.isArray(data) ? data : []).map(secureItemSummaryFromRow);
    },

    async createSecureItem(workspaceId, input, actorUserId) {
      const result = await createActorClient(actorUserId).from('secure_items')
        .insert({ workspace_id: workspaceId, ...databaseInput(input) })
        .select(SECURE_ITEM_SUMMARY_COLUMNS).single() as Result;
      return secureItemSummaryFromRow(dataOrThrow(result));
    },

    async updateSecureItem(workspaceId, id, input, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).from('secure_items').update(databasePatch(input))
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).is('deleted_at', null)
        .select(SECURE_ITEM_SUMMARY_COLUMNS).maybeSingle() as Result;
      const data = dataOrThrow(result);
      return data ? secureItemSummaryFromRow(data) : conflictOrMissing(workspaceId, id, expectedVersion);
    },

    async deleteSecureItem(workspaceId, id, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).rpc('set_secure_item_deleted', {
        p_workspace_id: workspaceId, p_secure_item_id: id, p_expected_version: expectedVersion,
      }) as Result;
      if (isDatabaseVersionConflict(result.error) || result.error?.message === 'secure_item_not_found') {
        return conflictOrMissing(workspaceId, id, expectedVersion);
      }
      const data = dataOrThrow(result);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new SecureItemNotFoundError();
      return secureItemSummaryFromRow(row);
    },

    async restoreSecureItem(workspaceId, id, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).rpc('restore_secure_item_record', {
        p_workspace_id: workspaceId,
        p_secure_item_id: id,
        p_expected_version: expectedVersion,
      }) as Result;
      if (isDatabaseVersionConflict(result.error)) return conflictOrMissing(workspaceId, id, expectedVersion);
      throwKnownRestoreDatabaseError(result.error, 'secure_item_not_found');
      const data = dataOrThrow(result);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new SecureItemNotFoundError();
      return secureItemSummaryFromRow(row);
    },

    async revealSecureItem(workspaceId, id) {
      const result = await client.from('secure_items').select('external_url')
        .eq('workspace_id', workspaceId).eq('id', id).is('deleted_at', null).maybeSingle() as Result;
      const data = dataOrThrow(result) as { external_url?: unknown } | null;
      if (!data || typeof data.external_url !== 'string') throw new SecureItemNotFoundError();
      if (!isAllowedBitwardenUrl(data.external_url, selfHostedOrigins)) throw new SecureItemUrlNotAllowedError();
      return { externalUrl: data.external_url };
    },
  };
}

export function createDefaultSecureItemRouteDependencies(): SecureItemRouteDependencies {
  const environment = requireProductionEnvironment();
  const client = createServiceSupabaseClient(environment);
  const accessStore = createSupabaseAccessStore(client);
  return {
    appOrigin: environment.appOrigin,
    store: createSupabaseSecureItemStore(
      client,
      (actorUserId) => createServiceSupabaseClient(environment, { 'x-smoking-zen-actor': actorUserId }),
      environment.bitwardenSelfHostedOrigins,
    ),
    requestId: () => crypto.randomUUID(),
    selfHostedOrigins: environment.bitwardenSelfHostedOrigins,
    async authenticate(request) {
      const identity = await readSession(readSessionCookie(request), { secret: environment.sessionSecret });
      if (!identity) return null;
      const membership = await accessStore.getActiveMembership(identity.userId, identity.workspaceId);
      if (!membership?.active || membership.membershipId !== identity.membershipId) return null;
      return { userId: identity.userId, workspaceId: identity.workspaceId, membershipId: identity.membershipId };
    },
  };
}
