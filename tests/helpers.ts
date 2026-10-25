import { PGlite } from '@electric-sql/pglite';
import { BOOTSTRAP, MIGRATIONS, SEED } from '../src/db/sql';

export class DbError extends Error {
  constructor(public code: string, public detail: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface TestDb {
  pg: PGlite;
  call<T = any>(fn: string, args?: Record<string, unknown>): Promise<T>;
  sql<T = any>(query: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(query: string, params?: unknown[]): Promise<T>;
  setNow(iso: string | null): Promise<void>;
  codes(): Promise<{ groups: Record<number, string>; teachers: Record<string, string>; admin: string }>;
}

/** The rules before fixed weekly slots: 30-minute slots picked from a grid,
 *  Sunday 12:00 deadline, one shared room. Suites written for them opt in. */
const LEGACY = `
  update app.settings set slot_minutes = 30, week_cap = 3, day_cap = 1, close_dow = 7, close_time = '12:00',
                          show_teacher_names = false where id = 1;
  update app.groups set teacher_id = null, slot_dow = null, slot_time = null where true;
  update app.teachers set room = null where true;
  update app.mail_settings set remind = true where true;
`;

export async function makeDb(opts: { seed?: boolean; legacy?: boolean } = {}): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(BOOTSTRAP);
  for (const m of MIGRATIONS) await pg.exec(m);
  if (opts.seed !== false) await pg.exec(SEED);
  if (opts.legacy) await pg.exec(LEGACY);

  const call = async (fn: string, args: Record<string, unknown> = {}) => {
    if (!/^oh_[a-z_]+$/.test(fn)) throw new Error('bad fn');
    const keys = Object.keys(args);
    const list = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    try {
      const r = await pg.query<{ r: any }>(`select public.${fn}(${list}) as r`, params);
      return r.rows[0].r;
    } catch (e: any) {
      if (e?.code === 'P0001') throw new DbError(e.message, e.detail ?? '');
      throw e;
    }
  };
  const sql = async (query: string, params: unknown[] = []) => (await pg.query<any>(query, params)).rows;
  const one = async (query: string, params: unknown[] = []) => (await sql(query, params))[0];
  const setNow = async (iso: string | null) => {
    await pg.query(`select set_config('app.now', $1, false)`, [iso ?? '']);
  };
  const codes = async () => {
    const groups: Record<number, string> = {};
    for (const g of await sql('select no, code from app.groups')) groups[g.no] = g.code;
    const teachers: Record<string, string> = {};
    for (const t of await sql('select name, code from app.teachers')) teachers[t.name] = t.code;
    const admin = (await one('select code from app.admins order by id limit 1')).code;
    return { groups, teachers, admin };
  };
  return { pg, call, sql, one, setNow, codes };
}

export async function expectCode(p: Promise<unknown>, code: string, detail?: string) {
  try {
    await p;
  } catch (e) {
    if (e instanceof DbError) {
      if (e.code !== code) throw new Error(`expected ${code}, got ${e.code} (${e.detail})`);
      if (detail !== undefined && e.detail !== detail) throw new Error(`expected detail ${detail}, got ${e.detail}`);
      return e;
    }
    throw e;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
