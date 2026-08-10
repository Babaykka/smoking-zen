// @vitest-environment node

import { readdir, readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  safePersistedUrlTextFixtures,
  unsafeDecodedCodepointUrlFixtures,
  unsafePersistedUrlTextFixtures,
} from '@/domain/__tests__/safe-content-fixtures';

const databases: PGlite[] = [];

async function initializeDatabase() {
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
      id uuid primary key default extensions.gen_random_uuid(), bucket_id text, name text
    );
    create schema realtime;
    create table realtime.messages (
      id uuid primary key default extensions.gen_random_uuid(), extension text, topic text, event text, payload jsonb
    );
    create function realtime.send(payload jsonb, event text, topic text, private boolean)
      returns void language sql volatile set search_path = '' as
      'insert into realtime.messages (extension, topic, event, payload) values (''broadcast'', topic, event, payload)';
    create function realtime.topic() returns text language sql stable set search_path = ''
      as 'select nullif(current_setting(''realtime.topic'', true), '''')::text';
    grant usage on schema public, storage, realtime to anon, authenticated, service_role;
    grant all privileges on storage.objects to anon, authenticated, service_role;
    grant all privileges on realtime.messages to anon, authenticated, service_role;
    alter default privileges in schema public grant all privileges on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all privileges on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  return database;
}

async function migrationFiles() {
  return (await readdir('supabase/migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
    .map((name) => `supabase/migrations/${name}`);
}

async function apply(database: PGlite, filename: string) {
  const sql = (await readFile(filename, 'utf8')).replace(
    'create extension if not exists pgcrypto with schema extensions;', '',
  );
  await database.exec(sql);
}

async function applyAll(database: PGlite) {
  for (const filename of await migrationFiles()) await apply(database, filename);
}

async function bootstrapOwner(database: PGlite) {
  const result = await database.query<{ user_id: string; workspace_id: string }>(`
    select user_id::text, workspace_id::text from public.bootstrap_telegram_user(
      '4503599627370495', 'Владелец', null, 'task8_owner', 'ru', '4503599627370495', 'Smoking Zen Task 8'
    )
  `);
  return result.rows[0]!;
}

async function expectServiceRoleKnowledgeWrites(
  database: PGlite,
  workspaceId: string,
  suffix: string,
) {
  await database.exec('set role service_role');
  try {
    const note = (await database.query<{ id: string }>(`
      insert into public.knowledge_items (workspace_id, title, body, kind, link_url)
      values ($1, $2, 'Без внешней ссылки', 'note', null)
      returning id::text
    `, [workspaceId, `ACL note ${suffix}`])).rows[0]!;
    await database.query(`
      update public.knowledge_items
      set body = 'Обновлённая заметка', link_url = null
      where workspace_id = $1 and id = $2
    `, [workspaceId, note.id]);
    const link = (await database.query<{ id: string }>(`
      insert into public.knowledge_items (workspace_id, title, body, kind, link_url)
      values ($1, $2, '', 'link', 'https://example.com/guides/opening-checklist-v2.pdf')
      returning id::text
    `, [workspaceId, `ACL link ${suffix}`])).rows[0]!;
    await database.query(`
      update public.knowledge_items
      set link_url = 'https://example.com/guides/closing-checklist-v2.pdf'
      where workspace_id = $1 and id = $2
    `, [workspaceId, link.id]);
  } finally {
    await database.exec('reset role');
  }
}

async function createReadyAttachment(
  database: PGlite,
  owner: { user_id: string; workspace_id: string },
  taskId: string,
  attachmentId: string,
) {
  const quarantinePath = crypto.randomUUID();
  await database.query(`
    insert into public.attachments (
      id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
    ) values ($1, $2, $3, 'scheme.pdf', 'application/pdf', 2048, $4, $5, clock_timestamp() + interval '15 minutes')
  `, [attachmentId, owner.workspace_id, taskId, quarantinePath, owner.user_id]);
  await database.query('select public.arm_attachment_ready_cleanup($1, $2, $3)', [
    owner.workspace_id, attachmentId, attachmentId,
  ]);
  const validationLease = (await database.query<{ lease_id: string }>(`
    select public.claim_attachment_validation($1, $2, $3)::text as lease_id
  `, [owner.workspace_id, attachmentId, quarantinePath])).rows[0]!.lease_id;
  await database.query(`select * from public.complete_attachment_upload(
    $1, $2, $3, $4, 'scheme.pdf', 'application/pdf', 2048, repeat('a', 64), $5
  )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId, validationLease]);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('ordered migration replay', () => {
  it('applies the entire chain twice and converges to the authoritative signatures', async () => {
    const database = await initializeDatabase();
    const migrations = await migrationFiles();
    expect(migrations.at(0)).toContain('0001_');

    for (let round = 0; round < 2; round += 1) {
      for (const filename of migrations) await apply(database, filename);
    }

    const signatures = await database.query<{ signature: string }>(`
      select oid::regprocedure::text as signature
      from pg_catalog.pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('prepare_file_cleanup_object', 'set_attachment_deleted', 'complete_attachment_upload')
      order by signature
    `);
    expect(signatures.rows.map(({ signature }) => signature)).toContain('prepare_file_cleanup_object(uuid)');
    expect(signatures.rows.map(({ signature }) => signature)).toContain('set_attachment_deleted(uuid,uuid,integer,boolean)');
    expect(signatures.rows.map(({ signature }) => signature)).toContain(
      'complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text,uuid)',
    );
    expect(signatures.rows.map(({ signature }) => signature)).not.toContain(
      'complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text)',
    );

    const publicTables = await database.query<{
      name: string; rls: boolean; anon_select: boolean; anon_insert: boolean; anon_update: boolean; anon_delete: boolean;
      auth_select: boolean; auth_insert: boolean; auth_update: boolean; auth_delete: boolean;
    }>(`
      select relation.relname as name, relation.relrowsecurity as rls,
        has_table_privilege('anon', relation.oid, 'select') as anon_select,
        has_table_privilege('anon', relation.oid, 'insert') as anon_insert,
        has_table_privilege('anon', relation.oid, 'update') as anon_update,
        has_table_privilege('anon', relation.oid, 'delete') as anon_delete,
        has_table_privilege('authenticated', relation.oid, 'select') as auth_select,
        has_table_privilege('authenticated', relation.oid, 'insert') as auth_insert,
        has_table_privilege('authenticated', relation.oid, 'update') as auth_update,
        has_table_privilege('authenticated', relation.oid, 'delete') as auth_delete
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relkind = 'r'
      order by relation.relname
    `);
    expect(publicTables.rows.map(({ name }) => name)).toEqual([
      'app_users', 'attachments', 'audit_events', 'comments', 'contact_methods', 'contacts',
      'file_cleanup_queue', 'global_file_orphan_queue', 'invitations', 'knowledge_items',
      'notification_deliveries', 'notification_outbox', 'reminders', 'sections', 'secure_items',
      'task_statuses', 'tasks', 'telegram_session_rate_limits', 'telegram_webhook_updates',
      'workspace_members', 'workspaces',
    ]);
    for (const table of publicTables.rows) {
      expect(table, table.name).toMatchObject({
        rls: true,
        anon_select: false, anon_insert: false, anon_update: false, anon_delete: false,
        auth_select: false, auth_insert: false, auth_update: false, auth_delete: false,
      });
    }

    const browserFunctions = await database.query<{ schema: string; signature: string; anon: boolean; authenticated: boolean }>(`
      select namespace.nspname as schema, procedure.oid::regprocedure::text as signature,
        has_function_privilege('anon', procedure.oid, 'execute') as anon,
        has_function_privilege('authenticated', procedure.oid, 'execute') as authenticated
      from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname in ('public', 'private')
        and (
          has_function_privilege('anon', procedure.oid, 'execute')
          or has_function_privilege('authenticated', procedure.oid, 'execute')
        )
      order by namespace.nspname, signature
    `);
    expect(browserFunctions.rows.filter(({ schema }) => schema === 'public')).toEqual([]);
    expect(browserFunctions.rows.filter(({ schema }) => schema === 'private').map(({ signature, anon, authenticated }) => ({ signature, anon, authenticated }))).toEqual([
      { signature: 'private.broadcast_workspace_id(text)', anon: false, authenticated: true },
      { signature: 'private.is_workspace_member(uuid)', anon: false, authenticated: true },
      { signature: 'private.is_workspace_owner(uuid)', anon: false, authenticated: true },
      { signature: 'private.storage_workspace_id(text)', anon: false, authenticated: true },
    ]);

    const servicePrivateFunctions = await database.query<{ signature: string }>(`
      select procedure.oid::regprocedure::text as signature
      from pg_proc as procedure
      where procedure.pronamespace = 'private'::regnamespace
        and has_function_privilege('service_role', procedure.oid, 'execute')
      order by signature
    `);
    expect(servicePrivateFunctions.rows.map(({ signature }) => signature)).toEqual([
      'private.broadcast_workspace_id(text)',
      'private.ensure_quarantine_cleanup_guard(uuid,uuid,text,timestamp with time zone)',
      'private.is_workspace_member(uuid)',
      'private.is_workspace_owner(uuid)',
      'private.knowledge_url_is_safe(text)',
      'private.percent_decode_url_component(text)',
      'private.persisted_text_is_safe(text)',
      'private.secure_item_normalize(text)',
      'private.secure_item_scan_text(text)',
      'private.secure_item_text_is_safe(text)',
      'private.secure_item_url_is_safe(text)',
      'private.storage_workspace_id(text)',
    ]);

    const peripheral = await database.query<{
      storage_rls: boolean; storage_anon: boolean; storage_auth: boolean; realtime_rls: boolean;
      realtime_anon: boolean; realtime_auth_select: boolean; realtime_auth_insert: boolean;
      realtime_auth_update: boolean; realtime_auth_delete: boolean;
    }>(`
      select
        (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) as storage_rls,
        has_table_privilege('anon', 'storage.objects', 'select') as storage_anon,
        has_table_privilege('authenticated', 'storage.objects', 'select') as storage_auth,
        (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass) as realtime_rls,
        has_table_privilege('anon', 'realtime.messages', 'select') as realtime_anon,
        has_table_privilege('authenticated', 'realtime.messages', 'select') as realtime_auth_select,
        has_table_privilege('authenticated', 'realtime.messages', 'insert') as realtime_auth_insert,
        has_table_privilege('authenticated', 'realtime.messages', 'update') as realtime_auth_update,
        has_table_privilege('authenticated', 'realtime.messages', 'delete') as realtime_auth_delete
    `);
    expect(peripheral.rows).toEqual([{
      storage_rls: true, storage_anon: false, storage_auth: false,
      realtime_rls: true, realtime_anon: false, realtime_auth_select: true,
      realtime_auth_insert: false, realtime_auth_update: false, realtime_auth_delete: false,
    }]);
    expect((await database.query<{ policy: string; command: string; roles: string }>(`
      select policyname as policy, cmd as command, roles::text
      from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    `)).rows).toEqual([{
      policy: 'workspace_broadcast_realtime_select', command: 'SELECT', roles: '{authenticated}',
    }]);

    const bearerTables = [
      'app_users', 'workspace_members', 'knowledge_items', 'contacts', 'secure_items', 'attachments',
      'notification_outbox', 'notification_deliveries', 'file_cleanup_queue', 'global_file_orphan_queue',
      'telegram_webhook_updates',
    ];
    await database.exec('set role authenticated');
    try {
      for (const table of bearerTables) {
        for (const statement of [
          `select * from public.${table} limit 1`,
          `insert into public.${table} default values`,
          `update public.${table} set id = id`,
          `delete from public.${table}`,
        ]) {
          await expect(database.exec(statement), `${table}: ${statement.split(' ')[0]}`).rejects.toThrow(/permission denied/iu);
        }
      }
      for (const statement of [
        `select public.reserve_attachment_upload(null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null, null, null, null)`,
        `select public.cancel_attachment_upload_reservation(null::uuid, null::uuid, null)`,
        `select public.claim_attachment_validation(null::uuid, null::uuid, null)`,
        `select public.release_attachment_validation(null::uuid, null::uuid, null, null::uuid)`,
        `select public.retire_quarantine_attachment(null::uuid, null::uuid, null, null, null::uuid)`,
        `select * from public.complete_attachment_upload(null::uuid, null::uuid, null, null, null, null, null, null, null::uuid)`,
        `select * from public.update_own_profile('forged', null, null)`,
      ]) {
        await expect(database.exec(statement)).rejects.toThrow(/permission denied/iu);
      }
    } finally {
      await database.exec('reset role');
    }

    await database.exec(`
      create table public.future_task8_private (id uuid primary key default extensions.gen_random_uuid());
      create function public.future_task8_private_rpc() returns integer language sql as 'select 1';
    `);
    expect((await database.query<{ anon_table: boolean; auth_table: boolean; anon_rpc: boolean; auth_rpc: boolean }>(`
      select
        has_table_privilege('anon', 'public.future_task8_private', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.future_task8_private', 'select') as auth_table,
        has_function_privilege('anon', 'public.future_task8_private_rpc()', 'execute') as anon_rpc,
        has_function_privilege('authenticated', 'public.future_task8_private_rpc()', 'execute') as auth_rpc
    `)).rows).toEqual([{ anon_table: false, auth_table: false, anon_rpc: true, auth_rpc: true }]);
    // PGlite retains PostgreSQL's implicit PUBLIC EXECUTE on a newly created
    // function at runtime; inspect the authoritative default ACL catalog too.
    expect((await database.query<{ leaks: number }>(`
      select count(*)::integer as leaks
      from pg_default_acl as defaults
      cross join lateral aclexplode(defaults.defaclacl) as grant_entry
      where defaults.defaclnamespace = 'public'::regnamespace
        and defaults.defaclobjtype = 'f'
        and grant_entry.grantee in (
          0,
          'anon'::regrole::oid,
          'authenticated'::regrole::oid
        )
    `)).rows).toEqual([{ leaks: 0 }]);
  }, 30_000);

  it('preserves exact private CHECK-helper privileges through double replay and restore hardening', async () => {
    const database = await initializeDatabase();
    const migrations = await migrationFiles();
    for (let round = 0; round < 2; round += 1) {
      for (const filename of migrations) await apply(database, filename);
    }
    const owner = await bootstrapOwner(database);

    await expectServiceRoleKnowledgeWrites(database, owner.workspace_id, 'after replay');
    await database.exec(`
      create function private.future_task8_private_probe()
      returns integer language sql set search_path = '' as 'select 1';
    `);
    await database.exec(await readFile('supabase/operations/restore_acl_0019.sql', 'utf8'));
    await expectServiceRoleKnowledgeWrites(database, owner.workspace_id, 'after restore ACL');

    expect((await database.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select
        has_function_privilege('anon', 'private.future_task8_private_probe()', 'execute') as anon,
        has_function_privilege('authenticated', 'private.future_task8_private_probe()', 'execute') as authenticated,
        has_function_privilege('service_role', 'private.future_task8_private_probe()', 'execute') as service
    `)).rows).toEqual([{ anon: false, authenticated: false, service: false }]);
    expect((await database.query<{ leaks: number }>(`
      select count(*)::integer as leaks
      from pg_default_acl as defaults
      cross join lateral aclexplode(defaults.defaclacl) as grant_entry
      where defaults.defaclnamespace = 'private'::regnamespace
        and defaults.defaclobjtype = 'f'
        and grant_entry.grantee in (
          0,
          'anon'::regrole::oid,
          'authenticated'::regrole::oid
        )
    `)).rows).toEqual([{ leaks: 0 }]);
  }, 30_000);

  it('provides DB-clock versioned delete transitions for every recoverable entity', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const functions = await database.query<{ signature: string; definition: string }>(`
      select oid::regprocedure::text as signature, pg_get_functiondef(oid) as definition
      from pg_catalog.pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('set_task_deleted', 'set_knowledge_deleted', 'set_secure_item_deleted', 'set_attachment_deleted')
      order by signature
    `);

    expect(functions.rows.map(({ signature }) => signature)).toEqual([
      'set_attachment_deleted(uuid,uuid,integer,boolean)',
      'set_knowledge_deleted(uuid,uuid,integer)',
      'set_secure_item_deleted(uuid,uuid,integer)',
      'set_task_deleted(uuid,uuid,integer)',
    ]);
    for (const { definition } of functions.rows) {
      expect(definition).toMatch(/clock_timestamp\(\)/u);
      expect(definition).not.toMatch(/p_(?:deleted_at|timestamp|now)/u);
      expect(definition).toMatch(/version is distinct from p_expected_version/u);
    }
    const attachmentDefinition = functions.rows.find(({ signature }) => signature.startsWith('set_attachment_deleted'))!.definition;
    expect(attachmentDefinition).toMatch(/p_restore is null/u);
    const contactDefinition = (await database.query<{ definition: string }>(`
      select pg_get_functiondef('public.set_contact_deleted(uuid,uuid,integer,boolean)'::regprocedure) as definition
    `)).rows[0]!.definition.toLowerCase();
    expect(contactDefinition.indexOf('operation_time := clock_timestamp()'))
      .toBeGreaterThan(contactDefinition.indexOf('for update'));
    expect(contactDefinition.indexOf('operation_time := clock_timestamp()'))
      .toBeLessThan(contactDefinition.indexOf('update public.contacts'));
  });

  it('uses the database clock and rejects NULL versions, cross-workspace targets, and public execution', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const secondOwner = (await database.query<{ workspace_id: string }>(`
      select workspace_id::text from public.bootstrap_telegram_user(
        '123456789', 'Другой владелец', null, 'task8_other', 'ru', '123456789', 'Other workspace'
      )
    `)).rows[0]!;
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string; version: number }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Проверка времени', $2) returning id::text, version
    `, [owner.workspace_id, status.id])).rows[0]!;
    const knowledge = (await database.query<{ id: string; version: number }>(`
      insert into public.knowledge_items (workspace_id, title, kind)
      values ($1, 'Регламент', 'note') returning id::text, version
    `, [owner.workspace_id])).rows[0]!;
    const secureItem = (await database.query<{ id: string; version: number }>(`
      insert into public.secure_items (workspace_id, title, external_url, purpose, owner)
      values ($1, 'Касса', 'https://vault.bitwarden.com', 'Доступ к кассе', 'Управляющий')
      returning id::text, version
    `, [owner.workspace_id])).rows[0]!;

    await expect(database.query(
      'select * from public.set_task_deleted($1, $2, $3::integer)',
      [owner.workspace_id, task.id, null],
    )).rejects.toThrow(/version_conflict/iu);
    await expect(database.query(
      'select * from public.set_knowledge_deleted($1, $2, $3::integer)',
      [secondOwner.workspace_id, knowledge.id, knowledge.version],
    )).rejects.toThrow(/knowledge_not_found/iu);

    const lowerBound = (await database.query<{ now: string }>('select clock_timestamp()::text as now')).rows[0]!.now;
    await database.query('select * from public.set_task_deleted($1, $2, $3)', [owner.workspace_id, task.id, task.version]);
    await database.query('select * from public.set_knowledge_deleted($1, $2, $3)', [owner.workspace_id, knowledge.id, knowledge.version]);
    await database.query('select * from public.set_secure_item_deleted($1, $2, $3)', [owner.workspace_id, secureItem.id, secureItem.version]);
    const upperBound = (await database.query<{ now: string }>('select clock_timestamp()::text as now')).rows[0]!.now;
    const timestamps = await database.query<{ deleted_at: string }>(`
      select deleted_at::text from public.tasks where id = $1
      union all select deleted_at::text from public.knowledge_items where id = $2
      union all select deleted_at::text from public.secure_items where id = $3
    `, [task.id, knowledge.id, secureItem.id]);
    for (const { deleted_at: deletedAt } of timestamps.rows) {
      expect(new Date(deletedAt).getTime()).toBeGreaterThanOrEqual(new Date(lowerBound).getTime());
      expect(new Date(deletedAt).getTime()).toBeLessThanOrEqual(new Date(upperBound).getTime());
    }

    const privileges = await database.query<{ signature: string; anon: boolean; authenticated: boolean; service: boolean }>(`
      select signature,
        has_function_privilege('anon', signature, 'execute') as anon,
        has_function_privilege('authenticated', signature, 'execute') as authenticated,
        has_function_privilege('service_role', signature, 'execute') as service
      from unnest(array[
        'public.set_task_deleted(uuid,uuid,integer)',
        'public.set_knowledge_deleted(uuid,uuid,integer)',
        'public.set_secure_item_deleted(uuid,uuid,integer)',
        'public.set_attachment_deleted(uuid,uuid,integer,boolean)',
        'public.restore_task_record(uuid,uuid,integer)',
        'public.restore_knowledge_record(uuid,uuid,integer)',
        'public.restore_secure_item_record(uuid,uuid,integer)',
        'public.set_contact_deleted(uuid,uuid,integer,boolean)',
        'public.reserve_attachment_upload(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text)',
        'public.cancel_attachment_upload_reservation(uuid,uuid,text)',
        'public.claim_attachment_validation(uuid,uuid,text)',
        'public.release_attachment_validation(uuid,uuid,text,uuid)',
        'public.retire_quarantine_attachment(uuid,uuid,text,text,uuid)',
        'public.complete_attachment_upload(uuid,uuid,text,text,text,text,bigint,text,uuid)'
      ]) as signature
    `);
    expect(privileges.rows).toHaveLength(14);
    for (const privilege of privileges.rows) {
      expect(privilege).toMatchObject({ anon: false, authenticated: false, service: true });
    }
  }, 30_000);

  it('preserves comments for Trash while rejecting comments on a deleted parent', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const member = (await database.query<{ id: string }>(`
      select id::text from public.workspace_members where workspace_id = $1 and user_id = $2
    `, [owner.workspace_id, owner.user_id])).rows[0]!;
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string; version: number }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Задача с обсуждением', $2) returning id::text, version
    `, [owner.workspace_id, status.id])).rows[0]!;
    const commentId = (await database.query<{ id: string }>(`
      insert into public.comments (workspace_id, task_id, author_id, body)
      values ($1, $2, $3, 'Проверено') returning id::text
    `, [owner.workspace_id, task.id, member.id])).rows[0]!.id;

    const archivedTask = (await database.query<{ version: number; deleted_at: string }>(`
      select version, deleted_at::text from public.set_task_deleted($1, $2, $3)
    `, [owner.workspace_id, task.id, task.version])).rows[0]!;
    const archivedComment = (await database.query<{ deleted_at: string }>(
      'select deleted_at::text from public.comments where id = $1', [commentId],
    )).rows[0]!;
    expect(archivedComment.deleted_at).toBe(archivedTask.deleted_at);
    await expect(database.query(`
      insert into public.comments (workspace_id, task_id, author_id, body)
      values ($1, $2, $3, 'Не должно сохраниться')
    `, [owner.workspace_id, task.id, member.id])).rejects.toThrow(/comment_parent_not_found/iu);

    await database.query('select * from public.restore_task_record($1, $2, $3)', [
      owner.workspace_id, task.id, archivedTask.version,
    ]);
    expect((await database.query<{ deleted_at: string | null }>(
      'select deleted_at::text from public.comments where id = $1', [commentId],
    )).rows).toEqual([{ deleted_at: null }]);
  }, 30_000);

  it('enforces the canonical Bitwarden item-link grammar in SQL', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    for (const value of [
      'https://vault.bitwarden.com/hunter2',
      'https://vault.bitwarden.com/?item=hunter2',
      'https://vault.bitwarden.com/#/items/hunter2',
      'https://vault.bitwarden.com/#/vault?itemId=hunter2',
      'https://vault.bitwarden.com/?itemId=123e4567-e89b-12d3-a456-426614174000&extra=1',
    ]) {
      expect((await database.query<{ safe: boolean }>(
        'select private.secure_item_url_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: false }]);
    }
    for (const value of [
      'https://vault.bitwarden.com',
      'https://vault.bitwarden.com/?itemId=123e4567-e89b-12d3-a456-426614174000',
      'https://vault.example.org/#/vault?itemId=123e4567-e89b-12d3-a456-426614174000',
    ]) {
      expect((await database.query<{ safe: boolean }>(
        'select private.secure_item_url_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: true }]);
    }
  });

  it('rejects query, fragment, and opaque signed-token knowledge links in SQL', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    for (const value of [
      'https://example.com/guide?file=opaque',
      'https://example.com/guide#signed',
      `https://example.com/files/${'a'.repeat(64)}`,
      `https://example.com/files/${'A1b2C3d4E5f6G7h8I9j0_K-lMnOpQrStUvWxYz'.repeat(2)}`,
      `https://example.com/files/${'%61'.repeat(64)}`,
      `https://example.com/files/${'%2561'.repeat(64)}`,
      'https://example.com/files/%zz',
    ]) {
      expect((await database.query<{ safe: boolean }>(
        'select private.knowledge_url_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: false }]);
    }
    expect((await database.query<{ safe: boolean }>(
      'select private.knowledge_url_is_safe($1) as safe',
      ['https://example.com/guides/opening-checklist-v2.pdf'],
    )).rows).toEqual([{ safe: true }]);
  });

  it('rejects the explicit decoded-codepoint URL matrix in both SQL helpers', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const urls = unsafeDecodedCodepointUrlFixtures.map(({ url }) => url);
    expect((await database.query<{ safe: boolean }>(`
      select private.knowledge_url_is_safe(url) as safe
      from unnest($1::text[]) with ordinality as unsafe(url, ordinality)
      order by ordinality
    `, [urls])).rows).toEqual(urls.map(() => ({ safe: false })));
    expect((await database.query<{ safe: boolean }>(`
      select private.persisted_text_is_safe('Инструкция: ' || url) as safe
      from unnest($1::text[]) with ordinality as unsafe(url, ordinality)
      order by ordinality
    `, [urls])).rows).toEqual(urls.map(() => ({ safe: false })));
  });

  it('matches the application persisted free-text URL matrix in SQL', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    for (const value of unsafePersistedUrlTextFixtures) {
      expect((await database.query<{ safe: boolean }>(
        'select private.persisted_text_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: false }]);
    }
    for (const value of safePersistedUrlTextFixtures) {
      expect((await database.query<{ safe: boolean }>(
        'select private.persisted_text_is_safe($1) as safe', [value],
      )).rows).toEqual([{ safe: true }]);
    }
  });

  it('removes unsafe legacy knowledge URLs instead of creating a false replacement link', async () => {
    const database = await initializeDatabase();
    const migrations = await migrationFiles();
    const migration0018Index = migrations.findIndex((name) => name.includes('/0018_'));
    for (const filename of migrations.slice(0, migration0018Index)) await apply(database, filename);
    const owner = await bootstrapOwner(database);
    const unsafeLinks = [
      `https://storage.example/files/${'a'.repeat(64)}`,
      `https://storage.example/files/${'%61'.repeat(64)}`,
      `https://storage.example/files/${'%2561'.repeat(64)}`,
      'https://storage.example/files/%zz',
    ];
    const items = (await database.query<{ id: string }>(`
      insert into public.knowledge_items (workspace_id, title, kind, link_url)
      select $1, 'Старая подписанная ссылка ' || ordinality, 'link', link_url
      from unnest($2::text[]) with ordinality as unsafe(link_url, ordinality)
      returning id::text
    `, [owner.workspace_id, unsafeLinks])).rows;

    await apply(database, migrations[migration0018Index]!);
    expect((await database.query<{ kind: string; link_url: string | null }>(
      'select kind, link_url from public.knowledge_items where id = any($1::uuid[]) order by id',
      [items.map(({ id }) => id)],
    )).rows).toEqual(items.map(() => ({ kind: 'note', link_url: null })));
    const audit = JSON.stringify((await database.query(
      'select entity_type, action from public.audit_events where entity_id = any($1::uuid[]) order by occurred_at',
      [items.map(({ id }) => id)],
    )).rows);
    for (const unsafeLink of unsafeLinks) expect(audit).not.toContain(unsafeLink);
  }, 30_000);

  it('scrubs decoded-codepoint legacy URLs before search and rejects service-role writes', async () => {
    const database = await initializeDatabase();
    const migrations = await migrationFiles();
    const migration0018Index = migrations.findIndex((name) => name.includes('/0018_'));
    for (const filename of migrations.slice(0, migration0018Index)) await apply(database, filename);
    const owner = await bootstrapOwner(database);
    const sentinel = 'DECODED_CODEPOINT_URL_SENTINEL';
    const urls = unsafeDecodedCodepointUrlFixtures.map(({ url }) => url);
    const legacy = (await database.query<{ id: string }>(`
      insert into public.knowledge_items (workspace_id, title, body, kind)
      select $1, 'Legacy decoded URL ' || ordinality, url || ' ' || $2, 'note'
      from unnest($3::text[]) with ordinality as unsafe(url, ordinality)
      returning id::text
    `, [owner.workspace_id, sentinel, urls])).rows;

    for (const filename of migrations.slice(migration0018Index)) await apply(database, filename);
    expect((await database.query<{ body: string }>(`
      select body from public.knowledge_items where id = any($1::uuid[]) order by id
    `, [legacy.map(({ id }) => id)])).rows).toEqual(legacy.map(() => ({ body: '' })));
    expect((await database.query(
      'select * from public.search_workspace($1, $2, 20)', [owner.workspace_id, sentinel],
    )).rows).toEqual([]);

    const safeItem = (await database.query<{ id: string }>(`
      insert into public.knowledge_items (workspace_id, title, body, kind, link_url)
      values ($1, 'Safe service-role target', '', 'link', 'https://example.com/guide')
      returning id::text
    `, [owner.workspace_id])).rows[0]!;
    await database.exec('set role service_role');
    try {
      for (const url of urls) {
        await expect(database.query(`
          insert into public.knowledge_items (workspace_id, title, body, kind, link_url)
          values ($1, 'Rejected service-role URL', '', 'link', $2)
        `, [owner.workspace_id, url])).rejects.toThrow(/knowledge_items_link_url_safe/u);
        await expect(database.query(`
          update public.knowledge_items set link_url = $1 where workspace_id = $2 and id = $3
        `, [url, owner.workspace_id, safeItem.id])).rejects.toThrow(/knowledge_items_link_url_safe/u);
      }
    } finally {
      await database.exec('reset role');
    }
  }, 30_000);

  it('scrubs unsafe legacy free text before constraints make it unsearchable and unpersistable', async () => {
    const database = await initializeDatabase();
    const migrations = await migrationFiles();
    const migration0018Index = migrations.findIndex((name) => name.includes('/0018_'));
    for (const filename of migrations.slice(0, migration0018Index)) await apply(database, filename);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const member = (await database.query<{ id: string }>(`
      select id::text from public.workspace_members where workspace_id = $1 and user_id = $2
    `, [owner.workspace_id, owner.user_id])).rows[0]!;
    const sentinel = 'URL_POLICY_SEARCH_SENTINEL';
    const unsafe = `https://example.com/guide?lang=${sentinel}`;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, description, status_id)
      values ($1, 'Legacy task URL', $2, $3) returning id::text
    `, [owner.workspace_id, unsafe, status.id])).rows[0]!;
    await database.query(`
      insert into public.comments (workspace_id, task_id, author_id, body)
      values ($1, $2, $3, $4)
    `, [owner.workspace_id, task.id, member.id, `http://example.com/${sentinel}`]);
    await database.query(`
      insert into public.knowledge_items (workspace_id, title, body, kind)
      values ($1, 'Legacy knowledge URL', $2, 'note')
    `, [owner.workspace_id, `https://example.com/files/${'%2561'.repeat(64)}-${sentinel}`]);
    await database.query(`
      insert into public.contacts (workspace_id, name, category, notes)
      values ($1, 'Legacy contact URL', 'other', $2)
    `, [owner.workspace_id, `https://user:password@example.com/${sentinel}`]);
    await database.query(`
      insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
      values ($1, 'Legacy Safe URL', $2, 'Команда', 'https://vault.bitwarden.com')
    `, [owner.workspace_id, `https://example.com/guide#${sentinel}`]);

    for (const filename of migrations.slice(migration0018Index)) await apply(database, filename);
    expect((await database.query(
      'select * from public.search_workspace($1, $2, 20)', [owner.workspace_id, sentinel],
    )).rows).toEqual([]);
    expect(JSON.stringify((await database.query(`
      select description as value from public.tasks where workspace_id = $1
      union all select body from public.comments where workspace_id = $1
      union all select body from public.knowledge_items where workspace_id = $1
      union all select notes from public.contacts where workspace_id = $1
      union all select purpose from public.secure_items where workspace_id = $1
    `, [owner.workspace_id])).rows)).not.toContain(sentinel);

    for (const statement of [
      `insert into public.tasks (workspace_id, title, description, status_id) values ($1, 'Unsafe task', $2, $3)`,
      `insert into public.comments (workspace_id, task_id, author_id, body) values ($1, $4, $5, $2)`,
      `insert into public.knowledge_items (workspace_id, title, body, kind) values ($1, 'Unsafe knowledge', $2, 'note')`,
      `insert into public.contacts (workspace_id, name, category, notes) values ($1, 'Unsafe contact', 'other', $2)`,
      `insert into public.secure_items (workspace_id, title, purpose, owner, external_url)
       values ($1, 'Unsafe Safe', $2, 'Команда', 'https://vault.bitwarden.com')`,
    ]) {
      await expect(database.query(statement, [owner.workspace_id, unsafe, status.id, task.id, member.id]))
        .rejects.toThrow();
    }
  }, 30_000);

  it('broadcasts ready attachments and Safe changes without exposing quarantine metadata', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Вложения Realtime', $2) returning id::text
    `, [owner.workspace_id, status.id])).rows[0]!;
    await database.exec('truncate table realtime.messages');

    const attachmentId = '50000000-0000-4000-8000-000000000010';
    const quarantinePath = crypto.randomUUID();
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'plan.pdf', 'application/pdf', 2048, $4, $5, clock_timestamp() + interval '15 minutes')
    `, [attachmentId, owner.workspace_id, task.id, quarantinePath, owner.user_id]);
    expect((await database.query('select * from realtime.messages')).rows).toHaveLength(0);

    await database.query('select public.arm_attachment_ready_cleanup($1, $2, $3)', [owner.workspace_id, attachmentId, attachmentId]);
    const validationLease = (await database.query<{ lease_id: string }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as lease_id
    `, [owner.workspace_id, attachmentId, quarantinePath])).rows[0]!.lease_id;
    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'plan.pdf', 'application/pdf', 2048, repeat('b', 64), $5
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId, validationLease]);
    await database.query(`
      insert into public.secure_items (workspace_id, title, external_url, purpose, owner)
      values ($1, 'Касса', 'https://vault.bitwarden.com', 'Доступ к кассе', 'Управляющий')
    `, [owner.workspace_id]);

    const broadcasts = await database.query<{ payload: { entity: string; action: string }; topic: string }>(`
      select payload, topic from realtime.messages order by event
    `);
    expect(broadcasts.rows).toEqual(expect.arrayContaining([
      { payload: { entity: 'attachment', action: 'created' }, topic: `workspace:${owner.workspace_id}` },
      { payload: { entity: 'secure_item', action: 'created' }, topic: `workspace:${owner.workspace_id}` },
    ]));
    expect(JSON.stringify(broadcasts.rows)).not.toContain(quarantinePath);
  }, 30_000);

  it('archives/restores ready metadata on the DB boundary and inherits the exact parent timestamp', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id]);
    const tasks = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Родитель', $2), ($1, 'Живой родитель', $2)
      returning id::text
    `, [owner.workspace_id, status.rows[0]!.id]);
    const inheritedId = '50000000-0000-4000-8000-000000000001';
    const individualId = '50000000-0000-4000-8000-000000000002';
    await createReadyAttachment(database, owner, tasks.rows[0]!.id, inheritedId);
    await createReadyAttachment(database, owner, tasks.rows[1]!.id, individualId);

    const taskVersion = await database.query<{ version: number }>('select version from public.tasks where id = $1', [tasks.rows[0]!.id]);
    await database.query('select * from public.set_task_deleted($1, $2, $3)', [
      owner.workspace_id, tasks.rows[0]!.id, taskVersion.rows[0]!.version,
    ]);
    const inherited = await database.query<{ parent_deleted: string; attachment_deleted: string }>(`
      select task.deleted_at::text as parent_deleted, attachment.deleted_at::text as attachment_deleted
      from public.tasks as task join public.attachments as attachment on attachment.task_id = task.id
      where task.id = $1 and attachment.id = $2
    `, [tasks.rows[0]!.id, inheritedId]);
    expect(inherited.rows[0]!.attachment_deleted).toBe(inherited.rows[0]!.parent_deleted);

    const before = await database.query<{ storage_path: string; sha256: string; completed_at: string; version: number }>(`
      select storage_path, sha256, completed_at::text, version from public.attachments where id = $1
    `, [individualId]);
    const archived = await database.query<{ version: number; deleted_at: string }>(`
      select version, deleted_at::text from public.set_attachment_deleted($1, $2, $3, false)
    `, [owner.workspace_id, individualId, before.rows[0]!.version]);
    await expect(database.query('select * from public.set_attachment_deleted($1, $2, $3, true)', [
      owner.workspace_id, individualId, archived.rows[0]!.version - 1,
    ])).rejects.toThrow(/version_conflict/iu);
    await expect(database.query('select * from public.set_attachment_deleted($1, $2, $3, $4::boolean)', [
      owner.workspace_id, individualId, archived.rows[0]!.version, null,
    ])).rejects.toThrow(/attachment_restore_flag_required/iu);

    await database.query(`
      update public.attachments set deleted_at = clock_timestamp() - interval '29 days 23 hours 59 minutes 59 seconds'
      where id = $1
    `, [individualId]);
    const beforeCutoff = await database.query<{ version: number }>('select version from public.attachments where id = $1', [individualId]);
    const restored = await database.query<{ version: number; deleted_at: string | null }>(`
      select version, deleted_at::text from public.set_attachment_deleted($1, $2, $3, true)
    `, [owner.workspace_id, individualId, beforeCutoff.rows[0]!.version]);
    expect(restored.rows[0]!.deleted_at).toBeNull();
    const preserved = await database.query<{ storage_path: string; sha256: string; completed_at: string }>(`
      select storage_path, sha256, completed_at::text from public.attachments where id = $1
    `, [individualId]);
    expect(preserved.rows[0]).toEqual({
      storage_path: before.rows[0]!.storage_path, sha256: before.rows[0]!.sha256, completed_at: before.rows[0]!.completed_at,
    });

    const reArchived = await database.query<{ version: number }>(`
      select version from public.set_attachment_deleted($1, $2, $3, false)
    `, [owner.workspace_id, individualId, restored.rows[0]!.version]);
    await database.query(`update public.attachments set deleted_at = clock_timestamp() - interval '30 days' where id = $1`, [individualId]);
    const atCutoff = await database.query<{ version: number }>('select version from public.attachments where id = $1', [individualId]);
    expect(atCutoff.rows[0]!.version).toBeGreaterThan(reArchived.rows[0]!.version);
    await expect(database.query('select * from public.set_attachment_deleted($1, $2, $3, true)', [
      owner.workspace_id, individualId, atCutoff.rows[0]!.version,
    ])).rejects.toThrow(/restore_expired/iu);

    const actions = await database.query<{ action: string }>(`
      select action from public.audit_events where entity_type = 'attachment' and entity_id = $1 order by occurred_at
    `, [individualId]);
    expect(actions.rows.map(({ action }) => action)).toEqual(expect.arrayContaining(['deleted', 'restored']));
  }, 30_000);

  it('charges every signed reservation as 25 MiB regardless of the declared size', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Квоты загрузок', $2) returning id::text
    `, [owner.workspace_id, status.id])).rows[0]!;
    const reserve = (size: number) => database.query(`select * from public.reserve_attachment_upload(
      $1, $2, $3, null, $4, 'quota.txt', 'text/plain', $5, $6
    )`, [owner.workspace_id, crypto.randomUUID(), task.id, owner.user_id, size, crypto.randomUUID()]);

    for (let reservation = 0; reservation < 10; reservation += 1) await reserve(1);
    await expect(reserve(1)).rejects.toThrow(/upload_member_byte_quota_exceeded/iu);

    await database.query(`update public.attachments
      set created_at = clock_timestamp() - interval '2 hours' where workspace_id = $1`, [owner.workspace_id]);
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      )
      select extensions.gen_random_uuid(), $1, $2, 'workspace.txt', 'text/plain', 1,
        extensions.gen_random_uuid()::text, null, clock_timestamp() + interval '125 minutes'
      from generate_series(1, 40);
    `, [owner.workspace_id, task.id]);
    await expect(reserve(1)).rejects.toThrow(/upload_workspace_byte_quota_exceeded/iu);
  }, 30_000);

  it('requires one current database validation lease for download completion and failure retirement', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Лизинг проверки', $2) returning id::text
    `, [owner.workspace_id, status.id])).rows[0]!;
    const attachmentId = crypto.randomUUID();
    const quarantinePath = crypto.randomUUID();
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'lease.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '125 minutes')
    `, [attachmentId, owner.workspace_id, task.id, quarantinePath, owner.user_id]);

    const firstLease = (await database.query<{ lease_id: string | null }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as lease_id
    `, [owner.workspace_id, attachmentId, quarantinePath])).rows[0]!.lease_id;
    expect(firstLease).toMatch(/^[0-9a-f-]{36}$/iu);
    expect((await database.query<{ lease_id: string | null }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as lease_id
    `, [owner.workspace_id, attachmentId, quarantinePath])).rows).toEqual([{ lease_id: null }]);

    await database.query(`update public.attachments
      set validation_lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [attachmentId]);
    const reclaimedLease = (await database.query<{ lease_id: string }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as lease_id
    `, [owner.workspace_id, attachmentId, quarantinePath])).rows[0]!.lease_id;
    expect(reclaimedLease).not.toBe(firstLease);

    await database.query('select public.arm_attachment_ready_cleanup($1, $2, $3)', [
      owner.workspace_id, attachmentId, attachmentId,
    ]);
    await expect(database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'lease.txt', 'text/plain', 16, repeat('a', 64)
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId]))
      .rejects.toThrow(/does not exist|function/iu);
    await expect(database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'lease.txt', 'text/plain', 16, repeat('a', 64), $5
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId, firstLease]))
      .rejects.toThrow(/attachment_validation_lease_invalid/iu);
    await database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'lease.txt', 'text/plain', 16, repeat('a', 64), $5
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId, reclaimedLease]);
    expect((await database.query<{ state: string; lease_id: string | null }>(`
      select state, validation_lease_id::text as lease_id from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ state: 'ready', lease_id: null }]);
    await expect(database.query(`select * from public.complete_attachment_upload(
      $1, $2, $3, $4, 'lease.txt', 'text/plain', 16, repeat('a', 64), $5
    )`, [owner.workspace_id, attachmentId, quarantinePath, attachmentId, reclaimedLease]))
      .rejects.toThrow();

    const failedId = crypto.randomUUID();
    const failedPath = crypto.randomUUID();
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'invalid.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '125 minutes')
    `, [failedId, owner.workspace_id, task.id, failedPath, owner.user_id]);
    const failedLease = (await database.query<{ lease_id: string }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as lease_id
    `, [owner.workspace_id, failedId, failedPath])).rows[0]!.lease_id;
    await expect(database.query(`select public.retire_quarantine_attachment(
      $1, $2, $3, $4::text, $5
    )`, [owner.workspace_id, failedId, failedPath, null, failedLease]))
      .rejects.toThrow(/attachment_retire_reason_invalid/iu);
    await expect(database.query(`select public.retire_quarantine_attachment(
      $1, $2, $3, 'invalid_content'
    )`, [owner.workspace_id, failedId, failedPath])).rejects.toThrow(/validation_lease_required/iu);
    await expect(database.query(`select public.retire_quarantine_attachment(
      $1, $2, $3, 'invalid_content', $4
    )`, [owner.workspace_id, failedId, failedPath, crypto.randomUUID()]))
      .rejects.toThrow(/attachment_validation_lease_invalid/iu);
    await database.query(`select public.retire_quarantine_attachment(
      $1, $2, $3, 'invalid_content', $4
    )`, [owner.workspace_id, failedId, failedPath, failedLease]);
    expect((await database.query<{ deleted: boolean }>(`
      select deleted_at is not null as deleted from public.attachments where id = $1
    `, [failedId])).rows).toEqual([{ deleted: true }]);
  }, 30_000);

  it('soft-cancels a failed pre-grant reservation without erasing rolling quota evidence', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Отмена до гранта', $2) returning id::text
    `, [owner.workspace_id, status.id])).rows[0]!;
    const attachmentId = crypto.randomUUID();
    const quarantinePath = crypto.randomUUID();
    await database.query(`select * from public.reserve_attachment_upload(
      $1, $2, $3, null, $4, 'cancel.txt', 'text/plain', 16, $5
    )`, [owner.workspace_id, attachmentId, task.id, owner.user_id, quarantinePath]);

    expect((await database.query<{ cancelled: boolean }>(`
      select public.cancel_attachment_upload_reservation($1, $2, $3) as cancelled
    `, [owner.workspace_id, attachmentId, quarantinePath])).rows).toEqual([{ cancelled: true }]);
    expect((await database.query<{ rows: number; deleted: boolean; cleanup: number }>(`
      select count(*)::integer as rows, bool_and(deleted_at is not null) as deleted,
        (select count(*)::integer from public.file_cleanup_queue where attachment_id = $2) as cleanup
      from public.attachments where workspace_id = $1 and id = $2
    `, [owner.workspace_id, attachmentId])).rows).toEqual([{ rows: 1, deleted: true, cleanup: 1 }]);
    expect((await database.query<{ recent: number }>(`
      select count(*)::integer as recent from public.attachments
      where workspace_id = $1 and created_by = $2 and created_at >= clock_timestamp() - interval '1 hour'
    `, [owner.workspace_id, owner.user_id])).rows).toEqual([{ recent: 1 }]);
  }, 30_000);

  it('lets parent deletion and expiry safely win an in-flight validation lease', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const tasks = await database.query<{ id: string; version: number }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Удаляемый родитель', $2), ($1, 'Истекающая проверка', $2)
      returning id::text, version
    `, [owner.workspace_id, status.id]);
    const parentAttachment = crypto.randomUUID();
    const parentPath = crypto.randomUUID();
    const expiringAttachment = crypto.randomUUID();
    const expiringPath = crypto.randomUUID();
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values
        ($1, $2, $3, 'parent.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '125 minutes'),
        ($6, $2, $7, 'expiry.txt', 'text/plain', 16, $8, $5, clock_timestamp() + interval '125 minutes')
    `, [parentAttachment, owner.workspace_id, tasks.rows[0]!.id, parentPath, owner.user_id,
      expiringAttachment, tasks.rows[1]!.id, expiringPath]);
    const parentLease = (await database.query<{ id: string }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as id
    `, [owner.workspace_id, parentAttachment, parentPath])).rows[0]!.id;
    const expiryLease = (await database.query<{ id: string }>(`
      select public.claim_attachment_validation($1, $2, $3)::text as id
    `, [owner.workspace_id, expiringAttachment, expiringPath])).rows[0]!.id;

    await database.query('select * from public.set_task_deleted($1, $2, $3)', [
      owner.workspace_id, tasks.rows[0]!.id, tasks.rows[0]!.version,
    ]);
    expect((await database.query<{ deleted: boolean; lease: string | null }>(`
      select deleted_at is not null as deleted, validation_lease_id::text as lease
      from public.attachments where id = $1
    `, [parentAttachment])).rows).toEqual([{ deleted: true, lease: parentLease }]);
    expect((await database.query<{ released: boolean }>(`
      select public.release_attachment_validation($1, $2, $3, $4) as released
    `, [owner.workspace_id, parentAttachment, parentPath, parentLease])).rows).toEqual([{ released: true }]);

    await database.query(`update public.attachments
      set quarantine_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [expiringAttachment]);
    expect((await database.query<{ retired: boolean }>(`
      select public.retire_quarantine_attachment($1, $2, $3, 'expired') as retired
    `, [owner.workspace_id, expiringAttachment, expiringPath])).rows).toEqual([{ retired: false }]);
    expect((await database.query<{ released: boolean }>(`
      select public.release_attachment_validation($1, $2, $3, $4) as released
    `, [owner.workspace_id, expiringAttachment, expiringPath, expiryLease])).rows).toEqual([{ released: true }]);
    expect((await database.query<{ retired: boolean }>(`
      select public.retire_quarantine_attachment($1, $2, $3, 'expired') as retired
    `, [owner.workspace_id, expiringAttachment, expiringPath])).rows).toEqual([{ retired: true }]);
  }, 30_000);

  it('locks before taking the quota clock and provides the rolling-window indexes', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const definition = (await database.query<{ definition: string }>(`
      select pg_get_functiondef('public.reserve_attachment_upload(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text)'::regprocedure) as definition
    `)).rows[0]!.definition;
    const normalizedDefinition = definition.toLowerCase();
    const lockPosition = normalizedDefinition.indexOf('for update');
    const clockPosition = normalizedDefinition.indexOf('observed_at := clock_timestamp()');
    expect(lockPosition).toBeGreaterThanOrEqual(0);
    expect(clockPosition).toBeGreaterThan(lockPosition);
    expect(definition).toMatch(/workspace_members[\s\S]+app_users[\s\S]+member\.deleted_at is null[\s\S]+app_user\.deleted_at is null/iu);
    const indexes = await database.query<{ name: string }>(`
      select indexname as name from pg_indexes
      where schemaname = 'public' and tablename = 'attachments'
    `);
    expect(indexes.rows.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'attachments_upload_workspace_window_idx', 'attachments_upload_member_window_idx',
    ]));
  });

  it('keeps cleanup away from a claimed quarantine until its validation lease expires', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Гонка очистки', $2) returning id::text
    `, [owner.workspace_id, status.id])).rows[0]!;
    const attachmentId = crypto.randomUUID();
    const quarantinePath = crypto.randomUUID();
    await database.query(`
      insert into public.attachments (
        id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
      ) values ($1, $2, $3, 'race.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '1 minute')
    `, [attachmentId, owner.workspace_id, task.id, quarantinePath, owner.user_id]);
    await database.query('select public.claim_attachment_validation($1, $2, $3)', [
      owner.workspace_id, attachmentId, quarantinePath,
    ]);
    await database.query(`update public.attachments
      set quarantine_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [attachmentId]);

    await database.query('select private.stage_file_cleanup_at(clock_timestamp())');
    expect((await database.query<{ deleted: boolean; queued: number }>(`
      select deleted_at is not null as deleted,
        (select count(*)::integer from public.file_cleanup_queue where attachment_id = $1) as queued
      from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ deleted: false, queued: 0 }]);

    const queue = (await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (
        workspace_id, attachment_id, storage_path, remove_after, retain_until
      ) values ($1, $2, $3, clock_timestamp() - interval '1 second', clock_timestamp() + interval '24 hours')
      returning id::text
    `, [owner.workspace_id, attachmentId, quarantinePath])).rows[0]!;
    expect((await database.query<{ lease: string | null }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [queue.id])).rows).toEqual([{ lease: null }]);
    const postponed = (await database.query<{ remove_after: string; validation_expires: string }>(`
      select cleanup.remove_after::text, attachment.validation_lease_expires_at::text as validation_expires
      from public.file_cleanup_queue as cleanup
      join public.attachments as attachment on attachment.id = cleanup.attachment_id
      where cleanup.id = $1
    `, [queue.id])).rows[0]!;
    expect(new Date(postponed.remove_after).getTime()).toBeGreaterThanOrEqual(
      new Date(postponed.validation_expires).getTime(),
    );

    const readyQueue = (await database.query<{ id: string }>(`
      insert into public.file_cleanup_queue (
        workspace_id, attachment_id, storage_path, remove_after, retain_until
      ) values ($1, $2::uuid, $2::uuid::text, clock_timestamp() - interval '1 second', clock_timestamp() + interval '24 hours')
      returning id::text
    `, [owner.workspace_id, attachmentId])).rows[0]!;
    expect((await database.query<{ lease: string | null }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [readyQueue.id])).rows).toEqual([{ lease: null }]);
    const readyPostponed = (await database.query<{ remove_after: string; validation_expires: string }>(`
      select cleanup.remove_after::text, attachment.validation_lease_expires_at::text as validation_expires
      from public.file_cleanup_queue as cleanup
      join public.attachments as attachment on attachment.id = cleanup.attachment_id
      where cleanup.id = $1
    `, [readyQueue.id])).rows[0]!;
    expect(new Date(readyPostponed.remove_after).getTime()).toBeGreaterThanOrEqual(
      new Date(readyPostponed.validation_expires).getTime(),
    );

    await database.query(`update public.attachments
      set validation_lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [attachmentId]);
    await database.query(`update public.file_cleanup_queue
      set remove_after = clock_timestamp() - interval '1 second' where id = $1`, [queue.id]);
    await database.query('select private.stage_file_cleanup_at(clock_timestamp())');
    expect((await database.query<{ deleted: boolean }>(`
      select deleted_at is not null as deleted from public.attachments where id = $1
    `, [attachmentId])).rows).toEqual([{ deleted: true }]);
    expect((await database.query<{ lease: string | null }>(`
      select public.prepare_file_cleanup_object($1)::text as lease
    `, [queue.id])).rows[0]!.lease).toMatch(/^[0-9a-f-]{36}$/iu);

    const functions = await database.query<{ name: string; definition: string }>(`
      select proname as name, pg_get_functiondef(oid) as definition
      from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and proname in ('claim_attachment_validation', 'stage_file_cleanup_at', 'prepare_file_cleanup_object')
    `);
    const claim = functions.rows.find(({ name }) => name === 'claim_attachment_validation')!.definition.toLowerCase();
    expect(claim.indexOf('for update')).toBeLessThan(claim.indexOf('observed_at := clock_timestamp()'));
    expect(functions.rows.find(({ name }) => name === 'stage_file_cleanup_at')!.definition)
      .toMatch(/validation_lease_expires_at/iu);
    expect(functions.rows.find(({ name }) => name === 'prepare_file_cleanup_object')!.definition)
      .toMatch(/validation_lease_expires_at/iu);
  }, 30_000);

  it('denies validation when cleanup leased either quarantine or deterministic ready coordinates first', async () => {
    const database = await initializeDatabase();
    await applyAll(database);
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses where workspace_id = $1 order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Очистка раньше проверки', $2) returning id::text
    `, [owner.workspace_id, status.id])).rows[0]!;

    for (const pathKind of ['quarantine', 'ready'] as const) {
      const attachmentId = crypto.randomUUID();
      const quarantinePath = crypto.randomUUID();
      await database.query(`
        insert into public.attachments (
          id, workspace_id, task_id, name, mime_type, size_bytes, storage_path, created_by, quarantine_expires_at
        ) values ($1, $2, $3, 'reverse-race.txt', 'text/plain', 16, $4, $5, clock_timestamp() + interval '125 minutes')
      `, [attachmentId, owner.workspace_id, task.id, quarantinePath, owner.user_id]);
      const cleanupPath = pathKind === 'quarantine' ? quarantinePath : attachmentId;
      const queue = (await database.query<{ id: string }>(`
        insert into public.file_cleanup_queue (
          workspace_id, attachment_id, storage_path, remove_after, retain_until
        ) values ($1, $2, $3, clock_timestamp() - interval '1 second', clock_timestamp() + interval '24 hours')
        returning id::text
      `, [owner.workspace_id, attachmentId, cleanupPath])).rows[0]!;
      if (pathKind === 'quarantine') {
        await database.query(`update public.file_cleanup_queue
          set lease_id = extensions.gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes'
          where id = $1`, [queue.id]);
      } else {
        expect((await database.query<{ lease: string | null }>(`
          select public.prepare_file_cleanup_object($1)::text as lease
        `, [queue.id])).rows[0]!.lease).toMatch(/^[0-9a-f-]{36}$/iu);
      }

      expect((await database.query<{ lease: string | null }>(`
        select public.claim_attachment_validation($1, $2, $3)::text as lease
      `, [owner.workspace_id, attachmentId, quarantinePath])).rows).toEqual([{ lease: null }]);
      expect((await database.query<{ lease: string | null }>(`
        select validation_lease_id::text as lease from public.attachments where id = $1
      `, [attachmentId])).rows).toEqual([{ lease: null }]);
    }
  }, 30_000);
});
