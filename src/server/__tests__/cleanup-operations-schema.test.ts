// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const MIGRATION_0016 = 'supabase/migrations/0016_task7_cleanup.sql';
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
  'supabase/migrations/0013_task6_quarantine_tombstones_safe_parity.sql',
  'supabase/migrations/0014_task6_explicit_cleanup_success_safe_url.sql',
  'supabase/migrations/0015_task7_notifications_cleanup.sql',
  MIGRATION_0016,
];

const databases: PGlite[] = [];

const ACL_INVENTORY_SQL = `
  select coalesce(jsonb_agg(to_jsonb(entry) order by kind, object_name, role_name, privilege), '[]') as inventory
  from (
    select 'schema'::text as kind, namespace.nspname::text as object_name,
      coalesce(role.rolname, 'PUBLIC')::text as role_name, acl.privilege_type::text as privilege
    from pg_catalog.pg_namespace namespace
    cross join lateral aclexplode(coalesce(namespace.nspacl, acldefault('n'::"char", namespace.nspowner))) acl
    left join pg_catalog.pg_roles role on role.oid = acl.grantee
    where namespace.nspname in ('public', 'private', 'storage', 'realtime')
    union all
    select 'relation', namespace.nspname || '.' || relation.relname,
      coalesce(role.rolname, 'PUBLIC'), acl.privilege_type
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral aclexplode(coalesce(
      relation.relacl,
      acldefault(case when relation.relkind = 'S' then 'S'::"char" else 'r'::"char" end, relation.relowner)
    )) acl
    left join pg_catalog.pg_roles role on role.oid = acl.grantee
    where (namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'S'))
      or (namespace.nspname = 'storage' and relation.relname = 'objects')
      or (namespace.nspname = 'realtime' and relation.relname = 'messages')
    union all
    select 'function', namespace.nspname || '.' || routine.oid::regprocedure::text,
      coalesce(role.rolname, 'PUBLIC'), acl.privilege_type
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    cross join lateral aclexplode(coalesce(routine.proacl, acldefault('f'::"char", routine.proowner))) acl
    left join pg_catalog.pg_roles role on role.oid = acl.grantee
    where namespace.nspname in ('public', 'private')
    union all
    select 'policy', namespace.nspname || '.' || relation.relname || '.' || policy.polname,
      coalesce((select string_agg(role.rolname, ',' order by role.rolname)
        from pg_catalog.pg_roles role where role.oid = any(policy.polroles)), 'PUBLIC'),
      concat_ws('|', policy.polcmd, policy.polpermissive::text,
        coalesce(pg_get_expr(policy.polqual, policy.polrelid), ''),
        coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), ''))
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('storage', 'realtime')
    union all
    select 'rls', namespace.nspname || '.' || relation.relname, '', relation.relrowsecurity::text
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where (namespace.nspname = 'public' and relation.relkind in ('r', 'p'))
      or (namespace.nspname = 'realtime' and relation.relname = 'messages')
  ) entry
`;

async function applyMigration(database: PGlite, filename: string) {
  const sql = (await readFile(filename, 'utf8')).replace(
    'create extension if not exists pgcrypto with schema extensions;', '',
  );
  await database.exec(sql);
}

async function createDatabase(reapply = true, migrations: readonly string[] = MIGRATIONS) {
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
    create function auth.uid() returns uuid language sql stable set search_path = ''
      as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    create function auth.jwt() returns jsonb language sql stable set search_path = ''
      as 'select coalesce(nullif(current_setting(''request.jwt.claims'', true), ''''), ''{}'')::jsonb';
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default extensions.gen_random_uuid(), bucket_id text, name text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
    create schema realtime;
    create table realtime.messages (
      id uuid primary key default extensions.gen_random_uuid(), extension text,
      topic text, event text, payload jsonb
    );
    create function realtime.send(payload jsonb, event text, topic text, private boolean)
      returns void language sql volatile set search_path = '' as
      'insert into realtime.messages (extension, topic, event, payload)
       values (''broadcast'', topic, event, payload)';
    create function realtime.topic() returns text language sql stable set search_path = ''
      as 'select nullif(current_setting(''realtime.topic'', true), '''')::text';
    grant usage on schema public, storage, realtime to anon, authenticated, service_role;
    grant all privileges on storage.objects to anon, authenticated, service_role;
    grant all privileges on realtime.messages to anon, authenticated, service_role;
    alter default privileges in schema public grant all privileges on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all privileges on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const migration of migrations) await applyMigration(database, migration);
  if (reapply) await applyMigration(database, migrations.at(-1)!);
  return database;
}

async function owner(database: PGlite) {
  return (await database.query<{ user_id: string; membership_id: string; workspace_id: string }>(`
    select * from public.bootstrap_telegram_user(
      '4503599627370495', 'Owner', null, 'owner', 'ru',
      '4503599627370495', 'Cleanup workspace'
    )
  `)).rows[0]!;
}

