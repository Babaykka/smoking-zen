// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  safeSafeTextFixtures,
  safeSafeUrlFixtures,
  unsafeSafeTextFixtures,
  unsafeSafeUrlFixtures,
} from '@/domain/__tests__/safe-content-fixtures';

const MIGRATION_0013 = 'supabase/migrations/0013_task6_quarantine_tombstones_safe_parity.sql';
const MIGRATION_0014 = 'supabase/migrations/0014_task6_explicit_cleanup_success_safe_url.sql';

const MIGRATIONS = [
  'supabase/migrations/0001_workspace_schema.sql',
  'supabase/migrations/0002_rls_storage_realtime.sql',
  'supabase/migrations/0003_task_realtime_actor.sql',
  'supabase/migrations/0004_realtime_scope_lockdown.sql',
  'supabase/migrations/0005_audit_immutability.sql',
  'supabase/migrations/0006_knowledge_contacts_search.sql',
  'supabase/migrations/0007_task5_integrity.sql',
  'supabase/migrations/0008_task5_taxonomy_recovery.sql',
  'supabase/migrations/0009_private_files_secure_items.sql',
  'supabase/migrations/0010_task6_ambiguous_file_cleanup.sql',
  'supabase/migrations/0011_task6_late_cleanup_safe_convergence.sql',
  'supabase/migrations/0012_task6_cleanup_retirement_canonical_safe.sql',
  MIGRATION_0013,
  MIGRATION_0014,
];

const databases: PGlite[] = [];

async function applyMigration(database: PGlite, filename: string) {
  const migration = (await readFile(filename, 'utf8'))
    .replace('create extension if not exists pgcrypto with schema extensions;', '');
  await database.exec(migration);
}

async function createDatabase(migrations: readonly string[] = MIGRATIONS, reapplyLast = true) {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    create schema extensions;
    create function extensions.gen_random_uuid()
      returns uuid language sql volatile set search_path = '' as 'select gen_random_uuid()';
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid()
      returns uuid language sql stable set search_path = ''
      as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    create function auth.jwt()
      returns jsonb language sql stable set search_path = ''
      as 'select coalesce(nullif(current_setting(''request.jwt.claims'', true), ''''), ''{}'')::jsonb';
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false, file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default extensions.gen_random_uuid(), bucket_id text, name text
    );
    create schema realtime;
    create table realtime.messages (
      id uuid primary key default extensions.gen_random_uuid(), extension text, topic text, event text, payload jsonb
    );
    create function realtime.send(payload jsonb, event text, topic text, private boolean)
      returns void language sql volatile set search_path = '' as
      'insert into realtime.messages (extension, topic, event, payload) values (''broadcast'', topic, event, payload)';
    create function realtime.topic()
      returns text language sql stable set search_path = ''
      as 'select nullif(current_setting(''realtime.topic'', true), '''')::text';
    grant usage on schema public, storage, realtime to anon, authenticated, service_role;
    grant all privileges on storage.objects to anon, authenticated, service_role;
    grant all privileges on realtime.messages to anon, authenticated, service_role;
    alter default privileges in schema public grant all privileges on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all privileges on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);

  for (const filename of migrations) await applyMigration(database, filename);
  if (reapplyLast) await applyMigration(database, migrations.at(-1)!);
  return database;
}

