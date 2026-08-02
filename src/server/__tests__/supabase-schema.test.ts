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
];
const OWNER_TELEGRAM_ID = '4503599627370495';
const REQUIRED_SECTIONS = [
  'Открытие',
  'Ремонт и техника',
  'Закупки и склад',
  'Зал и сервис',
  'Персонал',
  'Маркетинг',
  'Документы и финансы',
  'Безопасность и санитария',
];

const databases: PGlite[] = [];

async function applyMigration(database: PGlite, filename: string) {
  const migration = (await readFile(filename, 'utf8'))
    .replace('create extension if not exists pgcrypto with schema extensions;', '');
  await database.exec(migration);
}

async function createDatabase(options: { seedRounds?: number; migrations?: string[]; migrationRounds?: number } = {}) {
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
      id text primary key, name text not null, public boolean not null default false, file_size_limit bigint
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

  for (let round = 0; round < (options.migrationRounds ?? 2); round += 1) {
    for (const filename of options.migrations ?? MIGRATIONS) await applyMigration(database, filename);
  }
  for (let round = 0; round < (options.seedRounds ?? 0); round += 1) {
    await database.exec(await readFile('supabase/seed.sql', 'utf8'));
  }
  return database;
}

async function bootstrapOwner(database: PGlite) {
  const result = await database.query<{
    user_id: string;
    membership_id: string;
    workspace_id: string;
    role: string;
  }>(`select * from public.bootstrap_telegram_user(
    $1, 'Владелец', null, 'owner_test', 'ru', $1, 'Smoking Zen test'
  )`, [OWNER_TELEGRAM_ID]);
  return result.rows;
}