async function task(database: PGlite, workspaceId: string, title = 'Cleanup task') {
  return (await database.query<{ id: string }>(`
    insert into public.tasks (workspace_id, title, status_id)
    select $1, $2, id from public.task_statuses
    where workspace_id = $1 and not is_completed order by position limit 1
    returning id::text
  `, [workspaceId, title])).rows[0]!.id;
}

async function readyAttachment(
  database: PGlite, ids: { workspaceId: string; taskId: string; userId: string }, id: string,
) {
  await database.query(`
    insert into public.attachments (
      id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
      state, sha256, created_by, quarantine_expires_at, completed_at, storage_layout
    ) values ($1::uuid, $2, $3, 'proof.txt', 'text/plain', 4, $1::text,
      'ready', repeat('a', 64), $4, null, clock_timestamp(), 'opaque')
  `, [id, ids.workspaceId, ids.taskId, ids.userId]);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('Task 7 cleanup operations schema', () => {
  it('restores the exact fresh-0017 ACL, policy, and RLS inventory without historical migration replay', async () => {
    const database = await createDatabase();
    await applyMigration(database, 'supabase/migrations/0017_task7_notification_replay.sql');
    await applyMigration(database, 'supabase/migrations/0017_task7_notification_replay.sql');
    const expected = (await database.query<{ inventory: unknown }>(ACL_INVENTORY_SQL)).rows[0]!.inventory;
    await database.exec(`
      grant all privileges on schema public, private, storage, realtime to anon, authenticated;
      grant all privileges on all tables in schema public to anon, authenticated;
      grant execute on all functions in schema public, private to anon, authenticated;
      revoke all privileges on all tables in schema public from service_role;
      revoke execute on all functions in schema public, private from service_role;
      drop policy if exists workspace_broadcast_realtime_select on realtime.messages;
      create policy workspace_broadcast_member_select on realtime.messages for select to authenticated using (true);
    `);
    await database.exec(await readFile('supabase/operations/restore_acl_0017.sql', 'utf8'));
    const actual = (await database.query<{ inventory: unknown }>(ACL_INVENTORY_SQL)).rows[0]!.inventory;
    expect(actual).toEqual(expected);
  });

  it('converges an upgrade with already-deleted parents without losing ready metadata', async () => {
    const database = await createDatabase(false, MIGRATIONS.slice(0, -1));
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id, 'Upgrade parent');
    const attachmentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await readyAttachment(database, {
      workspaceId: actor.workspace_id, taskId, userId: actor.user_id,
    }, attachmentId);
    const deletedAt = '2026-07-01T10:00:00.000000Z';
    await database.query('update public.tasks set deleted_at = $2 where id = $1', [taskId, deletedAt]);
    expect((await database.query<{ deleted: boolean }>(`
      select deleted_at is not null as deleted from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ deleted: false }]);

    await applyMigration(database, MIGRATION_0016);
    await database.query('select public.stage_file_cleanup()');
    expect((await database.query<{ inherited: boolean; queued: boolean }>(`
      select attachment.deleted_at = $2::timestamptz as inherited,
        exists(select 1 from public.file_cleanup_queue where attachment_id = attachment.id) as queued
      from public.attachments as attachment where attachment.id = $1
    `, [attachmentId, deletedAt])).rows).toEqual([{ inherited: true, queued: true }]);
  });

  it('resets a pre-upgrade retained first-success attempt budget so its second removal remains reachable', async () => {
    const database = await createDatabase(false, MIGRATIONS.slice(0, -1));
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id, 'Upgrade retained');
    const attachmentId = '15151515-1515-4515-8515-151515151515';
    const path = '16161616-1616-4616-8616-161616161616';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
        state, sha256, created_by, quarantine_expires_at, completed_at,
        storage_layout, deleted_at
      ) values ($1, $2, $3, 'upgrade-q.txt', 'text/plain', 1, $4,
        'quarantine', null, $5, clock_timestamp() - interval '31 days', null,
        'opaque', clock_timestamp() - interval '31 days')
    `, [attachmentId, actor.workspace_id, taskId, path, actor.user_id]);
    const queue = (await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (
        workspace_id, attachment_id, storage_path, remove_after, retain_until,
        first_remove_succeeded_at, attempts
      ) values (
        $1, $2, $3, clock_timestamp() - interval '1 second',
        clock_timestamp() - interval '1 second', clock_timestamp() - interval '25 hours', 99
      ) returning id::text
    `, [actor.workspace_id, attachmentId, path])).rows[0]!.id;
    await applyMigration(database, MIGRATION_0016);
    expect((await database.query<{ attempts: number }>(`
      select attempts from public.file_cleanup_queue where id = $1
    `, [queue])).rows).toEqual([{ attempts: 0 }]);
    await database.query(`update public.file_cleanup_queue set attempts = 7 where id = $1`, [queue]);
    await applyMigration(database, MIGRATION_0016);
    expect((await database.query<{ attempts: number }>(`
      select attempts from public.file_cleanup_queue where id = $1
    `, [queue])).rows).toEqual([{ attempts: 7 }]);
    const lease = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [queue])).rows[0]!.lease;
    expect(lease).toBeTruthy();
    expect((await database.query<{ done: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as done
    `, [queue, lease])).rows).toEqual([{ done: true }]);
  });

  it('uses strict DB cutoffs, keeps equality/recent/live rows, and hides deterministic helpers', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const reference = '2026-08-10T10:00:00.000000Z';
    const equal = '11111111-1111-4111-8111-111111111111';
    const old = '22222222-2222-4222-8222-222222222222';
    const live = '33333333-3333-4333-8333-333333333333';
    await database.query(`
      insert into public.contacts (id, workspace_id, name, deleted_at) values
        ($1, $4, 'equal', $5::timestamptz - interval '30 days'),
        ($2, $4, 'old', $5::timestamptz - interval '30 days 0.000001 seconds'),
        ($3, $4, 'live', null)
    `, [equal, old, live, actor.workspace_id, reference]);
    await database.query('select private.purge_deleted_records_at($1)', [reference]);
    expect((await database.query<{ id: string }>('select id::text from public.contacts order by id')).rows)
      .toEqual([{ id: equal }, { id: live }]);
    expect((await database.query<{ allowed: boolean }>(`
      select has_function_privilege('service_role', 'private.purge_deleted_records_at(timestamptz)', 'execute') as allowed
    `)).rows).toEqual([{ allowed: false }]);
  });

  it('inherits parent deletion, waits for one ready-object success receipt, then purges child-first', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id);
    const attachmentId = '44444444-4444-4444-8444-444444444444';
    await readyAttachment(database, { workspaceId: actor.workspace_id, taskId, userId: actor.user_id }, attachmentId);
    await database.query(`update public.tasks set deleted_at = clock_timestamp() - interval '31 days' where id = $1`, [taskId]);
    expect((await database.query<{ deleted_at: string; marker: string | null }>(`
      select deleted_at::text, storage_cleanup_completed_at::text as marker
      from public.attachments where id = $1
    `, [attachmentId])).rows[0]).toMatchObject({ marker: null });
    await database.query('select public.purge_deleted_records()');
    expect((await database.query<{ count: number }>('select count(*)::int as count from public.tasks where id = $1', [taskId])).rows)
      .toEqual([{ count: 1 }]);
    const queue = (await database.query<{ id: string }>(`
      select id::text from public.file_cleanup_queue where attachment_id = $1
    `, [attachmentId])).rows[0]!;
    const lease = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [queue.id])).rows[0]!.lease;
    expect((await database.query<{ finished: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as finished
    `, [queue.id, lease])).rows).toEqual([{ finished: true }]);
    expect((await database.query<{ marker: boolean }>(`
      select storage_cleanup_completed_at is not null as marker from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ marker: true }]);
    await database.query('select public.purge_deleted_records()');
    expect((await database.query<{ count: number }>('select count(*)::int as count from public.tasks where id = $1', [taskId])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('keeps quarantine metadata through its two-success protocol and preserves anchors on reapply', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id);
    const attachmentId = '55555555-5555-4555-8555-555555555555';
    const path = '66666666-6666-4666-8666-666666666666';
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
        state, sha256, created_by, quarantine_expires_at, completed_at, storage_layout, deleted_at
      ) values ($1, $2, $3, 'q.txt', 'text/plain', 1, $4,
        'quarantine', null, $5, clock_timestamp() - interval '32 days', null, 'opaque',
        clock_timestamp() - interval '31 days')
    `, [attachmentId, actor.workspace_id, taskId, path, actor.user_id]);
    await database.query('select public.stage_file_cleanup()');
    const first = (await database.query<{ id: string; remove_after: string }>(`
      select id::text, remove_after::text from public.file_cleanup_queue where storage_path = $1
    `, [path])).rows[0]!;
    await applyMigration(database, MIGRATION_0016);
    expect((await database.query<{ remove_after: string }>(`
      select remove_after::text from public.file_cleanup_queue where id = $1
    `, [first.id])).rows).toEqual([{ remove_after: first.remove_after }]);
    const lease1 = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [first.id])).rows[0]!.lease;
    expect((await database.query<{ done: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as done
    `, [first.id, lease1])).rows).toEqual([{ done: false }]);
    await database.query(`
      update public.file_cleanup_queue
      set first_remove_succeeded_at = clock_timestamp() - interval '25 hours',
        remove_after = clock_timestamp() - interval '1 second',
        retain_until = clock_timestamp() - interval '1 second'
      where id = $1
    `, [first.id]);
    const lease2 = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [first.id])).rows[0]!.lease;
    expect((await database.query<{ done: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as done
    `, [first.id, lease2])).rows).toEqual([{ done: true }]);
    expect((await database.query<{ marked: boolean }>(`
      select quarantine_cleanup_completed_at is not null as marked from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ marked: true }]);
  });

  it('completes the retained future-ready guard separately from the quarantine-path receipt', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id);
    const attachmentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const quarantinePath = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const stagedAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
        state, sha256, created_by, quarantine_expires_at, completed_at, storage_layout
      ) values ($1, $2, $3, 'pending.txt', 'text/plain', 1, $4,
        'quarantine', null, $5, $6::timestamptz - interval '1 hour', null, 'opaque')
    `, [attachmentId, actor.workspace_id, taskId, quarantinePath, actor.user_id, stagedAt]);
    await database.query('select public.arm_attachment_ready_cleanup($1, $2::uuid, $2::text)', [actor.workspace_id, attachmentId]);
    await database.query('select private.stage_file_cleanup_at($1)', [stagedAt]);

    const guards = await database.query<{ id: string; storage_path: string }>(`
      select id::text, storage_path from public.file_cleanup_queue
      where attachment_id = $1 order by storage_path
    `, [attachmentId]);
    expect(guards.rows.map((row) => row.storage_path).sort()).toEqual([attachmentId, quarantinePath].sort());

    for (const guard of guards.rows) {
      await database.query(`
        update public.file_cleanup_queue
        set remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second',
          attempts = 7
        where id = $1
      `, [guard.id]);
      const lease1 = (await database.query<{ lease: string }>(`
        select public.prepare_file_cleanup_object($1)::text as lease
      `, [guard.id])).rows[0]!.lease;
      expect((await database.query<{ done: boolean }>(`
        select public.finish_file_cleanup_object($1, $2) as done
      `, [guard.id, lease1])).rows).toEqual([{ done: false }]);
      expect((await database.query<{ attempts: number }>(`
        select attempts from public.file_cleanup_queue where id = $1
      `, [guard.id])).rows).toEqual([{ attempts: 0 }]);
      await database.query(`
        update public.file_cleanup_queue
        set first_remove_succeeded_at = clock_timestamp() - interval '25 hours',
          remove_after = clock_timestamp() - interval '1 second',
          retain_until = clock_timestamp() - interval '1 second'
        where id = $1
      `, [guard.id]);
      const lease2 = (await database.query<{ lease: string }>(`
        select public.prepare_file_cleanup_object($1)::text as lease
      `, [guard.id])).rows[0]!.lease;
      expect((await database.query<{ done: boolean }>(`
        select public.finish_file_cleanup_object($1, $2) as done
      `, [guard.id, lease2])).rows).toEqual([{ done: true }]);
    }
    expect((await database.query<{ ready_guard: number; quarantine_receipt: boolean }>(`
      select
        (select count(*)::int from public.file_cleanup_queue where storage_path = $2) as ready_guard,
        quarantine_cleanup_completed_at is not null as quarantine_receipt
      from public.attachments where id = $1
    `, [attachmentId, attachmentId])).rows).toEqual([{ ready_guard: 0, quarantine_receipt: true }]);
  });

  it('stages, receipts, and purges only a canonical workspace-bound legacy ready path', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id, 'Legacy ready');
    const attachmentId = '12121212-1212-4212-8212-121212121212';
    const objectId = '13131313-1313-4313-8313-131313131313';
    const legacyPath = `${actor.workspace_id}/ready/${objectId}`;
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
        state, sha256, created_by, quarantine_expires_at, completed_at, storage_layout
      ) values ($1, $2, $3, 'legacy.txt', 'text/plain', 1, $4,
        'ready', repeat('b', 64), $5, null, clock_timestamp(), 'legacy')
    `, [attachmentId, actor.workspace_id, taskId, legacyPath, actor.user_id]);
    await database.query(`update public.tasks set deleted_at = clock_timestamp() - interval '31 days' where id = $1`, [taskId]);
    const queue = (await database.query<{ id: string }>(`
      select id::text from public.file_cleanup_queue
      where attachment_id = $1 and storage_path = $2
    `, [attachmentId, legacyPath])).rows[0]!;
    expect(queue).toBeDefined();
    const lease = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [queue.id])).rows[0]!.lease;
    expect((await database.query<{ done: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as done
    `, [queue.id, lease])).rows).toEqual([{ done: true }]);
    expect((await database.query<{ marked: boolean }>(`
      select storage_cleanup_completed_at is not null as marked from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ marked: true }]);
    await applyMigration(database, MIGRATION_0016);
    await database.query('select public.purge_deleted_records()');
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.tasks where id = $1
    `, [taskId])).rows).toEqual([{ count: 0 }]);
  });

  it('discovers only old unreferenced opaque keys and cancels a claimed key that becomes referenced', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id);
    const referenced = '77777777-7777-4777-8777-777777777777';
    const orphan = '88888888-8888-4888-8888-888888888888';
    const malformed = `${actor.workspace_id}/ready/99999999-9999-4999-8999-999999999999`;
    await readyAttachment(database, { workspaceId: actor.workspace_id, taskId, userId: actor.user_id }, referenced);
    await database.query(`
      insert into storage.objects (bucket_id, name, created_at) values
        ('workspace-files', $1, clock_timestamp() - interval '3 days'),
        ('workspace-files', $2, clock_timestamp() - interval '3 days'),
        ('workspace-files', $3, clock_timestamp() - interval '3 days'),
        ('workspace-files', 'folder/', clock_timestamp() - interval '3 days')
    `, [referenced, orphan, malformed]);
    await database.query('select public.discover_global_file_orphans()');
    expect((await database.query<{ storage_path: string }>(`
      select storage_path from public.global_file_orphan_queue order by storage_path
    `)).rows).toEqual([{ storage_path: orphan }]);
    const anchor = (await database.query<{ first_seen_at: string; remove_after: string }>(`
      select first_seen_at::text, remove_after::text from public.global_file_orphan_queue where storage_path = $1
    `, [orphan])).rows[0]!;
    await database.query(`select private.discover_global_file_orphans_at(clock_timestamp() + interval '2 days')`);
    expect((await database.query<{ first_seen_at: string; remove_after: string }>(`
      select first_seen_at::text, remove_after::text from public.global_file_orphan_queue where storage_path = $1
    `, [orphan])).rows).toEqual([anchor]);
    await readyAttachment(database, { workspaceId: actor.workspace_id, taskId, userId: actor.user_id }, orphan);
    expect((await database.query<{ lease: string | null }>(`
      select private.prepare_global_file_orphan_at($1, clock_timestamp() + interval '2 days')::text as lease
    `, [orphan])).rows).toEqual([{ lease: null }]);
    expect((await database.query<{ cancelled: boolean }>(`
      select cancelled_at is not null as cancelled from public.global_file_orphan_queue where storage_path = $1
    `, [orphan])).rows).toEqual([{ cancelled: true }]);
  });

  it('requires both globally revalidated removals, preserves grace equality, and never recreates completion', async () => {
    const database = await createDatabase();
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const observed = '2026-08-10T10:00:00.000000Z';
    await database.query(`
      insert into storage.objects (bucket_id, name, created_at)
      values ('workspace-files', $1, $2::timestamptz - interval '3 days')
    `, [key, observed]);
    await database.query('select private.discover_global_file_orphans_at($1)', [observed]);
    expect((await database.query<{ lease: string | null }>(`
      select private.prepare_global_file_orphan_at(
        $1, $2::timestamptz + interval '24 hours'
      )::text as lease
    `, [key, observed])).rows).toEqual([{ lease: null }]);
    const lease1 = (await database.query<{ lease: string }>(`
      select private.prepare_global_file_orphan_at(
        $1, $2::timestamptz + interval '24 hours 0.000001 seconds'
      )::text as lease
    `, [key, observed])).rows[0]!.lease;
    expect((await database.query<{ done: boolean }>(`
      select private.finish_global_file_orphan_at(
        $1, $2, $3::timestamptz + interval '24 hours 1 second'
      ) as done
    `, [key, lease1, observed])).rows).toEqual([{ done: false }]);
    const anchor = (await database.query<{ first_seen_at: string; first_success: string; remove_after: string }>(`
      select first_seen_at::text, first_remove_succeeded_at::text as first_success, remove_after::text
      from public.global_file_orphan_queue where storage_path = $1
    `, [key])).rows[0]!;
    expect((await database.query<{ lease: string | null }>(`
      select private.prepare_global_file_orphan_at($1, $2::timestamptz)::text as lease
    `, [key, anchor.remove_after])).rows).toEqual([{ lease: null }]);
    const lease2 = (await database.query<{ lease: string }>(`
      select private.prepare_global_file_orphan_at(
        $1, $2::timestamptz + interval '0.000001 seconds'
      )::text as lease
    `, [key, anchor.remove_after])).rows[0]!.lease;
    expect((await database.query<{ done: boolean }>(`
      select private.finish_global_file_orphan_at(
        $1, $2, $3::timestamptz + interval '1 second'
      ) as done
    `, [key, lease2, anchor.remove_after])).rows).toEqual([{ done: true }]);
    await applyMigration(database, MIGRATION_0016);
    await database.query(`select private.discover_global_file_orphans_at($1::timestamptz + interval '5 days')`, [observed]);
    expect((await database.query<{ completed: boolean; first_seen_at: string; first_success: string }>(`
      select completed_at is not null as completed, first_seen_at::text,
        first_remove_succeeded_at::text as first_success
      from public.global_file_orphan_queue where storage_path = $1
    `, [key])).rows).toEqual([{
      completed: true, first_seen_at: anchor.first_seen_at, first_success: anchor.first_success,
    }]);
  });

  it('starts a fresh bounded attempt budget after an eighth-attempt first orphan success', async () => {
    const database = await createDatabase();
    const key = '14141414-1414-4414-8414-141414141414';
    const firstSuccessAt = '2026-08-10T10:00:00.000000Z';
    await database.query(`
      insert into public.global_file_orphan_queue (
        storage_path, provider_created_at, first_seen_at, remove_after, attempts
      ) values (
        $1, $2::timestamptz - interval '3 days',
        $2::timestamptz - interval '2 days', $2::timestamptz - interval '1 second', 7
      )
    `, [key, firstSuccessAt]);
    const lease1 = (await database.query<{ lease: string }>(`
      select private.prepare_global_file_orphan_at($1, $2)::text as lease
    `, [key, firstSuccessAt])).rows[0]!.lease;
    expect((await database.query<{ done: boolean }>(`
      select private.finish_global_file_orphan_at($1, $2, $3) as done
    `, [key, lease1, firstSuccessAt])).rows).toEqual([{ done: false }]);
    expect((await database.query<{ attempts: number }>(`
      select attempts from public.global_file_orphan_queue where storage_path = $1
    `, [key])).rows).toEqual([{ attempts: 0 }]);
    const lease2 = (await database.query<{ lease: string }>(`
      select private.prepare_global_file_orphan_at(
        $1, $2::timestamptz + interval '24 hours 0.000001 seconds'
      )::text as lease
    `, [key, firstSuccessAt])).rows[0]!.lease;
    expect(lease2).toBeTruthy();
    expect((await database.query<{ done: boolean }>(`
      select private.finish_global_file_orphan_at(
        $1, $2, $3::timestamptz + interval '24 hours 1 second'
      ) as done
    `, [key, lease2, firstSuccessAt])).rows).toEqual([{ done: true }]);
  });

  it('reclaims stale file leases, rejects the old owner, and claims disjoint objects', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const firstTask = await task(database, actor.workspace_id, 'First lease');
    const secondTask = await task(database, actor.workspace_id, 'Second lease');
    const firstAttachment = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const secondAttachment = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await readyAttachment(database, {
      workspaceId: actor.workspace_id, taskId: firstTask, userId: actor.user_id,
    }, firstAttachment);
    await readyAttachment(database, {
      workspaceId: actor.workspace_id, taskId: secondTask, userId: actor.user_id,
    }, secondAttachment);
    await database.query(`update public.tasks set deleted_at = clock_timestamp() - interval '31 days' where id in ($1, $2)`, [firstTask, secondTask]);
    const queues = (await database.query<{ id: string; attachment_id: string }>(`
      select id::text, attachment_id::text from public.file_cleanup_queue
      where attachment_id in ($1, $2) order by attachment_id
    `, [firstAttachment, secondAttachment])).rows;
    const firstQueue = queues.find((row) => row.attachment_id === firstAttachment)!;
    const secondQueue = queues.find((row) => row.attachment_id === secondAttachment)!;
    const lease1 = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [firstQueue.id])).rows[0]!.lease;
    expect((await database.query<{ lease: string | null }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [firstQueue.id])).rows).toEqual([{ lease: null }]);
    const otherLease = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [secondQueue.id])).rows[0]!.lease;
    expect(otherLease).not.toBe(lease1);
    await database.query(`update public.file_cleanup_queue set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [firstQueue.id]);
    const lease2 = (await database.query<{ lease: string }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [firstQueue.id])).rows[0]!.lease;
    expect(lease2).not.toBe(lease1);
    expect((await database.query<{ done: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as done
    `, [firstQueue.id, lease1])).rows).toEqual([{ done: false }]);
    expect((await database.query<{ done: boolean }>(`
      select public.finish_file_cleanup_object($1, $2) as done
    `, [firstQueue.id, lease2])).rows).toEqual([{ done: true }]);
  });

  it('stages beyond a persistent first page of already-queued attachment candidates', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id, 'Pagination');
    await database.query(`
      with generated as (
        select extensions.gen_random_uuid() as id from generate_series(1, 101)
      )
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
        state, sha256, created_by, quarantine_expires_at, completed_at, storage_layout
      )
      select id, $1, $2, 'page.txt', 'text/plain', 1, id::text,
        'ready', repeat('c', 64), $3, null, clock_timestamp(), 'opaque'
      from generated
    `, [actor.workspace_id, taskId, actor.user_id]);
    await database.query(`
      update public.tasks set deleted_at = clock_timestamp() - interval '31 days' where id = $1
    `, [taskId]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where attachment_id in (select id from public.attachments where task_id = $1)
    `, [taskId])).rows).toEqual([{ count: 100 }]);
    await database.query('select public.stage_file_cleanup()');
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.file_cleanup_queue
      where attachment_id in (select id from public.attachments where task_id = $1)
    `, [taskId])).rows).toEqual([{ count: 101 }]);
  });

  it('reschedules fifty failed file leases so a healthy fifty-first object is visible next cycle', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    await database.query(`
      with generated as (
        select extensions.gen_random_uuid() as storage_path, series
        from generate_series(1, 51) as series
      )
      insert into public.file_cleanup_queue (workspace_id, storage_path, remove_after)
      select $1, storage_path::text, clock_timestamp() - interval '1 hour' + series * interval '1 second'
      from generated
    `, [actor.workspace_id]);
    const first = (await database.query<{ id: string }>(`
      select id::text from public.list_due_file_cleanup()
    `)).rows;
    expect(first).toHaveLength(50);
    for (const candidate of first) {
      const lease = (await database.query<{ lease: string }>(`
        select public.prepare_file_cleanup_object($1)::text as lease
      `, [candidate.id])).rows[0]!.lease;
      expect((await database.query<{ failed: boolean }>(`
        select public.fail_file_cleanup_object($1, $2, 'storage_unavailable') as failed
      `, [candidate.id, lease])).rows).toEqual([{ failed: true }]);
    }
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.list_due_file_cleanup()
    `)).rows).toEqual([{ count: 1 }]);
  });

  it('does not let one hundred Storage-blocked parents starve a later purgeable task', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    await database.query(`
      insert into public.tasks (workspace_id, title, status_id, deleted_at)
      select $1, 'Blocked ' || series::text, status.id, clock_timestamp() - interval '40 days'
      from generate_series(1, 100) as series
      cross join lateral (
        select id from public.task_statuses where workspace_id = $1 order by position limit 1
      ) as status
    `, [actor.workspace_id]);
    await database.query(`
      with blocked as (
        select task.*, extensions.gen_random_uuid() as attachment_id
        from public.tasks as task
        where task.workspace_id = $1 and task.title like 'Blocked %'
      )
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path,
        state, sha256, created_by, quarantine_expires_at, completed_at,
        storage_layout, deleted_at
      )
      select attachment_id, workspace_id, id,
        'blocked.txt', 'text/plain', 1, attachment_id::text,
        'ready', repeat('d', 64), $2, null, clock_timestamp(),
        'opaque', deleted_at
      from blocked
    `, [actor.workspace_id, actor.user_id]);
    const clean = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id, deleted_at)
      select $1, 'Clean after blocked', id, clock_timestamp() - interval '31 days'
      from public.task_statuses where workspace_id = $1 order by position limit 1
      returning id::text
    `, [actor.workspace_id])).rows[0]!.id;
    await database.query('select public.purge_deleted_records()');
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.tasks where id = $1
    `, [clean])).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.tasks where title like 'Blocked %'
    `)).rows).toEqual([{ count: 100 }]);
  });

  it('discovers an orphan beyond one hundred already-known durable queue rows', async () => {
    const database = await createDatabase();
    const observed = '2026-08-10T10:00:00.000000Z';
    await database.query(`
      with generated as (
        select extensions.gen_random_uuid() as path from generate_series(1, 101)
      )
      insert into storage.objects (bucket_id, name, created_at)
      select 'workspace-files', path::text, $1::timestamptz - interval '3 days'
      from generated
    `, [observed]);
    await database.query(`
      insert into public.global_file_orphan_queue (
        storage_path, provider_created_at, first_seen_at, remove_after
      )
      select name, created_at, $1::timestamptz - interval '2 days', $1::timestamptz - interval '1 day'
      from storage.objects where bucket_id = 'workspace-files'
      order by created_at, name limit 100
    `, [observed]);
    await database.query('select private.discover_global_file_orphans_at($1)', [observed]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.global_file_orphan_queue
    `)).rows).toEqual([{ count: 101 }]);
  });

  it('purges task children in FK-safe order, keeps audit, and leaves protected workspace taxonomy', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const taskId = await task(database, actor.workspace_id, 'Purge children');
    await database.query(`
      insert into public.comments (workspace_id, task_id, author_id, body, deleted_at)
      values ($1, $2, $3, 'old', clock_timestamp() - interval '31 days')
    `, [actor.workspace_id, taskId, actor.membership_id]);
    await database.query(`
      insert into public.reminders (workspace_id, task_id, recipient_id, remind_at, deleted_at)
      values ($1, $2, $3, clock_timestamp() - interval '40 days', clock_timestamp() - interval '31 days')
    `, [actor.workspace_id, taskId, actor.membership_id]);
    await database.query(`update public.tasks set deleted_at = clock_timestamp() - interval '31 days' where id = $1`, [taskId]);
    const sourceEvent = (await database.query<{ id: string }>(`
      select id::text from public.audit_events where workspace_id = $1 and entity_id = $2
      order by occurred_at desc limit 1
    `, [actor.workspace_id, taskId])).rows[0]!.id;
    const outbox = (await database.query<{ id: string }>(`
      insert into public.notification_outbox (
        workspace_id, task_id, recipient_id, source_event_id, kind, idempotency_key
      ) values ($1, $2, $3, $4, 'assignment', $5) returning id::text
    `, [actor.workspace_id, taskId, actor.membership_id, sourceEvent, `purge:${taskId}`])).rows[0]!.id;
    await database.query(`
      insert into public.notification_deliveries (
        workspace_id, task_id, recipient_id, outbox_id, telegram_message_id
      ) values ($1, $2, $3, $4, 1)
    `, [actor.workspace_id, taskId, actor.membership_id, outbox]);
    const auditBefore = (await database.query<{ count: number }>('select count(*)::int as count from public.audit_events')).rows[0]!.count;
    await database.query('select public.purge_deleted_records()');
    expect((await database.query<{ count: number }>('select count(*)::int as count from public.tasks where id = $1', [taskId])).rows)
      .toEqual([{ count: 0 }]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.notification_outbox where task_id = $1
    `, [taskId])).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ count: number }>('select count(*)::int as count from public.audit_events')).rows[0]!.count)
      .toBeGreaterThanOrEqual(auditBefore);
    expect((await database.query<{ count: number }>('select count(*)::int as count from public.workspaces where id = $1', [actor.workspace_id])).rows)
      .toEqual([{ count: 1 }]);
    expect((await database.query<{ count: number }>('select count(*)::int as count from public.task_statuses where workspace_id = $1', [actor.workspace_id])).rows[0]!.count)
      .toBeGreaterThan(0);
  });

  it('keeps cleanup tables and RPCs service-only', async () => {
    const database = await createDatabase();
    expect((await database.query<{ browser_select: boolean; service_select: boolean }>(`
      select
        has_table_privilege('authenticated', 'public.global_file_orphan_queue', 'select') as browser_select,
        has_table_privilege('service_role', 'public.global_file_orphan_queue', 'select') as service_select
    `)).rows).toEqual([{ browser_select: false, service_select: true }]);
    expect((await database.query<{ browser_execute: boolean; service_execute: boolean }>(`
      select
        has_function_privilege('authenticated', 'public.stage_file_cleanup()', 'execute') as browser_execute,
        has_function_privilege('service_role', 'public.stage_file_cleanup()', 'execute') as service_execute
    `)).rows).toEqual([{ browser_execute: false, service_execute: true }]);
  });

  it('rejects NULL cleanup failure codes without mutating either owned lease', async () => {
    const database = await createDatabase();
    const actor = await owner(database);
    const filePath = '17171717-1717-4717-8717-171717171717';
    const orphanPath = '18181818-1818-4818-8818-181818181818';
    const fileLease = '19191919-1919-4919-8919-191919191919';
    const orphanLease = '20202020-2020-4020-8020-202020202020';
    const fileQueue = (await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (
        workspace_id, storage_path, remove_after, lease_id, lease_expires_at, attempts
      ) values ($1, $2, clock_timestamp() - interval '1 hour', $3, clock_timestamp() + interval '5 minutes', 1)
      returning id::text
    `, [actor.workspace_id, filePath, fileLease])).rows[0]!.id;
    await database.query(`
      insert into public.global_file_orphan_queue (
        storage_path, provider_created_at, first_seen_at, remove_after,
        lease_id, lease_expires_at, attempts
      ) values (
        $1, clock_timestamp() - interval '3 days', clock_timestamp() - interval '2 days',
        clock_timestamp() - interval '1 day', $2, clock_timestamp() + interval '5 minutes', 1
      )
    `, [orphanPath, orphanLease]);
    await expect(database.query(`
      select public.fail_file_cleanup_object($1, $2, null)
    `, [fileQueue, fileLease])).rejects.toThrow(/file_cleanup_error_invalid/);
    await expect(database.query(`
      select public.fail_global_file_orphan($1, $2, null)
    `, [orphanPath, orphanLease])).rejects.toThrow(/orphan_cleanup_error_invalid/);
    expect((await database.query<{ file_owned: boolean; orphan_owned: boolean }>(`
      select
        (select lease_id = $2 from public.file_cleanup_queue where id = $1) as file_owned,
        (select lease_id = $4 from public.global_file_orphan_queue where storage_path = $3) as orphan_owned
    `, [fileQueue, fileLease, orphanPath, orphanLease])).rows)
      .toEqual([{ file_owned: true, orphan_owned: true }]);
  });
});
