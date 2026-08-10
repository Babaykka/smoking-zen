import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (filename: string) => readFileSync(path.join(root, filename), 'utf8');

describe('Task 7 production operations release surface', () => {
  it('documents every scalar production, backup, and restore variable without embedding credentials', () => {
    const environment = read('.env.example');
    for (const name of [
      'DEPLOYMENT_ENVIRONMENT', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_MINI_APP_SHORT_NAME',
      'TELEGRAM_WEBHOOK_SECRET', 'INTERNAL_JOB_SECRET', 'BITWARDEN_SELF_HOSTED_ORIGINS',
      'BACKUP_PGHOST', 'BACKUP_PGPORT', 'BACKUP_PGDATABASE', 'BACKUP_PGUSER', 'BACKUP_PGPASSWORD',
      'BACKUP_POSTGRES_MAJOR', 'BACKUP_PGSSLROOTCERT_BASE64',
      'BACKUP_SOURCE_ENDPOINT', 'BACKUP_SOURCE_PROJECT_REF', 'BACKUP_SOURCE_REGION',
      'BACKUP_SOURCE_AUTH_ANON_KEY', 'BACKUP_SOURCE_AUTH_USER_ID',
      'BACKUP_SOURCE_BUCKET', 'BACKUP_TARGET_ENDPOINT',
      'BACKUP_TARGET_BUCKET', 'BACKUP_TARGET_PREFIX', 'BACKUP_TARGET_ENCRYPTION',
      'BACKUP_TARGET_REGION', 'BACKUP_TARGET_FORCE_PATH_STYLE',
      'BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID', 'BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY',
      'RESTORE_TARGET_ENVIRONMENT', 'RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT',
      'RESTORE_SOURCE_PROJECT_REF', 'RESTORE_TARGET_PROJECT_REF', 'RESTORE_PGHOST',
      'RESTORE_ARCHIVE_ENDPOINT', 'RESTORE_ARCHIVE_ACCESS_KEY_ID',
      'RESTORE_ARCHIVE_SECRET_ACCESS_KEY', 'RESTORE_ARCHIVE_BUCKET', 'RESTORE_ARCHIVE_PREFIX',
      'RESTORE_ARCHIVE_REGION', 'RESTORE_ARCHIVE_FORCE_PATH_STYLE',
      'RESTORE_PGSSLROOTCERT_BASE64', 'RESTORE_TARGET_ENDPOINT', 'RESTORE_TARGET_BUCKET', 'RESTORE_TARGET_REGION',
      'RESTORE_TARGET_FORCE_PATH_STYLE',
    ]) expect(environment).toMatch(new RegExp(`^${name}=`, 'mu'));
    expect(environment).not.toMatch(/(?:DATABASE_URL|SUPABASE_DB_URL|postgres(?:ql)?:\/\/)/iu);
    expect(environment).not.toMatch(/(?:TOKEN|SECRET|PASSWORD|KEY)=\S+/u);
  });

  it('keeps Cron and Vault scheduling explicit, idempotent, bounded, and secret-free', () => {
    const schedule = read('supabase/operations/schedule_jobs.sql');
    const inspect = read('supabase/operations/inspect_jobs.sql');
    const rerun = read('supabase/operations/run_jobs_now.sql');
    const unschedule = read('supabase/operations/unschedule_jobs.sql');
    expect(schedule).toContain('smoking-zen-reminders-v1');
    expect(schedule).toContain('smoking-zen-cleanup-v1');
    expect(schedule).toContain("'*/5 * * * *'");
    expect(schedule).toContain("'30 0 * * *'");
    expect(schedule).toContain('vault.decrypted_secrets');
    expect(schedule).toContain("body := '{}'::jsonb");
    expect(schedule).toContain("'Authorization'");
    expect(schedule).toContain("'Bearer '");
    expect(schedule).not.toContain('cron.unschedule');
    expect(schedule.trimStart()).toMatch(/^begin;/u);
    expect(schedule.trimEnd()).toMatch(/commit;$/u);
    expect(schedule).toContain('smoking_zen_ops.smoking_zen_job_requests');
    expect(schedule).toMatch(/\^https:\/\//u);
    expect(schedule).toContain("^[A-Za-z0-9_-]{32,256}$");
    expect(schedule).not.toMatch(/https?:\/\/[a-z0-9]/iu);
    expect(schedule).not.toMatch(/(?:secret|token)\s*[:=]\s*['"][A-Za-z0-9_-]{24,}/iu);
    expect(inspect).toContain('cron.job_run_details');
    expect(inspect).toContain('net._http_response');
    expect(inspect).toContain('smoking_zen_ops.smoking_zen_job_requests');
    expect(rerun).toContain("body := '{}'::jsonb");
    expect(rerun).toContain('smoking_zen_ops.smoking_zen_job_requests');
    expect(unschedule).toContain('cron.unschedule');
    const prune = read('supabase/operations/prune_history.sql');
    expect(prune).toContain('smoking_zen_ops.smoking_zen_job_requests');
    expect(prune).toMatch(/using\s+smoking_zen_ops\.smoking_zen_job_requests/iu);
    expect(prune).not.toMatch(/delete from net\._http_response\s+where created/iu);
  });

  it('provisions a dedicated authenticated Storage reader without application membership or write policy', () => {
    const configure = read('supabase/operations/configure_backup_reader.sql');
    const inspect = read('supabase/operations/inspect_backup_reader.sql');
    const remove = read('supabase/operations/remove_backup_reader.sql');
    expect(configure).toContain('bucket_id = %L');
    expect(configure).toContain("'workspace-files'");
    expect(configure).toContain('for select');
    expect(configure).toContain('auth.uid()');
    expect(configure.match(/reader_id constant uuid := null/giu)).toHaveLength(1);
    expect(configure).toContain('execute format');
    expect(configure).not.toMatch(/for\s+(?:insert|update|delete|all)/iu);
    expect(inspect).toContain('workspace_members');
    expect(inspect).toContain('storage.objects');
    expect(configure).toContain('alter table storage.objects enable row level security');
    expect(inspect).toContain('storage_objects_rls_enabled');
    expect(inspect).toContain('has_no_other_authenticated_policy');
    expect(inspect).toContain('authenticated_has_no_write_privilege');
    expect(inspect).toContain('pg_get_expr');
    expect(inspect).toContain('reader_id::text');
    expect(remove).toContain('drop policy');
    expect(remove).toContain('revoke usage on schema storage from authenticated');
  });

  it('provisions and inspects a dedicated BYPASSRLS database dump role without embedding a password', () => {
    const configure = read('supabase/operations/configure_database_backup_reader.sql');
    const inspect = read('supabase/operations/inspect_database_backup_reader.sql');
    const remove = read('supabase/operations/remove_database_backup_reader.sql');
    expect(configure).toContain('smoking_zen_backup_reader');
    for (const attribute of [
      'login', 'noinherit', 'nosuperuser', 'nocreatedb', 'nocreaterole', 'noreplication', 'bypassrls',
    ]) expect(configure.toLowerCase()).toContain(attribute);
    expect(configure).toContain('grant connect on database');
    expect(configure).toContain('grant usage on schema public, private');
    expect(configure).toContain('grant select on all tables in schema public, private');
    expect(configure).toContain('alter default privileges for role');
    expect(configure).not.toMatch(/password\s+['"]/iu);
    expect(inspect).toContain('rolbypassrls');
    expect(inspect).toContain('has_write_privilege');
    expect(inspect).toContain('executable_security_definer');
    expect(read('scripts/backup.sh')).toContain('pg_catalog.pg_auth_members');
    expect(read('scripts/backup.sh')).toContain("default_transaction_read_only=on");
    expect(read('scripts/backup.sh')).toContain("not has_table_privilege(current_user, relation.oid, 'SELECT')");
    expect(read('scripts/backup.sh')).toContain('unexpected_direct_acl');
    expect(inspect).toContain('no_unexpected_direct_acl');
    expect(inspect).toContain('acldefault');
    expect(remove).toContain('drop role');
  });

  it('ships schema-revision ACL hardening that cannot mutate application data', () => {
    const hardening = read('supabase/operations/restore_acl_0017.sql');
    expect(hardening.trimStart()).toMatch(/^begin;/u);
    expect(hardening.trimEnd()).toMatch(/commit;$/u);
    expect(hardening).toContain('revoke all privileges on all tables in schema public');
    expect(hardening).toContain('grant select on public.audit_events to service_role');
    expect(hardening).toContain('workspace_broadcast_realtime_select');
    expect(hardening).toContain('alter table realtime.messages enable row level security');
    expect(hardening).toContain('private.is_workspace_member(uuid) to authenticated, service_role');
    expect(hardening).not.toMatch(/\b(?:insert|update|delete|truncate)\b/iu);
    expect(hardening).not.toMatch(/\b(?:create|replace)\s+(?:or\s+replace\s+)?function\b/iu);
    const restore = read('scripts/restore-drill.sh');
    expect(restore).toContain('restore_acl_0017.sql');
    expect(restore).toContain('smoking_zen_business_digest');
    expect(restore).not.toContain('MIGRATION_FILES');
  });

  it('pins CI actions and release tools while enforcing every launch gate', () => {
    const ci = read('.github/workflows/ci.yml');
    const backup = read('.github/workflows/backup.yml');
    const freshness = read('.github/workflows/backup-freshness.yml');
    for (const workflow of [ci, backup, freshness]) {
      expect(workflow).toContain('permissions:\n  contents: read');
      expect(workflow).not.toContain('pull_request_target');
      for (const line of workflow.match(/^\s*uses:\s*.+$/gmu) ?? []) {
        expect(line).toMatch(/@[0-9a-f]{40}\s+#\s+v?\d[^\s]*$/u);
      }
      expect(workflow).toContain('persist-credentials: false');
    }
    expect(ci).toContain('node-version: 24.18.0');
    expect(ci).toContain('version: 10.14.0');
    for (const gate of [
      'pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build', 'pnpm test:scripts',
      'pnpm lint:shell', 'playwright test', 'pnpm audit --prod --audit-level high', 'gitleaks',
    ]) expect(ci).toContain(gate);
    expect(backup).toContain("cron: '15 23 * * *'");
    expect(backup).toContain("if: github.ref == 'refs/heads/main'");
    expect(backup).toContain('environment: production');
    expect(backup).not.toContain('APP_MODE: demo');
    expect(backup).toContain('BACKUP_POSTGRES_MAJOR');
    expect(backup).toContain('postgresql_version=17.10');
    expect(backup).toContain('078a03516dcdbdb705fecaf415ea3d13a956c589e46f09fed68a06fb00598c90');
    expect(backup).toContain('postgresql_version=18.4');
    expect(backup).toContain('--with-ssl=openssl');
    expect(backup).toContain('--with-zlib');
    expect(backup).toContain('pg_config" --configure');
    expect(backup).toContain("ldd \"$tools/postgresql/lib/libpq.so\"");
    expect(backup).toContain('--format=custom');
    expect(backup).toContain('pg_restore" --list');
    const backupSession = read('scripts/run-production-backup.sh');
    expect(backup).toContain('scripts/run-production-backup.sh');
    expect(backupSession).toContain('/auth/v1/token?grant_type=password');
    expect(backupSession).toContain('max-filesize = 16384');
    expect(backup).toContain('BACKUP_SOURCE_AUTH_ANON_KEY');
    expect(backup).toContain('BACKUP_SOURCE_AUTH_USER_ID');
    expect(backup).not.toContain('BACKUP_SOURCE_ACCESS_KEY_ID');
    expect(freshness).toContain("cron: '30 4 * * *'");
    expect(freshness).toContain("if: github.ref == 'refs/heads/main'");
    expect(freshness).toContain('freshness');
    expect(freshness).toContain('BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID');
    expect(freshness).not.toContain('BACKUP_TARGET_ACCESS_KEY_ID');
    expect(freshness).toContain('BACKUP_TARGET_ENDPOINT');
    expect(freshness).toContain('BACKUP_SOURCE_PROJECT_REF');
    expect(freshness).toContain('BACKUP_TARGET_BUCKET');
    expect(freshness).not.toContain('BACKUP_FRESHNESS_TARGET_ENDPOINT');
    expect(ci).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1');
    expect(ci).toContain('if: failure()');
    expect(ci).toContain('retention-days: 3');
    expect(ci).toContain('path: playwright-report/');
    expect(read('playwright.config.ts')).toContain("reporter: [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]");
  });

  it('uses the reviewed action revisions and exact release-tool integrity anchors', () => {
    const ci = read('.github/workflows/ci.yml');
    const backup = read('.github/workflows/backup.yml');
    const freshness = read('.github/workflows/backup-freshness.yml');
    const all = [ci, backup, freshness].join('\n');
    expect(all).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1');
    expect(all).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0');
    expect(ci).toContain('pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10');
    for (const anchor of [
      '8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198',
      '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
      'eb7f42f8d608ac693d7a4b67474f6714ea68cfc5',
      '81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094',
      'aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa',
    ]) expect(all).toContain(anchor);
    expect(ci).not.toMatch(/\$\{\{\s*secrets\./u);
    expect(backup).not.toContain('pull_request:');
    expect(freshness).not.toContain('pull_request:');
  });

  it('keeps secret-scan exclusions away from source and browser-shipped build output', () => {
    const configuration = read('.gitleaks.toml');
    const scan = read('scripts/scan-secrets.sh');
    expect(configuration).toContain('useDefault = true');
    expect(configuration).not.toMatch(/src|docs|scripts|supabase|public|\.next\/static/u);
    expect(configuration).not.toMatch(/\^\\?\.next\/server\/(?:$|''')/u);
    expect(scan).toContain('--config .gitleaks.toml');
    expect(scan).toContain('gitleaks dir .next/static');
    expect(scan).toContain('gitleaks dir .next/server');
    expect(read('.github/workflows/ci.yml')).toMatch(/on:\n\s+push:\n\s+pull_request:/u);
  });

  it('pins Node, pnpm, and narrow vulnerable transitive dependency replacements', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      engines?: { node?: string };
      packageManager?: string;
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(packageJson.engines?.node).toBe('24.18.0');
    expect(packageJson.packageManager).toBe('pnpm@10.14.0');
    expect(packageJson.pnpm?.overrides).toEqual({
      'next>postcss': '8.5.26',
      'next>sharp': '0.35.3',
    });
    expect(read('.node-version').trim()).toBe('24.18.0');
  });

  it('ships Russian product, operations, security, rotation, and readiness guidance', () => {
    for (const filename of [
      'README.md', 'docs/operations.md', 'docs/security.md', 'docs/rotation-runbook.md',
      'docs/readiness.md', 'docs/production-configuration.md',
    ]) {
      const document = read(filename);
      expect(document.length).toBeGreaterThan(700);
      expect(document).not.toMatch(/\bTODO\b|ТЗ закрыто|для преподавателя|AI\/ChatGPT/iu);
    }
  });
});
