import 'server-only';

import type { PrivateFileStore } from '@/server/files/file-store';
import { createPrivateFileStore } from '@/server/files/file-store';
import { createSupabaseFileBackend } from '@/server/files/supabase-file-backend';
import { requireProductionEnvironment } from '@/server/env';
import { readSessionCookie } from '@/server/http';
import { readSession } from '@/server/session';
import { createServiceSupabaseClient, createSupabaseAccessStore } from '@/server/supabase';

export type FileSessionActor = { userId: string; workspaceId: string; membershipId: string };

export type FileRouteDependencies = {
  appOrigin: string;
  store: PrivateFileStore;
  authenticate: (request: Request) => Promise<FileSessionActor | null>;
  requestId: () => string;
};

export function createDefaultFileRouteDependencies(): FileRouteDependencies {
  const environment = requireProductionEnvironment();
  const client = createServiceSupabaseClient(environment);
  const accessStore = createSupabaseAccessStore(client);
  return {
    appOrigin: environment.appOrigin,
    store: createPrivateFileStore(createSupabaseFileBackend(client)),
    requestId: () => crypto.randomUUID(),
    async authenticate(request) {
      const identity = await readSession(readSessionCookie(request), { secret: environment.sessionSecret });
      if (!identity) return null;
      const membership = await accessStore.getActiveMembership(identity.userId, identity.workspaceId);
      if (!membership?.active || membership.membershipId !== identity.membershipId) return null;
      return { userId: identity.userId, workspaceId: identity.workspaceId, membershipId: identity.membershipId };
    },
  };
}
