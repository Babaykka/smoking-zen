type RealtimeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | string;

export type WorkspaceRealtimeChannel = {
  on(type: 'broadcast', filter: { event: string }, listener: () => void): WorkspaceRealtimeChannel;
  subscribe(listener: (status: RealtimeStatus) => void): WorkspaceRealtimeChannel;
};

export type WorkspaceRealtimeClient = {
  channel(name: string, options: { config: { private: true } }): WorkspaceRealtimeChannel;
  removeChannel(channel: WorkspaceRealtimeChannel): unknown;
};

type RealtimeOptions = {
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number;
  cancel?: (timer: ReturnType<typeof setTimeout> | number) => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function subscribeWorkspaceRealtime(
  client: WorkspaceRealtimeClient,
  workspaceId: string,
  listener: () => void,
  options: RealtimeOptions = {},
) {
  if (!UUID.test(workspaceId)) throw new Error('Invalid workspace identifier.');
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  let channel: WorkspaceRealtimeChannel | null = null;
  let timer: ReturnType<typeof setTimeout> | number | null = null;
  let stopped = false;
  let attempts = 0;
  let generation = 0;

  const connect = () => {
    if (stopped) return;
    const connectionGeneration = ++generation;
    const attemptChannel = client.channel(`workspace:${workspaceId}`, { config: { private: true } });
    channel = attemptChannel;
    attemptChannel.on('broadcast', { event: 'workspace_changed' }, listener).subscribe((status) => {
      if (stopped || connectionGeneration !== generation || channel !== attemptChannel) return;
      if (status === 'SUBSCRIBED') {
        attempts = 0;
        return;
      }
      if (!['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) return;
      generation += 1;
      channel = null;
      void client.removeChannel(attemptChannel);
      if (timer !== null) return;
      const delay = Math.min(30_000, 1_000 * (2 ** attempts));
      attempts += 1;
      timer = schedule(() => {
        timer = null;
        connect();
      }, delay);
    });
  };

  connect();
  return () => {
    stopped = true;
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    if (channel) void client.removeChannel(channel);
    channel = null;
  };
}
