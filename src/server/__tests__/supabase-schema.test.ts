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

async function createDatabase(options: { seedRounds?: number } = {}) {
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

  for (let round = 0; round < 2; round += 1) {
    for (const filename of MIGRATIONS) {
      const migration = (await readFile(filename, 'utf8'))
        .replace('create extension if not exists pgcrypto with schema extensions;', '');
      await database.exec(migration);
    }
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

  it('keeps contact and contact methods atomic, workspace-scoped, and recoverable together', async () => {
    const database = await createDatabase({ seedRounds: 1 });
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const created = await database.query<{ id: string; version: number }>(
      `select id, version from public.create_contact_with_methods($1, 'Мастер', 'service', '', $2::jsonb)`,
      [workspaceId, JSON.stringify([{ kind: 'phone', value: '+79991234567' }])],
    );
    const contactId = created.rows[0]!.id;
    await expect(database.query(
      `select * from public.replace_contact_with_methods($1, $2, $3, 'Сломано', 'service', '', $4::jsonb)`,
      [workspaceId, contactId, created.rows[0]!.version, JSON.stringify([{ kind: 'email', value: 'bad' }])],
    )).rejects.toThrow(/invalid_contact_method/i);
    const unchanged = await database.query<{ name: string; value: string }>(`
      select c.name, m.value from public.contacts c join public.contact_methods m on m.contact_id = c.id
      where c.id = $1 and c.deleted_at is null and m.deleted_at is null
    `, [contactId]);
    expect(unchanged.rows).toEqual([{ name: 'Мастер', value: '+79991234567' }]);

    const deleted = await database.query<{ version: number }>(
      'select version from public.set_contact_deleted($1, $2, $3, false)', [workspaceId, contactId, created.rows[0]!.version],
    );
    expect((await database.query('select 1 from public.contact_methods where contact_id = $1 and deleted_at is null', [contactId])).rows).toEqual([]);
    await database.query('select * from public.set_contact_deleted($1, $2, $3, true)', [workspaceId, contactId, deleted.rows[0]!.version]);
    expect((await database.query('select 1 from public.contact_methods where contact_id = $1 and deleted_at is null', [contactId])).rows).toHaveLength(1);
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
