// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

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
        'Банк', 'Иван П.', 'Закупки', '4242', 'https://vault.bitwarden.eu/#/vault/item-safe-example')
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
      card_bank: 'Банк', card_holder: 'Иван П.', card_purpose: 'Закупки', last_four: '4242',
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
    expect((await database.query<{ state: string; storage_path: string }>(
      'select state, storage_path from public.attachments where id = $1', [attachmentId],
    )).rows).toEqual([{ state: 'ready', storage_path: readyObject }]);
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

    const armed = await database.query<{ queue_id: string }>(
      'select public.arm_attachment_ready_cleanup($1, $2, $3) as queue_id',
      [owner.workspace_id, attachmentId, attachmentId],
    );
    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'first.txt', 'text/plain', 16, repeat('d', 64)
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId]);

    const lease = await database.query<{ lease_id: string | null }>(
      'select public.prepare_file_cleanup_object($1)::text as lease_id', [armed.rows[0]!.queue_id],
    );
    expect(lease.rows).toEqual([{ lease_id: null }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.file_cleanup_queue where id = $1', [armed.rows[0]!.queue_id],
    )).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ state: string }>(
      'select state from public.attachments where id = $1', [attachmentId],
    )).rows).toEqual([{ state: 'ready' }]);
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
    await database.query(`
      insert into public.secure_items (workspace_id, title, external_url, metadata)
      values ($1, 'Legacy unsafe', 'https://vault.bitwarden.com/#/items/access_token/abc.def',
        '{"purpose":"password hunter2","owner":"4111.1111.1111.1111"}'::jsonb)
    `, [owner.workspace_id]);
    for (const filename of MIGRATIONS.slice(8)) await applyMigration(database, filename);

    const row = await database.query<{ purpose: string; owner: string; external_url: string }>(`
      select purpose, owner, external_url from public.secure_items where workspace_id = $1
    `, [owner.workspace_id]);
    expect(row.rows).toEqual([{
      purpose: 'Ссылка на запись в Bitwarden',
      owner: 'Команда',
      external_url: 'https://vault.bitwarden.com/',
    }]);
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

  it('rejects unsafe fresh Safe summaries and nested encoded URLs while preserving benign UUID routes', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    for (const purpose of ['password/hunter2', 'access_token/abc.def', '4111.1111.1111.1111']) {
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
