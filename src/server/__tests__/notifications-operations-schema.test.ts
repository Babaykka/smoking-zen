// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const MIGRATION_0015 = 'supabase/migrations/0015_task7_notifications_cleanup.sql';
const MIGRATION_0017 = 'supabase/migrations/0017_task7_notification_replay.sql';
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
  MIGRATION_0015,
  MIGRATION_0017,
];

const databases: PGlite[] = [];

async function applyMigration(database: PGlite, filename: string) {
  const migration = (await readFile(filename, 'utf8'))
    .replace('create extension if not exists pgcrypto with schema extensions;', '');
  await database.exec(migration);
}

async function createDatabase(
  migrations: readonly string[] = MIGRATIONS,
  reapplyLast = true,
) {
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
      id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default extensions.gen_random_uuid(), bucket_id text, name text
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

async function bootstrapOwner(database: PGlite, telegramId = '4503599627370495') {
  const result = await database.query<{
    user_id: string;
    membership_id: string;
    workspace_id: string;
  }>(`select * from public.bootstrap_telegram_user(
    $1, 'Владелец', null, 'owner_zen', 'ru', $1, 'Smoking Zen notifications'
  )`, [telegramId]);
  return result.rows[0]!;
}

async function addMember(
  database: PGlite,
  workspaceId: string,
  index: 2 | 3,
  username: string,
) {
  const userId = `20000000-0000-4000-8000-00000000000${index}`;
  const membershipId = `30000000-0000-4000-8000-00000000000${index}`;
  await database.query(`
    insert into public.app_users (id, telegram_id, first_name, username)
    values ($1, $2, $3, $4)
  `, [userId, `12345678${index}`, `Участник ${index}`, username]);
  await database.query(`
    insert into public.workspace_members (
      id, workspace_id, user_id, display_name, role, active
    ) values ($1, $2, $3, $4, 'member', true)
  `, [membershipId, workspaceId, userId, `Участник ${index}`]);
  return { userId, membershipId, username };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('Task 7 notification operations schema', () => {
  it('does not persist uninvited bootstrap identities and rate-limits verified identities durably', async () => {
    const database = await createDatabase();
    await bootstrapOwner(database);
    const before = (await database.query<{ count: number }>(
      'select count(*)::int as count from public.app_users',
    )).rows[0]!.count;
    expect((await database.query(`select * from public.bootstrap_telegram_user(
      '123456789', 'Uninvited', null, 'uninvited', 'ru',
      '4503599627370495', 'Must not be created'
    )`)).rows).toEqual([]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.app_users',
    )).rows).toEqual([{ count: before }]);

    const verdicts: boolean[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      verdicts.push((await database.query<{ allowed: boolean }>(`
        select public.consume_telegram_session_attempt('123456789') as allowed
      `)).rows[0]!.allowed);
    }
    expect(verdicts.slice(0, 20)).toEqual(Array(20).fill(true));
    expect(verdicts[20]).toBe(false);
  });

  it('never preserves owner role through member-invite redemption and refuses active memberships', async () => {
    const database = await createDatabase();
    const actor = await bootstrapOwner(database);
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    await database.query(`select * from public.create_workspace_invitation(
      $1, $2, 'member', $3, clock_timestamp() + interval '1 day'
    )`, [actor.workspace_id, actor.user_id, firstHash]);
    await expect(database.query(`select * from public.redeem_workspace_invitation(
      $1, '4503599627370495', 'Owner', null, 'owner', 'ru'
    )`, [firstHash])).rejects.toThrow(/invitation_invalid/);
    expect((await database.query<{ used: boolean }>(`
      select used_at is not null as used from public.invitations where token_hash = decode($1, 'hex')
    `, [firstHash])).rows).toEqual([{ used: false }]);

    await database.query(`select * from public.create_workspace_invitation(
      $1, $2, 'member', $3, clock_timestamp() + interval '1 day'
    )`, [actor.workspace_id, actor.user_id, secondHash]);
    await database.query(`
      update public.workspace_members set active = false, deleted_at = clock_timestamp()
      where id = $1
    `, [actor.membership_id]);
    const redeemed = await database.query<{ role: string; active: boolean }>(`
      select role, active from public.redeem_workspace_invitation(
        $1, '4503599627370495', 'Owner', null, 'owner', 'ru'
      )
    `, [secondHash]);
    expect(redeemed.rows).toEqual([{ role: 'member', active: true }]);
    expect((await database.query<{ role: string }>(`
      select role from public.workspace_members where id = $1
    `, [actor.membership_id])).rows).toEqual([{ role: 'member' }]);
  });

  it('retains the validated service actor fallback for Task7 audit events', async () => {
    const database = await createDatabase();
    const actor = await bootstrapOwner(database);
    const other = await bootstrapOwner(database, '4503599627370494');
    await database.query(`select set_config('request.headers', $1, false)`, [
      JSON.stringify({ 'x-smoking-zen-actor': actor.user_id }),
    ]);
    await database.query(`
      insert into public.tasks (workspace_id, title, status_id)
      select $1, 'Attributed', id from public.task_statuses
      where workspace_id = $1 order by position limit 1
    `, [actor.workspace_id]);
    expect((await database.query<{ actor_user_id: string | null }>(`
      select actor_user_id::text from public.audit_events
      where workspace_id = $1 and entity_type = 'task' order by occurred_at desc limit 1
    `, [actor.workspace_id])).rows).toEqual([{ actor_user_id: actor.user_id }]);

    await database.query(`
      insert into public.tasks (workspace_id, title, status_id)
      select $1, 'Cross workspace', id from public.task_statuses
      where workspace_id = $1 order by position limit 1
    `, [other.workspace_id]);
    expect((await database.query<{ actor_user_id: string | null }>(`
      select actor_user_id::text from public.audit_events
      where workspace_id = $1 and entity_type = 'task' order by occurred_at desc limit 1
    `, [other.workspace_id])).rows).toEqual([{ actor_user_id: null }]);
  });

  it('adds explicit completion flags on upgrade and for workspaces created after an idempotent reapply', async () => {
    const before0015 = MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0015));
    const upgraded = await createDatabase(before0015, false);
    const owner = await bootstrapOwner(upgraded);
    expect((await upgraded.query<{ count: number }>(`
      select count(*)::int as count from public.task_statuses
      where workspace_id = $1 and name = 'Готово'
    `, [owner.workspace_id])).rows).toEqual([{ count: 1 }]);

    await applyMigration(upgraded, MIGRATION_0015);
    const afterUpgrade = await upgraded.query<{ name: string; is_completed: boolean }>(`
      select name, is_completed from public.task_statuses
      where workspace_id = $1 order by position
    `, [owner.workspace_id]);
    expect(afterUpgrade.rows).toEqual([
      { name: 'Новая', is_completed: false },
      { name: 'В работе', is_completed: false },
      { name: 'Ждёт', is_completed: false },
      { name: 'Готово', is_completed: true },
    ]);
    await applyMigration(upgraded, MIGRATION_0015);
    expect((await upgraded.query(`
      select name, is_completed from public.task_statuses
      where workspace_id = $1 order by position
    `, [owner.workspace_id])).rows).toEqual(afterUpgrade.rows);

    const completedId = (await upgraded.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and is_completed
    `, [owner.workspace_id])).rows[0]!.id;
    await upgraded.query("update public.task_statuses set name = 'Завершена' where id = $1", [completedId]);
    await upgraded.query(`
      insert into public.task_statuses (workspace_id, name, position, is_completed)
      values ($1, 'Готово', 99, false)
    `, [owner.workspace_id]);
    await bootstrapOwner(upgraded);
    await applyMigration(upgraded, MIGRATION_0015);
    const preservedCompletion = await upgraded.query<{ name: string; is_completed: boolean }>(`
      select name, is_completed from public.task_statuses
      where workspace_id = $1 and name in ('Завершена', 'Готово')
    `, [owner.workspace_id]);
    expect(preservedCompletion.rows).toHaveLength(2);
    expect(preservedCompletion.rows).toEqual(expect.arrayContaining([
      { name: 'Завершена', is_completed: true },
      { name: 'Готово', is_completed: false },
    ]));

    const fresh = await createDatabase();
    const freshOwner = await bootstrapOwner(fresh, '4503599627370494');
    expect((await fresh.query<{ name: string; is_completed: boolean }>(`
      select name, is_completed from public.task_statuses
      where workspace_id = $1 order by position
    `, [freshOwner.workspace_id])).rows).toEqual(afterUpgrade.rows);
  });

  it('seeds the explicit completion flag without localized-name inference', async () => {
    const database = await createDatabase();
    await database.exec(await readFile('supabase/seed.sql', 'utf8'));
    expect((await database.query<{ name: string; is_completed: boolean }>(`
      select name, is_completed from public.task_statuses
      where workspace_id = '10000000-0000-4000-8000-000000000001'
      order by position
    `)).rows).toEqual([
      { name: 'Новая', is_completed: false },
      { name: 'В работе', is_completed: false },
      { name: 'Ждёт', is_completed: false },
      { name: 'Готово', is_completed: true },
    ]);
    await database.query(`
      update public.task_statuses
      set is_completed = case name when 'Новая' then true else false end
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and name in ('Новая', 'Готово')
    `);
    await database.exec(await readFile('supabase/seed.sql', 'utf8'));
    expect((await database.query<{ name: string; is_completed: boolean }>(`
      select name, is_completed from public.task_statuses
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and name in ('Новая', 'Готово')
      order by position
    `)).rows).toEqual([
      { name: 'Новая', is_completed: true },
      { name: 'Готово', is_completed: false },
    ]);
  });

  it('retires old generic rows while preserving audit and emits only real recipient transitions and distinct active mentions', async () => {
    const before0015 = MIGRATIONS.slice(0, MIGRATIONS.indexOf(MIGRATION_0015));
    const database = await createDatabase(before0015, false);
    const owner = await bootstrapOwner(database);
    const status = await database.query<{ id: string }>(`
      select id from public.task_statuses where workspace_id = $1 and name = 'Новая'
    `, [owner.workspace_id]);
    await database.query(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Legacy generic event', $2)
    `, [owner.workspace_id, status.rows[0]!.id]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.notification_outbox',
    )).rows[0]!.count).toBeGreaterThan(0);
    const auditCount = (await database.query<{ count: number }>(
      'select count(*)::int as count from public.audit_events',
    )).rows[0]!.count;

    await applyMigration(database, MIGRATION_0015);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.notification_outbox',
    )).rows).toEqual([{ count: 0 }]);
    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.audit_events',
    )).rows).toEqual([{ count: auditCount }]);

    const alina = await addMember(database, owner.workspace_id, 2, 'alina_zen');
    const boris = await addMember(database, owner.workspace_id, 3, 'boris_zen');
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id, assignee_id)
      values ($1, 'Assignment transitions', $2, $3) returning id
    `, [owner.workspace_id, status.rows[0]!.id, alina.membershipId]);
    await database.query('update public.tasks set title = $2 where id = $1', [task.rows[0]!.id, 'No new assignment']);
    await database.query('update public.tasks set assignee_id = $2 where id = $1', [task.rows[0]!.id, alina.membershipId]);
    await database.query('update public.tasks set assignee_id = $2 where id = $1', [task.rows[0]!.id, boris.membershipId]);
    await database.query('update public.workspace_members set active = false where id = $1', [alina.membershipId]);
    await database.query('update public.tasks set assignee_id = $2 where id = $1', [task.rows[0]!.id, alina.membershipId]);
    expect((await database.query<{ recipient_id: string }>(`
      select recipient_id::text from public.notification_outbox
      where kind = 'assignment' order by created_at
    `)).rows).toEqual([
      { recipient_id: alina.membershipId },
      { recipient_id: boris.membershipId },
    ]);

    await database.query('update public.workspace_members set active = true where id = $1', [alina.membershipId]);
    await database.query(`
      insert into public.comments (workspace_id, task_id, author_id, body)
      values ($1, $2, $3, '@ALINA_ZEN @alina_zen @boris_zen @owner_zen')
    `, [owner.workspace_id, task.rows[0]!.id, owner.membership_id]);
    expect((await database.query<{ recipient_id: string }>(`
      select recipient_id::text from public.notification_outbox
      where kind = 'mention' order by recipient_id
    `)).rows).toEqual([
      { recipient_id: alina.membershipId },
      { recipient_id: boris.membershipId },
    ]);

    expect((await database.query<{ count: number }>(
      'select count(*)::int as count from public.audit_events',
    )).rows[0]!.count).toBeGreaterThan(auditCount);
  });

  it('rejects cross-workspace recipient/task scopes and fully locks operational tables from browser roles', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const member = await addMember(database, owner.workspace_id, 2, 'scope_member');
    const status = await database.query<{ id: string }>(`
      select id from public.task_statuses where workspace_id = $1 and name = 'Новая'
    `, [owner.workspace_id]);
    const task = await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id)
      values ($1, 'Scoped task', $2) returning id
    `, [owner.workspace_id, status.rows[0]!.id]);
    const otherWorkspace = '10000000-0000-4000-8000-000000000099';
    await database.query('insert into public.workspaces (id, name) values ($1, $2)', [otherWorkspace, 'Other']);

    await expect(database.query(`
      insert into public.notification_outbox (
        workspace_id, task_id, recipient_id, kind, idempotency_key, due_at_snapshot
      ) values ($1, $2, $3, 'due_24h', 'cross-workspace', clock_timestamp())
    `, [otherWorkspace, task.rows[0]!.id, member.membershipId])).rejects.toThrow();

    const privileges = await database.query<{
      anon_outbox: boolean;
      auth_delivery: boolean;
      anon_claim: boolean;
      auth_plan: boolean;
      service_claim: boolean;
      service_private_clock: boolean;
    }>(`
      select
        has_table_privilege('anon', 'public.notification_outbox', 'select') as anon_outbox,
        has_table_privilege('authenticated', 'public.notification_deliveries', 'insert') as auth_delivery,
        has_function_privilege('anon', 'public.claim_notification_outbox(integer)', 'execute') as anon_claim,
        has_function_privilege('authenticated', 'public.plan_task_notifications()', 'execute') as auth_plan,
        has_function_privilege('service_role', 'public.claim_notification_outbox(integer)', 'execute') as service_claim,
        has_function_privilege('service_role', 'private.plan_task_notifications_at(timestamptz)', 'execute') as service_private_clock
    `);
    expect(privileges.rows).toEqual([{
      anon_outbox: false,
      auth_delivery: false,
      anon_claim: false,
      auth_plan: false,
      service_claim: true,
      service_private_clock: false,
    }]);
  });

  it('plans exact DB-clock due and 10:00 Moscow overdue boundaries idempotently using is_completed', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'planner_member');
    const statuses = await database.query<{ id: string; is_completed: boolean }>(`
      select id::text, is_completed from public.task_statuses
      where workspace_id = $1 order by position
    `, [owner.workspace_id]);
    const openStatus = statuses.rows.find(({ is_completed }) => !is_completed)!.id;
    const completedStatus = statuses.rows.find(({ is_completed }) => is_completed)!.id;
    await database.query("update public.task_statuses set name = 'Завершена' where id = $1", [completedStatus]);

    const rows = [
      ['40000000-0000-4000-8000-000000000041', 'Due exact now', openStatus, '2026-08-02T06:59:00.000Z', null, assignee.membershipId],
      ['40000000-0000-4000-8000-000000000042', 'Due exact 24h', openStatus, '2026-08-03T06:59:00.000Z', null, assignee.membershipId],
      ['40000000-0000-4000-8000-000000000043', 'Due beyond 24h', openStatus, '2026-08-03T07:00:00.001Z', null, assignee.membershipId],
      ['40000000-0000-4000-8000-000000000044', 'Completed localized rename', completedStatus, '2026-08-03T06:00:00.000Z', null, assignee.membershipId],
      ['40000000-0000-4000-8000-000000000045', 'Deleted', openStatus, '2026-08-03T06:00:00.000Z', '2026-08-01T00:00:00.000Z', assignee.membershipId],
    ] as const;
    for (const row of rows) {
      await database.query(`
        insert into public.tasks (
          id, workspace_id, title, status_id, due_at, deleted_at, assignee_id
        ) values ($1, $2, $3, $4, $5, $6, $7)
      `, [row[0], owner.workspace_id, row[1], row[2], row[3], row[4], row[5]]);
    }
    await database.query("delete from public.notification_outbox where kind = 'assignment'");

    expect((await database.query<{ planned: number }>(
      "select private.plan_task_notifications_at('2026-08-02T06:59:00.000Z') as planned",
    )).rows).toEqual([{ planned: 1 }]);
    expect((await database.query<{ kind: string; task_id: string }>(`
      select kind, task_id::text from public.notification_outbox order by kind, task_id
    `)).rows).toEqual([{ kind: 'due_24h', task_id: rows[1][0] }]);
    expect((await database.query<{ planned: number }>(
      "select private.plan_task_notifications_at('2026-08-02T06:59:00.000Z') as planned",
    )).rows).toEqual([{ planned: 0 }]);

    expect((await database.query<{ planned: number }>(
      "select private.plan_task_notifications_at('2026-08-02T07:00:00.000Z') as planned",
    )).rows).toEqual([{ planned: 1 }]);
    expect((await database.query<{ planned: number }>(
      "select private.plan_task_notifications_at('2026-08-02T20:59:59.999Z') as planned",
    )).rows).toEqual([{ planned: 1 }]);
    expect((await database.query<{ planned: number }>(
      "select private.plan_task_notifications_at('2026-08-03T07:00:00.000Z') as planned",
    )).rows).toEqual([{ planned: 2 }]);
    expect((await database.query<{ local_day: string }>(`
      select split_part(idempotency_key, ':', 5) as local_day
      from public.notification_outbox where kind = 'overdue_daily'
      order by local_day desc limit 1
    `)).rows).toEqual([{ local_day: '2026-08-03' }]);
  });

  it('builds one canonical due key for an exact instant in every session time zone', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'timezone_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    await database.query(`
      insert into public.tasks (id, workspace_id, title, status_id, assignee_id, due_at)
      values (
        '40000000-0000-4000-8000-000000000071', $1, 'Canonical due', $2, $3,
        '2026-08-03T08:00:00.123456Z'
      )
    `, [owner.workspace_id, status.id, assignee.membershipId]);
    await database.query("delete from public.notification_outbox where kind = 'assignment'");

    await database.query("set time zone 'UTC'");
    await database.query("select private.plan_task_notifications_at('2026-08-02T08:00:00.123456Z')");
    const utcKey = (await database.query<{ idempotency_key: string }>(`
      select idempotency_key from public.notification_outbox where kind = 'due_24h'
    `)).rows[0]!.idempotency_key;
    await database.query("delete from public.notification_outbox where kind = 'due_24h'");

    await database.query("set time zone 'Europe/Moscow'");
    await database.query("select private.plan_task_notifications_at('2026-08-02T08:00:00.123456Z')");
    const moscowKey = (await database.query<{ idempotency_key: string }>(`
      select idempotency_key from public.notification_outbox where kind = 'due_24h'
    `)).rows[0]!.idempotency_key;

    expect(moscowKey).toBe(utcKey);
    expect(moscowKey).toMatch(/:1785744000123456$/u);
  });

  it('revalidates exact due windows and only the matching Moscow overdue day at or after 10:00', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'timing_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const dueTask = '40000000-0000-4000-8000-000000000072';
    const overdueTask = '40000000-0000-4000-8000-000000000073';
    await database.query(`
      insert into public.tasks (id, workspace_id, title, status_id, assignee_id, due_at)
      values
        ($1, $3, 'Due timing', $4, $5, '2026-08-03T07:00:00Z'),
        ($2, $3, 'Overdue timing', $4, $5, '2026-08-01T07:00:00Z')
    `, [dueTask, overdueTask, owner.workspace_id, status.id, assignee.membershipId]);
    await database.query("delete from public.notification_outbox where kind = 'assignment'");
    await database.query("select private.plan_task_notifications_at('2026-08-02T07:00:00Z')");
    await database.query(`
      update public.notification_outbox
      set lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff1',
          lease_expires_at = '2030-01-01T00:00:00Z', attempts = 1
      where task_id = $1
    `, [dueTask]);
    const dueOutbox = (await database.query<{ id: string }>(`
      select id::text from public.notification_outbox where task_id = $1
    `, [dueTask])).rows[0]!;
    expect((await database.query(`
      select * from private.revalidate_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff1', '2026-08-02T07:00:00Z'
      )
    `, [dueOutbox.id])).rows).toHaveLength(1);
    expect((await database.query(`
      select * from private.revalidate_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff1', '2026-08-03T07:00:00Z'
      )
    `, [dueOutbox.id])).rows).toEqual([]);

    const firstOverdue = (await database.query<{ id: string; overdue_local_date: string }>(`
      select id::text, overdue_local_date::text
      from public.notification_outbox where task_id = $1 and kind = 'overdue_daily'
    `, [overdueTask])).rows[0]!;
    expect(firstOverdue.overdue_local_date).toBe('2026-08-02');
    await database.query(`
      update public.notification_outbox
      set lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff2',
          lease_expires_at = '2030-01-01T00:00:00Z', attempts = 1
      where id = $1
    `, [firstOverdue.id]);
    expect((await database.query(`
      select * from private.revalidate_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff2', '2026-08-02T06:59:59.999Z'
      )
    `, [firstOverdue.id])).rows).toEqual([]);
    expect((await database.query(`
      select * from private.revalidate_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff2', '2026-08-02T07:00:00Z'
      )
    `, [firstOverdue.id])).rows).toHaveLength(1);

    await database.query("select private.plan_task_notifications_at('2026-08-03T07:00:00Z')");
    const nextOverdue = (await database.query<{ id: string }>(`
      select id::text from public.notification_outbox
      where task_id = $1 and kind = 'overdue_daily' and overdue_local_date = '2026-08-03'
    `, [overdueTask])).rows[0]!;
    await database.query(`
      update public.notification_outbox
      set lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff3',
          lease_expires_at = '2030-01-01T00:00:00Z', attempts = 1
      where id = $1
    `, [nextOverdue.id]);
    expect((await database.query(`
      select * from private.revalidate_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff2', '2026-08-03T07:00:00Z'
      )
    `, [firstOverdue.id])).rows).toEqual([]);
    expect((await database.query(`
      select * from private.revalidate_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff3', '2026-08-03T07:00:00Z'
      )
    `, [nextOverdue.id])).rows).toHaveLength(1);
  });

  it('uses a post-lock clock when suppressing an expired owned lease', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'suppress_clock_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id, assignee_id)
      values ($1, 'Suppress clock', $2, $3) returning id::text
    `, [owner.workspace_id, status.id, assignee.membershipId])).rows[0]!;
    const queue = (await database.query<{ id: string }>(`
      select id::text from public.notification_outbox where task_id = $1
    `, [task.id])).rows[0]!;
    await database.query(`
      update public.notification_outbox
      set lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff4',
          lease_expires_at = '2026-08-02T07:00:00Z', attempts = 1
      where id = $1
    `, [queue.id]);

    expect((await database.query<{ suppressed: boolean }>(`
      select private.suppress_notification_outbox_at(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff4', '2026-08-02T07:00:00.001Z'
      ) as suppressed
    `, [queue.id])).rows).toEqual([{ suppressed: false }]);
    expect((await database.query<{ still_owned: boolean; suppressed: boolean }>(`
      select lease_id is not null as still_owned, suppressed_at is not null as suppressed
      from public.notification_outbox where id = $1
    `, [queue.id])).rows).toEqual([{ still_owned: true, suppressed: false }]);
  });

  it('terminalizes an expired eighth lease without a ninth delivery attempt', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'max_lease_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id, assignee_id)
      values ($1, 'Expired eighth lease', $2, $3) returning id::text
    `, [owner.workspace_id, status.id, assignee.membershipId])).rows[0]!;
    await database.query(`
      update public.notification_outbox
      set attempts = 8,
          lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff5',
          lease_expires_at = clock_timestamp() - interval '1 second'
      where task_id = $1
    `, [task.id]);

    expect((await database.query('select * from public.claim_notification_outbox(20)')).rows).toEqual([]);
    expect((await database.query<{ attempts: number; dead: boolean; code: string }>(`
      select attempts, dead_letter_at is not null as dead, last_error_code as code
      from public.notification_outbox where task_id = $1
    `, [task.id])).rows).toEqual([{ attempts: 8, dead: true, code: 'delivery_indeterminate' }]);
    expect((await database.query('select * from public.claim_notification_outbox(20)')).rows).toEqual([]);
  });

  it('bounds expired-eighth-lease terminalization with a separately skip-locked candidate set', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'bounded_reaper_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    for (const suffix of ['91', '92']) {
      await database.query(`
        insert into public.tasks (id, workspace_id, title, status_id, assignee_id)
        values ($1, $2, 'Bounded expired lease', $3, $4)
      `, [`40000000-0000-4000-8000-0000000000${suffix}`, owner.workspace_id, status.id, assignee.membershipId]);
    }
    await database.query(`
      update public.notification_outbox
      set attempts = 8, lease_id = extensions.gen_random_uuid(),
          lease_expires_at = clock_timestamp() - interval '1 second'
    `);

    expect((await database.query('select * from public.claim_notification_outbox(1)')).rows).toEqual([]);
    expect((await database.query<{ dead: number; pending: number }>(`
      select
        count(*) filter (where dead_letter_at is not null)::int as dead,
        count(*) filter (where dead_letter_at is null)::int as pending
      from public.notification_outbox
    `)).rows).toEqual([{ dead: 1, pending: 1 }]);
    const definition = (await database.query<{ definition: string }>(`
      select pg_get_functiondef('public.claim_notification_outbox(integer)'::regprocedure) as definition
    `)).rows[0]!.definition;
    expect(definition.match(/for update skip locked/giu)).toHaveLength(2);
  });

  it('records an expired known-success lease only while it remains owned and rejects an older reclaimed lease', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'completion_race_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    for (const suffix of ['81', '82']) {
      await database.query(`
        insert into public.tasks (id, workspace_id, title, status_id, assignee_id)
        values ($1, $2, 'Completion race', $3, $4)
      `, [`40000000-0000-4000-8000-0000000000${suffix}`, owner.workspace_id, status.id, assignee.membershipId]);
    }
    const rows = (await database.query<{ id: string }>(`
      select id::text from public.notification_outbox order by task_id
    `)).rows;
    const owned = rows[0]!;
    const reclaimed = rows[1]!;
    await database.query(`
      update public.notification_outbox
      set lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff6',
          lease_expires_at = clock_timestamp() - interval '1 second', attempts = 1
      where id = $1
    `, [owned.id]);
    expect((await database.query<{ completed: boolean }>(`
      select public.complete_notification_outbox(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff6', 996
      ) as completed
    `, [owned.id])).rows).toEqual([{ completed: true }]);

    await database.query(`
      update public.notification_outbox
      set lease_id = 'ffffffff-ffff-4fff-8fff-fffffffffff7',
          lease_expires_at = clock_timestamp() - interval '1 second', attempts = 1
      where id = $1
    `, [reclaimed.id]);
    const newLease = (await database.query<{ lease_id: string }>(`
      select lease_id::text from public.claim_notification_outbox(1)
    `)).rows[0]!;
    expect(newLease.lease_id).not.toBe('ffffffff-ffff-4fff-8fff-fffffffffff7');
    expect((await database.query<{ completed: boolean }>(`
      select public.complete_notification_outbox(
        $1, 'ffffffff-ffff-4fff-8fff-fffffffffff7', 997
      ) as completed
    `, [reclaimed.id])).rows).toEqual([{ completed: false }]);
    expect((await database.query<{ completed: boolean }>(`
      select public.complete_notification_outbox($1, $2, 998) as completed
    `, [reclaimed.id, newLease.lease_id])).rows).toEqual([{ completed: true }]);
  });

  it('durably deduplicates Telegram webhook update ids behind service-only operations', async () => {
    const database = await createDatabase();
    expect((await database.query<{ inserted: boolean }>(`
      select public.record_telegram_webhook_update(9223372036854775) as inserted
    `)).rows).toEqual([{ inserted: true }]);
    expect((await database.query<{ inserted: boolean }>(`
      select public.record_telegram_webhook_update(9223372036854775) as inserted
    `)).rows).toEqual([{ inserted: false }]);
    await expect(database.query('select public.record_telegram_webhook_update(-1)')).rejects.toThrow();

    expect((await database.query<{
      anon_table: boolean; auth_table: boolean; anon_rpc: boolean; service_rpc: boolean;
    }>(`
      select
        has_table_privilege('anon', 'public.telegram_webhook_updates', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.telegram_webhook_updates', 'insert') as auth_table,
        has_function_privilege('anon', 'public.record_telegram_webhook_update(bigint)', 'execute') as anon_rpc,
        has_function_privilege('service_role', 'public.record_telegram_webhook_update(bigint)', 'execute') as service_rpc
    `)).rows).toEqual([{
      anon_table: false, auth_table: false, anon_rpc: false, service_rpc: true,
    }]);
  });

  it('returns task launch directives only through the active member workspace boundary', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const taskId = '40000000-0000-4000-8000-000000000093';
    await database.query(`
      insert into public.tasks (id, workspace_id, title, status_id)
      values ($1, $2, 'Launch boundary', $3)
    `, [taskId, owner.workspace_id, status.id]);

    expect((await database.query<{ task_id: string }>(`
      select task_id::text from public.get_authorized_task_launch($1, $2, $3, $4)
    `, [owner.user_id, owner.workspace_id, owner.membership_id, taskId])).rows).toEqual([{ task_id: taskId }]);
    expect((await database.query(`
      select * from public.get_authorized_task_launch(
        $1, '10000000-0000-4000-8000-000000000099', $2, $3
      )
    `, [owner.user_id, owner.membership_id, taskId])).rows).toEqual([]);
    await database.query('update public.tasks set deleted_at = clock_timestamp() where id = $1', [taskId]);
    expect((await database.query(`
      select * from public.get_authorized_task_launch($1, $2, $3, $4)
    `, [owner.user_id, owner.workspace_id, owner.membership_id, taskId])).rows).toEqual([]);

    expect((await database.query<{ anon_rpc: boolean; service_rpc: boolean }>(`
      select
        has_function_privilege('anon', 'public.get_authorized_task_launch(uuid,uuid,uuid,uuid)', 'execute') as anon_rpc,
        has_function_privilege('service_role', 'public.get_authorized_task_launch(uuid,uuid,uuid,uuid)', 'execute') as service_rpc
    `)).rows).toEqual([{ anon_rpc: false, service_rpc: true }]);
  });

  it('claims disjoint leases, reclaims expiry, suppresses stale work, and completes once atomically', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'worker_member');
    const status = await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id]);
    for (let index = 1; index <= 3; index += 1) {
      await database.query(`
        insert into public.tasks (
          id, workspace_id, title, status_id, assignee_id, due_at
        ) values ($1, $2, $3, $4, $5, '2026-08-03T06:00:00.000Z')
      `, [
        `40000000-0000-4000-8000-00000000005${index}`,
        owner.workspace_id,
        `Worker ${index}`,
        status.rows[0]!.id,
        assignee.membershipId,
      ]);
    }
    await database.query("delete from public.notification_outbox where kind = 'assignment'");
    await database.query("select private.plan_task_notifications_at('2026-08-02T07:00:00.000Z')");

    const first = await database.query<{
      id: string; lease_id: string; attempts: number;
    }>('select id::text, lease_id::text, attempts from public.claim_notification_outbox(1)');
    const second = await database.query<{ id: string }>(
      'select id::text from public.claim_notification_outbox(1)',
    );
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);

    await database.query(`
      update public.notification_outbox
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where id = $1
    `, [first.rows[0]!.id]);
    const reclaimed = await database.query<{ id: string; lease_id: string; attempts: number }>(
      'select id::text, lease_id::text, attempts from public.claim_notification_outbox(1)',
    );
    expect(reclaimed.rows).toEqual([expect.objectContaining({ id: first.rows[0]!.id, attempts: 2 })]);
    expect(reclaimed.rows[0]!.lease_id).not.toBe(first.rows[0]!.lease_id);

    expect((await database.query<{ suppressed: boolean }>(`
      select public.suppress_notification_outbox($1, $2) as suppressed
    `, [reclaimed.rows[0]!.id, reclaimed.rows[0]!.lease_id])).rows).toEqual([{ suppressed: true }]);
    expect((await database.query<{
      suppressed_at: string; lease_id: string | null; last_error_code: string | null; dead_letter_at: string | null;
    }>(`
      select suppressed_at::text, lease_id::text, last_error_code, dead_letter_at::text
      from public.notification_outbox where id = $1
    `, [reclaimed.rows[0]!.id])).rows).toEqual([expect.objectContaining({
      lease_id: null,
      last_error_code: null,
      dead_letter_at: null,
    })]);

    const completionLease = await database.query<{ id: string; lease_id: string }>(
      'select id::text, lease_id::text from public.claim_notification_outbox(1)',
    );
    const completion = completionLease.rows[0]!;
    expect((await database.query<{ completed: boolean }>(`
      select public.complete_notification_outbox($1, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 99) as completed
    `, [completion.id])).rows).toEqual([{ completed: false }]);
    expect((await database.query<{ completed: boolean }>(`
      select public.complete_notification_outbox($1, $2, 99) as completed
    `, [completion.id, completion.lease_id])).rows).toEqual([{ completed: true }]);
    expect((await database.query<{ completed: boolean }>(`
      select public.complete_notification_outbox($1, $2, 99) as completed
    `, [completion.id, completion.lease_id])).rows).toEqual([{ completed: false }]);
    expect((await database.query<{ count: number }>(`
      select count(*)::int as count from public.notification_deliveries
      where outbox_id = $1
    `, [completion.id])).rows).toEqual([{ count: 1 }]);
  });

  it('keeps only enumerated retry codes and moves the eighth attempt to dead letter', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'retry_member');
    const status = await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id]);
    await database.query(`
      insert into public.tasks (
        id, workspace_id, title, status_id, assignee_id, due_at
      ) values (
        '40000000-0000-4000-8000-000000000061', $1, 'Retry', $2, $3,
        '2026-08-03T06:00:00.000Z'
      )
    `, [owner.workspace_id, status.rows[0]!.id, assignee.membershipId]);
    await database.query("delete from public.notification_outbox where kind = 'assignment'");
    await database.query("select private.plan_task_notifications_at('2026-08-02T07:00:00.000Z')");

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await database.query(`
        update public.notification_outbox
        set available_at = clock_timestamp() - interval '1 second',
            lease_expires_at = case when lease_id is null then null else lease_expires_at end
        where delivered_at is null and dead_letter_at is null
      `);
      const lease = await database.query<{ id: string; lease_id: string; attempts: number }>(
        'select id::text, lease_id::text, attempts from public.claim_notification_outbox(1)',
      );
      expect(lease.rows[0]!.attempts).toBe(attempt);
      const outcome = await database.query<{ outcome: string }>(`
        select public.fail_notification_outbox(
          $1, $2, 'network_error', 1, false
        ) as outcome
      `, [lease.rows[0]!.id, lease.rows[0]!.lease_id]);
      expect(outcome.rows).toEqual([{ outcome: attempt === 8 ? 'dead_letter' : 'retry' }]);
    }
    expect((await database.query<{ dead: boolean; code: string }>(`
      select dead_letter_at is not null as dead, last_error_code as code
      from public.notification_outbox
    `)).rows).toEqual([{ dead: true, code: 'network_error' }]);
    await expect(database.query(`
      select public.fail_notification_outbox(
        '00000000-0000-4000-8000-000000000000',
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        'raw socket secret', 1, false
      )
    `)).rejects.toThrow();
  });

  it('replays only an exact safe dead letter through a service-only locked reset', async () => {
    const database = await createDatabase();
    const owner = await bootstrapOwner(database);
    const assignee = await addMember(database, owner.workspace_id, 2, 'replay_member');
    const status = (await database.query<{ id: string }>(`
      select id::text from public.task_statuses
      where workspace_id = $1 and not is_completed order by position limit 1
    `, [owner.workspace_id])).rows[0]!;
    const task = (await database.query<{ id: string }>(`
      insert into public.tasks (workspace_id, title, status_id, assignee_id)
      values ($1, 'Replay guarded', $2, $3) returning id::text
    `, [owner.workspace_id, status.id, assignee.membershipId])).rows[0]!;
    const queue = (await database.query<{ id: string }>(`
      select id::text from public.notification_outbox where task_id = $1
    `, [task.id])).rows[0]!;
    await database.query(`
      update public.notification_outbox
      set attempts = 8, failed_at = clock_timestamp(), dead_letter_at = clock_timestamp(),
          last_error_code = 'network_error', lease_id = null, lease_expires_at = null
      where id = $1
    `, [queue.id]);

    expect((await database.query<{ replayed: boolean }>(`
      select public.replay_notification_outbox($1, 'configuration_error') as replayed
    `, [queue.id])).rows).toEqual([{ replayed: false }]);
    expect((await database.query<{ attempts: number; code: string }>(`
      select attempts, last_error_code as code from public.notification_outbox where id = $1
    `, [queue.id])).rows).toEqual([{ attempts: 8, code: 'network_error' }]);

    expect((await database.query<{ replayed: boolean }>(`
      select public.replay_notification_outbox($1, 'network_error') as replayed
    `, [queue.id])).rows).toEqual([{ replayed: true }]);
    expect((await database.query<{
      attempts: number; dead: boolean; failed: boolean; code: string | null; lease: string | null;
    }>(`
      select attempts, dead_letter_at is not null as dead, failed_at is not null as failed,
             last_error_code as code, lease_id::text as lease
      from public.notification_outbox where id = $1
    `, [queue.id])).rows).toEqual([{
      attempts: 0, dead: false, failed: false, code: null, lease: null,
    }]);
    const lease = (await database.query<{ id: string; lease_id: string }>(`
      select id::text, lease_id::text from public.claim_notification_outbox(1)
    `)).rows[0]!;
    expect(lease.id).toBe(queue.id);
    expect((await database.query(`
      select * from public.revalidate_notification_outbox($1, $2)
    `, [lease.id, lease.lease_id])).rows).toHaveLength(1);

    await database.query(`
      update public.notification_outbox
      set attempts = 8, failed_at = clock_timestamp(), dead_letter_at = clock_timestamp(),
          last_error_code = 'delivery_indeterminate', lease_id = null, lease_expires_at = null
      where id = $1
    `, [queue.id]);
    expect((await database.query<{ replayed: boolean }>(`
      select public.replay_notification_outbox($1, 'delivery_indeterminate') as replayed
    `, [queue.id])).rows).toEqual([{ replayed: false }]);
    expect((await database.query<{ attempts: number; code: string }>(`
      select attempts, last_error_code as code from public.notification_outbox where id = $1
    `, [queue.id])).rows).toEqual([{ attempts: 8, code: 'delivery_indeterminate' }]);

    expect((await database.query<{ anon_rpc: boolean; auth_rpc: boolean; service_rpc: boolean }>(`
      select
        has_function_privilege('anon', 'public.replay_notification_outbox(uuid,text)', 'execute') as anon_rpc,
        has_function_privilege('authenticated', 'public.replay_notification_outbox(uuid,text)', 'execute') as auth_rpc,
        has_function_privilege('service_role', 'public.replay_notification_outbox(uuid,text)', 'execute') as service_rpc
    `)).rows).toEqual([{ anon_rpc: false, auth_rpc: false, service_rpc: true }]);
    const definition = (await database.query<{ definition: string }>(`
      select pg_get_functiondef('public.replay_notification_outbox(uuid,text)'::regprocedure) as definition
    `)).rows[0]!.definition;
    expect(definition).toMatch(/for update/iu);
    expect(definition).toMatch(/clock_timestamp\(\)/iu);
  });
});
