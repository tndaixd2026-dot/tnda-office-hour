import { beforeAll, describe, expect, it } from 'vitest';
import { DbError, expectCode, makeDb, type TestDb } from './helpers';

const WED = '2026-10-14T09:00:00+08:00'; // a week before W7 starts
const W7 = { mon: '2026-10-19', tue: '2026-10-20', wed: '2026-10-21', thu: '2026-10-22', fri: '2026-10-23' };

async function join(db: TestDb, code: string, name?: string) {
  const r = await db.call('oh_join', { p_code: code, p_name: name ?? null });
  if (!r.ok) throw new Error(r.error);
  return r.token as string;
}

async function weekId(db: TestDb, label: string): Promise<number> {
  return (await db.one('select id from app.weeks where label = $1', [label])).id;
}

async function teacherId(db: TestDb, name: string): Promise<number> {
  return (await db.one('select id from app.teachers where name = $1', [name])).id;
}

async function groupId(db: TestDb, no: number): Promise<number> {
  return (await db.one('select id from app.groups where no = $1', [no])).id;
}

const basicRequest = (week: number, slots: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
  p_week: week,
  p_topic: '感測器延遲',
  p_progress: '第一版原型完成',
  p_link: 'https://drive.google.com/drive/folders/abc',
  p_want: 1,
  p_slots: slots.map(([d, t]) => ({ d, t })),
  p_version: null,
  ...extra,
});

describe('joining', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await makeDb();
    await db.setNow(WED);
  });

  it('peeks a group code and normalises spacing and case', async () => {
    const { groups } = await db.codes();
    const c = groups[2];
    const pretty = `${c.slice(0, 4).toLowerCase()} - ${c.slice(4)}`;
    const r = await db.call('oh_peek', { p_code: pretty });
    expect(r).toEqual({ ok: true, role: 'student', group: { no: 2, name: '看到太陽就知道完蛋了' } });
  });

  it('rejects unknown codes without raising', async () => {
    expect(await db.call('oh_peek', { p_code: 'ZZZZZZZZ' })).toEqual({ ok: false, error: 'CODE_INVALID' });
    expect(await db.call('oh_join', { p_code: '', p_name: 'x' })).toEqual({ ok: false, error: 'CODE_INVALID' });
  });

  it('requires a name for students only', async () => {
    const { groups, teachers, admin } = await db.codes();
    expect(await db.call('oh_join', { p_code: groups[1], p_name: '   ' })).toEqual({ ok: false, error: 'NAME_REQUIRED' });
    const t = await db.call('oh_join', { p_code: teachers.Tim });
    expect(t.ok).toBe(true);
    expect(t.session.role).toBe('teacher');
    expect(t.session.name).toBe('Tim');
    const a = await db.call('oh_join', { p_code: admin });
    expect(a.session.role).toBe('admin');
    const s = await db.call('oh_join', { p_code: groups[1], p_name: '  王\u0007小明  ' });
    expect(s.session.name).toBe('王 小明');
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores only a hash of the token', async () => {
    const { groups } = await db.codes();
    const token = await join(db, groups[3], '阿華');
    const rows = await db.sql('select token_hash from app.sessions');
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    for (const r of rows) expect(hex(r.token_hash)).not.toBe(token);
  });

  it('throttles repeated wrong guesses', async () => {
    await db.sql('delete from app.join_attempts');
    for (let i = 0; i < 20; i++) await db.call('oh_peek', { p_code: `WRONG${i}XX` });
    await expectCode(db.call('oh_peek', { p_code: 'WRONGXXXX' }), 'RATE_LIMIT');
    const { groups } = await db.codes();
    await expectCode(db.call('oh_join', { p_code: groups[1], p_name: 'x' }), 'RATE_LIMIT');
    // the window slides
    await db.setNow('2026-10-14T09:11:00+08:00');
    expect((await db.call('oh_peek', { p_code: groups[1] })).ok).toBe(true);
    await db.setNow(WED);
    await db.sql('delete from app.join_attempts');
  });

  it('rejects garbage tokens and signed-out sessions', async () => {
    await expectCode(db.call('oh_me', { p_token: 'nope' }), 'AUTH');
    await expectCode(db.call('oh_me', { p_token: 'a'.repeat(64) }), 'AUTH');
    const { groups } = await db.codes();
    const tok = await join(db, groups[4], '小美');
    expect((await db.call('oh_me', { p_token: tok })).session.name).toBe('小美');
    await db.call('oh_leave', { p_token: tok });
    await expectCode(db.call('oh_me', { p_token: tok }), 'AUTH');
  });

  it('expires sessions unused for 180 days', async () => {
    const { groups } = await db.codes();
    const tok = await join(db, groups[6], '久未登入');
    await db.setNow('2027-04-10T09:00:00+08:00'); // 178 days later
    expect((await db.call('oh_me', { p_token: tok })).session.name).toBe('久未登入');
    await db.setNow('2027-10-10T09:00:00+08:00'); // 183 days after that use
    await expectCode(db.call('oh_me', { p_token: tok }), 'AUTH');
    await db.setNow(WED);
  });

  it('keeps roles apart', async () => {
    const { groups, teachers } = await db.codes();
    const stu = await join(db, groups[5], '學生');
    const tea = await join(db, teachers.Joseph);
    await expectCode(db.call('oh_admin_state', { p_token: stu }), 'FORBIDDEN');
    await expectCode(db.call('oh_admin_state', { p_token: tea }), 'FORBIDDEN');
    await expectCode(db.call('oh_teacher_state', { p_token: stu }), 'FORBIDDEN');
    await expectCode(db.call('oh_student_state', { p_token: tea }), 'FORBIDDEN');
    await expectCode(db.call('oh_admin_save', { p_token: stu, p_kind: 'settings', p: { close_dow: 1 } }), 'FORBIDDEN');
  });

  it('lets students rename themselves', async () => {
    const { groups } = await db.codes();
    const tok = await join(db, groups[6], 'A');
    const r = await db.call('oh_rename', { p_token: tok, p_name: '  新名字  ' });
    expect(r.name).toBe('新名字');
    await expectCode(db.call('oh_rename', { p_token: tok, p_name: ' ' }), 'VALIDATION', 'name');
  });
});

