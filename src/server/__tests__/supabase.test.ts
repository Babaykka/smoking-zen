// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createSupabaseAccessStore } from '@/server/supabase';

describe('Supabase access adapter', () => {
  it('uses the database clock when redeeming an invitation', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        user_id: '11111111-1111-4111-8111-111111111111',
        membership_id: '22222222-2222-4222-8222-222222222222',
        workspace_id: '33333333-3333-4333-8333-333333333333',
        role: 'member',
        active: true,
        display_name: 'Иван',
      }],
      error: null,
    });
    const store = createSupabaseAccessStore({ rpc } as unknown as SupabaseClient);

    const input = {
      tokenHash: 'a'.repeat(64),
      telegramUser: { id: '123456789', firstName: 'Иван', authDate: 1_722_513_600 },
      redeemedAt: '2026-08-02T10:00:00.000Z',
    };
    await store.redeemInvitation(input);

    expect(rpc).toHaveBeenCalledWith('redeem_workspace_invitation', {
      p_token_hash: 'a'.repeat(64),
      p_telegram_id: '123456789',
      p_first_name: 'Иван',
      p_last_name: null,
      p_username: null,
      p_language_code: null,
    });
  });

  it('resolves only a strictly parsed database-authorized task launch', async () => {
    const taskId = '40000000-0000-4000-8000-000000000001';
    const rpc = vi.fn().mockResolvedValue({ data: [{ task_id: taskId }], error: null });
    const store = createSupabaseAccessStore({ rpc } as unknown as SupabaseClient);

    await expect(store.getAuthorizedTaskLaunch(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      taskId,
    )).resolves.toEqual({ taskId });
    expect(rpc).toHaveBeenCalledWith('get_authorized_task_launch', {
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_workspace_id: '33333333-3333-4333-8333-333333333333',
      p_membership_id: '22222222-2222-4222-8222-222222222222',
      p_task_id: taskId,
    });

    rpc.mockResolvedValueOnce({ data: [{ task_id: 'RAW_DATABASE_SENTINEL' }], error: null });
    const error = await store.getAuthorizedTaskLaunch(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      taskId,
    ).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain('RAW_DATABASE_SENTINEL');
  });
});
