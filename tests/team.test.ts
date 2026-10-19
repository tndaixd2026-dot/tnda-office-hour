import { beforeAll, describe, expect, it } from 'vitest';
import { expectCode, makeDb, type TestDb } from './helpers';

const W7 = { mon: '2026-10-19', wed: '2026-10-21', thu: '2026-10-22' };

describe('one view for the PMs', () => {
  let db: TestDb;
  let admin: string;
  let shared: string;
  let tim: string;
  let ids: Record<string, number>;
  let w7: number;
  const ics = async (feed: string) => ((await db.one(`select convert_from(public.oh_calendar(p_feed => $1), 'UTF8') as v`, [feed])).v as string).replace(/\r\n /g, '');

  beforeAll(async () => {
    db = await makeDb();
    await db.setNow('2026-10-14T09:00:00+08:00');
    const c = await db.codes();
    admin = (await db.call('oh_join', { p_code: c.admin })).token;
    ids = {};
    for (const t of await db.sql('select id, name from app.teachers')) ids[t.name] = t.id;
    for (const g of await db.sql('select id, no from app.groups')) ids[`g${g.no}`] = g.id;
    w7 = (await db.one("select id from app.weeks where label = 'W7'")).id;
    // two published sessions with different PMs
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.Joseph, p_d: W7.mon, p_t: '17:00', p_force: true });
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g2, p_teacher: ids.Prolong, p_d: W7.wed, p_t: '10:00', p_force: true });
    await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
  });

  it('signs the shared account in by name', async () => {
    const r = await db.call('oh_login', { p_name: ' 叁式 ' });
    expect(r.session).toMatchObject({ role: 'teacher', name: '叁式' });
    shared = r.token;
    tim = (await db.call('oh_login', { p_name: 'Tim' })).token;
  });

  it('shows every PM the same sessions, each one their own marked', async () => {
    const s = await db.call('oh_teacher_state', { p_token: shared });
    expect(s.me).toMatchObject({ name: '叁式', team: true });
    expect(s.teachers.map((t: any) => t.name)).toEqual(['Joseph', 'Prolong', 'Tim']);
    expect(s.sessions.map((x: any) => [x.d, x.teacher, x.mine])).toEqual([
      [W7.mon, 'Joseph', false],
      [W7.wed, 'Prolong', false],
    ]);
    expect(s.blocks.every((b: any) => b.teacher_id !== ids['叁式'])).toBe(true);
    const t = await db.call('oh_teacher_state', { p_token: tim });
    expect(t.me.team).toBe(false);
    expect(t.sessions).toHaveLength(2);
    expect(t.sessions.every((x: any) => !x.mine)).toBe(true);
  });

  it('gives the shared account a feed with every PM in it', async () => {
    const { feed } = await db.call('oh_calendar_feed', { p_token: shared });
    const text = await ics(feed);
    expect(text).toContain('X-WR-CALNAME:Office Hour · 叁式');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(text).toContain('SUMMARY:Office Hour · Joseph · 第 1 組「南宜到達的斜上方」');
    expect(text).toContain('老師：Prolong');
    // a PM's own feed still has only their sessions
    const own = await ics((await db.call('oh_calendar_feed', { p_token: tim })).feed);
    expect(own).not.toContain('BEGIN:VEVENT');
  });

  it('never schedules the shared account or gives it open hours', async () => {
    await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g3, p_teacher: ids['叁式'], p_d: W7.thu, p_t: '16:00', p_force: true }),
      'NOT_FOUND',
      'teacher',
    );
    await expectCode(
      db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: ids['叁式'], dow: 1, start: '10:00', end: '11:00' } }),
      'NOT_FOUND',
      'teacher',
    );
    const st = await db.call('oh_admin_state', { p_token: admin, p_week: w7 });
    expect(st.teachers.map((t: any) => t.name)).toEqual(['Joseph', 'Prolong', 'Tim']);
  });

  it('keeps the shared name off student rosters', async () => {
    await expectCode(db.call('oh_admin_roster', { p_token: admin, p_group: ids.g1, p_names: ['叁式'] }), 'NAME_TAKEN', '叁式');
  });
});