describe('student requests', () => {
  let db: TestDb;
  let w7: number;
  let a1: string; // group 1, member A
  let b1: string; // group 1, member B
  let c2: string; // group 2
  beforeAll(async () => {
    db = await makeDb();
    await db.sql('update app.settings set week_cap = 2'); // these cases are written around a two-slot weekly cap
    await db.setNow(WED);
    const { groups } = await db.codes();
    a1 = await join(db, groups[1], 'A');
    b1 = await join(db, groups[1], 'B');
    c2 = await join(db, groups[2], 'C');
    w7 = await weekId(db, 'W7');
  });

  it('opens on the first bookable week with the right grid', async () => {
    const st = await db.call('oh_student_state', { p_token: a1 });
    expect(st.week_id).toBe(w7);
    expect(st.me.group.no).toBe(1);
    expect(st.members).toEqual(['A', 'B']);
    expect(st.slots).toHaveLength(24);
    const wed10 = st.slots.find((s: any) => s.d === W7.wed && s.t === '10:00');
    expect(wed10).toMatchObject({ cap: 1, late: false, full: false, demand: 0 }); // two PMs, one meeting room
    expect(st.request).toBeNull();
    expect(st.weeks).toHaveLength(13);
    expect(st.weeks[0]).toMatchObject({ label: 'W7', bookable: true, requested: false, booked: 0 });
  });

  it('validates every field', async () => {
    const slots: Array<[string, string]> = [[W7.wed, '10:00']];
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_topic: '  ' }) }), 'VALIDATION', 'topic');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_topic: 'x'.repeat(81) }) }), 'VALIDATION', 'topic');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_progress: '\n\n' }) }), 'VALIDATION', 'progress');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_link: 'javascript:alert(1)' }) }), 'VALIDATION', 'link');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_link: 'https://' }) }), 'VALIDATION', 'link');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_want: 3 }) }), 'VALIDATION', 'want');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, []) }), 'VALIDATION', 'slots');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_slots: [{ d: 'x', t: '10:00' }] }) }), 'VALIDATION', 'slots');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, slots, { p_slots: [{ d: W7.wed }] }) }), 'VALIDATION', 'slots');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, [[W7.wed, '13:00']]) }), 'SLOT_INVALID');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, [[W7.wed, '10:15']]) }), 'SLOT_INVALID');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, [['2026-10-26', '17:00']]) }), 'SLOT_INVALID');
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(9999, slots) }), 'NOT_FOUND', 'week');
  });

  it('saves, then shows teammates the same request', async () => {
    const r = await db.call('oh_request_save', {
      p_token: a1,
      ...basicRequest(w7, [[W7.wed, '10:00'], [W7.wed, '10:30'], [W7.thu, '16:00'], [W7.wed, '10:00']], {
        p_progress: '  企劃完成\r\n\r\n\r\n\r\n原型卡關  ',
        p_link: '',
      }),
    });
    expect(r.version).toBe(1);
    expect(r.author).toBe('A');
    expect(r.link).toBeNull();
    expect(r.progress).toBe('企劃完成\n\n原型卡關');
    expect(r.slots).toEqual([
      { d: W7.wed, t: '10:00' },
      { d: W7.wed, t: '10:30' },
      { d: W7.thu, t: '16:00' },
    ]);
    const st = await db.call('oh_student_state', { p_token: b1 });
    expect(st.request.id).toBe(r.id);
    expect(st.weeks[0].requested).toBe(true);
    // other groups see demand, not identities
    const other = await db.call('oh_student_state', { p_token: c2 });
    expect(other.request).toBeNull();
    expect(other.slots.find((s: any) => s.d === W7.wed && s.t === '10:00').demand).toBe(1);
    expect(JSON.stringify(other)).not.toContain('感測器延遲');
  });

  it('detects concurrent edits by teammates', async () => {
    const st = await db.call('oh_student_state', { p_token: b1 });
    const v = st.request.version;
    const edited = await db.call('oh_request_save', {
      p_token: b1,
      ...basicRequest(w7, [[W7.fri, '11:00']], { p_version: v, p_topic: 'B 改了題目' }),
    });
    expect(edited.version).toBe(v + 1);
    expect(edited.author).toBe('B');
    await expectCode(
      db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, [[W7.fri, '11:30']], { p_version: v }) }),
      'CONFLICT',
    );
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7, [[W7.fri, '11:30']]) }), 'CONFLICT');
  });

  it('closes each week at noon on the Sunday before', async () => {
    const g2 = await db.call('oh_request_save', { p_token: c2, ...basicRequest(w7, [[W7.mon, '17:00'], [W7.wed, '11:00']]) });
    let st = await db.call('oh_student_state', { p_token: c2 });
    expect(st.weeks[0].deadline).toBe('2026-10-18 12:00');
    expect(st.settings).toMatchObject({ close_dow: 7, close_time: '12:00' });
    expect(st.settings).not.toHaveProperty('lead_days');
    // Sunday 11:59: still open, and every slot of the week can change, Monday's too
    await db.setNow('2026-10-18T11:59:00+08:00');
    const edited = await db.call('oh_request_save', {
      p_token: c2,
      ...basicRequest(w7, [[W7.mon, '17:30'], [W7.wed, '11:00']], { p_version: g2.version }),
    });
    expect(edited.version).toBe(g2.version + 1);
    // 12:00: no more changes or withdrawals; the next week is the one to book
    await db.setNow('2026-10-18T12:00:00+08:00');
    st = await db.call('oh_student_state', { p_token: c2, p_week: w7 });
    expect(st.weeks[0].bookable).toBe(false);
    expect(st.slots.every((x: any) => x.late)).toBe(true);
    await expectCode(
      db.call('oh_request_save', { p_token: c2, ...basicRequest(w7, [[W7.wed, '11:00']], { p_version: edited.version }) }),
      'WEEK_LATE',
      '10/18（日）12:00',
    );
    await expectCode(db.call('oh_request_withdraw', { p_token: c2, p_week: w7, p_version: edited.version }), 'WEEK_LATE');
    st = await db.call('oh_student_state', { p_token: c2 });
    expect(st.week_id).toBe(w7 + 1);
    expect(st.slots.find((x: any) => x.d === '2026-10-26').late).toBe(false);
    // the admins can move the deadline, say to Saturday 18:00
    await db.sql(`update app.settings set close_dow = 6, close_time = '18:00'`);
    st = await db.call('oh_student_state', { p_token: c2 });
    expect(st.weeks[1].deadline).toBe('2026-10-24 18:00');
    await db.sql(`update app.settings set close_dow = 7, close_time = '12:00'`);
    await db.setNow(WED);
  });

  it('rejects writes to closed weeks', async () => {
    const { token } = await db.call('oh_join', { p_code: (await db.codes()).admin });
    await db.call('oh_admin_save', { p_token: token, p_kind: 'week', p: { id: w7 + 1, open: false } });
    await expectCode(db.call('oh_request_save', { p_token: a1, ...basicRequest(w7 + 1, [['2026-10-28', '10:00']]) }), 'WEEK_CLOSED');
    const st = await db.call('oh_student_state', { p_token: a1 });
    expect(st.weeks[1].bookable).toBe(false);
  });

  it('withdraws and can restore', async () => {
    const st = await db.call('oh_student_state', { p_token: a1 });
    const w = await db.call('oh_request_withdraw', { p_token: a1, p_week: w7, p_version: st.request.version });
    expect(w.status).toBe('withdrawn');
    await expectCode(db.call('oh_request_withdraw', { p_token: a1, p_week: w7, p_version: w.version }), 'NOT_FOUND', 'request');
    const other = await db.call('oh_student_state', { p_token: c2 });
    expect(other.slots.find((s: any) => s.d === W7.fri && s.t === '11:00').demand).toBe(0);
    const back = await db.call('oh_request_save', { p_token: b1, ...basicRequest(w7, [[W7.fri, '11:00']], { p_version: w.version }) });
    expect(back.status).toBe('open');
  });
});

