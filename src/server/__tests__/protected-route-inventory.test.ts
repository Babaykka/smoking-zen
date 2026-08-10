// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const apiRoot = join(process.cwd(), 'src/app/api');

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const routePaths = filesBelow(apiRoot)
  .filter((path) => path.endsWith('/route.ts'))
  .map((path) => relative(apiRoot, path))
  .sort();

const expectedRoutes = [
  'comments/route.ts',
  'contacts/[id]/route.ts',
  'contacts/route.ts',
  'files/[id]/complete/route.ts',
  'files/[id]/download/route.ts',
  'files/[id]/route.ts',
  'files/sign-upload/route.ts',
  'internal/cleanup/route.ts',
  'internal/reminders/route.ts',
  'invites/redeem/route.ts',
  'invites/route.ts',
  'knowledge/[id]/route.ts',
  'knowledge/route.ts',
  'realtime/token/route.ts',
  'search/route.ts',
  'secure-items/[id]/reveal/route.ts',
  'secure-items/[id]/route.ts',
  'secure-items/route.ts',
  'session/refresh/route.ts',
  'session/telegram/route.ts',
  'tasks/[id]/route.ts',
  'tasks/route.ts',
  'telegram/webhook/route.ts',
].sort();

const nonSessionRoutes = new Map<string, RegExp>([
  ['internal/cleanup/route.ts', /hasTimingSafeBearer/u],
  ['internal/reminders/route.ts', /hasTimingSafeBearer/u],
  ['invites/redeem/route.ts', /endpoint_removed/u],
  ['session/telegram/route.ts', /verifyInitData/u],
  ['telegram/webhook/route.ts', /timingSafeSecretMatches/u],
]);

const sameOriginBrowserRoutes = new Set([
  'comments/route.ts',
  'contacts/[id]/route.ts',
  'contacts/route.ts',
  'files/[id]/complete/route.ts',
  'files/[id]/download/route.ts',
  'files/[id]/route.ts',
  'files/sign-upload/route.ts',
  'invites/route.ts',
  'knowledge/[id]/route.ts',
  'knowledge/route.ts',
  'search/route.ts',
  'secure-items/[id]/reveal/route.ts',
  'secure-items/[id]/route.ts',
  'secure-items/route.ts',
  'session/refresh/route.ts',
  'session/telegram/route.ts',
  'tasks/[id]/route.ts',
  'tasks/route.ts',
]);

describe('protected API route inventory', () => {
  it('keeps every route in an explicit security class with a bounded common envelope', () => {
    expect(routePaths).toEqual(expectedRoutes);

    for (const path of routePaths) {
      const source = readFileSync(join(apiRoot, path), 'utf8');
      expect(source, `${path}: common envelope`).toContain('apiResponse');
      expect(source, `${path}: explicit factory method boundary`).toContain('request.method');
      expect(source, `${path}: testable handler factory`).toMatch(/export function create[A-Za-z]+Handler/u);
      expect(source, `${path}: no direct response bypass`).not.toMatch(/(?:NextResponse|Response)\.json\s*\(/u);

      const specialBoundary = nonSessionRoutes.get(path);
      if (specialBoundary) expect(source, `${path}: special authentication boundary`).toMatch(specialBoundary);
      else {
        expect(source, `${path}: protected session boundary`).toMatch(/authenticate\s*\(|readSessionCookie\s*\(/u);
        expect(source, `${path}: generic missing-session denial`).toMatch(/401/u);
      }

      if (sameOriginBrowserRoutes.has(path)) expect(source, `${path}: same-origin browser boundary`).toContain('hasSameOrigin');
    }
  });

  it('requires behavioral factory coverage for every route, so new routes cannot escape the suite', () => {
    const testSources = filesBelow(join(process.cwd(), 'src'))
      .filter((path) => /(?:\.test|__tests__\/.*)\.tsx?$/u.test(path) && !path.endsWith('protected-route-inventory.test.ts'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    for (const path of routePaths) {
      const source = readFileSync(join(apiRoot, path), 'utf8');
      const factory = source.match(/export function (create[A-Za-z]+Handler)/u)?.[1];
      expect(factory, `${path}: exported factory`).toBeTruthy();
      expect(testSources, `${path}: ${factory} behavioral coverage`).toMatch(new RegExp(`\\b${factory}\\b`, 'u'));
    }
  });
});
