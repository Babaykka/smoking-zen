import 'server-only';

import { importPKCS8, SignJWT } from 'jose';

type RealtimeIdentity = { userId: string; workspaceId: string };
type RealtimeTokenOptions = { privateKeyPem: string; keyId: string; issuer: string; now?: Date };

export async function createRealtimeAccessToken(identity: RealtimeIdentity, options: RealtimeTokenOptions): Promise<string> {
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const privateKey = await importPKCS8(options.privateKeyPem.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({ role: 'authenticated', workspace_id: identity.workspaceId, smoking_zen_scope: 'realtime' })
    .setProtectedHeader({ alg: 'ES256', kid: options.keyId, typ: 'JWT' })
    .setSubject(identity.userId)
    .setIssuer(options.issuer)
    .setAudience('authenticated')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(privateKey);
}