describe('scheduling', () => {
  let db: TestDb;
  let w7: number;
  let admin: string;
  let g1: string;
  let g2: string;
  let g3: string;
  let joseph: string;
  let ids: { joseph: number; prolong: number; tim: number; g1: number; g2: number; g3: number };

  beforeAll(async () => {
    db = await makeDb();
    await db.sql('update app.settings set week_cap = 2'); // these cases are written around a two-slot weekly cap
    await db.setNow(WED);
    const c = await db.codes();
    admin = await join(db, c.admin);
    g1 = await join(db, c.groups[1], 'A');
    g2 = await join(db, c.groups[2], 'B');
    g3 = await join(db, c.groups[3], 'C');
    joseph = await join(db, c.teachers.Joseph);
    w7 = await weekId(db, 'W7');
    ids = {
      joseph: await teacherId(db, 'Joseph'),
      prolong: await teacherId(db, 'Prolong'),
      tim: await teacherId(db, 'Tim'),
      g1: await groupId(db, 1),
      g2: await groupId(db, 2),
      g3: await groupId(db, 3),
    };
    await db.call('oh_request_save', { p_token: g1, ...basicRequest(w7, [[W7.wed, '10:00'], [W7.thu, '10:00'], [W7.fri, '10:00']], { p_want: 2 }) });
    await db.call('oh_request_save', { p_token: g2, ...basicRequest(w7, [[W7.wed, '10:00'], [W7.mon, '17:00']]) });
    await db.call('oh_request_save', { p_token: g3, ...basicRequest(w7, [[W7.wed, '10:00']]) });
  });

  it('gives admins the whole week', async () => {
    const st = await db.call('oh_admin_state', { p_token: admin });
    expect(st.week_id).toBe(w7);
    expect(st.requests).toHaveLength(3);
    expect(st.slots.find((s: any) => s.d === W7.wed && s.t === '10:00').teachers).toEqual([ids.joseph, ids.prolong].sort((a, b) => a - b));
    expect(st.weeks[0]).toMatchObject({ requests: 3, scheduled: 0, drafts: 0 });
    expect(st.groups).toHaveLength(7);
    expect(st.events.length).toBeGreaterThan(0);
  });

  it('keeps drafts private until published', async () => {
    const a = await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.prolong, p_d: W7.wed, p_t: '10:00' });
    expect(a.status).toBe('draft');
    let st = await db.call('oh_student_state', { p_token: g1 });
    expect(st.scheduling).toBe(true);
    expect(st.appointments).toEqual([]);
    let t = await db.call('oh_teacher_state', { p_token: joseph });
    expect(t.sessions).toEqual([]);

    const pub = await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
    expect(pub.published).toHaveLength(1);
    st = await db.call('oh_student_state', { p_token: g1 });
    expect(st.scheduling).toBe(false);
    expect(st.appointments).toHaveLength(1);
    expect(st.appointments[0]).toMatchObject({ d: W7.wed, t: '10:00', status: 'confirmed', teacher: null, can_cancel: true, topic: '感測器延遲' });
    expect(st.weeks[0].booked).toBe(1);
    // every teacher sees every PM's sessions, their own marked
    t = await db.call('oh_teacher_state', { p_token: joseph });
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]).toMatchObject({ teacher: 'Prolong', teacher_id: ids.prolong, mine: false, request: { topic: '感測器延遲' } });
  });

  it('never double-books a teacher or a group', async () => {
    await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g2, p_teacher: ids.prolong, p_d: W7.wed, p_t: '10:00' }),
      'TEACHER_BUSY',
    );
    await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.joseph, p_d: W7.wed, p_t: '10:00', p_force: true }),
      'GROUP_BUSY',
    );
  });

  it('keeps one group per time slot (one meeting room)', async () => {
    // group 1 has Wednesday 10:00 with Prolong; Joseph is free then, but the room is not
    const e = await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g2, p_teacher: ids.joseph, p_d: W7.wed, p_t: '10:00' }),
      'NEEDS_FORCE',
    );
    expect((e as DbError).detail).toBe('SLOT_TAKEN');
    const other = await db.call('oh_student_state', { p_token: g2, p_week: w7 });
    const wed = other.slots.find((x: any) => x.d === W7.wed && x.t === '10:00');
    expect(wed).toMatchObject({ cap: 1, full: true });
    expect(other.slots.find((x: any) => x.d === W7.wed && x.t === '10:30').full).toBe(false);
    const mine = await db.call('oh_student_state', { p_token: g1, p_week: w7 });
    expect(mine.slots.find((x: any) => x.d === W7.wed && x.t === '10:00').full).toBe(false);
  });

  it('asks for confirmation before breaking the rules', async () => {
    // group 1 already has Wednesday: a second slot that day breaks the daily cap
    let e = await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.joseph, p_d: W7.wed, p_t: '10:30' }),
      'NEEDS_FORCE',
    );
    expect((e as DbError).detail.split(',')).toEqual(['CAP_DAY', 'NOT_REQUESTED']);
    // Tim is not available on Friday
    e = await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.tim, p_d: W7.fri, p_t: '10:00' }),
      'NEEDS_FORCE',
    );
    expect((e as DbError).detail).toBe('OFF_HOURS');
    await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.tim, p_d: W7.wed, p_t: '10:07', p_force: true }),
      'SLOT_INVALID',
    );
    await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.tim, p_d: '2026-10-26', p_t: '10:00', p_force: true }),
      'SLOT_INVALID',
    );
    // second session on Thursday is fine; a third breaks the weekly cap
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.prolong, p_d: W7.thu, p_t: '10:00' });
    e = await expectCode(
      db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.prolong, p_d: W7.fri, p_t: '10:00' }),
      'NEEDS_FORCE',
    );
    expect((e as DbError).detail).toBe('CAP_WEEK');
    const forced = await db.call('oh_admin_assign', {
      p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.prolong, p_d: W7.fri, p_t: '10:00', p_force: true,
    });
    await db.call('oh_admin_remove', { p_token: admin, p_id: forced.id });
  });

  it('moves appointments and frees the old slot', async () => {
    const st = await db.call('oh_admin_state', { p_token: admin, p_week: w7 });
    const thu = st.appointments.find((a: any) => a.d === W7.thu);
    const moved = await db.call('oh_admin_move', { p_token: admin, p_id: thu.id, p_teacher: ids.prolong, p_d: W7.fri, p_t: '10:00' });
    expect(moved).toMatchObject({ d: W7.fri, t: '10:00', status: 'draft' });
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g2, p_teacher: ids.joseph, p_d: W7.mon, p_t: '17:00' });
    const discarded = await db.call('oh_admin_discard', { p_token: admin, p_week: w7 });
    expect(discarded.count).toBe(2);
  });

  it('applies the auto-schedule as one transaction', async () => {
    await expectCode(
      db.call('oh_admin_apply', {
        p_token: admin, p_week: w7, p_items: [
          { group_id: ids.g2, teacher_id: ids.joseph, d: W7.mon, t: '17:00' },
          { group_id: ids.g3, teacher_id: ids.prolong, d: W7.wed, t: '10:00' }, // Prolong is taken
        ],
      }),
      'TEACHER_BUSY',
    );
    expect((await db.call('oh_admin_state', { p_token: admin, p_week: w7 })).appointments).toHaveLength(1);
    // Joseph is free on Wednesday 10:00, but group 1 already has that slot
    const e = await expectCode(
      db.call('oh_admin_apply', {
        p_token: admin, p_week: w7, p_items: [{ group_id: ids.g3, teacher_id: ids.joseph, d: W7.wed, t: '10:00' }],
      }),
      'NEEDS_FORCE',
    );
    expect((e as DbError).detail).toBe('SLOT_TAKEN');
    const ok = await db.call('oh_admin_apply', {
      p_token: admin, p_week: w7, p_items: [{ group_id: ids.g2, teacher_id: ids.joseph, d: W7.mon, t: '17:00' }],
    });
    expect(ok.count).toBe(1);
    await expectCode(db.call('oh_admin_apply', { p_token: admin, p_week: w7, p_items: [{ group_id: 'x' }] }), 'VALIDATION', 'items');
    await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
    const t = await db.call('oh_teacher_state', { p_token: joseph });
    const mine = t.sessions.filter((m: any) => m.mine);
    expect(mine.map((m: any) => [m.d, m.t, m.group.no])).toEqual([[W7.mon, '17:00', 2]]);
    expect(mine[0].request).toMatchObject({ topic: '感測器延遲', progress: '第一版原型完成' });
  });

  it('lets students cancel until the cut-off', async () => {
    const st = await db.call('oh_student_state', { p_token: g2 });
    const mon = st.appointments[0];
    await db.setNow('2026-10-18T17:30:00+08:00'); // 23.5 h before
    await expectCode(db.call('oh_appointment_cancel', { p_token: g2, p_id: mon.id }), 'CANCEL_LATE');
    await db.setNow('2026-10-18T16:59:00+08:00');
    await expectCode(db.call('oh_appointment_cancel', { p_token: g1, p_id: mon.id }), 'NOT_FOUND', 'appointment');
    const c = await db.call('oh_appointment_cancel', { p_token: g2, p_id: mon.id, p_reason: '組員生病' });
    expect(c).toMatchObject({ status: 'cancelled', cancelled_by: 'B', cancel_reason: '組員生病' });
    await expectCode(db.call('oh_appointment_cancel', { p_token: g2, p_id: mon.id }), 'NOT_FOUND', 'appointment');
    const t = await db.call('oh_teacher_state', { p_token: joseph });
    expect(t.sessions.find((m: any) => m.d === W7.mon)).toMatchObject({ status: 'cancelled', cancel_reason: '組員生病', mine: true });
    await db.setNow(WED);
  });

  it('will not withdraw a request with confirmed sessions', async () => {
    const st = await db.call('oh_student_state', { p_token: g1, p_week: w7 });
    await expectCode(db.call('oh_request_withdraw', { p_token: g1, p_week: w7, p_version: st.request.version }), 'HAS_APPOINTMENTS');
  });

  it('respects holidays and teacher leave', async () => {
    const w17 = await weekId(db, 'W17');
    const s = await db.call('oh_admin_state', { p_token: admin, p_week: w17 });
    expect(s.slots.some((x: any) => x.d === '2027-01-01')).toBe(false);
    expect(s.closures).toEqual([{ id: expect.any(Number), d: '2027-01-01', teacher_id: null, reason: '元旦' }]);
    const w8 = await weekId(db, 'W8');
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'closure', p: { d: '2026-10-28', teacher_id: ids.joseph, reason: '出差' } });
    const s8 = await db.call('oh_admin_state', { p_token: admin, p_week: w8 });
    expect(s8.slots.find((x: any) => x.d === '2026-10-28' && x.t === '10:00').teachers).toEqual([ids.prolong]);
    const st = await db.call('oh_student_state', { p_token: g1, p_week: w8 });
    expect(st.slots.find((x: any) => x.d === '2026-10-28' && x.t === '10:00').cap).toBe(1);
    expect(st.closures).toEqual([]); // personal leave is not a holiday
  });
});