async function useAuthenticatedIdentity(database: PGlite, userId: string) {
  await database.query("select set_config('request.jwt.claim.sub', $1::text, false)", [userId]);
  await database.exec('set role authenticated');
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('Supabase schema runtime security', () => {
  it('blocks direct Telegram identity and profile mutation for authenticated browser roles', async () => {
    const database = await createDatabase();
    const ordinaryLogin = await database.query(`select * from public.bootstrap_telegram_user(
      '123456789', 'Сотрудник', null, 'member_test', 'ru', $1, 'Smoking Zen test'
    )`, [OWNER_TELEGRAM_ID]);
    expect(ordinaryLogin.rows).toEqual([]);
    const ordinaryUser = await database.query<{ id: string }>(
      "select id from public.app_users where telegram_id = '123456789'",
    );
    expect(ordinaryUser.rows[0]).toBeDefined();
    await database.exec('grant usage on schema public to authenticated');
    await database.exec('grant select, update on public.app_users to authenticated');
    await useAuthenticatedIdentity(database, ordinaryUser.rows[0]!.id);

    const direct = await database.query<{ telegram_id: string }>(`
      update public.app_users set telegram_id = $2
      where id = $1 returning telegram_id
    `, [ordinaryUser.rows[0]!.id, OWNER_TELEGRAM_ID]);
    let profileDenied = false;
    try {
      await database.query(`select * from public.update_own_profile(
        'Владелец смены', 'updated_owner', 'https://images.example/avatar.png'
      )`);
    } catch (error) {
      profileDenied = /permission denied/i.test(String(error));
    }
    await database.exec('reset role');
    const identity = await database.query<{ telegram_id: string }>(
      'select telegram_id from public.app_users where id = $1',
      [ordinaryUser.rows[0]!.id],
    );
    const owner = await bootstrapOwner(database);

    expect(direct.rows).toEqual([]);
    expect(identity.rows[0]?.telegram_id).toBe('123456789');
    expect(owner[0]?.role).toBe('owner');
    expect(profileDenied).toBe(true);
  });

  it.each(['user', 'membership', 'workspace'] as const)(
    'revokes owner authorization without creating a duplicate workspace when %s is soft-deleted',
    async (target) => {
      const database = await createDatabase();
      const [owner] = await bootstrapOwner(database);
      expect(owner).toBeDefined();
      const countBefore = await database.query<{ count: number }>('select count(*)::int as count from public.workspaces');

      if (target === 'user') {
        await database.query('update public.app_users set deleted_at = clock_timestamp() where id = $1', [owner!.user_id]);
      } else if (target === 'membership') {
        await database.query('update public.workspace_members set deleted_at = clock_timestamp() where id = $1', [owner!.membership_id]);
      } else {
        await database.query('update public.workspaces set deleted_at = clock_timestamp() where id = $1', [owner!.workspace_id]);
      }

      await useAuthenticatedIdentity(database, owner!.user_id);
      const authorization = await database.query<{ allowed: boolean }>(
        'select private.is_workspace_owner($1) as allowed',
        [owner!.workspace_id],
      );
      await database.exec('reset role');
      const bootstrapAfterRevocation = await bootstrapOwner(database);
      const countAfter = await database.query<{ count: number }>('select count(*)::int as count from public.workspaces');

      expect(authorization.rows[0]?.allowed).toBe(false);
      expect(bootstrapAfterRevocation).toEqual([]);
      expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count);
    },
  );

  it('seeds exactly the required eight sections and four statuses on repeated execution', async () => {
    const database = await createDatabase({ seedRounds: 2 });
    const sections = await database.query<{ name: string }>(
      'select name from public.sections where deleted_at is null order by position',
    );
    const statuses = await database.query<{ name: string }>(
      'select name from public.task_statuses where deleted_at is null order by position',
    );

    expect(sections.rows.map(({ name }) => name)).toEqual(REQUIRED_SECTIONS);
    expect(statuses.rows.map(({ name }) => name)).toEqual(['Новая', 'В работе', 'Ждёт', 'Готово']);
  });

  it('initializes fresh production workspaces and backfills existing workspaces idempotently without a seed', async () => {
    const database = await createDatabase({ migrationRounds: 1 });
    const [owner] = await bootstrapOwner(database);
    const taxonomyBefore = await database.query<{ entity: string; id: string; name: string; position: number; version: number }>(`
      select 'section' as entity, id, name, position, version from public.sections where workspace_id = $1 and deleted_at is null
      union all
      select 'status', id, name, position, version from public.task_statuses where workspace_id = $1 and deleted_at is null
      order by entity, position
    `, [owner!.workspace_id]);
    const [sameOwner] = await bootstrapOwner(database);
    expect(owner).toBeDefined();
    expect(sameOwner).toMatchObject({ workspace_id: owner!.workspace_id, membership_id: owner!.membership_id });
    const sections = await database.query<{ name: string }>(
      'select name from public.sections where workspace_id = $1 and deleted_at is null order by position',
      [owner!.workspace_id],
    );
    const statuses = await database.query<{ name: string }>(
      'select name from public.task_statuses where workspace_id = $1 and deleted_at is null order by position',
      [owner!.workspace_id],
    );
    expect(sections.rows.map(({ name }) => name)).toEqual(REQUIRED_SECTIONS);
    expect(statuses.rows.map(({ name }) => name)).toEqual(['Новая', 'В работе', 'Ждёт', 'Готово']);

    await applyMigration(database, MIGRATIONS[5]!);
    expect((await database.query('select 1 from public.sections where workspace_id = $1 and deleted_at is null', [owner!.workspace_id])).rows).toHaveLength(8);
    expect((await database.query('select 1 from public.task_statuses where workspace_id = $1 and deleted_at is null', [owner!.workspace_id])).rows).toHaveLength(4);
    const taxonomyAfter = await database.query<{ entity: string; id: string; name: string; position: number; version: number }>(`
      select 'section' as entity, id, name, position, version from public.sections where workspace_id = $1 and deleted_at is null
      union all
      select 'status', id, name, position, version from public.task_statuses where workspace_id = $1 and deleted_at is null
      order by entity, position
    `, [owner!.workspace_id]);
    expect(taxonomyAfter.rows).toEqual(taxonomyBefore.rows);
    expect((await database.query<{ allowed: boolean }>(
      "select has_function_privilege('service_role', 'public.bootstrap_telegram_user(text,text,text,text,text,text,text)', 'execute') as allowed",
    )).rows[0]?.allowed).toBe(true);
    const helperPrivileges = await database.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select
        has_function_privilege('anon', 'private.ensure_workspace_taxonomy(uuid)', 'execute') as anon,
        has_function_privilege('authenticated', 'private.ensure_workspace_taxonomy(uuid)', 'execute') as authenticated,
        has_function_privilege('service_role', 'private.ensure_workspace_taxonomy(uuid)', 'execute') as service
    `);
    expect(helperPrivileges.rows).toEqual([{ anon: false, authenticated: false, service: false }]);
  });

  it('reconciles canonical taxonomy without deleting custom rows or breaking live references', async () => {
    const database = await createDatabase({ migrations: MIGRATIONS.slice(0, 5) });
    const workspaceId = '10000000-0000-4000-8000-000000000098';
    const customStatusId = '40000000-0000-4000-8000-000000000098';
    const customSectionId = '50000000-0000-4000-8000-000000000098';
    const taskId = '60000000-0000-4000-8000-000000000098';
    const knowledgeId = '70000000-0000-4000-8000-000000000098';
    await database.query('insert into public.workspaces (id, name) values ($1, $2)', [workspaceId, 'Conflicting taxonomy']);
    await database.query(`
      insert into public.task_statuses (id, workspace_id, name, position) values
        ($2, $1, 'На проверке', 1),
        ('40000000-0000-4000-8000-000000000091', $1, 'Новая', 2),
        ('40000000-0000-4000-8000-000000000092', $1, 'В работе', 3),
        ('40000000-0000-4000-8000-000000000093', $1, 'Ждёт', 4),
        ('40000000-0000-4000-8000-000000000094', $1, 'Готово', 5),
        ('40000000-0000-4000-8000-000000000095', $1, 'Пауза', 10)
    `, [workspaceId, customStatusId]);
    await database.query(`
      insert into public.sections (id, workspace_id, name, position) values
        ($2, $1, 'Франшиза', 1),
        ('50000000-0000-4000-8000-000000000091', $1, 'Открытие', 2),
        ('50000000-0000-4000-8000-000000000095', $1, 'Развитие', 20)
    `, [workspaceId, customSectionId]);
    await database.query(`
      insert into public.tasks (id, workspace_id, title, status_id, section_id)
      values ($1, $2, 'Проверить франшизу', $3, $4)
    `, [taskId, workspaceId, customStatusId, customSectionId]);
    await database.query(`
      insert into public.knowledge_items (id, workspace_id, title, body, kind, section_id)
      values ($1, $2, 'Регламент франшизы', '', 'note', $3)
    `, [knowledgeId, workspaceId, customSectionId]);

    await applyMigration(database, MIGRATIONS[5]!);
    const afterFirst = await database.query<{ entity: string; id: string; name: string; position: number; version: number; deleted_at: string | null }>(`
      select 'section' as entity, id, name, position, version, deleted_at from public.sections where workspace_id = $1
      union all
      select 'status', id, name, position, version, deleted_at from public.task_statuses where workspace_id = $1
      order by entity, name
    `, [workspaceId]);
    await applyMigration(database, MIGRATIONS[5]!);
    const afterSecond = await database.query<{ entity: string; id: string; name: string; position: number; version: number; deleted_at: string | null }>(`
      select 'section' as entity, id, name, position, version, deleted_at from public.sections where workspace_id = $1
      union all
      select 'status', id, name, position, version, deleted_at from public.task_statuses where workspace_id = $1
      order by entity, name
    `, [workspaceId]);
    expect(afterSecond.rows).toEqual(afterFirst.rows);
    expect((await database.query<{ name: string; position: number }>(`
      select name, position from public.task_statuses
      where workspace_id = $1 and deleted_at is null and name in ('Новая', 'В работе', 'Ждёт', 'Готово')
      order by position
    `, [workspaceId])).rows).toEqual([
      { name: 'Новая', position: 1 }, { name: 'В работе', position: 2 },
      { name: 'Ждёт', position: 3 }, { name: 'Готово', position: 4 },
    ]);
    expect((await database.query<{ name: string; position: number }>(`
      select name, position from public.sections
      where workspace_id = $1 and deleted_at is null and name = any($2::text[])
      order by position
    `, [workspaceId, REQUIRED_SECTIONS])).rows).toEqual(REQUIRED_SECTIONS.map((name, index) => ({ name, position: index + 1 })));
    const customStatus = await database.query<{ name: string; position: number; active: boolean; selectable: boolean }>(`
      select s.name, s.position, s.deleted_at is null as active,
        exists (select 1 from public.tasks t where t.id = $2 and t.deleted_at is null and t.status_id = s.id) as selectable
      from public.task_statuses s where s.id = $1
    `, [customStatusId, taskId]);
    expect(customStatus.rows).toEqual([{ name: 'На проверке', position: expect.any(Number), active: true, selectable: true }]);
    expect(customStatus.rows[0]!.position).toBeGreaterThan(4);
    const customSection = await database.query<{ name: string; position: number; active: boolean; task_ref: boolean; knowledge_ref: boolean }>(`
      select s.name, s.position, s.deleted_at is null as active,
        exists (select 1 from public.tasks t where t.id = $2 and t.deleted_at is null and t.section_id = s.id) as task_ref,
        exists (select 1 from public.knowledge_items k where k.id = $3 and k.deleted_at is null and k.section_id = s.id) as knowledge_ref
      from public.sections s where s.id = $1
    `, [customSectionId, taskId, knowledgeId]);
    expect(customSection.rows).toEqual([{
      name: 'Франшиза', position: expect.any(Number), active: true, task_ref: true, knowledge_ref: true,
    }]);
    expect(customSection.rows[0]!.position).toBeGreaterThan(8);
    expect((await database.query<{ entity: string; name: string; position: number }>(`
      select 'status' as entity, name, position from public.task_statuses
        where workspace_id = $1 and name = 'Пауза' and deleted_at is null
      union all
      select 'section', name, position from public.sections
        where workspace_id = $1 and name = 'Развитие' and deleted_at is null
      order by entity
    `, [workspaceId])).rows).toEqual([
      { entity: 'section', name: 'Развитие', position: 20 },
      { entity: 'status', name: 'Пауза', position: 10 },
    ]);
  });

  it('converges a database that already recorded 0006 through an idempotent 0007', async () => {
    const database = await createDatabase({ migrations: MIGRATIONS.slice(0, 6), migrationRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000097';
    const customStatusId = '40000000-0000-4000-8000-000000000097';
    const customSectionId = '50000000-0000-4000-8000-000000000097';
    await database.query('insert into public.workspaces (id, name) values ($1, $2)', [workspaceId, 'Recorded 0006']);
    await database.query(`
      insert into public.task_statuses (id, workspace_id, name, position) values
        ($2, $1, 'На согласовании', 1),
        ('40000000-0000-4000-8000-000000000096', $1, 'Новая', 2)
    `, [workspaceId, customStatusId]);
    await database.query(`
      insert into public.sections (id, workspace_id, name, position) values
        ($2, $1, 'Партнёры', 1),
        ('50000000-0000-4000-8000-000000000096', $1, 'Открытие', 2)
    `, [workspaceId, customSectionId]);
    await database.query(`
      insert into public.tasks (workspace_id, title, status_id, section_id)
      values ($1, 'Ссылка после 0006', $2, $3)
    `, [workspaceId, customStatusId, customSectionId]);

    await applyMigration(database, MIGRATIONS[6]!);
    const afterFirst = await database.query<{ entity: string; id: string; name: string; position: number; version: number; deleted_at: string | null }>(`
      select 'section' as entity, id, name, position, version, deleted_at from public.sections where workspace_id = $1
      union all
      select 'status', id, name, position, version, deleted_at from public.task_statuses where workspace_id = $1
      order by entity, name
    `, [workspaceId]);
    await applyMigration(database, MIGRATIONS[6]!);
    const afterSecond = await database.query<{ entity: string; id: string; name: string; position: number; version: number; deleted_at: string | null }>(`
      select 'section' as entity, id, name, position, version, deleted_at from public.sections where workspace_id = $1
      union all
      select 'status', id, name, position, version, deleted_at from public.task_statuses where workspace_id = $1
      order by entity, name
    `, [workspaceId]);
    const definitions = await database.query<{ name: string; definition: string }>(`
      select p.proname as name, pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.proname in (
        'ensure_workspace_taxonomy', 'bootstrap_telegram_user', 'create_contact_with_methods',
        'replace_contact_with_methods', 'set_contact_deleted', 'search_workspace',
        'restore_task_record', 'restore_knowledge_record'
      )
      order by name
    `);
    const restorePrivileges = await database.query<{
      service_task: boolean;
      service_knowledge: boolean;
      authenticated_task: boolean;
      authenticated_knowledge: boolean;
    }>(`
      select
        has_function_privilege('service_role', 'public.restore_task_record(uuid,uuid,integer)', 'execute') as service_task,
        has_function_privilege('service_role', 'public.restore_knowledge_record(uuid,uuid,integer)', 'execute') as service_knowledge,
        has_function_privilege('authenticated', 'public.restore_task_record(uuid,uuid,integer)', 'execute') as authenticated_task,
        has_function_privilege('authenticated', 'public.restore_knowledge_record(uuid,uuid,integer)', 'execute') as authenticated_knowledge
    `);

    expect(afterSecond.rows).toEqual(afterFirst.rows);
    expect(afterSecond.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: customStatusId, name: 'На согласовании', deleted_at: null }),
      expect.objectContaining({ id: customSectionId, name: 'Партнёры', deleted_at: null }),
    ]));
    expect(definitions.rows.map(({ name }) => name)).toEqual([
      'bootstrap_telegram_user', 'create_contact_with_methods', 'ensure_workspace_taxonomy',
      'replace_contact_with_methods', 'restore_knowledge_record', 'restore_task_record',
      'search_workspace', 'set_contact_deleted',
    ]);
    expect(definitions.rows.find(({ name }) => name === 'create_contact_with_methods')?.definition).toMatch(/p_methods is null/i);
    expect(definitions.rows.find(({ name }) => name === 'set_contact_deleted')?.definition).toMatch(/restore_not_deleted/i);
    expect(definitions.rows.find(({ name }) => name === 'search_workspace')?.definition).toMatch(/position\(lower\(trim\(p_query\)\)/i);
    expect(definitions.rows.find(({ name }) => name === 'bootstrap_telegram_user')?.definition).toMatch(/ensure_workspace_taxonomy/i);
    expect(restorePrivileges.rows).toEqual([{
      service_task: true, service_knowledge: true, authenticated_task: false, authenticated_knowledge: false,
    }]);
  });

  it('upgrades populated legacy link rows before enforcing link consistency', async () => {
    const database = await createDatabase({ migrations: MIGRATIONS.slice(0, 5) });
    const workspaceId = '10000000-0000-4000-8000-000000000099';
    const knowledgeId = '70000000-0000-4000-8000-000000000099';
    await database.query('insert into public.workspaces (id, name) values ($1, $2)', [workspaceId, 'Legacy']);
    await database.query(
      "insert into public.knowledge_items (id, workspace_id, title, body, kind) values ($1, $2, 'Старая ссылка', 'URL был в тексте', 'link')",
      [knowledgeId, workspaceId],
    );

    await applyMigration(database, MIGRATIONS[5]!);
    const afterFirstUpgrade = await database.query<{ title: string; body: string; kind: string; link_url: string | null; version: number }>(
      'select title, body, kind, link_url, version from public.knowledge_items where id = $1', [knowledgeId],
    );
    await applyMigration(database, MIGRATIONS[5]!);
    const upgraded = await database.query<{ title: string; body: string; kind: string; link_url: string | null; version: number }>(
      'select title, body, kind, link_url, version from public.knowledge_items where id = $1', [knowledgeId],
    );
    expect(upgraded.rows).toEqual([{ title: 'Старая ссылка', body: 'URL был в тексте', kind: 'note', link_url: null, version: 2 }]);
    expect(upgraded.rows).toEqual(afterFirstUpgrade.rows);
    expect((await database.query('select 1 from public.sections where workspace_id = $1 and deleted_at is null', [workspaceId])).rows).toHaveLength(8);
    expect((await database.query('select 1 from public.task_statuses where workspace_id = $1 and deleted_at is null', [workspaceId])).rows).toHaveLength(4);
  });

  it('keeps production search field-safe, globally newest-first, and bounded to twenty results', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const statusId = '40000000-0000-4000-8000-000000000001';
    await database.query(`
      insert into public.tasks (workspace_id, title, description, status_id, updated_at)
      select $1, 'needle task ' || value, '', $2, timestamptz '2026-08-01 00:00:00+00' + value * interval '1 minute'
      from generate_series(1, 25) as value
    `, [workspaceId, statusId]);
    const contact = await database.query<{ id: string }>(`
      insert into public.contacts (workspace_id, name, category, notes, updated_at)
      values ($1, 'needle contact', 'other', 'public operational note', '2026-08-03T00:00:00Z')
      returning id
    `, [workspaceId]);
    await database.query(`
      insert into public.contact_methods (workspace_id, contact_id, kind, value, position)
      values ($1, $2, 'telegram', 'private_only_handle', 1)
    `, [workspaceId, contact.rows[0]!.id]);
    await database.query(`
      insert into public.knowledge_items (workspace_id, title, body, kind, link_url, updated_at)
      values ($1, 'needle knowledge', 'public guide', 'note', null, '2026-08-04T00:00:00Z')
    `, [workspaceId]);

    const results = await database.query<{ entity: string; title: string }>(
      'select entity, title from public.search_workspace($1, $2, 100)', [workspaceId, 'needle'],
    );
    expect(results.rows).toHaveLength(20);
    expect(results.rows.slice(0, 2)).toEqual([
      { entity: 'knowledge', title: 'needle knowledge' },
      { entity: 'contact', title: 'needle contact' },
    ]);
    expect((await database.query('select * from public.search_workspace($1, $2, 20)', [workspaceId, 'private_only_handle'])).rows).toEqual([]);
    expect((await database.query('select * from public.search_workspace($1, $2, 20)', [workspaceId, 'example.com'])).rows).toEqual([]);
    expect((await database.query('select * from public.search_workspace($1, $2, 20)', [workspaceId, '%'])).rows).toEqual([]);
    expect((await database.query('select * from public.search_workspace($1, $2, 20)', [workspaceId, '_'])).rows).toEqual([]);
    expect((await database.query('select * from public.search_workspace($1, $2, 20)', [workspaceId, 'x'.repeat(121)])).rows).toEqual([]);
  });

  it('keeps contact and contact methods atomic, workspace-scoped, and recoverable together', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    await expect(database.query(
      `select * from public.create_contact_with_methods($1, 'Пустые методы', 'service', '', $2::jsonb)`,
      [workspaceId, null],
    )).rejects.toThrow(/invalid_contact/i);
    expect((await database.query<{ count: number }>(
      `select count(*)::int as count from public.contacts where workspace_id = $1 and name = 'Пустые методы'`,
      [workspaceId],
    )).rows).toEqual([{ count: 0 }]);
    const created = await database.query<{ id: string; version: number }>(
      `select id, version from public.create_contact_with_methods($1, 'Мастер', 'service', '', $2::jsonb)`,
      [workspaceId, JSON.stringify([{ kind: 'phone', value: '+79991234567' }])],
    );
    const contactId = created.rows[0]!.id;
    await expect(database.query(
      `select * from public.replace_contact_with_methods($1, $2, $3, 'Сломано', 'service', '', $4::jsonb)`,
      [workspaceId, contactId, created.rows[0]!.version, JSON.stringify([{ kind: 'email', value: 'bad' }])],
    )).rejects.toThrow(/invalid_contact_method/i);
    await expect(database.query(
      `select * from public.replace_contact_with_methods($1, $2, $3, 'Стереть методы', 'service', 'изменено', $4::jsonb)`,
      [workspaceId, contactId, created.rows[0]!.version, null],
    )).rejects.toThrow(/invalid_contact/i);
    const unchanged = await database.query<{ name: string; value: string }>(`
      select c.name, m.value from public.contacts c join public.contact_methods m on m.contact_id = c.id
      where c.id = $1 and c.deleted_at is null and m.deleted_at is null
    `, [contactId]);
    expect(unchanged.rows).toEqual([{ name: 'Мастер', value: '+79991234567' }]);

    const deleted = await database.query<{ version: number }>(
      'select version from public.set_contact_deleted($1, $2, $3, false)', [workspaceId, contactId, created.rows[0]!.version],
    );
    expect((await database.query('select 1 from public.contact_methods where contact_id = $1 and deleted_at is null', [contactId])).rows).toEqual([]);
    const restored = await database.query<{ version: number }>(
      'select version from public.set_contact_deleted($1, $2, $3, true)', [workspaceId, contactId, deleted.rows[0]!.version],
    );
    expect((await database.query('select 1 from public.contact_methods where contact_id = $1 and deleted_at is null', [contactId])).rows).toHaveLength(1);
    await expect(database.query(
      'select * from public.set_contact_deleted($1, $2, $3, true)', [workspaceId, contactId, restored.rows[0]!.version],
    )).rejects.toThrow(/restore_not_deleted/i);
    await expect(database.query(
      "select * from public.set_contact_deleted($1, '00000000-0000-4000-8000-000000000404', 1, true)", [workspaceId],
    )).rejects.toThrow(/contact_not_found/i);
    await database.query(
      "update public.contacts set deleted_at = clock_timestamp() - interval '31 days' where id = $1", [contactId],
    );
    const expired = await database.query<{ version: number }>('select version from public.contacts where id = $1', [contactId]);
    await expect(database.query(
      'select * from public.set_contact_deleted($1, $2, $3, true)', [workspaceId, contactId, expired.rows[0]!.version],
    )).rejects.toThrow(/restore_expired/i);
  });

  it('enforces task and knowledge restore state and deadline inside atomic database functions', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const statusId = '40000000-0000-4000-8000-000000000001';
    const activeTask = await database.query<{ id: string; version: number }>(`
      insert into public.tasks (workspace_id, title, status_id) values ($1, 'Активная', $2)
      returning id, version
    `, [workspaceId, statusId]);
    await expect(database.query(
      'select * from public.restore_task_record($1, $2, $3)',
      [workspaceId, activeTask.rows[0]!.id, activeTask.rows[0]!.version],
    )).rejects.toThrow(/restore_not_deleted/i);

    const expiredTask = await database.query<{ id: string; version: number }>(`
      insert into public.tasks (workspace_id, title, status_id, deleted_at)
      values ($1, 'Просроченная', $2, clock_timestamp() - interval '30 days') returning id, version
    `, [workspaceId, statusId]);
    const expiredKnowledge = await database.query<{ id: string; version: number }>(`
      insert into public.knowledge_items (workspace_id, title, kind, link_url, deleted_at)
      values ($1, 'Просроченный материал', 'note', null, clock_timestamp() - interval '31 days') returning id, version
    `, [workspaceId]);
    await expect(database.query(
      'select * from public.restore_task_record($1, $2, $3)',
      [workspaceId, expiredTask.rows[0]!.id, expiredTask.rows[0]!.version],
    )).rejects.toThrow(/restore_expired/i);
    await expect(database.query(
      'select * from public.restore_knowledge_record($1, $2, $3)',
      [workspaceId, expiredKnowledge.rows[0]!.id, expiredKnowledge.rows[0]!.version],
    )).rejects.toThrow(/restore_expired/i);

    const recentTask = await database.query<{ id: string; version: number }>(`
      insert into public.tasks (workspace_id, title, status_id, deleted_at)
      values ($1, 'Свежая', $2, clock_timestamp() - interval '29 days') returning id, version
    `, [workspaceId, statusId]);
    const recentKnowledge = await database.query<{ id: string; version: number }>(`
      insert into public.knowledge_items (workspace_id, title, kind, link_url, deleted_at)
      values ($1, 'Свежий материал', 'note', null, clock_timestamp() - interval '29 days') returning id, version
    `, [workspaceId]);
    expect((await database.query<{ deleted_at: string | null }>(
      'select deleted_at from public.restore_task_record($1, $2, $3)',
      [workspaceId, recentTask.rows[0]!.id, recentTask.rows[0]!.version],
    )).rows).toEqual([{ deleted_at: null }]);
    expect((await database.query<{ deleted_at: string | null }>(
      'select deleted_at from public.restore_knowledge_record($1, $2, $3)',
      [workspaceId, recentKnowledge.rows[0]!.id, recentKnowledge.rows[0]!.version],
    )).rows).toEqual([{ deleted_at: null }]);
    await expect(database.query(
      "select * from public.restore_task_record($1, '00000000-0000-4000-8000-000000000404', 1)", [workspaceId],
    )).rejects.toThrow(/task_not_found/i);
    await expect(database.query(
      "select * from public.restore_knowledge_record($1, '00000000-0000-4000-8000-000000000404', 1)", [workspaceId],
    )).rejects.toThrow(/knowledge_not_found/i);
  });

  it('broadcasts contact changes only to the owning workspace and accepts only a same-workspace active audit actor', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const actorId = '20000000-0000-4000-8000-000000000001';
    await database.exec('delete from realtime.messages');
    await database.query("select set_config('request.headers', $1, false)", [JSON.stringify({ 'x-smoking-zen-actor': actorId })]);
    await database.query(
      `select * from public.create_contact_with_methods($1, 'Клининг', 'cleaning', '', $2::jsonb)`,
      [workspaceId, JSON.stringify([{ kind: 'whatsapp', value: '79991234567' }])],
    );
    const messages = await database.query<{ topic: string; payload: { entity: string } }>('select topic, payload from realtime.messages order by id');
    expect(messages.rows).toEqual(expect.arrayContaining([
      { topic: `workspace:${workspaceId}`, payload: { entity: 'contact', action: 'created' } },
      { topic: `workspace:${workspaceId}`, payload: { entity: 'contact_method', action: 'created' } },
    ]));
    const event = await database.query<{ actor_user_id: string | null }>(`
      select actor_user_id from public.audit_events where entity_type = 'contact' order by occurred_at desc limit 1
    `);
    expect(event.rows[0]?.actor_user_id).toBe(actorId);
  });

  it('rejects cross-workspace event, outbox, and delivery relationships', async () => {
    const database = await createDatabase();
    const workspaceOne = '10000000-0000-4000-8000-000000000001';
    const workspaceTwo = '10000000-0000-4000-8000-000000000002';
    const eventOne = '20000000-0000-4000-8000-000000000001';
    const eventTwo = '20000000-0000-4000-8000-000000000002';
    const eventThree = '20000000-0000-4000-8000-000000000003';
    const outboxOne = '30000000-0000-4000-8000-000000000001';
    await database.exec(`
      insert into public.workspaces (id, name) values
        ('${workspaceOne}', 'One'), ('${workspaceTwo}', 'Two');
      insert into public.audit_events (id, workspace_id, entity_type, entity_id, action, entity_version) values
        ('${eventOne}', '${workspaceOne}', 'task', gen_random_uuid(), 'created', 1),
        ('${eventTwo}', '${workspaceTwo}', 'task', gen_random_uuid(), 'created', 1),
        ('${eventThree}', '${workspaceOne}', 'task', gen_random_uuid(), 'created', 1);
      insert into public.notification_outbox (id, workspace_id, event_id, channel)
      values ('${outboxOne}', '${workspaceOne}', '${eventOne}', 'telegram');
    `);

    await expect(database.exec(`
      insert into public.notification_outbox (workspace_id, event_id, channel)
      values ('${workspaceTwo}', '${eventThree}', 'telegram')
    `)).rejects.toThrow(/foreign key/i);
    await expect(database.exec(`
      insert into public.notification_deliveries (workspace_id, event_id, outbox_id, channel)
      values ('${workspaceTwo}', '${eventTwo}', '${outboxOne}', 'telegram')
    `)).rejects.toThrow(/foreign key/i);
  });

  it('exposes the redemption RPC without a client-controlled timestamp parameter', async () => {
    const database = await createDatabase();
    const signature = await database.query<{ arguments: string }>(`
      select pg_get_function_identity_arguments(p.oid) as arguments
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'redeem_workspace_invitation'
    `);

    expect(signature.rows).toEqual([{
      arguments: 'p_token_hash text, p_telegram_id text, p_first_name text, p_last_name text, p_username text, p_language_code text',
    }]);
  });

  it('broadcasts task changes only on the owning private workspace topic', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const status = await database.query<{ id: string; workspace_id: string }>(
      'select id, workspace_id from public.task_statuses order by position limit 1',
    );

    await database.exec('delete from realtime.messages');
    await database.query(
      'insert into public.tasks (workspace_id, title, status_id) values ($1, $2, $3)',
      [status.rows[0]!.workspace_id, 'Realtime task', status.rows[0]!.id],
    );
    const messages = await database.query<{ topic: string; extension: string; event: string; payload: { entity: string } }>(
      'select topic, extension, event, payload from realtime.messages',
    );

    expect(messages.rows).toEqual([{
      topic: `workspace:${status.rows[0]!.workspace_id}`,
      extension: 'broadcast',
      event: 'workspace_changed',
      payload: { entity: 'task', action: 'created' },
    }]);
  });

  it('attributes service-role audit events only to an active member of the same live workspace', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceOne = '10000000-0000-4000-8000-000000000001';
    const workspaceTwo = '10000000-0000-4000-8000-000000000002';
    const actorOne = '20000000-0000-4000-8000-000000000001';
    const statusOne = '40000000-0000-4000-8000-000000000001';
    const statusTwo = '40000000-0000-4000-8000-000000000099';
    await database.exec(`
      insert into public.workspaces (id, name) values ('${workspaceTwo}', 'Other workspace');
      insert into public.task_statuses (id, workspace_id, name, position)
      values ('${statusTwo}', '${workspaceTwo}', 'Новая', 1);
    `);

    await database.query("select set_config('request.headers', $1, false)", [JSON.stringify({ 'x-smoking-zen-actor': actorOne })]);
    await database.query('insert into public.tasks (workspace_id, title, status_id) values ($1, $2, $3)', [workspaceOne, 'Attributed', statusOne]);
    await database.query('insert into public.tasks (workspace_id, title, status_id) values ($1, $2, $3)', [workspaceTwo, 'Forged cross-workspace', statusTwo]);
    const events = await database.query<{ workspace_id: string; actor_user_id: string | null }>(
      `select ae.workspace_id, ae.actor_user_id
       from public.audit_events ae join public.tasks t on t.id = ae.entity_id
       where t.title in ('Attributed', 'Forged cross-workspace') order by ae.workspace_id`,
    );

    expect(events.rows).toEqual([
      { workspace_id: workspaceOne, actor_user_id: actorOne },
      { workspace_id: workspaceTwo, actor_user_id: null },
    ]);
  });

  it('allows service-role audit reads and trigger writes while denying every direct audit mutation', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const taskId = '61000000-0000-4000-8000-000000000005';
    const commentId = '62000000-0000-4000-8000-000000000005';
    const directEventId = '63000000-0000-4000-8000-000000000005';
    await database.exec('set role service_role');

    await database.query(
      'insert into public.tasks (id, workspace_id, title, status_id) values ($1, $2, $3, $4)',
      [taskId, workspaceId, 'Service task', '40000000-0000-4000-8000-000000000001'],
    );
    await database.query(
      'insert into public.comments (id, workspace_id, task_id, author_id, body) values ($1, $2, $3, $4, $5)',
      [commentId, workspaceId, taskId, '30000000-0000-4000-8000-000000000001', 'Service comment'],
    );
    const triggerEvents = await database.query<{ entity_type: string; entity_id: string }>(`
      select entity_type, entity_id
      from public.audit_events
      where entity_id in ('${taskId}', '${commentId}')
      order by entity_type
    `);

    const rejected = async (sql: string, params: unknown[] = []) => {
      try {
        await database.query(sql, params);
        return false;
      } catch {
        return true;
      }
    };
    const mutations = {
      insert: await rejected(
        `insert into public.audit_events
          (id, workspace_id, entity_type, entity_id, action, entity_version)
         values ($1, $2, 'task', $3, 'created', 1)`,
        [directEventId, workspaceId, '64000000-0000-4000-8000-000000000005'],
      ),
      update: await rejected("update public.audit_events set action = 'updated' where id = $1", [directEventId]),
      delete: await rejected('delete from public.audit_events where id = $1', [directEventId]),
      truncate: await rejected('truncate table public.audit_events cascade'),
    };
    const privileges = await database.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
    }>(`
      select
        has_table_privilege(current_user, 'public.audit_events', 'select') as can_select,
        has_table_privilege(current_user, 'public.audit_events', 'insert') as can_insert,
        has_table_privilege(current_user, 'public.audit_events', 'update') as can_update,
        has_table_privilege(current_user, 'public.audit_events', 'delete') as can_delete,
        has_table_privilege(current_user, 'public.audit_events', 'truncate') as can_truncate
    `);

    expect(triggerEvents.rows).toEqual([
      { entity_type: 'comment', entity_id: commentId },
      { entity_type: 'task', entity_id: taskId },
    ]);
    expect(mutations).toEqual({ insert: true, update: true, delete: true, truncate: true });
    expect(privileges.rows).toEqual([{
      can_select: true, can_insert: false, can_update: false, can_delete: false, can_truncate: false,
    }]);
    await database.exec('reset role');
    await expect(database.exec('truncate table public.audit_events cascade')).rejects.toThrow(/append-only/i);
  });

  it('denies a Realtime-scoped authenticated bearer every direct business-table mutation', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const userId = '20000000-0000-4000-8000-000000000001';
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const taskId = '61000000-0000-4000-8000-000000000001';
    const commentId = '62000000-0000-4000-8000-000000000001';
    await database.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    await database.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role: 'authenticated', workspace_id: workspaceId, smoking_zen_scope: 'realtime' })]);
    await database.exec('set role authenticated');

    const permissionDenied = async (sql: string, params: unknown[] = []) => {
      try {
        await database.query(sql, params);
        return false;
      } catch (error) {
        return /permission denied/i.test(String(error));
      }
    };
    const denied = {
      taskSelect: await permissionDenied('select * from public.tasks'),
      taskInsert: await permissionDenied(
        'insert into public.tasks (id, workspace_id, title, status_id) values ($1, $2, $3, $4)',
        [taskId, workspaceId, 'Bearer insert', '40000000-0000-4000-8000-000000000001'],
      ),
      taskUpdate: await permissionDenied("update public.tasks set title = 'Bypass version' where id = '60000000-0000-4000-8000-000000000001'"),
      taskHardDelete: await permissionDenied('delete from public.tasks where id = $1', [taskId]),
      commentSelect: await permissionDenied('select * from public.comments'),
      commentSpoofAuthor: await permissionDenied(
        'insert into public.comments (id, workspace_id, task_id, author_id, body) values ($1, $2, $3, $4, $5)',
        [commentId, workspaceId, '60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'Spoofed author'],
      ),
      commentUpdate: await permissionDenied("update public.comments set body = 'Bypass version' where id = $1", [commentId]),
      commentHardDelete: await permissionDenied('delete from public.comments where id = $1', [commentId]),
    };

    expect(denied).toEqual({
      taskSelect: true, taskInsert: true, taskUpdate: true, taskHardDelete: true,
      commentSelect: true, commentSpoofAuthor: true, commentUpdate: true, commentHardDelete: true,
    });
  });

  it('denies direct Storage and public RPC access to the Realtime bearer', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const userId = '20000000-0000-4000-8000-000000000001';
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    await database.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    await database.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role: 'authenticated', workspace_id: workspaceId, smoking_zen_scope: 'realtime' })]);
    await database.exec('set role authenticated');

    await expect(database.query(
      'insert into storage.objects (bucket_id, name) values ($1, $2)',
      ['workspace-files', `${workspaceId}/forged.txt`],
    )).rejects.toThrow(/permission denied/i);
    await expect(database.query("select * from public.update_own_profile('Forged profile', null, null)"))
      .rejects.toThrow(/permission denied/i);
  });

  it('authorizes only scoped private Realtime SELECT for the active member workspace', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const userId = '20000000-0000-4000-8000-000000000001';
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    await database.exec(`
      insert into public.workspaces (id, name) values ('10000000-0000-4000-8000-000000000002', 'Other');
      insert into public.workspace_members (id, workspace_id, user_id, display_name, role, active)
      values (
        '30000000-0000-4000-8000-000000000099',
        '10000000-0000-4000-8000-000000000002',
        '${userId}',
        'Same user, other workspace',
        'member',
        true
      );
      insert into realtime.messages (extension, topic, event, payload)
      values ('broadcast', 'workspace:${workspaceId}', 'workspace_changed', '{}');
    `);
    await database.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    await database.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role: 'authenticated', workspace_id: workspaceId, smoking_zen_scope: 'realtime' })]);
    await database.exec('set role authenticated');

    await database.query("select set_config('realtime.topic', $1, false)", [`workspace:${workspaceId}`]);
    const own = await database.query<{ count: number }>('select count(*)::int as count from realtime.messages');
    await database.query("select set_config('realtime.topic', $1, false)", ['workspace:10000000-0000-4000-8000-000000000002']);
    const other = await database.query<{ count: number }>('select count(*)::int as count from realtime.messages');
    await database.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role: 'authenticated', workspace_id: workspaceId })]);
    await database.query("select set_config('realtime.topic', $1, false)", [`workspace:${workspaceId}`]);
    const unscoped = await database.query<{ count: number }>('select count(*)::int as count from realtime.messages');
    await expect(database.query(
      "insert into realtime.messages (extension, topic, event, payload) values ('broadcast', $1, 'forged', '{}')",
      [`workspace:${workspaceId}`],
    )).rejects.toThrow(/permission denied/i);

    expect(own.rows[0]?.count).toBeGreaterThan(0);
    expect(other.rows[0]?.count).toBe(0);
    expect(unscoped.rows[0]?.count).toBe(0);
  });

  it('removes Supabase default grants for future public objects', async () => {
    const database = await createDatabase();
    await database.exec(`
      create table public.future_private_record (id bigserial primary key);
      create function public.future_private_function() returns integer language sql as 'select 1';
    `);
    const privileges = await database.query<{
      authenticated_table: boolean;
      authenticated_sequence: boolean;
      anon_table: boolean;
      anon_sequence: boolean;
      service_table: boolean;
      service_function: boolean;
    }>(`
      select
        has_table_privilege('authenticated', 'public.future_private_record', 'select') as authenticated_table,
        has_sequence_privilege('authenticated', 'public.future_private_record_id_seq', 'usage') as authenticated_sequence,
        has_table_privilege('anon', 'public.future_private_record', 'select') as anon_table,
        has_sequence_privilege('anon', 'public.future_private_record_id_seq', 'usage') as anon_sequence,
        has_table_privilege('service_role', 'public.future_private_record', 'select') as service_table,
        has_function_privilege('service_role', 'public.future_private_function()', 'execute') as service_function
    `);

    const lockdownMigration = await readFile('supabase/migrations/0004_realtime_scope_lockdown.sql', 'utf8');
    const currentLeaks = await database.query<{ grantee: string; object_name: string }>(`
      select grantee, table_name as object_name
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('PUBLIC', 'anon', 'authenticated')
      union all
      select grantee, routine_name as object_name
      from information_schema.role_routine_grants
      where routine_schema = 'public'
        and routine_name <> 'future_private_function'
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    `);
    expect(privileges.rows).toEqual([{
      authenticated_table: false,
      authenticated_sequence: false,
      anon_table: false,
      anon_sequence: false,
      service_table: true,
      service_function: true,
    }]);
    expect(currentLeaks.rows).toEqual([]);
    // PGlite keeps PostgreSQL's implicit PUBLIC function EXECUTE even after ALTER DEFAULT
    // PRIVILEGES, so the function-default revocation is covered statically here while
    // current function denial is exercised above against the profile RPC.
    expect(lockdownMigration).toMatch(/alter default privileges in schema public revoke execute on functions from public, anon, authenticated;/i);
  });
});
