import { createClient } from '@supabase/supabase-js';
import { ApiError, Emitter, assertFn, type Engine, type LinkStatus } from './engine';

export function cloudEngine(url: string, key: string): Engine {
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const changes = new Emitter<void>();
  const statuses = new Emitter<LinkStatus>();
  let status: LinkStatus = 'connecting';
  let everLive = false;

  const setStatus = (s: LinkStatus) => {
    if (s === status) return;
    status = s;
    statuses.emit(s);
  };

  // a private channel: anyone may listen, only the database may speak
  sb.channel('oh-sync', { config: { private: true } })
    .on('broadcast', { event: 'change' }, () => changes.emit())
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') {
        setStatus('live');
        // after a reconnect, catch up on whatever was missed
        if (everLive) changes.emit();
        everLive = true;
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
        setStatus('offline');
      }
    });

  return {
    mode: 'cloud',
    async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      assertFn(fn);
      let res;
      try {
        res = await sb.rpc(fn, args);
      } catch {
        throw new ApiError('NETWORK');
      }
      const { data, error } = res;
      if (error) {
        if (error.code === 'P0001') throw new ApiError(error.message, error.details ?? '');
        if (!error.code || /fetch|network/i.test(error.message)) throw new ApiError('NETWORK');
        throw new ApiError('SERVER', `${error.code} ${error.message}`);
      }
      return data as T;
    },
    onChange: (cb) => changes.on(cb),
    onStatus: (cb) => statuses.on(cb),
    status: () => status,
  };
}
