import { beforeAll, describe, expect, it } from 'vitest';
import { makeDb, type TestDb } from './helpers';

describe('calendar feeds', () => {
  let db: TestDb;
  let admin: string;
  let student: string;
  let teacher: string;
  let w7: number;
  const ics = async (feed: string | null) => {
    const r = await db.one(`select convert_from(public.oh_calendar(p_feed => $1), 'UTF8') as v`, [feed]);
    return r.v as string;
  };

  beforeAll(async () => {
    db = await makeDb({ legacy: true });
    await db.setNow('2026-10-14T09:00:00+08:00');
    const c = await db.codes();
    admin = (await db.call('oh_join', { p_code: c.admin })).token;
    student = (await db.call('oh_join', { p_code: c.groups[2], p_name: '小晴' })).token;
    teacher = (await db.call('oh_join', { p_code: c.teachers.Prolong })).token;
    w7 = (await db.one("select id from app.weeks where label = 'W7'")).id;
    await db.call('oh_request_save', {
      p_token: student, p_week: w7, p_topic: '展場動線, 與排隊; 位置', p_progress: '平面圖完成\n下一步：測試', p_link: 'https://drive.google.com/x',
      p_want: 1, p_slots: [{ d: '2026-10-21', t: '10:00' }], p_version: null,
    });
    const g2 = (await db.one('select id from app.groups where no = 2')).id;
    const prolong = (await db.one("select id from app.teachers where name = 'Prolong'")).id;
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: g2, p_teacher: prolong, p_d: '2026-10-21', p_t: '10:00' });
  });

  it('hands each person their own feed', async () => {
    const s = await db.call('oh_calendar_feed', { p_token: student });
    const t = await db.call('oh_calendar_feed', { p_token: teacher });
    expect(s.feed).toMatch(/^[0-9a-f]{32}$/);
    expect(t.feed).toMatch(/^[0-9a-f]{32}$/);
    expect(s.feed).not.toBe(t.feed);
    await expect(db.call('oh_calendar_feed', { p_token: admin })).rejects.toThrow(/FORBIDDEN/);
  });

  it('serves only published sessions, as valid iCalendar', async () => {
    const { feed } = await db.call('oh_calendar_feed', { p_token: teacher });
    expect(await ics(feed)).not.toContain('BEGIN:VEVENT'); // still a draft
    await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
    const text = await ics(feed);
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('X-WR-CALNAME:Office Hour · Prolong');
    expect(text).toContain('DTSTART:20261021T020000Z');
    expect(text).toContain('DTEND:20261021T023000Z');
    expect(text).toMatch(/UID:oh-\d+@tnda-office-hour/);
    const unfolded = text.replace(/\r\n /g, '');
    expect(unfolded).toContain(String.raw`SUMMARY:Office Hour · 第 2 組「看到太陽就知道完蛋了」｜展場動線\, 與排隊\; 位置`);
    expect(unfolded).toContain(String.raw`進度：平面圖完成\n下一步：測試`);
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('gives groups a feed without other groups or progress notes', async () => {
    const { feed } = await db.call('oh_calendar_feed', { p_token: student });
    const text = (await ics(feed)).replace(/\r\n /g, '');
    expect(text).toContain('X-WR-CALNAME:Office Hour · 第 2 組「看到太陽就知道完蛋了」');
    expect(text).toContain('SUMMARY:Office Hour · 叁式 PM｜');
    expect(text).not.toContain('Prolong'); // teacher names hidden unless the setting allows it
    expect(text).not.toContain('進度：');
  });

  it('drops cancelled sessions and survives bad links', async () => {
    const { feed } = await db.call('oh_calendar_feed', { p_token: student });
    const st = await db.call('oh_student_state', { p_token: student, p_week: w7 });
    await db.call('oh_appointment_cancel', { p_token: student, p_id: st.appointments[0].id });
    expect(await ics(feed)).not.toContain('BEGIN:VEVENT');
    expect(await ics('0'.repeat(32))).toContain('訂閱連結已失效');
    expect(await ics(null)).toContain('訂閱連結已失效');
  });

  it('can retire a feed URL', async () => {
    const old = (await db.call('oh_calendar_feed', { p_token: teacher })).feed;
    const fresh = (await db.call('oh_calendar_feed', { p_token: teacher, p_reset: true })).feed;
    expect(fresh).not.toBe(old);
    expect(await ics(old)).toContain('訂閱連結已失效');
    expect(await ics(fresh)).toContain('Office Hour · Prolong');
  });
});