async function bootstrapOwner(database: PGlite) {
  const result = await database.query<{
    user_id: string;
    membership_id: string;
    workspace_id: string;
  }>(`select * from public.bootstrap_telegram_user(
    '4503599627370495', 'Владелец', null, 'owner_files', 'ru', '4503599627370495', 'Smoking Zen files'
  )`);
  return result.rows[0]!;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('private file and secure-item schema runtime', () => {
  it('persists only the fixed safe summary fields and the separately selected reveal URL', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    await database.query(`
      insert into public.secure_items (
        workspace_id, title, purpose, owner, review_date,
        card_bank, card_holder, card_purpose, last_four, external_url
      ) values ($1, 'Терминал', 'Оплата поставщикам', 'Управляющий', '2026-12-01',
        'Банк', 'Участник Дельта', 'Закупки', '4242', 'https://vault.bitwarden.eu/#/vault/item-safe-example')
    `, [owner.workspace_id]);

    const columns = await database.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'secure_items'
      order by ordinal_position
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      'id', 'workspace_id', 'title', 'external_url', 'version', 'created_at', 'updated_at', 'deleted_at',
      'purpose', 'owner', 'review_date', 'card_bank', 'card_holder', 'card_purpose', 'last_four',
    ]);
    const summary = await database.query(`
      select title, purpose, owner, review_date::text, card_bank, card_holder, card_purpose, last_four
      from public.secure_items where workspace_id = $1
    `, [owner.workspace_id]);
    expect(summary.rows).toEqual([{
      title: 'Терминал', purpose: 'Оплата поставщикам', owner: 'Управляющий', review_date: '2026-12-01',
      card_bank: 'Банк', card_holder: 'Участник Дельта', card_purpose: 'Закупки', last_four: '4242',
    }]);
  });

  it.each([
    ['last four', "'Терминал', 'Назначение', 'Владелец', '123', 'https://vault.bitwarden.com/#/item'"],
    ['insecure URL', "'Терминал', 'Назначение', 'Владелец', '4242', 'http://vault.bitwarden.com/#/item'"],
    ['URL credentials', "'Терминал', 'Назначение', 'Владелец', '4242', 'https://user:pass@vault.bitwarden.com/#/item'"],
    ['full PAN', "'Терминал', 'Карта 4111 1111 1111 1111', 'Владелец', '4242', 'https://vault.bitwarden.com/#/item'"],
  ])('rejects unsafe fixed secure-item data: %s', async (_label, values) => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    await expect(database.query(`
      insert into public.secure_items (workspace_id, title, purpose, owner, last_four, external_url)
      values ($1, ${values})
    `, [owner.workspace_id])).rejects.toThrow();
  });

  it('restores Safe metadata before, but not at, the 30-day database deadline', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const inserted = await database.query<{ id: string }>(`
      insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
      values ($1, 'Касса', 'Операции', 'Управляющий', 'https://vault.bitwarden.com/#/items/restore')
      returning id
    `, [owner.workspace_id]);
    await database.query(`
      update public.secure_items set deleted_at = clock_timestamp() - interval '29 days'
      where id = $1
    `, [inserted.rows[0]!.id]);
    const deleted = await database.query<{ version: number }>(
      'select version from public.secure_items where id = $1', [inserted.rows[0]!.id],
    );

    const restored = await database.query<{ deleted_at: Date | null }>(`
      select deleted_at from public.restore_secure_item_record($1, $2, $3)
    `, [owner.workspace_id, inserted.rows[0]!.id, deleted.rows[0]!.version]);
    expect(restored.rows).toEqual([{ deleted_at: null }]);

    await database.query(`
      update public.secure_items set deleted_at = clock_timestamp() - interval '30 days'
      where id = $1
    `, [inserted.rows[0]!.id]);
    const expired = await database.query<{ version: number }>(
      'select version from public.secure_items where id = $1', [inserted.rows[0]!.id],
    );
    await expect(database.query(`select * from public.restore_secure_item_record($1, $2, $3)`, [
      owner.workspace_id, inserted.rows[0]!.id, expired.rows[0]!.version,
    ])).rejects.toThrow(/restore_expired/iu);
  });

  it('enforces quarantine metadata and permits only a complete ready transition', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'",
      [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Документы смены', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000001';
    const quarantinePath = '10000000-0000-4000-8000-000000000001';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'policy.pdf', 'application/pdf', 64, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);

    await expect(database.query(`
      update public.attachments set state = 'ready', quarantine_expires_at = null where id = $1
    `, [attachmentId])).rejects.toThrow();

    const readyPath = attachmentId;
    await database.query('select public.arm_attachment_ready_cleanup($1, $2, $3)', [
      owner.workspace_id, attachmentId, readyPath,
    ]);
    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'policy.pdf', 'application/pdf', 64, repeat('a', 64)
    )`, [owner.workspace_id, attachmentId, quarantinePath, readyPath]);
    const ready = await database.query<{ state: string; sha256: string; complete: boolean }>(`
      select state, sha256, completed_at is not null as complete from public.attachments where id = $1
    `, [attachmentId]);
    expect(ready.rows).toEqual([{ state: 'ready', sha256: 'a'.repeat(64), complete: true }]);
    const queued = await database.query<{ storage_path: string }>(`
      select storage_path from public.file_cleanup_queue where workspace_id = $1
    `, [owner.workspace_id]);
    expect(queued.rows).toEqual([{ storage_path: quarantinePath }]);
  });

  it('atomically refuses to publish quarantine bytes after the parent is soft-deleted', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'",
      [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Удалённый родитель', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000002';
    const quarantinePath = '10000000-0000-4000-8000-000000000002';
    const readyPath = attachmentId;
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'policy.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);
    await database.query('select public.arm_attachment_ready_cleanup($1, $2, $3)', [
      owner.workspace_id, attachmentId, readyPath,
    ]);
    await database.query('update public.tasks set deleted_at = clock_timestamp() where id = $1', [task.rows[0]!.id]);

    await expect(database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'policy.txt', 'text/plain', 16, repeat('b', 64)
    )`, [owner.workspace_id, attachmentId, quarantinePath, readyPath])).rejects.toThrow();
    const state = await database.query<{ state: string }>('select state from public.attachments where id = $1', [attachmentId]);
    expect(state.rows).toEqual([{ state: 'quarantine' }]);
  });

  it('authoritatively defers or discards cleanup for an opaque ready object that can become or is live', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'",
      [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Неоднозначное завершение', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000003';
    const quarantineObject = '10000000-0000-4000-8000-000000000003';
    const readyObject = attachmentId;
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'policy.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantineObject, owner.user_id]);
    const queued = await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (workspace_id, attachment_id, storage_path, remove_after)
      values ($1, $2, $3, clock_timestamp()) returning id
    `, [owner.workspace_id, attachmentId, readyObject]);

    const deferred = await database.query<{ lease_id: string | null }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [queued.rows[0]!.id],
    );
    expect(deferred.rows).toEqual([{ lease_id: null }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [queued.rows[0]!.id],
    )).rows).toEqual([{ count: 1 }]);

    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'policy.txt', 'text/plain', 16, repeat('c', 64)
    )`, [owner.workspace_id, attachmentId, quarantineObject, readyObject]);
    const staleQueue = await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (workspace_id, attachment_id, storage_path, remove_after)
      values ($1, $2, $3, clock_timestamp())
      on conflict (workspace_id, storage_path) do update set remove_after = excluded.remove_after
      returning id
    `, [owner.workspace_id, attachmentId, readyObject]);

    const referenced = await database.query<{ lease_id: string | null }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [staleQueue.rows[0]!.id],
    );
    expect(referenced.rows).toEqual([{ lease_id: null }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [staleQueue.rows[0]!.id],
    )).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{
      state: string; storage_path: string; quarantine_cleanup_completed_at: string | null;
    }>(`
      select state, storage_path, quarantine_cleanup_completed_at::text
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{
      state: 'ready',
      storage_path: readyObject,
      quarantine_cleanup_completed_at: null,
    }]);
  });

  it('lets completion publish first and atomically cancel its unleased late-commit guard', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Completion first', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000006';
    const quarantinePath = '10000000-0000-4000-8000-000000000006';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'first.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);
    const signedWindow = await database.query<{ expires_at: string }>(
      'select quarantine_expires_at::text as expires_at from public.attachments where id = $1', [attachmentId],
    );

    const armed = await database.query<{ queue_id: string }>(
      'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
      [owner.workspace_id, attachmentId, attachmentId],
    );
    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'first.txt', 'text/plain', 16, repeat('d', 64)
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId]);
    expect((await database.query<{ delayed_until_token_expiry: boolean; retained_for_24h: boolean }>(`
      select
        cleanup.remove_after >= $3::timestamptz as delayed_until_token_expiry,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained_for_24h
      from public.file_cleanup_queue as cleanup
      join public.attachments as completed
        on completed.workspace_id = cleanup.workspace_id and completed.id = cleanup.attachment_id
      where cleanup.storage_path = $1 and completed.id = $2
    `, [quarantinePath, attachmentId, signedWindow.rows[0]!.expires_at])).rows).toEqual([{
      delayed_until_token_expiry: true,
      retained_for_24h: true,
    }]);

    const lease = await database.query<{ lease_id: string | null }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [armed.rows[0]!.queue_id],
    );
    expect(lease.rows).toEqual([{ lease_id: null }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [armed.rows[0]!.queue_id],
    )).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ state: string; quarantine_cleanup_completed_at: string | null }>(`
      select state, quarantine_cleanup_completed_at::text
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{
      state: 'ready',
      quarantine_cleanup_completed_at: null,
    }]);

    const oldQuarantineCleanup = await database.query<{ queue_id: string }>(`
      select id::text as queue_id from public.file_cleanup_queue
      where attachment_id = $1 and storage_path = $2
    `, [attachmentId, quarantinePath]);
    await database.query(`
      update public.file_cleanup_queue
      set remove_after = clock_timestamp() - interval '25 hours',
          retain_until = clock_timestamp() - interval '1 hour'
      where id = $1
    `, [oldQuarantineCleanup.rows[0]!.queue_id]);
    const firstOldPathLease = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id',
      [oldQuarantineCleanup.rows[0]!.queue_id],
    );
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [oldQuarantineCleanup.rows[0]!.queue_id, firstOldPathLease.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: false }]);
    await database.query(`
      update public.file_cleanup_queue
      set first_remove_succeeded_at = clock_timestamp() - interval '25 hours',
          remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second'
      where id = $1
    `, [oldQuarantineCleanup.rows[0]!.queue_id]);
    const secondOldPathLease = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id',
      [oldQuarantineCleanup.rows[0]!.queue_id],
    );
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [oldQuarantineCleanup.rows[0]!.queue_id, secondOldPathLease.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: true }]);
    expect((await database.query<{ quarantine_cleanup_completed_at: string | null }>(`
      select quarantine_cleanup_completed_at::text
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ quarantine_cleanup_completed_at: null }]);
    await expect(database.query(`
      update public.attachments
      set quarantine_cleanup_completed_at = clock_timestamp()
      where id = $1
    `, [attachmentId])).rejects.toThrow(/attachments_quarantine_cleanup_completed_check/iu);
  });

  it('blocks completion after cleanup prepare commits and re-arms the token-matched tombstone after remove', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Prepare first', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000007';
    const quarantinePath = '10000000-0000-4000-8000-000000000007';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'second.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);

    const armed = await database.query<{ queue_id: string }>(
      'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
      [owner.workspace_id, attachmentId, attachmentId],
    );
    await database.query(`
      update public.attachments
      set quarantine_expires_at = clock_timestamp() - interval '1 second'
      where id = $1
    `, [attachmentId]);
    await database.query('update public.file_cleanup_queue set remove_after = clock_timestamp() where id = $1', [armed.rows[0]!.queue_id]);
    const prepared = await database.query<{ lease_id: string | null }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [armed.rows[0]!.queue_id],
    );
    expect(prepared.rows[0]!.lease_id).toMatch(/^[0-9a-f-]{36}$/u);

    await expect(database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'second.txt', 'text/plain', 16, repeat('e', 64)
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId])).rejects.toThrow(/attachment_cleanup_in_progress/iu);
    const wrongToken = await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
    );
    expect(wrongToken.rows).toEqual([{ removed: false }]);
    expect((await database.query<{ lease_id: string | null }>(
      'select lease_id::text from public.file_cleanup_queue where id = $1', [armed.rows[0]!.queue_id],
    )).rows).toEqual([{ lease_id: prepared.rows[0]!.lease_id }]);
    const finished = await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, prepared.rows[0]!.lease_id],
    );

    expect(finished.rows).toEqual([{ removed: false }]);
    expect((await database.query<{ state: string }>(
      'select state from public.attachments where id = $1', [attachmentId],
    )).rows).toEqual([{ state: 'quarantine' }]);
    const guard = await database.query<{ lease_id: string | null; delayed: boolean }>(`
      select lease_id::text, remove_after = retain_until and retain_until > clock_timestamp() as delayed
      from public.file_cleanup_queue where id = $1
    `, [armed.rows[0]!.queue_id]);
    expect(guard.rows).toEqual([{ lease_id: null, delayed: true }]);
  });

  it('does not count a crashed or stale lease and rearms a delayed first success before a separate second removal', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Stale cleanup finish', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000009';
    const quarantinePath = '10000000-0000-4000-8000-000000000009';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'stale.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);
    await expect(database.query(`
      update public.attachments
      set quarantine_cleanup_completed_at = clock_timestamp()
      where id = $1
    `, [attachmentId])).rejects.toThrow(/attachments_quarantine_cleanup_completed_check/iu);
    const armed = await database.query<{ queue_id: string }>(
      'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
      [owner.workspace_id, attachmentId, attachmentId],
    );
    await database.query(`
      update public.attachments
      set quarantine_expires_at = clock_timestamp() - interval '25 hours'
      where id = $1
    `, [attachmentId]);
    await database.query(`
      update public.file_cleanup_queue
      set remove_after = clock_timestamp() - interval '25 hours',
          retain_until = clock_timestamp() - interval '1 hour'
      where id = $1
    `, [armed.rows[0]!.queue_id]);

    const first = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [armed.rows[0]!.queue_id],
    );
    await database.query(`
      update public.file_cleanup_queue
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where id = $1
    `, [armed.rows[0]!.queue_id]);
    const beforeStaleFinish = await database.query<{
      id: string; lease_id: string; remove_after: string; retain_until: string;
      first_remove_succeeded_at: string | null;
    }>(`
      select id::text, lease_id::text, remove_after::text, retain_until::text,
        first_remove_succeeded_at::text
      from public.file_cleanup_queue where id = $1
    `, [armed.rows[0]!.queue_id]);
    expect(beforeStaleFinish.rows[0]!.first_remove_succeeded_at).toBeNull();

    const stale = await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, first.rows[0]!.lease_id],
    );
    expect(stale.rows).toEqual([{ removed: false }]);
    expect((await database.query(`
      select id::text, lease_id::text, remove_after::text, retain_until::text,
        first_remove_succeeded_at::text
      from public.file_cleanup_queue where id = $1
    `, [armed.rows[0]!.queue_id])).rows).toEqual(beforeStaleFinish.rows);
    expect((await database.query<{ quarantine_cleanup_completed_at: string | null }>(`
      select quarantine_cleanup_completed_at::text
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ quarantine_cleanup_completed_at: null }]);

    const reclaimed = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [armed.rows[0]!.queue_id],
    );
    expect(reclaimed.rows[0]!.lease_id).not.toBe(first.rows[0]!.lease_id);
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, first.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: false }]);
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, reclaimed.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: false }]);
    expect((await database.query<{ quarantine_cleanup_completed_at: string | null }>(`
      select quarantine_cleanup_completed_at::text
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ quarantine_cleanup_completed_at: null }]);
    expect((await database.query<{ recorded: boolean; live_lease: boolean }>(`
      select first_remove_succeeded_at is not null as recorded,
        lease_id is not null as live_lease
      from public.file_cleanup_queue where id = $1
    `, [armed.rows[0]!.queue_id])).rows).toEqual([{ recorded: true, live_lease: false }]);
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, reclaimed.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: false }]);

    await database.query(`
      update public.file_cleanup_queue
      set first_remove_succeeded_at = clock_timestamp() - interval '25 hours',
          remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second'
      where id = $1
    `, [armed.rows[0]!.queue_id]);
    const second = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [armed.rows[0]!.queue_id],
    );
    expect(second.rows[0]!.lease_id).not.toBe(reclaimed.rows[0]!.lease_id);
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [armed.rows[0]!.queue_id, second.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: true }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [armed.rows[0]!.queue_id],
    )).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ quarantine_cleanup_completed_at: string | null }>(`
      select quarantine_cleanup_completed_at::text
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ quarantine_cleanup_completed_at: null }]);
  });

  it('refreshes every database-clock lifecycle verdict after its blocking row locks', async () => {
    const database = await createDatabase();
    for (const signature of [
      'private.ensure_quarantine_cleanup_guard(uuid,uuid,text,timestamp with time zone)',
      'public.arm_attachment_ready_cleanup(uuid,uuid,text)',
      'public.retire_quarantine_attachment(uuid,uuid,text,text)',
      'public.complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text)',
      'public.finish_file_cleanup_object(uuid,uuid)',
    ]) {
      const definition = (await database.query<{ definition: string }>(
        'select pg_get_functiondef($1::regprocedure) as definition', [signature],
      )).rows[0]!.definition.toLowerCase();
      expect(definition.lastIndexOf('for update')).toBeGreaterThan(-1);
      expect(definition.lastIndexOf('observed_at := clock_timestamp()'))
        .toBeGreaterThan(definition.lastIndexOf('for update'));
    }

    const finish = (await database.query<{ definition: string }>(`
      select pg_get_functiondef(
        'public.finish_file_cleanup_object(uuid,uuid)'::regprocedure
      ) as definition
    `)).rows[0]!.definition.toLowerCase();
    expect(finish.indexOf('lease_expires_at <= observed_at'))
      .toBeGreaterThan(finish.indexOf('observed_at := clock_timestamp()'));
  });

  it('returns one durable guard UUID when concurrent first-arm callers hit the insert conflict path', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Concurrent arm', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000010';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'arm.txt', 'text/plain', 16,
        '10000000-0000-4000-8000-000000000010', $4, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, owner.user_id]);

    await database.exec(`
      create or replace function private.inject_first_guard_conflict()
      returns trigger language plpgsql set search_path = '' as $$
      begin
        if current_setting('test.inject_first_guard_conflict', true) = 'on' then
          perform set_config('test.inject_first_guard_conflict', 'off', false);
          insert into public.file_cleanup_queue (
            id, workspace_id, attachment_id, storage_path, remove_after, retain_until
          ) values (
            '90000000-0000-4000-8000-000000000010', new.workspace_id,
            new.attachment_id, new.storage_path, new.remove_after, new.retain_until
          );
        end if;
        return new;
      end;
      $$;
      create trigger inject_first_guard_conflict
      before insert on public.file_cleanup_queue
      for each row execute function private.inject_first_guard_conflict();
      select set_config('test.inject_first_guard_conflict', 'on', false);
    `);

    const calls = await Promise.all([
      database.query<{ queue_id: string }>(
        'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
        [owner.workspace_id, attachmentId, attachmentId],
      ),
      database.query<{ queue_id: string }>(
        'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
        [owner.workspace_id, attachmentId, attachmentId],
      ),
    ]);

    expect(calls.map(({ rows }) => rows[0]!.queue_id)).toEqual([
      '90000000-0000-4000-8000-000000000010',
      '90000000-0000-4000-8000-000000000010',
    ]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where workspace_id = $1 and storage_path = $2
    `, [owner.workspace_id, attachmentId])).rows).toEqual([{ count: 1 }]);
  });

  it('returns no ready guard after the database quarantine expiry boundary', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Expired ready arm', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000017';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'expired-arm.txt', 'text/plain', 16,
        '10000000-0000-4000-8000-000000000017', $4, clock_timestamp() - interval '1 second')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, owner.user_id]);

    expect((await database.query<{ queue_id: string | null }>(
      'select public.arm_attachment_ready_cleanup($1, $2, $3)::text as queue_id',
      [owner.workspace_id, attachmentId, attachmentId],
    )).rows).toEqual([{ queue_id: null }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where storage_path = $1', [attachmentId],
    )).rows).toEqual([{ count: 0 }]);
  });

  it('rejects a global ready-path guard collision from another workspace without changing its scope', async () => {
    const database = await createDatabase();
    const first = await bootstrapOwner(database);
    const second = (await database.query<{ user_id: string; workspace_id: string }>(`select * from public.bootstrap_telegram_user(
      '4503599627370493', 'Collision owner', null, 'owner_collision', 'ru',
      '4503599627370493', 'Collision workspace'
    )`)).rows[0]!;
    const firstStatus = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [first.workspace_id],
    );
    const secondStatus = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [second.workspace_id],
    );
    const firstTask = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Guard owner', $2) returning id
    `, [first.workspace_id, firstStatus.rows[0]!.id]);
    const secondTask = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Guard collision', $2) returning id
    `, [second.workspace_id, secondStatus.rows[0]!.id]);
    const firstAttachmentId = 'a0000000-0000-4000-8000-000000000011';
    const secondAttachmentId = 'a0000000-0000-4000-8000-000000000012';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'owner.txt', 'text/plain', 16,
        '10000000-0000-4000-8000-000000000011', $4, clock_timestamp() + interval '15 minutes')
    `, [firstAttachmentId, first.workspace_id, firstTask.rows[0]!.id, first.user_id]);
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'collision.txt', 'text/plain', 16,
        '10000000-0000-4000-8000-000000000012', $4, clock_timestamp() + interval '15 minutes')
    `, [secondAttachmentId, second.workspace_id, secondTask.rows[0]!.id, second.user_id]);
    const original = await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (workspace_id, attachment_id, storage_path, remove_after)
      values ($1, $2, $3, clock_timestamp()) returning id
    `, [first.workspace_id, firstAttachmentId, secondAttachmentId]);

    await expect(database.query(
      'select public.arm_attachment_ready_cleanup($1, $2, $3)',
      [second.workspace_id, secondAttachmentId, secondAttachmentId],
    )).rejects.toThrow(/attachment_cleanup_guard_scope_conflict/iu);
    expect((await database.query<{ id: string; workspace_id: string; attachment_id: string }>(`
      select id::text, workspace_id::text, attachment_id::text
      from public.file_cleanup_queue where storage_path = $1
    `, [secondAttachmentId])).rows).toEqual([{
      id: original.rows[0]!.id,
      workspace_id: first.workspace_id,
      attachment_id: firstAttachmentId,
    }]);
  });

  it('soft-retires only same-workspace expired quarantines while retaining their late-ready guard', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const outsider = (await database.query<{ workspace_id: string }>(`select * from public.bootstrap_telegram_user(
      '4503599627370492', 'Retire outsider', null, 'owner_retire_outsider', 'ru',
      '4503599627370492', 'Retire outsider workspace'
    )`)).rows[0]!;
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Retire expiry', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const expiredId = 'a0000000-0000-4000-8000-000000000013';
    const unexpiredId = 'a0000000-0000-4000-8000-000000000014';
    const readyId = 'a0000000-0000-4000-8000-000000000015';
    const expiredPath = '10000000-0000-4000-8000-000000000013';
    const unexpiredPath = '10000000-0000-4000-8000-000000000014';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values
        ($1, $2, $3, 'expired.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes'),
        ($6, $2, $3, 'unexpired.txt', 'text/plain', 16, $7, $5, clock_timestamp() + interval '15 minutes')
    `, [expiredId, owner.workspace_id, task.rows[0]!.id, expiredPath, owner.user_id, unexpiredId, unexpiredPath]);
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, state,
        sha256, created_by, quarantine_expires_at, completed_at
      ) values ($1, $2, $3, 'ready.txt', 'text/plain', 16, $5, 'ready', repeat('f', 64), $4, null, clock_timestamp())
    `, [readyId, owner.workspace_id, task.rows[0]!.id, owner.user_id, readyId]);
    const guard = await database.query<{ queue_id: string }>(
      'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
      [owner.workspace_id, expiredId, expiredId],
    );
    await database.query(`
      update public.attachments set quarantine_expires_at = clock_timestamp() - interval '1 second'
      where id = $1
    `, [expiredId]);

    const retired = await database.query<{ retired: boolean }>(`
      select public.retire_expired_quarantine_attachment($1, $2, $3) as retired
    `, [owner.workspace_id, expiredId, expiredPath]);
    expect(retired.rows).toEqual([{ retired: true }]);
    expect((await database.query<{ retired: boolean }>(`
      select public.retire_expired_quarantine_attachment($1, $2, $3) as retired
    `, [owner.workspace_id, expiredId, expiredPath])).rows).toEqual([{ retired: true }]);
    expect((await database.query<{ deleted: boolean }>(
      'select deleted_at is not null as deleted from public.attachments where id = $1', [expiredId],
    )).rows).toEqual([{ deleted: true }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [guard.rows[0]!.queue_id],
    )).rows).toEqual([{ count: 1 }]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where workspace_id = $1 and attachment_id = $2 and storage_path = $3
    `, [owner.workspace_id, expiredId, expiredPath])).rows).toEqual([{ count: 1 }]);

    await expect(database.query(`
      select public.retire_expired_quarantine_attachment($1, $2, $3)
    `, [owner.workspace_id, unexpiredId, unexpiredPath])).rejects.toThrow(/attachment_retire_not_expired/iu);
    await expect(database.query(`
      select public.retire_expired_quarantine_attachment($1, $2, $3)
    `, [owner.workspace_id, readyId, readyId])).rejects.toThrow(/attachment_retire_invalid_state/iu);
    await expect(database.query(`
      select public.retire_expired_quarantine_attachment($1, $2, $3)
    `, [outsider.workspace_id, expiredId, expiredPath])).rejects.toThrow(/attachment_retire_not_found/iu);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where storage_path in ($1, $2)
    `, [unexpiredPath, readyId])).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ deleted: boolean }>(
      'select deleted_at is not null as deleted from public.attachments where id = $1', [readyId],
    )).rows).toEqual([{ deleted: false }]);
    expect((await database.query<{
      anon: boolean; auth: boolean; service: boolean;
    }>(`
      select
        has_function_privilege('anon', 'public.retire_expired_quarantine_attachment(uuid,uuid,text)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.retire_expired_quarantine_attachment(uuid,uuid,text)', 'execute') as auth,
        has_function_privilege('service_role', 'public.retire_expired_quarantine_attachment(uuid,uuid,text)', 'execute') as service
    `)).rows).toEqual([{ anon: false, auth: false, service: true }]);
  });

  it('authorizes reasoned quarantine retirement only through the service role and retains each signed path', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Reasoned retire', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const expiredId = 'a0000000-0000-4000-8000-000000000018';
    const parentId = 'a0000000-0000-4000-8000-000000000019';
    const invalidId = 'a0000000-0000-4000-8000-000000000020';
    const nullReasonId = 'a0000000-0000-4000-8000-000000000023';
    const expiredPath = '10000000-0000-4000-8000-000000000018';
    const parentPath = '10000000-0000-4000-8000-000000000019';
    const invalidPath = '10000000-0000-4000-8000-000000000020';
    const nullReasonPath = '10000000-0000-4000-8000-000000000023';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values
        ($1, $2, $3, 'expired.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes'),
        ($6, $2, $3, 'parent.txt', 'text/plain', 16, $7, $5, clock_timestamp() + interval '15 minutes'),
        ($8, $2, $3, 'invalid.txt', 'text/plain', 16, $9, $5, clock_timestamp() + interval '15 minutes'),
        ($10, $2, $3, 'null-reason.txt', 'text/plain', 16, $11, $5, clock_timestamp() + interval '15 minutes')
    `, [
      expiredId, owner.workspace_id, task.rows[0]!.id, expiredPath, owner.user_id,
      parentId, parentPath, invalidId, invalidPath, nullReasonId, nullReasonPath,
    ]);

    await expect(database.query(`
      select public.retire_quarantine_attachment($1, $2, $3, $4::text)
    `, [owner.workspace_id, nullReasonId, nullReasonPath, null])).rejects.toThrow(/attachment_retire_reason_invalid/iu);
    expect((await database.query<{ deleted: boolean; queued: boolean }>(`
      select attachment.deleted_at is not null as deleted,
        exists (
          select 1 from public.file_cleanup_queue as cleanup
          where cleanup.workspace_id = attachment.workspace_id
            and cleanup.attachment_id = attachment.id
            and cleanup.storage_path = attachment.storage_path
        ) as queued
      from public.attachments as attachment where attachment.id = $1
    `, [nullReasonId])).rows).toEqual([{ deleted: false, queued: false }]);

    expect((await database.query<{ retired: boolean }>(`
      select public.retire_quarantine_attachment($1, $2, $3, 'expired') as retired
    `, [owner.workspace_id, expiredId, expiredPath])).rows).toEqual([{ retired: false }]);
    await database.query('update public.tasks set deleted_at = clock_timestamp() where id = $1', [task.rows[0]!.id]);
    expect((await database.query<{ retired: boolean }>(`
      select public.retire_quarantine_attachment($1, $2, $3, 'parent_missing') as retired
    `, [owner.workspace_id, parentId, parentPath])).rows).toEqual([{ retired: true }]);
    expect((await database.query<{ retired: boolean }>(`
      select public.retire_quarantine_attachment($1, $2, $3, 'invalid_content') as retired
    `, [owner.workspace_id, invalidId, invalidPath])).rows).toEqual([{ retired: true }]);

    expect((await database.query<{ storage_path: string; delayed: boolean; retained: boolean }>(`
      select cleanup.storage_path,
        cleanup.remove_after >= attachment.quarantine_expires_at as delayed,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained
      from public.file_cleanup_queue as cleanup
      join public.attachments as attachment
        on attachment.workspace_id = cleanup.workspace_id and attachment.id = cleanup.attachment_id
      where cleanup.storage_path in ($1, $2)
      order by cleanup.storage_path
    `, [parentPath, invalidPath])).rows).toEqual([
      { storage_path: parentPath, delayed: true, retained: true },
      { storage_path: invalidPath, delayed: true, retained: true },
    ]);
    expect((await database.query<{ anon: boolean; auth: boolean; service: boolean }>(`
      select
        has_function_privilege('anon', 'public.retire_quarantine_attachment(uuid,uuid,text,text)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.retire_quarantine_attachment(uuid,uuid,text,text)', 'execute') as auth,
        has_function_privilege('service_role', 'public.retire_quarantine_attachment(uuid,uuid,text,text)', 'execute') as service
    `)).rows).toEqual([{ anon: false, auth: false, service: true }]);
  });

  it('retains an expired quarantine-path tombstone until a second remove catches an in-flight signed upload', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Late quarantine upload', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000016';
    const quarantinePath = '10000000-0000-4000-8000-000000000016';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'late-q.txt', 'text/plain', 16, $4, $5, clock_timestamp() - interval '1 second')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);

    // The provider accepted the signed upload before expiry, but its commit is still in flight.
    const storedObjects = new Set<string>([quarantinePath]);
    await database.query(
      'select public.retire_expired_quarantine_attachment($1, $2, $3)',
      [owner.workspace_id, attachmentId, quarantinePath],
    );
    const queue = await database.query<{ id: string }>(`
      select id::text from public.file_cleanup_queue where storage_path = $1
    `, [quarantinePath]);
    const firstLease = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [queue.rows[0]!.id],
    );
    storedObjects.delete(quarantinePath);
    const firstFinish = await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [queue.rows[0]!.id, firstLease.rows[0]!.lease_id],
    );

    expect(firstFinish.rows).toEqual([{ removed: false }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [queue.rows[0]!.id],
    )).rows).toEqual([{ count: 1 }]);

    const afterFirstSweep = await database.query<{
      first_remove_succeeded_at: string; remove_after: string; retain_until: string; anchored: boolean;
    }>(`
      select first_remove_succeeded_at::text, remove_after::text, retain_until::text,
        remove_after >= first_remove_succeeded_at + interval '24 hours'
          and retain_until >= first_remove_succeeded_at + interval '24 hours' as anchored
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id]);
    expect(afterFirstSweep.rows).toEqual([expect.objectContaining({ anchored: true })]);
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [queue.rows[0]!.id, firstLease.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: false }]);
    await database.query(
      'select public.retire_expired_quarantine_attachment($1, $2, $3)',
      [owner.workspace_id, attachmentId, quarantinePath],
    );
    expect((await database.query(`
      select first_remove_succeeded_at::text, remove_after::text, retain_until::text,
        remove_after >= first_remove_succeeded_at + interval '24 hours'
          and retain_until >= first_remove_succeeded_at + interval '24 hours' as anchored
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id])).rows).toEqual(afterFirstSweep.rows);
    await applyMigration(database, MIGRATION_0014);
    expect((await database.query(`
      select first_remove_succeeded_at::text, remove_after::text, retain_until::text,
        remove_after >= first_remove_succeeded_at + interval '24 hours'
          and retain_until >= first_remove_succeeded_at + interval '24 hours' as anchored
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id])).rows).toEqual(afterFirstSweep.rows);
    expect((await database.query<{ lease_id: string | null }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [queue.rows[0]!.id],
    )).rows).toEqual([{ lease_id: null }]);

    // The already-authorized provider write lands after the first successful remove.
    storedObjects.add(quarantinePath);
    await database.query(`
      update public.file_cleanup_queue
      set first_remove_succeeded_at = clock_timestamp() - interval '25 hours',
          remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second'
      where id = $1
    `, [queue.rows[0]!.id]);
    const secondLease = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [queue.rows[0]!.id],
    );
    storedObjects.delete(quarantinePath);
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [queue.rows[0]!.id, secondLease.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: true }]);
    expect(storedObjects.has(quarantinePath)).toBe(false);
  });

  it('upgrades 0013 retained rows without inferring success and preserves the first-success anchor on reapply', async () => {
    const before0014 = MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0014));
    const database = await createDatabase(before0014, false);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Upgrade cleanup success', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000024';
    const quarantinePath = '10000000-0000-4000-8000-000000000024';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'upgrade.txt', 'text/plain', 16, $4, $5, clock_timestamp() - interval '1 second')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);
    await database.query(
      'select public.retire_expired_quarantine_attachment($1, $2, $3)',
      [owner.workspace_id, attachmentId, quarantinePath],
    );
    const queue = await database.query<{ id: string }>(`
      select id::text from public.file_cleanup_queue where storage_path = $1
    `, [quarantinePath]);
    const legacyLease = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await database.query(`
      update public.file_cleanup_queue
      set attempts = 7, lease_id = $2, lease_expires_at = clock_timestamp() + interval '5 minutes'
      where id = $1
    `, [queue.rows[0]!.id, legacyLease]);
    const legacySchedule = (await database.query<{
      remove_after: string; retain_until: string; lease_expires_at: string;
    }>(`
      select remove_after::text, retain_until::text, lease_expires_at::text
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id])).rows[0]!;

    await applyMigration(database, MIGRATION_0014);
    const upgraded = await database.query<{
      first_remove_succeeded_at: string | null; attempts: number; lease_id: string;
      remove_after: string; retain_until: string; lease_expires_at: string;
    }>(`
      select first_remove_succeeded_at::text, attempts, lease_id::text,
        remove_after::text, retain_until::text, lease_expires_at::text
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id]);
    expect(upgraded.rows).toEqual([{
      first_remove_succeeded_at: null,
      attempts: 7,
      lease_id: legacyLease,
      ...legacySchedule,
    }]);
    await applyMigration(database, MIGRATION_0014);
    expect((await database.query(`
      select first_remove_succeeded_at::text, attempts, lease_id::text,
        remove_after::text, retain_until::text, lease_expires_at::text
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id])).rows).toEqual(upgraded.rows);

    await database.query(`
      update public.file_cleanup_queue
      set lease_id = null, lease_expires_at = null,
          remove_after = clock_timestamp() - interval '25 hours',
          retain_until = clock_timestamp() - interval '1 hour'
      where id = $1
    `, [queue.rows[0]!.id]);
    const firstLease = await database.query<{ lease_id: string }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [queue.rows[0]!.id],
    );
    expect((await database.query<{ removed: boolean }>(
      'select public.finish_file_cleanup_object($1, $2) as removed',
      [queue.rows[0]!.id, firstLease.rows[0]!.lease_id],
    )).rows).toEqual([{ removed: false }]);
    const anchored = await database.query<{
      first_remove_succeeded_at: string; remove_after: string; retain_until: string;
    }>(`
      select first_remove_succeeded_at::text, remove_after::text, retain_until::text
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id]);
    expect(anchored.rows[0]!.first_remove_succeeded_at).not.toBeNull();
    await applyMigration(database, MIGRATION_0014);
    expect((await database.query(`
      select first_remove_succeeded_at::text, remove_after::text, retain_until::text
      from public.file_cleanup_queue where id = $1
    `, [queue.rows[0]!.id])).rows).toEqual(anchored.rows);
  });

  it('restores guards erased by the old 0013 finish and requires two post-upgrade removals for every retirement reason', async () => {
    const before0014 = MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0014));
    const database = await createDatabase(before0014, false);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const cases = [
      {
        attachmentId: 'a0000000-0000-4000-8000-000000000025',
        path: '10000000-0000-4000-8000-000000000025',
        taskId: '40000000-0000-4000-8000-000000000025',
        reason: 'expired',
        expiresInMinutes: -1,
      },
      {
        attachmentId: 'a0000000-0000-4000-8000-000000000026',
        path: '10000000-0000-4000-8000-000000000026',
        taskId: '40000000-0000-4000-8000-000000000026',
        reason: 'parent_missing',
        expiresInMinutes: 15,
      },
      {
        attachmentId: 'a0000000-0000-4000-8000-000000000027',
        path: '10000000-0000-4000-8000-000000000027',
        taskId: '40000000-0000-4000-8000-000000000027',
        reason: 'invalid_content',
        expiresInMinutes: 15,
      },
    ] as const;

    for (const candidate of cases) {
      await database.query(`
        insert into public.tasks (id, workspace_id, title, status_id)
        values ($1, $2, $3, $4)
      `, [candidate.taskId, owner.workspace_id, `upgrade-gap-${candidate.reason}`, status.rows[0]!.id]);
      await database.query(`
        insert into public.attachments (
          id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
          created_by, quarantine_expires_at
        ) values (
          $1, $2, $3, $4, 'text/plain', 16, $5, $6,
          clock_timestamp() + $7::int * interval '1 minute'
        )
      `, [
        candidate.attachmentId, owner.workspace_id, candidate.taskId,
        `${candidate.reason}.txt`, candidate.path, owner.user_id, candidate.expiresInMinutes,
      ]);
    }
    await database.query(
      'update public.tasks set deleted_at = clock_timestamp() where id = $1',
      [cases[1].taskId],
    );

    for (const candidate of cases) {
      expect((await database.query<{ retired: boolean }>(`
        select public.retire_quarantine_attachment($1, $2, $3, $4) as retired
      `, [owner.workspace_id, candidate.attachmentId, candidate.path, candidate.reason])).rows)
        .toEqual([{ retired: true }]);
    }
    await database.query(`
      update public.file_cleanup_queue
      set remove_after = clock_timestamp() - interval '25 hours',
          retain_until = clock_timestamp() - interval '1 hour'
      where attachment_id in ($1, $2, $3)
    `, cases.map(({ attachmentId }) => attachmentId));
    const legacyQueues = await database.query<{ attachment_id: string; queue_id: string }>(`
      select attachment_id::text, id::text as queue_id
      from public.file_cleanup_queue
      where attachment_id in ($1, $2, $3)
      order by attachment_id
    `, cases.map(({ attachmentId }) => attachmentId));
    expect(legacyQueues.rows.map(({ attachment_id }) => attachment_id))
      .toEqual(cases.map(({ attachmentId }) => attachmentId));
    for (const queue of legacyQueues.rows) {
      const lease = await database.query<{ lease_id: string }>(
        'select public.prepare_file_cleanup_object($1)::text as lease_id', [queue.queue_id],
      );
      expect((await database.query<{ removed: boolean }>(
        'select public.finish_file_cleanup_object($1, $2) as removed',
        [queue.queue_id, lease.rows[0]!.lease_id],
      )).rows).toEqual([{ removed: true }]);
    }
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where attachment_id in ($1, $2, $3)
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual([{ count: 0 }]);

    const migrationStarted = (await database.query<{ observed_at: string }>(
      'select clock_timestamp()::text as observed_at',
    )).rows[0]!.observed_at;
    await applyMigration(database, MIGRATION_0014);
    const restored = await database.query<{
      attachment_id: string;
      queue_id: string;
      first_remove_succeeded_at: string | null;
      lease_id: string | null;
      remove_after: string;
      retain_until: string;
      scoped: boolean;
      signed_window_protected: boolean;
      retained: boolean;
    }>(`
      select attachment.id::text as attachment_id, cleanup.id::text as queue_id,
        cleanup.first_remove_succeeded_at::text, cleanup.lease_id::text,
        cleanup.remove_after::text, cleanup.retain_until::text,
        cleanup.workspace_id = attachment.workspace_id
          and cleanup.attachment_id = attachment.id
          and cleanup.storage_path = attachment.storage_path as scoped,
        cleanup.remove_after >= greatest($4::timestamptz, attachment.quarantine_expires_at)
          as signed_window_protected,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained
      from public.attachments as attachment
      join public.file_cleanup_queue as cleanup
        on cleanup.workspace_id = attachment.workspace_id
       and cleanup.attachment_id = attachment.id
       and cleanup.storage_path = attachment.storage_path
      where attachment.id in ($1, $2, $3)
      order by attachment.id
    `, [...cases.map(({ attachmentId }) => attachmentId), migrationStarted]);
    expect(restored.rows.map(({ attachment_id }) => attachment_id))
      .toEqual(cases.map(({ attachmentId }) => attachmentId));
    for (const row of restored.rows) {
      expect(row).toMatchObject({
        first_remove_succeeded_at: null,
        lease_id: null,
        scoped: true,
        signed_window_protected: true,
        retained: true,
      });
    }
    expect((await database.query<{ quarantine_cleanup_completed_at: string | null }>(`
      select quarantine_cleanup_completed_at::text
      from public.attachments
      where id in ($1, $2, $3)
      order by id
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual(
      cases.map(() => ({ quarantine_cleanup_completed_at: null })),
    );

    await applyMigration(database, MIGRATION_0014);
    expect((await database.query(`
      select attachment.id::text as attachment_id, cleanup.id::text as queue_id,
        cleanup.first_remove_succeeded_at::text, cleanup.lease_id::text,
        cleanup.remove_after::text, cleanup.retain_until::text,
        cleanup.workspace_id = attachment.workspace_id
          and cleanup.attachment_id = attachment.id
          and cleanup.storage_path = attachment.storage_path as scoped,
        cleanup.remove_after >= greatest($4::timestamptz, attachment.quarantine_expires_at)
          as signed_window_protected,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained
      from public.attachments as attachment
      join public.file_cleanup_queue as cleanup
        on cleanup.workspace_id = attachment.workspace_id
       and cleanup.attachment_id = attachment.id
       and cleanup.storage_path = attachment.storage_path
      where attachment.id in ($1, $2, $3)
      order by attachment.id
    `, [...cases.map(({ attachmentId }) => attachmentId), migrationStarted])).rows).toEqual(restored.rows);

    await database.query(`
      update public.file_cleanup_queue
      set remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second'
      where attachment_id in ($1, $2, $3)
    `, cases.map(({ attachmentId }) => attachmentId));
    const firstLeases = new Map<string, string>();
    for (const row of restored.rows) {
      const lease = await database.query<{ lease_id: string }>(
        'select public.prepare_file_cleanup_object($1)::text as lease_id', [row.queue_id],
      );
      firstLeases.set(row.queue_id, lease.rows[0]!.lease_id);
      expect((await database.query<{ removed: boolean }>(
        'select public.finish_file_cleanup_object($1, $2) as removed',
        [row.queue_id, lease.rows[0]!.lease_id],
      )).rows).toEqual([{ removed: false }]);
      expect((await database.query<{ removed: boolean }>(
        'select public.finish_file_cleanup_object($1, $2) as removed',
        [row.queue_id, lease.rows[0]!.lease_id],
      )).rows).toEqual([{ removed: false }]);
      expect((await database.query<{ lease_id: string | null }>(
        'select public.prepare_file_cleanup_object($1)::text as lease_id', [row.queue_id],
      )).rows).toEqual([{ lease_id: null }]);
    }
    const afterFirstSuccess = await database.query<{
      queue_id: string;
      first_remove_succeeded_at: string | null;
      remove_after: string;
      retain_until: string;
      lease_id: string | null;
      delayed: boolean;
    }>(`
      select id::text as queue_id, first_remove_succeeded_at::text,
        remove_after::text, retain_until::text, lease_id::text,
        remove_after >= first_remove_succeeded_at + interval '24 hours' as delayed
      from public.file_cleanup_queue
      where attachment_id in ($1, $2, $3)
      order by attachment_id
    `, cases.map(({ attachmentId }) => attachmentId));
    expect(afterFirstSuccess.rows).toHaveLength(3);
    for (const row of afterFirstSuccess.rows) {
      expect(row).toMatchObject({ delayed: true, lease_id: null });
      expect(row.first_remove_succeeded_at).not.toBeNull();
    }
    expect((await database.query<{ quarantine_cleanup_completed_at: string | null }>(`
      select quarantine_cleanup_completed_at::text
      from public.attachments
      where id in ($1, $2, $3)
      order by id
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual(
      cases.map(() => ({ quarantine_cleanup_completed_at: null })),
    );
    await applyMigration(database, MIGRATION_0014);
    expect((await database.query(`
      select id::text as queue_id, first_remove_succeeded_at::text,
        remove_after::text, retain_until::text, lease_id::text,
        remove_after >= first_remove_succeeded_at + interval '24 hours' as delayed
      from public.file_cleanup_queue
      where attachment_id in ($1, $2, $3)
      order by attachment_id
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual(afterFirstSuccess.rows);

    await database.query(`
      update public.file_cleanup_queue
      set first_remove_succeeded_at = clock_timestamp() - interval '25 hours',
          remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second'
      where attachment_id in ($1, $2, $3)
    `, cases.map(({ attachmentId }) => attachmentId));
    for (const row of restored.rows) {
      const secondLease = await database.query<{ lease_id: string }>(
        'select public.prepare_file_cleanup_object($1)::text as lease_id', [row.queue_id],
      );
      expect(secondLease.rows[0]!.lease_id).not.toBe(firstLeases.get(row.queue_id));
      expect((await database.query<{ removed: boolean }>(
        'select public.finish_file_cleanup_object($1, $2) as removed',
        [row.queue_id, secondLease.rows[0]!.lease_id],
      )).rows).toEqual([{ removed: true }]);
    }
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where attachment_id in ($1, $2, $3)
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual([{ count: 0 }]);

    const completedAttachments = await database.query<{
      attachment_id: string;
      state: string;
      soft_deleted: boolean;
      quarantine_metadata_preserved: boolean;
      quarantine_cleanup_completed_at: string;
    }>(`
      select id::text as attachment_id, state, deleted_at is not null as soft_deleted,
        quarantine_expires_at is not null as quarantine_metadata_preserved,
        quarantine_cleanup_completed_at::text
      from public.attachments
      where id in ($1, $2, $3)
      order by id
    `, cases.map(({ attachmentId }) => attachmentId));
    expect(completedAttachments.rows.map(({ attachment_id }) => attachment_id))
      .toEqual(cases.map(({ attachmentId }) => attachmentId));
    for (const attachment of completedAttachments.rows) {
      expect(attachment).toMatchObject({
        state: 'quarantine',
        soft_deleted: true,
        quarantine_metadata_preserved: true,
      });
      expect(attachment.quarantine_cleanup_completed_at).not.toBeNull();
    }

    await applyMigration(database, MIGRATION_0014);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where attachment_id in ($1, $2, $3)
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual([{ count: 0 }]);
    expect((await database.query(`
      select id::text as attachment_id, state, deleted_at is not null as soft_deleted,
        quarantine_expires_at is not null as quarantine_metadata_preserved,
        quarantine_cleanup_completed_at::text
      from public.attachments
      where id in ($1, $2, $3)
      order by id
    `, cases.map(({ attachmentId }) => attachmentId))).rows).toEqual(completedAttachments.rows);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from pg_constraint
      where conname = 'attachments_quarantine_cleanup_completed_check'
    `)).rows).toEqual([{ count: 1 }]);
  });

  it('backfills retained tombstones for signed quarantine paths created before 0013 and reapplies without churn', async () => {
    const migration0013 = MIGRATION_0013;
    const database = await createDatabase(MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0013)), false);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Legacy signed quarantine', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000021';
    const quarantinePath = '10000000-0000-4000-8000-000000000021';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by,
        quarantine_expires_at, deleted_at
      ) values ($1, $2, $3, 'legacy-signed.txt', 'text/plain', 16, $4, $5,
        clock_timestamp() + interval '15 minutes', clock_timestamp())
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);

    await applyMigration(database, migration0013);
    const first = await database.query<{
      id: string; delayed: boolean; retained: boolean; version: number; updated_at: string;
    }>(`
      select cleanup.id::text,
        cleanup.remove_after >= attachment.quarantine_expires_at as delayed,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained,
        attachment.version, attachment.updated_at::text
      from public.attachments as attachment
      join public.file_cleanup_queue as cleanup
        on cleanup.workspace_id = attachment.workspace_id
       and cleanup.attachment_id = attachment.id
       and cleanup.storage_path = attachment.storage_path
      where attachment.id = $1
    `, [attachmentId]);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ delayed: true, retained: true });

    await applyMigration(database, migration0013);
    expect((await database.query(`
      select cleanup.id::text,
        cleanup.remove_after >= attachment.quarantine_expires_at as delayed,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained,
        attachment.version, attachment.updated_at::text
      from public.attachments as attachment
      join public.file_cleanup_queue as cleanup
        on cleanup.workspace_id = attachment.workspace_id
       and cleanup.attachment_id = attachment.id
       and cleanup.storage_path = attachment.storage_path
      where attachment.id = $1
    `, [attachmentId])).rows).toEqual(first.rows);
  });

  it('extends a pre-0013 completed quarantine-path row from the derived 125-minute signed window', async () => {
    const migration0013 = MIGRATION_0013;
    const database = await createDatabase(MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0013)), false);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Legacy completed quarantine', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000022';
    const quarantinePath = '10000000-0000-4000-8000-000000000022';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by,
        quarantine_expires_at
      ) values ($1, $2, $3, 'legacy-completed.txt', 'text/plain', 16, $4, $5,
        clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, quarantinePath, owner.user_id]);
    await database.query('select public.arm_attachment_ready_cleanup($1, $2, $3)', [
      owner.workspace_id, attachmentId, attachmentId,
    ]);
    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'legacy-completed.txt', 'text/plain', 16, $5
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId, 'a'.repeat(64)]);
    expect((await database.query<{ retain_until: string | null }>(`
      select retain_until::text from public.file_cleanup_queue where storage_path = $1
    `, [quarantinePath])).rows).toEqual([{ retain_until: null }]);

    await applyMigration(database, migration0013);
    const first = await database.query<{
      delayed: boolean; retained: boolean; version: number; updated_at: string;
    }>(`
      select cleanup.remove_after >= attachment.created_at + interval '125 minutes' as delayed,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained,
        attachment.version, attachment.updated_at::text
      from public.attachments as attachment
      join public.file_cleanup_queue as cleanup
        on cleanup.workspace_id = attachment.workspace_id
       and cleanup.attachment_id = attachment.id
      where attachment.id = $1 and cleanup.storage_path = $2
    `, [attachmentId, quarantinePath]);
    expect(first.rows).toEqual([expect.objectContaining({ delayed: true, retained: true })]);

    await applyMigration(database, migration0013);
    expect((await database.query(`
      select cleanup.remove_after >= attachment.created_at + interval '125 minutes' as delayed,
        cleanup.retain_until >= cleanup.remove_after + interval '24 hours' as retained,
        attachment.version, attachment.updated_at::text
      from public.attachments as attachment
      join public.file_cleanup_queue as cleanup
        on cleanup.workspace_id = attachment.workspace_id
       and cleanup.attachment_id = attachment.id
      where attachment.id = $1 and cleanup.storage_path = $2
    `, [attachmentId, quarantinePath])).rows).toEqual(first.rows);
  });

  it('reapplies 0010 without mutating an existing legacy attachment version or timestamp', async () => {
    const migration0010 = 'supabase/migrations/0010_task6_ambiguous_file_cleanup.sql';
    const before0010 = MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration0010));
    const database = await createDatabase(before0010, false);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [owner.workspace_id],
    );
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Legacy attachment', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const attachmentId = 'a0000000-0000-4000-8000-000000000008';
    const legacyPath = `${owner.workspace_id}/quarantine/10000000-0000-4000-8000-000000000008`;
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'legacy.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.rows[0]!.id, legacyPath, owner.user_id]);
    await applyMigration(database, migration0010);
    const first = await database.query<{ version: number; updated_at: string }>(
      'select version, updated_at::text from public.attachments where id = $1', [attachmentId],
    );

    await applyMigration(database, migration0010);
    const second = await database.query<{ version: number; updated_at: string }>(
      'select version, updated_at::text from public.attachments where id = $1', [attachmentId],
    );

    expect(second.rows).toEqual(first.rows);
  });

  it('converges unsafe legacy metadata and URL values before installing strict Safe constraints', async () => {
    const database = await createDatabase(MIGRATIONS.slice(0, 8), false);
    const owner = await bootstrapOwner(database);
    const legacyRows = [
      ['Legacy unsafe', 'password hunter2', '4111.1111.1111.1111', 'https://vault.bitwarden.com/#/items/access_token/abc.def'],
      ['Legacy dash', 'password—hunter2', 'Команда', 'https://vault.bitwarden.com/#/items/example'],
      ['Legacy plus PAN', 'Политика паролей', '4111+1111+1111+1111', 'https://vault.bitwarden.com/#/items/example'],
      ['Legacy zero width', 'pass\u200bword/hunter2', 'Команда', 'https://vault.bitwarden.com/#/items/example'],
      ['Legacy fullwidth URL', 'Политика паролей', 'Команда', 'https://vault.bitwarden.com/#/items/ｐａｓｓｗｏｒｄ：ｈｕｎｔｅｒ２'],
    ] as const;
    for (const [title, purpose, itemOwner, externalUrl] of legacyRows) {
      await database.query(`
        insert into public.secure_items (workspace_id, title, external_url, metadata)
        values ($1, $2, $3, jsonb_build_object('purpose', $4::text, 'owner', $5::text))
      `, [owner.workspace_id, title, externalUrl, purpose, itemOwner]);
    }
    for (const filename of MIGRATIONS.slice(8)) await applyMigration(database, filename);

    const rows = await database.query<{ title: string; purpose: string; owner: string; external_url: string }>(`
      select title, purpose, owner, external_url
      from public.secure_items where workspace_id = $1 order by title
    `, [owner.workspace_id]);
    expect(rows.rows).toEqual([
      { title: 'Legacy dash', purpose: 'Ссылка на запись в Bitwarden', owner: 'Команда', external_url: 'https://vault.bitwarden.com/#/items/example' },
      { title: 'Legacy fullwidth URL', purpose: 'Политика паролей', owner: 'Команда', external_url: 'https://vault.bitwarden.com/' },
      { title: 'Legacy plus PAN', purpose: 'Политика паролей', owner: 'Команда', external_url: 'https://vault.bitwarden.com/#/items/example' },
      { title: 'Legacy unsafe', purpose: 'Ссылка на запись в Bitwarden', owner: 'Команда', external_url: 'https://vault.bitwarden.com/' },
      { title: 'Legacy zero width', purpose: 'Ссылка на запись в Bitwarden', owner: 'Команда', external_url: 'https://vault.bitwarden.com/#/items/example' },
    ]);
    const unsafe = await database.query<{ count: number }>(`
      select count(*)::int as count
      from public.secure_items
      where not private.secure_item_text_is_safe(title)
        or not private.secure_item_text_is_safe(purpose)
        or not private.secure_item_text_is_safe(owner)
        or not private.secure_item_url_is_safe(external_url)
    `);
    expect(unsafe.rows).toEqual([{ count: 0 }]);
  });

  it('converges OGHAM-disguised credentials and PANs when upgrading from 0012 without repeat churn', async () => {
    const migration0013 = MIGRATION_0013;
    const database = await createDatabase(MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0013)), false);
    const owner = await bootstrapOwner(database);
    await database.query(`
      insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
      values
        ($1, 'Legacy OGHAM credential', $2, 'Команда', 'https://vault.bitwarden.com/#/items/example'),
        ($1, 'Legacy OGHAM PAN', 'Политика паролей', $3, 'https://vault.bitwarden.com/#/items/example')
    `, [owner.workspace_id, 'password\u1680hunter2', '4111\u16801111\u16801111\u16801111']);

    await applyMigration(database, migration0013);
    const first = await database.query<{
      title: string; purpose: string; owner: string; version: number; updated_at: string;
    }>(`
      select title, purpose, owner, version, updated_at::text
      from public.secure_items where workspace_id = $1 order by title
    `, [owner.workspace_id]);
    expect(first.rows).toEqual([
      expect.objectContaining({ title: 'Legacy OGHAM PAN', owner: 'Команда' }),
      expect.objectContaining({ title: 'Legacy OGHAM credential', purpose: 'Ссылка на запись в Bitwarden' }),
    ]);

    await applyMigration(database, migration0013);
    expect((await database.query(`
      select title, purpose, owner, version, updated_at::text
      from public.secure_items where workspace_id = $1 order by title
    `, [owner.workspace_id])).rows).toEqual(first.rows);
  });

  it('rejects unsafe fresh Safe summaries and nested encoded URLs while preserving benign UUID routes', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    for (const purpose of [
      'password/hunter2', 'access_token/abc.def', '4111.1111.1111.1111', ...unsafeSafeTextFixtures,
    ]) {
      await expect(database.query(`
        insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
        values ($1, 'Unsafe summary', $2, 'Команда', 'https://vault.bitwarden.com/#/items/example')
      `, [owner.workspace_id, purpose])).rejects.toThrow();
    }
    for (const externalUrl of [
      'https://vault.bitwarden.com/#/items/password/hunter2',
      'https://vault.bitwarden.com/?item=credential%2Fuser.name',
      'https://vault.bitwarden.com/#/items/access.token/abc.def',
      'https://vault.bitwarden.com/#/items/password%25252Fhunter2',
      'https://vault.bitwarden.com/#/items/4111_1111_1111_1111',
      'https://vault.bitwarden.com/#/items/%252561%252563%252563%252565%252573%252573%25255f%252574%25256f%25256b%252565%25256e%252fabc.def',
      ...unsafeSafeUrlFixtures,
    ]) {
      await expect(database.query(`
        insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
        values ($1, 'Unsafe URL', 'Политика паролей', 'Команда', $2)
      `, [owner.workspace_id, externalUrl])).rejects.toThrow();
    }
    await expect(database.query(`
      insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
      values ($1, 'Benign UUID', 'Пароль хранится в Bitwarden', 'Команда',
        'https://vault.bitwarden.com/#/vault/item/123e4567-e89b-12d3-a456-426614174000')
    `, [owner.workspace_id])).resolves.toBeDefined();
  });

  it('matches the application canonical Safe fixture matrix in SQL', async () => {
    const database = await createDatabase();
    for (const value of unsafeSafeTextFixtures) {
      expect((await database.query<{ safe: boolean }>(
        'select private.secure_item_text_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: false }]);
    }
    for (const value of safeSafeTextFixtures) {
      expect((await database.query<{ safe: boolean }>(
        'select private.secure_item_text_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: true }]);
    }
    for (const value of unsafeSafeUrlFixtures) {
      expect((await database.query<{ safe: boolean }>(
        'select private.secure_item_url_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: false }]);
    }
    for (const value of safeSafeUrlFixtures) {
      expect((await database.query<{ safe: boolean }>(
        'select private.secure_item_url_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: true }]);
    }
  });

  it('rejects cross-workspace cleanup references and globally duplicated opaque object names', async () => {
    const database = await createDatabase();
    const first = await bootstrapOwner(database);
    const secondResult = await database.query<{ user_id: string; workspace_id: string }>(`select * from public.bootstrap_telegram_user(
      '4503599627370494', 'Второй владелец', null, 'owner_files_2', 'ru', '4503599627370494', 'Smoking Zen files 2'
    )`);
    const second = secondResult.rows[0]!;
    const firstStatus = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [first.workspace_id],
    );
    const secondStatus = await database.query<{ id: string }>(
      "select id from public.task_statuses where workspace_id = $1 and name = 'Новая'", [second.workspace_id],
    );
    const firstTask = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Первый файл', $2) returning id
    `, [first.workspace_id, firstStatus.rows[0]!.id]);
    const secondTask = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Второй файл', $2) returning id
    `, [second.workspace_id, secondStatus.rows[0]!.id]);
    const firstAttachmentId = 'a0000000-0000-4000-8000-000000000004';
    const opaqueObject = '10000000-0000-4000-8000-000000000004';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'first.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [firstAttachmentId, first.workspace_id, firstTask.rows[0]!.id, opaqueObject, first.user_id]);

    await expect(database.query(`
      insert into public.file_cleanup_queue (workspace_id, attachment_id, storage_path, remove_after)
      values ($1, $2, $3, clock_timestamp())
    `, [second.workspace_id, firstAttachmentId, firstAttachmentId])).rejects.toThrow();

    await expect(database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ('a0000000-0000-4000-8000-000000000005', $1, $2, 'second.txt', 'text/plain', 16, $3, $4,
        clock_timestamp() + interval '15 minutes')
    `, [second.workspace_id, secondTask.rows[0]!.id, opaqueObject, second.user_id])).rejects.toThrow();
  });

  it('keeps quarantine cleanup indexed and all business tables and Storage locked to the server role', async () => {
    const database = await createDatabase();
    const access = await database.query<{ auth_attachments: boolean; auth_secure: boolean; anon_storage: boolean }>(`
      select
        has_table_privilege('authenticated', 'public.attachments', 'select') as auth_attachments,
        has_table_privilege('authenticated', 'public.secure_items', 'select') as auth_secure,
        has_table_privilege('anon', 'storage.objects', 'select') as anon_storage
    `);
    const indexes = await database.query<{ indexname: string }>(`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'attachments'
    `);
    const bucket = await database.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(`
      select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'workspace-files'
    `);
    const browserPolicies = await database.query<{ count: number }>(`
      select count(*)::int as count from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and ('authenticated' = any(roles) or 'anon' = any(roles))
    `);
    const cleanupPrivileges = await database.query<{
      anon: boolean; auth: boolean; service: boolean;
      arm_anon: boolean; arm_auth: boolean; arm_service: boolean;
      prepare_anon: boolean; prepare_auth: boolean; prepare_service: boolean;
      finish_anon: boolean; finish_auth: boolean; finish_service: boolean;
      restore_anon: boolean; restore_auth: boolean; restore_service: boolean;
    }>(`
      select
        has_function_privilege('anon', 'public.complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text)', 'execute') as auth,
        has_function_privilege('service_role', 'public.complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text)', 'execute') as service,
        has_function_privilege('anon', 'public.arm_attachment_ready_cleanup(uuid,uuid,text)', 'execute') as arm_anon,
        has_function_privilege('authenticated', 'public.arm_attachment_ready_cleanup(uuid,uuid,text)', 'execute') as arm_auth,
        has_function_privilege('service_role', 'public.arm_attachment_ready_cleanup(uuid,uuid,text)', 'execute') as arm_service,
        has_function_privilege('anon', 'public.prepare_file_cleanup_object(uuid)', 'execute') as prepare_anon,
        has_function_privilege('authenticated', 'public.prepare_file_cleanup_object(uuid)', 'execute') as prepare_auth,
        has_function_privilege('service_role', 'public.prepare_file_cleanup_object(uuid)', 'execute') as prepare_service,
        has_function_privilege('anon', 'public.finish_file_cleanup_object(uuid,uuid)', 'execute') as finish_anon,
        has_function_privilege('authenticated', 'public.finish_file_cleanup_object(uuid,uuid)', 'execute') as finish_auth,
        has_function_privilege('service_role', 'public.finish_file_cleanup_object(uuid,uuid)', 'execute') as finish_service,
        has_function_privilege('anon', 'public.restore_secure_item_record(uuid,uuid,integer)', 'execute') as restore_anon,
        has_function_privilege('authenticated', 'public.restore_secure_item_record(uuid,uuid,integer)', 'execute') as restore_auth,
        has_function_privilege('service_role', 'public.restore_secure_item_record(uuid,uuid,integer)', 'execute') as restore_service
    `);

    expect(access.rows).toEqual([{ auth_attachments: false, auth_secure: false, anon_storage: false }]);
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain('attachments_quarantine_cleanup_idx');
    expect(bucket.rows).toEqual([{
      public: false,
      file_size_limit: 26_214_400,
      allowed_mime_types: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
    }]);
    expect(browserPolicies.rows).toEqual([{ count: 0 }]);
    expect(cleanupPrivileges.rows).toEqual([{
      anon: false, auth: false, service: true,
      arm_anon: false, arm_auth: false, arm_service: true,
      prepare_anon: false, prepare_auth: false, prepare_service: true,
      finish_anon: false, finish_auth: false, finish_service: true,
      restore_anon: false, restore_auth: false, restore_service: true,
    }]);
  });
});