describe('administration', () => {
  let db: TestDb;
  let admin: string;
  beforeAll(async () => {
    db = await makeDb();
    await db.setNow(WED);
    admin = await join(db, (await db.codes()).admin);
  });

  it('updates settings within bounds', async () => {
    const s = await db.call('oh_admin_save', {
      p_token: admin, p_kind: 'settings', p: { close_dow: 6, close_time: '18:00', notice: ' 期中週暫停 ', show_teacher_names: true },
    });
    expect(s).toMatchObject({ close_dow: 6, close_time: '18:00', notice: '期中週暫停', show_teacher_names: true, week_cap: 3 });
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'settings', p: { close_dow: 8 } }), 'VALIDATION', 'settings');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'settings', p: { close_time: 'noon' } }), 'VALIDATION', 'settings');
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'settings', p: { close_dow: 7, close_time: '12:00' } });
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'settings', p: { week_cap: 'many' } }), 'VALIDATION', 'settings');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'nope', p: {} }), 'VALIDATION', 'kind');
  });

  it('manages groups and their codes', async () => {
    const g = await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { name: '新的一組' } });
    expect(g).toMatchObject({ no: 8, name: '新的一組', active: true });
    expect(g.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: g.id, no: 1 } }), 'DUPLICATE', 'group');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: g.id, webhook: 'https://evil.example/hook' } }), 'VALIDATION', 'group');
    const hook = 'https://discord.com/api/webhooks/123456/abc_DEF-123';
    expect((await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: g.id, webhook: hook } })).webhook).toBe(hook);

    const member = await join(db, g.code, '新成員');
    const rot = await db.call('oh_admin_rotate', { p_token: admin, p_kind: 'group', p_id: g.id, p_revoke: true });
    expect(rot.revoked).toBe(1);
    expect(rot.code).not.toBe(g.code);
    await expectCode(db.call('oh_me', { p_token: member }), 'AUTH');
    expect((await db.call('oh_peek', { p_code: g.code })).ok).toBe(false);
    expect((await db.call('oh_peek', { p_code: rot.code })).ok).toBe(true);

    const m2 = await join(db, rot.code, '另一位');
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: g.id, active: false } });
    await expectCode(db.call('oh_me', { p_token: m2 }), 'AUTH');
    expect((await db.call('oh_peek', { p_code: rot.code })).ok).toBe(false);
    await db.call('oh_admin_delete', { p_token: admin, p_kind: 'group', p_id: g.id });
    await expectCode(db.call('oh_admin_delete', { p_token: admin, p_kind: 'group', p_id: g.id }), 'NOT_FOUND', 'group');
  });

  it('protects groups and weeks that hold data', async () => {
    const c = await db.codes();
    const s = await join(db, c.groups[1], 'A');
    const w7 = await weekId(db, 'W7');
    await db.call('oh_request_save', { p_token: s, ...basicRequest(w7, [[W7.wed, '10:00']]) });
    await expectCode(db.call('oh_admin_delete', { p_token: admin, p_kind: 'group', p_id: await groupId(db, 1) }), 'IN_USE');
    await expectCode(db.call('oh_admin_delete', { p_token: admin, p_kind: 'week', p_id: w7 }), 'IN_USE');
  });

  it('validates availability blocks', async () => {
    const tim = await teacherId(db, 'Tim');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: tim, dow: 5, start: '13:15', end: '14:00' } }), 'VALIDATION', 'block');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: tim, dow: 5, start: '14:00', end: '13:00' } }), 'VALIDATION', 'block');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: tim, start: '13:00', end: '14:00' } }), 'VALIDATION', 'block');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: tim, dow: 9, start: '13:00', end: '14:00' } }), 'VALIDATION', 'block');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: 999, dow: 5, start: '13:00', end: '14:00' } }), 'NOT_FOUND', 'teacher');
    // a one-off Saturday block shows up only in its week
    const b = await db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: tim, on_date: '2026-10-24', start: '13:00', end: '14:00' } });
    const st = await db.call('oh_admin_state', { p_token: admin, p_week: await weekId(db, 'W7') });
    expect(st.slots.filter((x: any) => x.d === '2026-10-24').map((x: any) => x.t)).toEqual(['13:00', '13:30']);
    const st8 = await db.call('oh_admin_state', { p_token: admin, p_week: await weekId(db, 'W8') });
    expect(st8.slots.some((x: any) => x.d === '2026-10-31')).toBe(false);
    await db.call('oh_admin_delete', { p_token: admin, p_kind: 'block', p_id: b.id });
    // recurring blocks honour their date range
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'block', p: { teacher_id: tim, dow: 6, start: '09:00', end: '10:00', valid_from: '2026-10-26' } });
    expect((await db.call('oh_admin_state', { p_token: admin, p_week: await weekId(db, 'W7') })).slots.some((x: any) => x.d === '2026-10-24')).toBe(false);
    expect((await db.call('oh_admin_state', { p_token: admin, p_week: await weekId(db, 'W8') })).slots.some((x: any) => x.d === '2026-10-31')).toBe(true);
  });

  it('cannot lock itself out', async () => {
    const me = (await db.call('oh_me', { p_token: admin })).session.admin.id;
    await expectCode(db.call('oh_admin_delete', { p_token: admin, p_kind: 'admin', p_id: me }), 'SELF');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'admin', p: { id: me, active: false } }), 'SELF');
    const other = await db.call('oh_admin_save', { p_token: admin, p_kind: 'admin', p: { name: '第二位助教' } });
    expect(other.code).toHaveLength(12);
    const otherTok = await join(db, other.code);
    await db.call('oh_admin_rotate', { p_token: admin, p_kind: 'admin', p_id: me, p_revoke: true });
    expect((await db.call('oh_me', { p_token: admin })).session.role).toBe('admin');
    await db.call('oh_admin_delete', { p_token: admin, p_kind: 'admin', p_id: other.id });
    await expectCode(db.call('oh_me', { p_token: otherTok }), 'AUTH');
  });

  it('generates weeks without duplicates', async () => {
    const r = await db.call('oh_admin_weeks_generate', { p_token: admin, p_start: '2027-01-13', p_count: 3, p_first_no: 19 });
    expect(r.added).toBe(2); // 1/11 already exists
    const weeks = await db.sql("select start_date::text as s, label from app.weeks where start_date >= '2027-01-11' order by 1");
    expect(weeks).toEqual([
      { s: '2027-01-11', label: 'W18' },
      { s: '2027-01-18', label: 'W20' },
      { s: '2027-01-25', label: 'W21' },
    ]);
    await expectCode(db.call('oh_admin_weeks_generate', { p_token: admin, p_start: '2027-01-13', p_count: 0 }), 'VALIDATION', 'weeks');
    await expectCode(db.call('oh_admin_save', { p_token: admin, p_kind: 'week', p: { start: '2027-03-03' } }), 'VALIDATION', 'week');
  });

  it('exports everything except drafts', async () => {
    const e = await db.call('oh_admin_export', { p_token: admin });
    expect(e.requests).toHaveLength(1);
    expect(e.requests[0]).toMatchObject({ group_no: 1, slots: '10/21 10:00', status: 'open' });
    expect(e.appointments).toEqual([]);
  });

  it('shows full configuration to admins', async () => {
    const cfg = await db.call('oh_admin_config', { p_token: admin });
    expect(cfg.groups[0].code).toHaveLength(8);
    // the shared account first, then the PMs
    expect(cfg.teachers.map((t: any) => [t.name, t.team])).toEqual([['叁式', true], ['Joseph', false], ['Prolong', false], ['Tim', false]]);
    expect(cfg.admins.find((a: any) => a.me).name).toBe('助教');
    expect(cfg.blocks.length).toBeGreaterThanOrEqual(7);
  });
});

