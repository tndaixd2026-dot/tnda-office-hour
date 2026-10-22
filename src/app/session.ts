import { cloudEngine } from '../api/cloud';
import { ApiError, type Engine } from '../api/engine';
import type { JoinResult, Role, SessionInfo } from '../api/types';
import { HAS_CLOUD, SUPABASE_KEY, SUPABASE_URL } from '../config';
import { toast } from '../ui/toast';
import { go } from './router';
import { local, store } from './store';

export interface Auth {
  token: string;
  session: SessionInfo;
}

interface Demo {
  role: Role;
  tokens: Partial<Record<Role, Auth>>;
  /** started from the sign-in page: students only, no switching to admin or teacher */
  studentOnly?: boolean;
}

interface AppState {
  engine: Engine | null;
  auth: Auth | null;
  demo: Demo | null;
  /** loading the in-browser database */
  demoLoading: boolean;
  /** 0…1 while the demo database downloads */
  demoProgress: number;
}

const AUTH_KEY = 'oh.auth.v1';
const DEMO_CODES: Record<Role, { code: string; name?: string }> = {
  student: { code: 'DEMOG002', name: '林小晴' },
  admin: { code: 'DEMOADMIN001' },
  teacher: { code: 'DEMOT00001' },
};

let cloud: Engine | null = null;
let demoEngine: Engine | null = null;

function cloudOrNull(): Engine | null {
  if (!HAS_CLOUD) return null;
  if (!cloud) cloud = cloudEngine(SUPABASE_URL, SUPABASE_KEY);
  return cloud;
}

export const app = store<AppState>({
  engine: cloudOrNull(),
  auth: HAS_CLOUD ? local.get<Auth>(AUTH_KEY) : null,
  demo: null,
  demoLoading: false,
  demoProgress: 0,
});

export function useApp() {
  return app.use();
}

/** Re-check a remembered session; refreshes names, drops dead tokens. */
export async function verifySession() {
  const { engine, auth, demo } = app.get();
  if (!engine || !auth || demo) return;
  try {
    const r = await engine.call<{ session: SessionInfo }>('oh_me', { p_token: auth.token });
    const next = { token: auth.token, session: r.session };
    local.set(AUTH_KEY, next);
    app.set((s) => (s.auth?.token === auth.token ? { ...s, auth: next } : s));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'AUTH') expire();
  }
}

export function signedIn(r: JoinResult) {
  if (!r.ok || !r.token || !r.session) return;
  const auth = { token: r.token, session: r.session };
  const s = app.get();
  if (s.demo) {
    app.set({ ...s, auth, demo: { ...s.demo, tokens: { ...s.demo.tokens, [r.session.role]: auth } } });
  } else {
    local.set(AUTH_KEY, auth);
    app.set({ ...s, auth });
  }
}

export async function signOut() {
  const { engine, auth, demo } = app.get();
  if (demo) {
    exitDemo();
    return;
  }
  local.remove(AUTH_KEY);
  app.set((s) => ({ ...s, auth: null }));
  go('', { replace: true });
  if (engine && auth) engine.call('oh_leave', { p_token: auth.token }).catch(() => {});
}

export function expire() {
  const s = app.get();
  if (s.demo) return;
  local.remove(AUTH_KEY);
  app.set({ ...s, auth: null });
  toast('登入已失效，請重新登入', { kind: 'error' });
  go('', { replace: true });
}

export function updateSession(session: SessionInfo) {
  const s = app.get();
  if (!s.auth) return;
  const auth = { ...s.auth, session };
  if (!s.demo) local.set(AUTH_KEY, auth);
  app.set({ ...s, auth });
}

// ---------- demo ----------
export async function startDemo(role: Role = 'student', opts: { studentOnly?: boolean } = {}) {
  const s = app.get();
  if (s.demoLoading) return;
  try {
    if (!demoEngine) {
      app.set({ ...s, demoLoading: true, demoProgress: 0 });
      const { demoEngine: make } = await import('../api/demo');
      let last = 0;
      demoEngine = await make((f) => {
        // repaint at most every 2%
        if (f - last >= 0.02 || f === 1) {
          last = f;
          app.set((x) => ({ ...x, demoProgress: f }));
        }
      });
    }
    app.set((x) => ({ ...x, engine: demoEngine, demo: { role, tokens: {}, studentOnly: opts.studentOnly }, demoLoading: false }));
    await switchDemoRole(role);
  } catch (e) {
    console.error(e);
    app.set((x) => ({ ...x, demoLoading: false }));
    toast('示範模式載入失敗，請重新整理再試一次', { kind: 'error' });
  }
}

export async function switchDemoRole(role: Role) {
  const s = app.get();
  if (!s.demo || !demoEngine || (s.demo.studentOnly && role !== 'student')) return;
  let auth = s.demo.tokens[role];
  if (!auth) {
    const c = DEMO_CODES[role];
    const r = await demoEngine.call<JoinResult>('oh_join', { p_code: c.code, p_name: c.name ?? null });
    if (!r.ok || !r.token || !r.session) throw new ApiError('CLIENT', 'demo join failed');
    auth = { token: r.token, session: r.session };
  }
  app.set((x) => ({ ...x, auth: auth!, demo: { ...x.demo!, role, tokens: { ...x.demo!.tokens, [role]: auth! } } }));
  go(role === 'admin' ? 'admin' : '', { replace: true });
}

export function exitDemo() {
  app.set({ engine: cloudOrNull(), auth: HAS_CLOUD ? local.get<Auth>(AUTH_KEY) : null, demo: null, demoLoading: false, demoProgress: 0 });
  go('', { replace: true });
}

export function resetDemo() {
  demoEngine = null;
  const { role = 'student', studentOnly } = app.get().demo ?? {};
  app.set((x) => ({ ...x, demo: null }));
  startDemo(role, { studentOnly });
}
