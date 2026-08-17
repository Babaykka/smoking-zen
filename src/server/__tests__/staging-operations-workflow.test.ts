import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (filename: string) => readFileSync(path.join(root, filename), 'utf8');

function extractRunBodies(workflow: string) {
  const lines = workflow.split(/\r?\n/u);
  const bodies: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/u.exec(lines[index] ?? '');
    if (!match) continue;

    const indentation = match[1]?.length ?? 0;
    const value = match[2] ?? '';
    if (!/^[|>][-+]?(?:\s+#.*)?$/u.test(value)) {
      bodies.push(value);
      continue;
    }

    const block: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor] ?? '';
      if (line.trim().length === 0) {
        block.push(line);
        cursor += 1;
        continue;
      }

      const lineIndentation = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (lineIndentation <= indentation) break;
      block.push(line);
      cursor += 1;
    }
    bodies.push(block.join('\n'));
    index = cursor - 1;
  }

  return bodies;
}

describe('staging backup and restore operations workflow', () => {
  it('is manual, main-only, and separates restore approval from staging operations', () => {
    const workflow = read('.github/workflows/staging-operations.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('schedule:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main' && inputs.operation != 'restore-drill'");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main' && inputs.operation == 'restore-drill'");
    expect(workflow).toContain('environment: staging\n');
    expect(workflow).toContain('environment: staging-drill\n');
    expect(workflow).toContain('RESTORE_ISOLATED_TARGET:<drill-project-ref>:<snapshot-id>');
    expect(workflow).toContain('STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT: ${{ inputs.restore_acknowledgement }}');
    expect(workflow).toContain('RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT: RESTORE_ISOLATED_TARGET');
  });

  it('pins checkout, actions, tools, and every staging contour coordinate', () => {
    const workflow = read('.github/workflows/staging-operations.yml');
    const setupAction = read('.github/actions/setup-backup-tools/action.yml');
    const preflight = read('scripts/staging-operations-preflight.mjs');

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
    expect(workflow.match(/ref: \$\{\{ github\.sha \}\}/gu)).toHaveLength(2);
    expect(workflow.match(/test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/gu)).toHaveLength(2);
    expect(workflow).toContain('scripts/run-production-backup.sh');
    expect(workflow).toContain('scripts/check-backup-freshness.sh');
    expect(workflow).toContain('scripts/restore-drill.sh');
    expect(workflow).toContain('scripts/staging-operations-preflight.mjs');

    for (const coordinate of [
      'BACKUP_SOURCE_PROJECT_REF',
      'BACKUP_SOURCE_ENDPOINT',
      'BACKUP_TARGET_ENDPOINT',
      'BACKUP_TARGET_BUCKET',
      'BACKUP_TARGET_PREFIX',
      'RESTORE_SOURCE_PROJECT_REF',
      'RESTORE_TARGET_PROJECT_REF',
      'RESTORE_ARCHIVE_ENDPOINT',
      'RESTORE_ARCHIVE_BUCKET',
      'RESTORE_ARCHIVE_PREFIX',
      'RESTORE_TARGET_ENDPOINT',
    ]) expect(workflow).toContain(`${coordinate}:`);

    for (const line of workflow.match(/^\s*uses:\s*.+$/gmu) ?? []) {
      const action = line.trim().slice('uses: '.length);
      expect(action.startsWith('./') || /@[0-9a-f]{40}\s+#\s+v?\d[^\s]*$/u.test(action)).toBe(true);
    }
    expect(setupAction).toContain('postgresql_version=18.4');
    expect(setupAction).toContain('81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094');
    expect(setupAction).toContain('rclone-v1.75.0-linux-amd64.zip');
    expect(setupAction).toContain('aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa');
    expect(preflight).toContain('../config/staging-identities.json');
    expect(preflight).toContain('supabaseDrillProjectRef');
  });

  it('keeps secrets out of command interpolation and retains exact reviewable data-operation evidence', () => {
    const workflow = read('.github/workflows/staging-operations.yml');

    for (const secret of [
      'BACKUP_PGPASSWORD',
      'BACKUP_PGSSLROOTCERT_BASE64',
      'BACKUP_SOURCE_AUTH_ANON_KEY',
      'BACKUP_SOURCE_AUTH_EMAIL',
      'BACKUP_SOURCE_AUTH_PASSWORD',
      'BACKUP_TARGET_ACCESS_KEY_ID',
      'BACKUP_TARGET_SECRET_ACCESS_KEY',
      'BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID',
      'BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY',
      'RESTORE_ARCHIVE_ACCESS_KEY_ID',
      'RESTORE_ARCHIVE_SECRET_ACCESS_KEY',
      'RESTORE_PGPASSWORD',
      'RESTORE_PGSSLROOTCERT_BASE64',
      'RESTORE_TARGET_ACCESS_KEY_ID',
      'RESTORE_TARGET_SECRET_ACCESS_KEY',
    ]) expect(workflow).toContain(`${secret}: \${{ secrets.${secret} }}`);

    const runBodies = extractRunBodies(workflow);
    expect(runBodies.length).toBeGreaterThan(0);
    for (const body of runBodies) {
      expect(body).not.toMatch(/\$\{\{\s*secrets\./u);
      expect(body).not.toMatch(/(?:--password|--secret|--token).*\$\{\{/u);
    }
    expect(workflow).toContain('BACKUP_EVIDENCE_OUTPUT:');
    expect(workflow).toContain('${{ runner.temp }}/staging-backup-manifest.json');
    expect(workflow).toContain('BACKUP_FRESHNESS_EVIDENCE_OUTPUT: ${{ runner.temp }}/staging-freshness-manifest.json');
    expect(workflow).toContain('${{ runner.temp }}/staging-restore-evidence.json');
    expect(workflow).toContain('staging-backup-manifest-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow).toContain('staging-freshness-manifest-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow).toContain('staging-restore-evidence-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/gu)).toHaveLength(3);
    expect(workflow).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1');
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('retention-days: 90');
    expect(workflow).not.toContain('backups/**');
  });
});