describe('name login', () => {
  let db: TestDb;
  let admin: string;
  beforeAll(async () => {
    db = await makeDb();
    await db.setNow(WED);
    admin = await join(db, (await db.codes()).admin);
  });

  const roster = (no: number, names: unknown) =>
    groupId(db, no).then((id) => db.call('oh_admin_roster', { p_token: admin, p_group: id, p_names: names }));

  it('keeps a cleaned, de-duplicated roster per group, in order', async () => {
    const r = await roster(1, ['  吳思妤 ', '張家豪', '', '張 家豪', 'Amy  Chen', null]);
    expect(r.roster).toEqual(['吳思妤', '張家豪', 'Amy Chen']);
    const cfg = await db.call('oh_admin_config', { p_token: admin });
    expect(cfg.groups.find((g: any) => g.no === 1).roster).toEqual(['吳思妤', '張家豪', 'Amy Chen']);
    expect(cfg.groups.find((g: any) => g.no === 2).roster).toEqual([]);
    // saving again replaces the list
    expect((await roster(1, ['吳思妤', 'Amy Chen'])).roster).toEqual(['吳思妤', 'Amy Chen']);
  });

  it('signs a student in to their group by name, ignoring case, spaces and width', async () => {
    const r = await db.call('oh_login', { p_name: ' ａｍｙ chen ' });
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.session).toMatchObject({ role: 'student', name: 'Amy Chen', group: { no: 1 } });
    const st = await db.call('oh_student_state', { p_token: r.token });
    expect(st.me.group.no).toBe(1);
    const ev = await db.one("select data from app.events where kind = 'member.joined' order by id desc limit 1");
    expect(ev.data).toEqual({ via: 'name' });
  });

  it('signs a teacher in by name', async () => {
    const t = await db.call('oh_login', { p_name: 'tim' });
    expect(t.session).toMatchObject({ role: 'teacher', name: 'Tim' });
    await db.call('oh_teacher_state', { p_token: t.token });
  });

  it('signs admins in by name, except the code-only 助教 account', async () => {
    expect(await db.call('oh_login', { p_name: '助教' })).toEqual({ ok: false, error: 'NAME_UNKNOWN' });
    const cfg0 = await db.call('oh_admin_config', { p_token: admin });
    expect(cfg0.admins.find((a: any) => a.name === '助教').name_login).toBe(false);
    const added = await db.call('oh_admin_save', { p_token: admin, p_kind: 'admin', p: { name: '黃瑞恩' } });
    const a = await db.call('oh_login', { p_name: ' 黃 瑞恩' });
    expect(a.session).toMatchObject({ role: 'admin', name: '黃瑞恩' });
    await db.call('oh_admin_state', { p_token: a.token });
    const cfg = await db.call('oh_admin_config', { p_token: a.token });
    expect(cfg.admins.find((x: any) => x.name === '黃瑞恩')).toMatchObject({ name_login: true, me: true });
    // a disabled admin cannot sign in by name
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'admin', p: { id: added.id, active: false } });
    expect(await db.call('oh_login', { p_name: '黃瑞恩' })).toEqual({ ok: false, error: 'NAME_UNKNOWN' });
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'admin', p: { id: added.id, active: true } });
  });

  it('rejects empty and unknown names, and counts unknown ones as guesses', async () => {
    await db.sql('delete from app.join_attempts');
    expect(await db.call('oh_login', { p_name: '   ' })).toEqual({ ok: false, error: 'NAME_REQUIRED' });
    expect(await db.call('oh_login', { p_name: '張家豪' })).toEqual({ ok: false, error: 'NAME_UNKNOWN' }); // removed from the roster
    expect((await db.one('select count(*)::int as n from app.join_attempts')).n).toBe(1);
    for (let i = 0; i < 19; i++) await db.call('oh_login', { p_name: `路人${i}` });
    await expectCode(db.call('oh_login', { p_name: '吳思妤' }), 'RATE_LIMIT');
    await db.sql('delete from app.join_attempts');
  });

  it('does not sign in members of a disabled group', async () => {
    const id = await groupId(db, 1);
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id, active: false } });
    expect(await db.call('oh_login', { p_name: '吳思妤' })).toEqual({ ok: false, error: 'NAME_UNKNOWN' });
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id, active: true } });
    expect((await db.call('oh_login', { p_name: '吳思妤' })).ok).toBe(true);
  });

  it('keeps names unique across groups and teachers', async () => {
    const e = await expectCode(roster(2, ['陳柏宇', '吳 思妤', 'TIM', '黃瑞恩']), 'NAME_TAKEN');
    expect(e.detail).toBe('吳 思妤、TIM、黃瑞恩');
    expect((await roster(2, ['助教'])).roster).toEqual(['助教']); // the code-only admin name is free
    expect((await roster(2, ['陳柏宇'])).roster).toEqual(['陳柏宇']);
    // a teacher added later with a student's name makes the name ambiguous
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'teacher', p: { name: '陳柏宇' } });
    expect(await db.call('oh_login', { p_name: '陳柏宇' })).toEqual({ ok: false, error: 'NAME_AMBIGUOUS' });
  });

  it('validates roster input and requires an admin', async () => {
    await expectCode(roster(3, { not: 'a list' }), 'VALIDATION', 'roster');
    await expectCode(roster(3, ['這個名字實在是太長了超過二十個字的上限了吧對吧']), 'VALIDATION', 'roster');
    await expectCode(db.call('oh_admin_roster', { p_token: admin, p_group: 9999, p_names: [] }), 'NOT_FOUND');
    const student = (await db.call('oh_login', { p_name: '吳思妤' })).token;
    await expectCode(db.call('oh_admin_roster', { p_token: student, p_group: 1, p_names: [] }), 'FORBIDDEN');
  });

  it('drops the roster with its group', async () => {
    const r = await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { name: '臨時組' } });
    const id = (await db.one("select id from app.groups where name = '臨時組'")).id;
    expect(r).toBeTruthy();
    await db.call('oh_admin_roster', { p_token: admin, p_group: id, p_names: ['臨時同學'] });
    await db.call('oh_admin_delete', { p_token: admin, p_kind: 'group', p_id: id });
    expect(await db.call('oh_login', { p_name: '臨時同學' })).toEqual({ ok: false, error: 'NAME_UNKNOWN' });
    expect((await db.one('select count(*)::int as n from app.roster where group_id = $1', [id])).n).toBe(0);
  });
});

