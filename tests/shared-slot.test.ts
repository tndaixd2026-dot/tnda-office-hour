import { beforeAll, describe, expect, it } from 'vitest';
import { expectCode, makeDb, type TestDb } from './helpers';

// Groups 6 and 7 share Joseph's Tuesday 18:00-19:00: one booking has the
// hour, two split it, the first to book starting at 18:00.
describe('a fixed hour shared by two groups', () => {
  let db: TestDb;
  let admin: string;
  let g6: string;
  let g7: string;
  let w7: number;
  const ids: Record<string, number> = {};
  const fields = { p_questions: 'q', p_progress: 'p', p_link: 'https://drive.google.com/x' };
  const book = async (token: string, topic: string) => {
    const st = await db.call('oh_student_state', { p_token: token, p_week: w7 });
    return db.call('oh_booking_save', { p_token: token, p_week: w7, p_topic: topic, ...fields, p_version: st.request?.version ?? null });
  };
  const skip = async (token: string) => {
    const st = await db.call('oh_student_state', { p_token: token, p_week: w7 });
    return db.call('oh_booking_skip', { p_token: token, p_week: w7, p_version: st.request?.version ?? null });
  };
  const sessions = async () =>
    (await db.sql(`select g.no, a.d::text, to_char(a.t, 'HH24:MI') as t, a.minutes from app.appointments a join app.groups g on g.id = a.group_id
                    where a.week_id = $1 and a.status = 'confirmed' order by a.d, a.t`, [w7])).map((r: any) => `${r.no} ${r.t} ${r.minutes ?? 60}`);
  const join = async (code: string, name: string) => (await db.call('oh_join', { p_code: code, p_name: name })).token as string;

  beforeAll(async () => {
    db = await makeDb();
    await db.setNow('2026-10-14T09:00:00+08:00'); // W7 (10/19-10/23) is open until 10/17 20:00
    const c = await db.codes();
    admin = await join(c.admin, '助教');
    g6 = await join(c.groups[6], '六');
    g7 = await join(c.groups[7], '七');
    w7 = (await db.one(`select id from app.weeks where label = 'W7'`)).id;
    for (const g of await db.sql('select id, no from app.groups')) ids['g' + g.no] = g.id;
    for (const t of await db.sql('select id, name from app.teachers')) ids[t.name] = t.id;
    for (const no of [6, 7]) await db.sql('select app.discord_set_channel($1, $2, true)', [ids['g' + no], `40000000000000000${no}`]);
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: ids.g6, teacher_id: ids.Joseph, slot_dow: 2, slot_time: '18:00' } });
  });

  it('tells each group who shares its hour', async () => {
    expect((await db.call('oh_student_state', { p_token: g6 })).fixed).toMatchObject({ dow: 2, t: '18:00', teacher: 'Joseph', shared: [7] });
    expect((await db.call('oh_student_state', { p_token: g7 })).fixed.shared).toEqual([6]);
    const m = (await db.one('select app.discord_message($1, $2) as m', [ids.g7, w7])).m;
    expect(m.content).toContain('### 10/20（二）18:00–19:00\n第 7 組「媒日媒夜」 · Joseph\n👥 和第 6 組共用這一小時：只有一組預約就討論 60 分鐘，都預約就各 30 分鐘，先約的先開始');
  });

  it('gives one booking the whole hour, and splits it when the other group books', async () => {
    await book(g6, '第六組');
    expect(await sessions()).toEqual(['6 18:00 60']);
    await book(g7, '第七組');
    expect(await sessions()).toEqual(['6 18:00 30', '7 18:30 30']);
    const st = await db.call('oh_student_state', { p_token: g7 });
    expect(st.appointments).toEqual([expect.objectContaining({ d: '2026-10-20', t: '18:30', minutes: 30, teacher: 'Joseph' })]);
    // editing a booking keeps its place
    await book(g6, '第六組改過');
    expect(await sessions()).toEqual(['6 18:00 30', '7 18:30 30']);
  });

  it('gives the hour back when a group skips, and puts a returning group last', async () => {
    await skip(g6);
    expect(await sessions()).toEqual(['7 18:00 60']);
    await book(g6, '第六組又約了');
    expect(await sessions()).toEqual(['7 18:00 30', '6 18:30 30']);
  });

  it('shows each half-hour as it is everywhere', async () => {
    const msg = async (no: number) => (await db.one('select app.discord_message($1, $2) as m', [ids['g' + no], w7])).m.content;
    expect(await msg(6)).toContain('### 10/20（二）18:30–19:00\n第 6 組「會努力的」 · Joseph · 🔗 [進入討論室](<https://meet.google.com/wgj-uxbz-bcv>)\n👥 這週和第 7 組共用這一小時，各 30 分鐘');
    const t = await db.call('oh_teacher_state', { p_token: await join((await db.codes()).teachers.Joseph, 'Joseph') });
    expect(t.sessions.filter((x: any) => x.d === '2026-10-20').map((x: any) => `${x.t} ${x.minutes}`)).toEqual(['18:00 30', '18:30 30']);
    const feed = (await db.one(`select feed from app.teachers where name = 'Joseph'`)).feed;
    const ics = (await db.one(`select convert_from(public.oh_calendar(p_feed => $1), 'UTF8') as v`, [feed])).v as string;
    expect(ics).toContain('DTSTART:20261020T100000Z\r\nDTEND:20261020T103000Z');
    expect(ics).toContain('DTSTART:20261020T103000Z\r\nDTEND:20261020T110000Z');
    const mail = (await db.one(`select app.mail_message('2026-10-19', array[$1::int], 'Joseph', 'https://site', '', '') as v`, [ids.Joseph])).v;
    expect(mail.text).toContain('18:00–18:30');
    expect(mail.text).toContain('18:30–19:00');
    await db.setNow('2026-10-20T08:00:00+08:00');
    const today = await db.sql('select group_no, payload from app.discord_today_outbox()');
    expect(today.map((r: any) => `${r.group_no} ${r.payload.content.split('\n')[1]}`)).toEqual(['6 ### 18:30–19:00', '7 ### 18:00–18:30']);
    const sunday = (await db.one('select app.discord_summary($1, $2) as m', [ids.g7, w7])).m.content;
    expect(sunday).toContain('### 10/20（二）18:00–18:30\n第 7 組「媒日媒夜」 · Joseph');
  });

  it('keeps the halves after the deadline, and lets the board hand one to another PM or move it', async () => {
    await db.setNow('2026-10-18T09:00:00+08:00'); // closed
    const appts = (await db.call('oh_admin_state', { p_token: admin, p_week: w7 })).appointments;
    const of = (no: number) => appts.find((a: any) => a.group_id === ids['g' + no]);
    expect(of(6)).toMatchObject({ t: '18:30', minutes: 30 });
    // 代班 at 18:30, not on the hour: allowed, still half an hour
    expect(await db.call('oh_admin_move', { p_token: admin, p_id: of(6).id, p_teacher: ids.Tim, p_d: '2026-10-20', p_t: '18:30', p_force: true }))
      .toMatchObject({ teacher_id: ids.Tim, t: '18:30', minutes: 30 });
    // 改期 to another time: a whole session again
    expect(await db.call('oh_admin_move', { p_token: admin, p_id: of(6).id, p_teacher: ids.Joseph, p_d: '2026-10-21', p_t: '10:00', p_force: true }))
      .toMatchObject({ t: '10:00', minutes: null });
    // and any other start off the hour is still refused
    await expectCode(db.call('oh_admin_move', { p_token: admin, p_id: of(7).id, p_teacher: ids.Joseph, p_d: '2026-10-21', p_t: '10:30', p_force: true }), 'SLOT_INVALID');
    // after the deadline the other group's time stays as it was
    expect(await sessions()).toEqual(['7 18:00 30', '6 10:00 60']);
  });
});
