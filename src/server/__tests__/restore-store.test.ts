// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  ConflictError,
  RestoreExpiredError,
  RestoreNotDeletedError,
  RestoreNotFoundError,
} from '@/data/workspace-repository';
import { createSupabaseKnowledgeContactStore } from '@/server/knowledge-contact-api';
import { createSupabaseTaskStore } from '@/server/task-api';

type RestoreState = 'missing' | 'not-deleted' | 'expired' | 'stale' | 'deleted';

function clientFor(table: string, state: RestoreState): SupabaseClient {
  const row = state === 'missing'
    ? null
    : {
        id: 'record-1',
        workspace_id: 'workspace-1',
        version: state === 'stale' ? 3 : 2,
        deleted_at: state === 'not-deleted' ? null : state === 'expired' ? '2000-01-01T00:00:00.000Z' : new Date().toISOString(),
      };
  const from = vi.fn((selectedTable: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: selectedTable === table ? row : null, error: null })),
    };
    return chain;
  });
  return {
    from,
    rpc: vi.fn(async () => ({ data: [], error: null })),
  } as unknown as SupabaseClient;
}

describe('Supabase restore stores', () => {
  it.each([
    { state: 'missing' as const, error: RestoreNotFoundError },
    { state: 'not-deleted' as const, error: RestoreNotDeletedError },
    { state: 'expired' as const, error: RestoreExpiredError },
    { state: 'stale' as const, error: ConflictError },
  ])('classifies $state before restoring task, knowledge, and contact records', async ({ state, error }) => {
    const taskClient = clientFor('tasks', state);
    const knowledgeClient = clientFor('knowledge_items', state);
    const contactClient = clientFor('contacts', state);
    const taskActor = vi.fn(() => taskClient);
    const knowledgeActor = vi.fn(() => knowledgeClient);
    const contactActor = vi.fn(() => contactClient);

    await expect(createSupabaseTaskStore(taskClient, taskActor).restoreTask('workspace-1', 'record-1', 2, 'actor-1'))
      .rejects.toBeInstanceOf(error);
    await expect(createSupabaseKnowledgeContactStore(knowledgeClient, knowledgeActor).restoreKnowledge('workspace-1', 'record-1', 2, 'actor-1'))
      .rejects.toBeInstanceOf(error);
    await expect(createSupabaseKnowledgeContactStore(contactClient, contactActor).restoreContact('workspace-1', 'record-1', 2, 'actor-1'))
      .rejects.toBeInstanceOf(error);
    expect(taskActor).not.toHaveBeenCalled();
    expect(knowledgeActor).not.toHaveBeenCalled();
    expect(contactActor).not.toHaveBeenCalled();
  });

  it.each([
    { databaseError: { code: 'P0002', message: 'contact_not_found' }, error: RestoreNotFoundError },
    { databaseError: { code: '55000', message: 'restore_not_deleted' }, error: RestoreNotDeletedError },
    { databaseError: { code: '22023', message: 'restore_expired' }, error: RestoreExpiredError },
    { databaseError: { code: '40001', message: 'version_conflict' }, error: ConflictError },
  ])('maps contact RPC error $databaseError.message after a valid restore preflight', async ({ databaseError, error }) => {
    const readClient = clientFor('contacts', 'deleted');
    const actorClient = {
      rpc: vi.fn(async () => ({ data: null, error: databaseError })),
    } as unknown as SupabaseClient;
    const createActorClient = vi.fn(() => actorClient);

    await expect(createSupabaseKnowledgeContactStore(readClient, createActorClient)
      .restoreContact('workspace-1', 'record-1', 2, 'actor-1')).rejects.toBeInstanceOf(error);
    expect(createActorClient).toHaveBeenCalledWith('actor-1');
  });

  it('does not translate an unrelated P0002 contact failure into a recovery status', async () => {
    const readClient = clientFor('contacts', 'deleted');
    const actorClient = {
      rpc: vi.fn(async () => ({ data: null, error: { code: 'P0002', message: 'unrelated_lookup_failed' } })),
    } as unknown as SupabaseClient;

    await expect(createSupabaseKnowledgeContactStore(readClient, () => actorClient)
      .restoreContact('workspace-1', 'record-1', 2, 'actor-1')).rejects.toThrow('Database operation failed.');
  });

  it('uses the atomic task and knowledge RPCs and maps their exact recovery errors', async () => {
    const entities = [
      { table: 'tasks', notFound: 'task_not_found', rpc: 'restore_task_record' },
      { table: 'knowledge_items', notFound: 'knowledge_not_found', rpc: 'restore_knowledge_record' },
    ] as const;
    const failures = [
      { code: 'P0002', message: 'not_found', error: RestoreNotFoundError },
      { code: '55000', message: 'restore_not_deleted', error: RestoreNotDeletedError },
      { code: '22023', message: 'restore_expired', error: RestoreExpiredError },
      { code: '40001', message: 'version_conflict', error: ConflictError },
    ] as const;

    for (const entity of entities) {
      for (const failure of failures) {
        const readClient = clientFor(entity.table, 'deleted');
        const databaseError = {
          code: failure.code,
          message: failure.message === 'not_found' ? entity.notFound : failure.message,
        };
        const actorClient = {
          rpc: vi.fn(async () => ({ data: null, error: databaseError })),
        } as unknown as SupabaseClient;
        const restore = entity.table === 'tasks'
          ? createSupabaseTaskStore(readClient, () => actorClient)
              .restoreTask('workspace-1', 'record-1', 2, 'actor-1')
          : createSupabaseKnowledgeContactStore(readClient, () => actorClient)
              .restoreKnowledge('workspace-1', 'record-1', 2, 'actor-1');

        await expect(restore).rejects.toBeInstanceOf(failure.error);
        expect(actorClient.rpc).toHaveBeenCalledWith(entity.rpc, expect.any(Object));
      }
    }
  });
});
