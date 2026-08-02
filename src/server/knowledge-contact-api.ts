import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { assertRestorableRecord, ConflictError } from '@/data/workspace-repository';
import {
  contactInputSchema,
  knowledgeInputSchema,
  mergeKnowledgePatch,
  type ContactInput,
  type ContactPatchInput,
  type KnowledgeInput,
  type KnowledgePatchInput,
} from '@/domain/schemas';
import type { Contact, ContactMethod, KnowledgeItem, RecordMetadata, SearchResult } from '@/domain/types';
import { requireProductionEnvironment } from '@/server/env';
import { readSessionCookie } from '@/server/http';
import { isDatabaseVersionConflict, throwKnownRestoreDatabaseError } from '@/server/restore';
import { readSession } from '@/server/session';
import { createServiceSupabaseClient, createSupabaseAccessStore } from '@/server/supabase';
import type { TaskSessionActor } from '@/server/task-api';

type DataResult = { data: unknown; error: { code?: string; message?: string } | null };

export interface KnowledgeContactApiStore {
  createKnowledge(workspaceId: string, input: KnowledgeInput, actorUserId: string): Promise<KnowledgeItem>;
  updateKnowledge(workspaceId: string, id: string, input: KnowledgePatchInput, expectedVersion: number, actorUserId: string): Promise<KnowledgeItem>;
  deleteKnowledge(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<KnowledgeItem>;
  restoreKnowledge(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<KnowledgeItem>;
  createContact(workspaceId: string, input: ContactInput, actorUserId: string): Promise<Contact>;
  updateContact(workspaceId: string, id: string, input: ContactPatchInput, expectedVersion: number, actorUserId: string): Promise<Contact>;
  deleteContact(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<Contact>;
  restoreContact(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<Contact>;
  search(workspaceId: string, query: string): Promise<SearchResult[]>;
}

export type KnowledgeContactRouteDependencies = {
  appOrigin: string;
  store: KnowledgeContactApiStore;
  authenticate: (request: Request) => Promise<TaskSessionActor | null>;
  requestId: () => string;
};

function assertResult(result: DataResult): unknown {
  if (result.error) throw new Error('Database operation failed.');
  return result.data;
}

function metadata(row: Record<string, unknown>): RecordMetadata {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

function knowledgeFromRow(value: unknown): KnowledgeItem {
  const row = value as Record<string, unknown>;
  return {
    ...metadata(row), title: String(row.title), body: String(row.body ?? ''),
    kind: row.kind as KnowledgeItem['kind'], linkUrl: row.link_url === null ? null : String(row.link_url),
    sectionId: row.section_id === null ? null : String(row.section_id), attachments: [],
  };
}

function contactMethodFromRow(value: unknown): ContactMethod {
  const row = value as Record<string, unknown>;
  return { kind: row.kind as ContactMethod['kind'], value: String(row.value) };
}

function contactFromRow(value: unknown, methods: ContactMethod[]): Contact {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.name), category: row.category as Contact['category'], notes: String(row.notes ?? ''), methods };
}

function isVersionConflict(result: DataResult): boolean {
  return isDatabaseVersionConflict(result.error);
}

function methodsPayload(input: ContactInput): Record<string, unknown>[] {
  return input.methods.map((method) => ({ kind: method.kind, value: method.value }));
}

export function createSupabaseKnowledgeContactStore(
  client: SupabaseClient,
  createActorClient: (actorUserId: string) => SupabaseClient = () => client,
): KnowledgeContactApiStore {
  const currentKnowledge = async (workspaceId: string, id: string) => {
    const result = await client.from('knowledge_items').select('*').eq('workspace_id', workspaceId).eq('id', id).maybeSingle() as DataResult;
    return assertResult(result) as Record<string, unknown> | null;
  };
  const currentContact = async (workspaceId: string, id: string) => {
    const result = await client.from('contacts').select('*').eq('workspace_id', workspaceId).eq('id', id).maybeSingle() as DataResult;
    return assertResult(result) as Record<string, unknown> | null;
  };
  const contactMethods = async (workspaceId: string, contactId: string) => {
    const result = await client.from('contact_methods').select('*').eq('workspace_id', workspaceId).eq('contact_id', contactId).is('deleted_at', null).order('position') as DataResult;
    return (assertResult(result) as unknown[]).map(contactMethodFromRow);
  };
  const conflictOrMissing = async (read: (workspaceId: string, id: string) => Promise<Record<string, unknown> | null>, workspaceId: string, id: string, expectedVersion: number): Promise<never> => {
    const current = await read(workspaceId, id);
    if (!current) throw new Error('Запись не найдена');
    throw new ConflictError(expectedVersion, Number(current.version));
  };
  const loadContact = async (workspaceId: string, id: string): Promise<Contact> => {
    const current = await currentContact(workspaceId, id);
    if (!current) throw new Error('Запись не найдена');
    return contactFromRow(current, await contactMethods(workspaceId, id));
  };

  return {
    async createKnowledge(workspaceId, input, actorUserId) {
      const item = knowledgeInputSchema.parse(input);
      const result = await createActorClient(actorUserId).from('knowledge_items').insert({
        workspace_id: workspaceId, title: item.title, body: item.body, kind: item.kind, link_url: item.linkUrl,
        section_id: item.sectionId,
      }).select('*').single() as DataResult;
      return knowledgeFromRow(assertResult(result));
    },
    async updateKnowledge(workspaceId, id, input, expectedVersion, actorUserId) {
      const current = await currentKnowledge(workspaceId, id);
      if (!current || current.deleted_at !== null) return conflictOrMissing(currentKnowledge, workspaceId, id, expectedVersion);
      if (Number(current.version) !== expectedVersion) throw new ConflictError(expectedVersion, Number(current.version));
      const merged = mergeKnowledgePatch({
        title: String(current.title), body: String(current.body ?? ''), kind: current.kind as KnowledgeItem['kind'],
        linkUrl: current.link_url === null ? null : String(current.link_url),
        sectionId: current.section_id === null ? null : String(current.section_id), attachments: [],
      }, input);
      const result = await createActorClient(actorUserId).from('knowledge_items').update({
        title: merged.title, body: merged.body, kind: merged.kind, link_url: merged.linkUrl, section_id: merged.sectionId,
      }).eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).is('deleted_at', null).select('*').maybeSingle() as DataResult;
      const data = assertResult(result);
      return data ? knowledgeFromRow(data) : conflictOrMissing(currentKnowledge, workspaceId, id, expectedVersion);
    },
    async deleteKnowledge(workspaceId, id, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).from('knowledge_items').update({ deleted_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).is('deleted_at', null).select('*').maybeSingle() as DataResult;
      const data = assertResult(result);
      return data ? knowledgeFromRow(data) : conflictOrMissing(currentKnowledge, workspaceId, id, expectedVersion);
    },
    async restoreKnowledge(workspaceId, id, expectedVersion, actorUserId) {
      const current = await currentKnowledge(workspaceId, id);
      assertRestorableRecord(current ? {
        version: Number(current.version),
        deletedAt: current.deleted_at === null ? null : String(current.deleted_at),
      } : null, expectedVersion);
      const result = await createActorClient(actorUserId).rpc('restore_knowledge_record', {
        p_workspace_id: workspaceId, p_knowledge_id: id, p_expected_version: expectedVersion,
      }) as DataResult;
      if (isDatabaseVersionConflict(result.error)) return conflictOrMissing(currentKnowledge, workspaceId, id, expectedVersion);
      throwKnownRestoreDatabaseError(result.error, 'knowledge_not_found');
      const rows = assertResult(result) as unknown[];
      const row = rows[0];
      if (row) return knowledgeFromRow(row);
      const latest = await currentKnowledge(workspaceId, id);
      assertRestorableRecord(latest ? {
        version: Number(latest.version),
        deletedAt: latest.deleted_at === null ? null : String(latest.deleted_at),
      } : null, expectedVersion);
      throw new Error('Не удалось восстановить запись.');
    },
    async createContact(workspaceId, input, actorUserId) {
      const contact = contactInputSchema.parse(input);
      const result = await createActorClient(actorUserId).rpc('create_contact_with_methods', {
        p_workspace_id: workspaceId, p_name: contact.name, p_category: contact.category, p_notes: contact.notes, p_methods: methodsPayload(contact),
      }) as DataResult;
      const rows = assertResult(result) as unknown[];
      const row = rows[0];
      if (!row) throw new Error('Не удалось создать контакт');
      return loadContact(workspaceId, String((row as Record<string, unknown>).id));
    },
    async updateContact(workspaceId, id, input, expectedVersion, actorUserId) {
      const current = await loadContact(workspaceId, id);
      if (current.deletedAt !== null) return conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
      if (current.version !== expectedVersion) throw new ConflictError(expectedVersion, current.version);
      const merged = contactInputSchema.parse({ name: current.name, category: current.category, notes: current.notes, methods: current.methods, ...input });
      const result = await createActorClient(actorUserId).rpc('replace_contact_with_methods', {
        p_workspace_id: workspaceId, p_contact_id: id, p_expected_version: expectedVersion,
        p_name: merged.name, p_category: merged.category, p_notes: merged.notes, p_methods: methodsPayload(merged),
      }) as DataResult;
      if (isVersionConflict(result)) return conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
      const rows = assertResult(result) as unknown[];
      const row = rows[0];
      if (!row) return conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
      return loadContact(workspaceId, String((row as Record<string, unknown>).id));
    },
    async deleteContact(workspaceId, id, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).rpc('set_contact_deleted', {
        p_workspace_id: workspaceId, p_contact_id: id, p_expected_version: expectedVersion, p_restore: false,
      }) as DataResult;
      if (isVersionConflict(result)) return conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
      const rows = assertResult(result) as unknown[];
      const row = rows[0];
      return row ? contactFromRow(row, []) : conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
    },
    async restoreContact(workspaceId, id, expectedVersion, actorUserId) {
      const current = await currentContact(workspaceId, id);
      assertRestorableRecord(current ? {
        version: Number(current.version),
        deletedAt: current.deleted_at === null ? null : String(current.deleted_at),
      } : null, expectedVersion);
      const result = await createActorClient(actorUserId).rpc('set_contact_deleted', {
        p_workspace_id: workspaceId, p_contact_id: id, p_expected_version: expectedVersion, p_restore: true,
      }) as DataResult;
      if (isVersionConflict(result)) return conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
      throwKnownRestoreDatabaseError(result.error, 'contact_not_found');
      const rows = assertResult(result) as unknown[];
      const row = rows[0];
      if (!row) return conflictOrMissing(currentContact, workspaceId, id, expectedVersion);
      return loadContact(workspaceId, String((row as Record<string, unknown>).id));
    },
    async search(workspaceId, query) {
      const result = await client.rpc('search_workspace', { p_workspace_id: workspaceId, p_query: query.trim(), p_limit: 20 }) as DataResult;
      return (assertResult(result) as unknown[]).flatMap((row) => {
        const candidate = row as Record<string, unknown>;
        return (candidate.entity === 'task' || candidate.entity === 'knowledge' || candidate.entity === 'contact') &&
          typeof candidate.id === 'string' && typeof candidate.title === 'string'
          ? [{ entity: candidate.entity, id: candidate.id, title: candidate.title }]
          : [];
      });
    },
  };
}

export function createDefaultKnowledgeContactRouteDependencies(): KnowledgeContactRouteDependencies {
  const environment = requireProductionEnvironment();
  const client = createServiceSupabaseClient(environment);
  const accessStore = createSupabaseAccessStore(client);
  return {
    appOrigin: environment.appOrigin,
    store: createSupabaseKnowledgeContactStore(client, (actorUserId) => createServiceSupabaseClient(environment, { 'x-smoking-zen-actor': actorUserId })),
    requestId: () => crypto.randomUUID(),
    async authenticate(request) {
      const identity = await readSession(readSessionCookie(request), { secret: environment.sessionSecret });
      if (!identity) return null;
      const membership = await accessStore.getActiveMembership(identity.userId, identity.workspaceId);
      if (!membership?.active || membership.membershipId !== identity.membershipId) return null;
      return { userId: identity.userId, workspaceId: identity.workspaceId, membershipId: identity.membershipId };
    },
  };
}
