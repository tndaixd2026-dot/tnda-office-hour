import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/engine';
import type { ClockInfo, Settings } from '../api/types';
import { Clock } from '../lib/time';
import { toast } from '../ui/toast';
import { errorText } from './messages';
import { expire, useApp } from './session';

/** Server time, kept in sync by every state response. */
export const clock = new Clock();

export function useApi() {
  const { engine, auth } = useApp();
  const token = auth?.token;
  const call = useCallback(
    async <T,>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (!engine || !token) throw new ApiError('AUTH');
      try {
        return await engine.call<T>(fn, { p_token: token, ...args });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'AUTH') expire();
        throw e;
      }
    },
    [engine, token],
  );
  return { engine, auth, call };
}

/**
 * Loads a state function and keeps it fresh: refetches on realtime pings,
 * when the tab comes back, when the network returns, and every minute as
 * a safety net. Older responses never overwrite newer ones. `anon` calls
 * a public function, without a session token.
 */
export function useLive<T extends { clock?: ClockInfo }>(fn: string, args: Record<string, unknown> = {}, anon = false) {
  const { engine, call } = useApi();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const seq = useRef(0);
  const argKey = JSON.stringify(args);

  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      if (anon && !engine) throw new ApiError('NETWORK');
      const r = anon ? await engine!.call<T>(fn, JSON.parse(argKey)) : await call<T>(fn, JSON.parse(argKey));
      if (id !== seq.current) return;
      if (r?.clock) clock.sync(r.clock);
      setData(r);
      setError(null);
    } catch (e) {
      if (id !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError('CLIENT'));
    }
  }, [call, engine, anon, fn, argKey]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!engine) return;
    // coalesce bursts of pings, and never refetch more than every 1.5 s
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const kick = () => {
      if (timer) return;
      const wait = Math.max(150, last + 1500 - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        load();
      }, wait);
    };
    const off = engine.onChange(kick);
    const onVis = () => {
      if (document.visibilityState === 'visible') kick();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', kick);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 60000);
    return () => {
      off();
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', kick);
    };
  }, [engine, load]);

  return { data, error, reload: load };
}

/** Re-renders every `ms` so countdowns stay honest. */
export function useTick(ms = 30000): number {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return clock.now();
}

/** Runs one mutation at a time, with a busy flag and an error toast. */
export function useBusy(settings?: Pick<Settings, 'lead_days' | 'cancel_hours'>) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(
      key: string,
      f: () => Promise<T>,
      opts: { ok?: string; onError?: (e: ApiError) => boolean | void } = {},
    ): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await f();
        if (opts.ok) toast(opts.ok);
        return r;
      } catch (e) {
        const handled = e instanceof ApiError && opts.onError?.(e);
        if (!handled && !(e instanceof ApiError && e.code === 'AUTH')) toast(errorText(e, settings), { kind: 'error' });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [settings?.lead_days, settings?.cancel_hours],
  );
  return { busy, run };
}

export function useEngineStatus() {
  const { engine } = useApp();
  const [s, set] = useState(engine?.status() ?? 'connecting');
  useEffect(() => {
    if (!engine) return;
    set(engine.status());
    return engine.onStatus(set);
  }, [engine]);
  return s;
}

/** Tracks a CSS media query. */
export function useMedia(query: string): boolean {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false);
  const [v, set] = useState(get);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => set(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return v;
}

/**
 * Calls `onChange(prev, next)` whenever fresh data replaces older data
 * (never on the first load), so views can announce what just happened.
 */
export function useDiff<T>(data: T | undefined, onChange: (prev: T, next: T) => void) {
  const prev = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (data === undefined) return;
    if (prev.current !== undefined && prev.current !== data) onChange(prev.current, data);
    prev.current = data;
  }, [data]);
}
