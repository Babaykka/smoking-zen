// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const databases: PGlite[] = [];

async function databaseWithApplicationObjects() {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    create schema private;
    create table public.workspace_example (id uuid primary key);
    create sequence private.operation_sequence;
    create function private.safe_trigger_helper()
      returns trigger language plpgsql security invoker set search_path = ''
      as 'begin return new; end';
    create function private.service_mutation()
      returns void language sql security definer set search_path = '' as 'select';
    revoke all on function private.service_mutation() from public;
  `);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('database backup reader operations', () => {
  it('converges to a machine-only read-all role with no write, membership, or definer execution', async () => {
    const database = await databaseWithApplicationObjects();
    const configure = await readFile('supabase/operations/configure_database_backup_reader.sql', 'utf8');
    await database.exec(configure);
    await database.exec(configure);
    const state = await database.query<{
      rolcanlogin: boolean; rolinherit: boolean; rolsuper: boolean; rolbypassrls: boolean;
      read_only: boolean; can_select: boolean; can_insert: boolean; can_sequence_update: boolean;
      can_execute_definer: boolean; memberships: number;
    }>(`
      select role.rolcanlogin, role.rolinherit, role.rolsuper, role.rolbypassrls,
        role.rolconfig @> array['default_transaction_read_only=on'] as read_only,
        has_table_privilege(role.rolname, 'public.workspace_example', 'select') as can_select,
        has_table_privilege(role.rolname, 'public.workspace_example', 'insert') as can_insert,
        has_sequence_privilege(role.rolname, 'private.operation_sequence', 'update') as can_sequence_update,
        has_function_privilege(role.rolname, 'private.service_mutation()', 'execute') as can_execute_definer,
        (select count(*)::int from pg_catalog.pg_auth_members membership
         where role.oid in (membership.roleid, membership.member)) as memberships
      from pg_catalog.pg_roles role where role.rolname = 'smoking_zen_backup_reader'
    `);
    expect(state.rows).toEqual([{
      rolcanlogin: true,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: true,
      read_only: true,
      can_select: true,
      can_insert: false,
      can_sequence_update: false,
      can_execute_definer: false,
      memberships: 0,
    }]);
    const inspect = await readFile('supabase/operations/inspect_database_backup_reader.sql', 'utf8');
    const inspection = await database.query<Record<string, boolean>>(inspect);
    expect(inspection.rows).toHaveLength(1);
    expect(Object.values(inspection.rows[0]!)).toEqual(expect.arrayContaining([true]));
    expect(Object.values(inspection.rows[0]!).every(Boolean)).toBe(true);
  });

  it('fails closed when an existing backup role can assume or be assumed by another role', async () => {
    const database = await databaseWithApplicationObjects();
    const configure = await readFile('supabase/operations/configure_database_backup_reader.sql', 'utf8');
    await database.exec(configure);
    await database.exec('create role unexpected_role; grant unexpected_role to smoking_zen_backup_reader');
    await expect(database.exec(configure)).rejects.toThrow(/unexpected_membership/u);
  });

  it('rejects retained direct grants outside the dumped application schemas', async () => {
    const database = await databaseWithApplicationObjects();
    const configure = await readFile('supabase/operations/configure_database_backup_reader.sql', 'utf8');
    const inspect = await readFile('supabase/operations/inspect_database_backup_reader.sql', 'utf8');
    await database.exec(configure);
    await database.exec(`
      create schema external_provider;
      create table external_provider.mutable_state (id integer primary key);
      create function external_provider.mutate()
        returns void language sql security definer set search_path = '' as 'select';
      grant usage on schema external_provider to smoking_zen_backup_reader;
      grant insert on external_provider.mutable_state to smoking_zen_backup_reader;
      grant execute on function external_provider.mutate() to smoking_zen_backup_reader;
    `);
    const drifted = await database.query<Record<string, boolean>>(inspect);
    expect(drifted.rows[0]!.no_unexpected_direct_acl).toBe(false);
    await expect(database.exec(configure)).rejects.toThrow(/unexpected_direct_acl/u);
  });
});

describe('Storage backup reader operations', () => {
  it('binds one nonmember auth identity to select-only workspace-files access and removes it symmetrically', async () => {
    const database = new PGlite();
    databases.push(database);
    const readerId = '11111111-1111-4111-8111-111111111111';
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      create table public.workspace_members (user_id uuid not null);
      create schema storage;
      create table storage.objects (id uuid primary key, bucket_id text not null, name text not null);
      alter table storage.objects enable row level security;
      insert into auth.users values ('${readerId}');
    `);
    const configure = (await readFile('supabase/operations/configure_backup_reader.sql', 'utf8'))
      .replace('reader_id constant uuid := null', `reader_id constant uuid := '${readerId}'`);
    await database.exec(`
      grant insert on storage.objects to authenticated;
      create policy unexpected_authenticated_writer on storage.objects
      for insert to authenticated with check (true);
    `);
    await expect(database.exec(configure)).rejects.toThrow(/unexpected_storage_policy/u);
    await database.exec('rollback');
    await database.exec('drop policy unexpected_authenticated_writer on storage.objects');
    await database.exec(configure);
    await database.exec(configure);
    const inspect = (await readFile('supabase/operations/inspect_backup_reader.sql', 'utf8'))
      .replace('values (null::uuid)', `values ('${readerId}'::uuid)`);
    const inspected = await database.query<Record<string, boolean>>(inspect);
    expect(Object.values(inspected.rows[0]!).every(Boolean)).toBe(true);
    expect((await database.query<{ write: boolean }>(`
      select has_table_privilege('authenticated', 'storage.objects', 'insert') as write
    `)).rows).toEqual([{ write: false }]);
    await database.exec('set role authenticated');
    await expect(database.exec(`insert into storage.objects (id, bucket_id, name)
      values ('22222222-2222-4222-8222-222222222222', 'other-bucket', 'forbidden')`))
      .rejects.toThrow(/permission denied/u);
    await database.exec('reset role');

    await database.exec('alter table storage.objects disable row level security');
    const rlsDisabled = await database.query<Record<string, boolean>>(inspect);
    expect(rlsDisabled.rows[0]!.storage_objects_rls_enabled).toBe(false);
    await database.exec(`
      alter table storage.objects enable row level security;
      create policy unexpected_authenticated_reader on storage.objects
      for select to authenticated using (true);
    `);
    const extraPolicy = await database.query<Record<string, boolean>>(inspect);
    expect(extraPolicy.rows[0]!.has_no_other_authenticated_policy).toBe(false);
    await expect(database.exec(configure)).rejects.toThrow(/unexpected_storage_policy/u);
    await database.exec('rollback');
    await database.exec('drop policy unexpected_authenticated_reader on storage.objects');

    await database.exec(`
      drop policy smoking_zen_backup_reader_select on storage.objects;
      create policy smoking_zen_backup_reader_select on storage.objects for select to public
      using (true or (bucket_id = 'workspace-files' and auth.uid() = '${readerId}'::uuid));
    `);
    const drifted = await database.query<Record<string, boolean>>(inspect);
    expect(drifted.rows[0]!.select_policy_bound_to_reader).toBe(false);

    await database.exec(await readFile('supabase/operations/remove_backup_reader.sql', 'utf8'));
    expect((await database.query<{ schema_usage: boolean; table_select: boolean; policies: number }>(`
      select has_schema_privilege('authenticated', 'storage', 'usage') as schema_usage,
        has_table_privilege('authenticated', 'storage.objects', 'select') as table_select,
        (select count(*)::int from pg_catalog.pg_policy where polname = 'smoking_zen_backup_reader_select') as policies
    `)).rows).toEqual([{ schema_usage: false, table_select: false, policies: 0 }]);
  });
});