describe('lockdown', () => {
  it('gives the anon role nothing but the oh_ functions', async () => {
    const db = await makeDb();
    await db.sql('set role anon');
    await expect(db.sql('select * from app.groups')).rejects.toThrow(/permission denied/);
    await expect(db.sql('select app.gen_code(8)')).rejects.toThrow(/permission denied/);
    const r = await db.call('oh_peek', { p_code: 'NOPE1234' });
    expect(r.ok).toBe(false);
    await expect(db.sql('select * from app.roster')).rejects.toThrow(/permission denied/);
    expect(await db.call('oh_login', { p_name: '沒有這個人' })).toEqual({ ok: false, error: 'NAME_UNKNOWN' });
    await db.sql('reset role');
  });

  it('cleans text input', async () => {
    const db = await makeDb({ seed: false });
    expect((await db.one(`select app.clean(E'  a\\t\\tb\\n c  ') as v`)).v).toBe('a b c');
    expect((await db.one(`select app.clean('   ') as v`)).v).toBeNull();
    expect((await db.one(`select app.clean_multiline(E'a  \\r\\nb\\n\\n\\n\\nc\\u0007') as v`)).v).toBe('a\nb\n\nc');
    const codes = await db.sql('select app.gen_code(12) as c from generate_series(1, 200)');
    for (const { c } of codes) expect(c).toMatch(/^[2-9A-HJKMNP-TV-Z]{12}$/);
    expect(new Set(codes.map((x: any) => x.c)).size).toBe(200);
  });
});
