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
};

export interface AccessStore {
  consumeTelegramSessionAttempt(telegramId: string): Promise<boolean>;
  bootstrapTelegramUser(input: BootstrapTelegramUserInput): Promise<MembershipAccess | null>;
  getActiveMembership(userId: string, workspaceId: string): Promise<MembershipAccess | null>;
  createInvitation(input: CreateInvitationInput): Promise<InvitationRecord>;
  redeemInvitation(input: RedeemInvitationInput): Promise<MembershipAccess>;
  getAuthorizedTaskLaunch(
    userId: string,
    workspaceId: string,
    membershipId: string,
    taskId: string,
  ): Promise<{ taskId: string } | null>;
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseTaskLaunch(value: unknown): { taskId: string } | null {
  if (!Array.isArray(value)) throw new AccessStoreError('database_error');
  if (value.length === 0) return null;
  if (value.length !== 1 || !value[0] || typeof value[0] !== 'object' || Array.isArray(value[0])) {
    throw new AccessStoreError('database_error');
  }
  const row = value[0] as Record<string, unknown>;
  if (Object.keys(row).length !== 1 || typeof row.task_id !== 'string' || !uuidPattern.test(row.task_id)) {
    throw new AccessStoreError('database_error');
  }
  return { taskId: row.task_id };
}

export function createServiceSupabaseClient(
  environment: ProductionServerEnvironment,
  requestHeaders: Readonly<Record<string, string>> = {},
): SupabaseClient {
  return createClient(environment.supabaseUrl, environment.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'smoking-zen-server', ...requestHeaders } },
  });
}

export function createSupabaseAccessStore(client: SupabaseClient): AccessStore {
  return {
    async consumeTelegramSessionAttempt(telegramId) {
      const { data, error } = await client.rpc('consume_telegram_session_attempt', {
        p_telegram_id: telegramId,
      });
      if (error || typeof data !== 'boolean') throw new AccessStoreError('database_error');
      return data;
    },
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
      });
      if (error) throw invitationError(error.message);
      const membership = parseMembership(data);
      if (!membership) throw new AccessStoreError('database_error');
      return membership;
    },

    async getAuthorizedTaskLaunch(userId, workspaceId, membershipId, taskId) {
      const { data, error } = await client.rpc('get_authorized_task_launch', {
        p_user_id: userId,
        p_workspace_id: workspaceId,
        p_membership_id: membershipId,
        p_task_id: taskId,
      });
      if (error) throw new AccessStoreError('database_error');
      return parseTaskLaunch(data);
    },
  };
}
