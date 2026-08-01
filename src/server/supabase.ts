import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { ProductionServerEnvironment } from '@/server/env';
import type { VerifiedTelegramUser } from '@/server/telegram/verify-init-data';

export type MembershipAccess = {
  userId: string;
  membershipId: string;
  workspaceId: string;
  role: 'owner' | 'member';
  active: boolean;
  displayName: string;
};

export type InvitationRecord = {
  id: string;
  expiresAt: string;
};

export type BootstrapTelegramUserInput = {
  telegramUser: VerifiedTelegramUser;
  ownerTelegramId: string;
  workspaceName: string;
};

export type CreateInvitationInput = {
  workspaceId: string;
  creatorUserId: string;
  role: 'member';
  tokenHash: string;
  expiresAt: string;
};

export type RedeemInvitationInput = {
  tokenHash: string;
  telegramUser: VerifiedTelegramUser;
  redeemedAt: string;
};

export interface AccessStore {
  bootstrapTelegramUser(input: BootstrapTelegramUserInput): Promise<MembershipAccess | null>;
  getActiveMembership(userId: string, workspaceId: string): Promise<MembershipAccess | null>;
  createInvitation(input: CreateInvitationInput): Promise<InvitationRecord>;
  redeemInvitation(input: RedeemInvitationInput): Promise<MembershipAccess>;
}

export class AccessStoreError extends Error {
  readonly code: 'database_error' | 'invitation_invalid' | 'invitation_used' | 'invitation_expired';

  constructor(code: AccessStoreError['code']) {
    super('The access operation could not be completed.');
    this.name = 'AccessStoreError';
    this.code = code;
  }
}

type MembershipRow = {
  user_id: string;
  membership_id: string;
  workspace_id: string;
  role: string;
  active: boolean;
  display_name: string;
};

function parseMembership(value: unknown): MembershipAccess | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;
  const candidate = row as Partial<MembershipRow>;
  if (
    typeof candidate.user_id !== 'string' || typeof candidate.membership_id !== 'string' ||
    typeof candidate.workspace_id !== 'string' ||
    (candidate.role !== 'owner' && candidate.role !== 'member') ||
    typeof candidate.active !== 'boolean' || typeof candidate.display_name !== 'string'
  ) return null;
  return {
    userId: candidate.user_id,
    membershipId: candidate.membership_id,
    workspaceId: candidate.workspace_id,
    role: candidate.role,
    active: candidate.active,
    displayName: candidate.display_name,
  };
}

function invitationError(message: string): AccessStoreError {
  if (message.includes('invitation_used')) return new AccessStoreError('invitation_used');
  if (message.includes('invitation_expired')) return new AccessStoreError('invitation_expired');
  if (message.includes('invitation_invalid')) return new AccessStoreError('invitation_invalid');
  return new AccessStoreError('database_error');
}

export function createServiceSupabaseClient(environment: ProductionServerEnvironment): SupabaseClient {
  return createClient(environment.supabaseUrl, environment.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'smoking-zen-server' } },
  });
}

export function createSupabaseAccessStore(client: SupabaseClient): AccessStore {
  return {
    async bootstrapTelegramUser(input) {
      const { data, error } = await client.rpc('bootstrap_telegram_user', {
        p_telegram_id: input.telegramUser.id,
        p_first_name: input.telegramUser.firstName,
        p_last_name: input.telegramUser.lastName ?? null,
        p_username: input.telegramUser.username ?? null,
        p_language_code: input.telegramUser.languageCode ?? null,
        p_owner_telegram_id: input.ownerTelegramId,
        p_workspace_name: input.workspaceName,
      });
      if (error) throw new AccessStoreError('database_error');
      return parseMembership(data);
    },

    async getActiveMembership(userId, workspaceId) {
      const { data, error } = await client.rpc('get_active_membership', {
        p_user_id: userId,
        p_workspace_id: workspaceId,
      });
      if (error) throw new AccessStoreError('database_error');
      return parseMembership(data);
    },

    async createInvitation(input) {
      const { data, error } = await client.rpc('create_workspace_invitation', {
        p_workspace_id: input.workspaceId,
        p_creator_user_id: input.creatorUserId,
        p_role: input.role,
        p_token_hash: input.tokenHash,
        p_expires_at: input.expiresAt,
      });
      if (error) throw new AccessStoreError('database_error');
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object') throw new AccessStoreError('database_error');
      const candidate = row as { invitation_id?: unknown; expires_at?: unknown };
      if (typeof candidate.invitation_id !== 'string' || typeof candidate.expires_at !== 'string') {
        throw new AccessStoreError('database_error');
      }
      return { id: candidate.invitation_id, expiresAt: candidate.expires_at };
    },

    async redeemInvitation(input) {
      const { data, error } = await client.rpc('redeem_workspace_invitation', {
        p_token_hash: input.tokenHash,
        p_telegram_id: input.telegramUser.id,
        p_first_name: input.telegramUser.firstName,
        p_last_name: input.telegramUser.lastName ?? null,
        p_username: input.telegramUser.username ?? null,
        p_language_code: input.telegramUser.languageCode ?? null,
        p_redeemed_at: input.redeemedAt,
      });
      if (error) throw invitationError(error.message);
      const membership = parseMembership(data);
      if (!membership) throw new AccessStoreError('database_error');
      return membership;
    },
  };
}
