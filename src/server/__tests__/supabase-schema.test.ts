// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const MIGRATIONS = [
  'supabase/migrations/0001_workspace_schema.sql',
  'supabase/migrations/0002_rls_storage_realtime.sql',
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
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false, file_size_limit bigint
    );
    create table storage.objects (
      id uuid primary key default extensions.gen_random_uuid(), bucket_id text, name text
    );
    create schema realtime;
    create table realtime.messages (
      id uuid primary key default extensions.gen_random_uuid(), extension text, topic text
    );
    create function realtime.topic()
      returns text language sql stable set search_path = '' as 'select null::text';
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
  it('blocks direct Telegram identity mutation while allowing the scoped profile RPC', async () => {
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
    const profile = await database.query<{
      display_name: string;
      username: string;
      avatar_url: string;
    }>(`select * from public.update_own_profile(
      'Владелец смены', 'updated_owner', 'https://images.example/avatar.png'
    )`);
    const identity = await database.query<{ telegram_id: string }>(
      'select telegram_id from public.app_users where id = $1',
      [ordinaryUser.rows[0]!.id],
    );
    await database.exec('reset role');
    const owner = await bootstrapOwner(database);

    expect(direct.rows).toEqual([]);
    expect(identity.rows[0]?.telegram_id).toBe('123456789');
    expect(owner[0]?.role).toBe('owner');
    expect(profile.rows).toEqual([{
      display_name: 'Владелец смены',
      username: 'updated_owner',
      avatar_url: 'https://images.example/avatar.png',
    }]);
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
});
