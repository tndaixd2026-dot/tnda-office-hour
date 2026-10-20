import { beforeAll, describe, expect, it } from 'vitest';
import { expectCode, makeDb, type TestDb } from './helpers';

const SITE = 'https://example.github.io/office-hour/';
const API = 'https://abc.supabase.co';
const KEY = 'sb_publishable_test';

describe('weekly email', () => {
  let db: TestDb;
  let admin: string;
  let student: string;
  let ids: Record<string, number>;
  let codes: any;
  const outbox = async (kind: string, extra: Record<string, unknown> = {}) =>
    (await db.one(`select app.mail_outbox($1, null, $2, $3, $4, $5, $6) as v`, [kind, SITE, API, KEY, extra.fallback ?? 'sender@example.com', extra.force ?? false])).v;

  beforeAll(async () => {
    db = await makeDb();
    await db.setNow('2026-10-14T09:00:00+08:00');
    const c = await db.codes();
    codes = c;
    admin = (await db.call('oh_join', { p_code: c.admin })).token;
    student = (await db.call('oh_join', { p_code: c.groups[2], p_name: '小晴' })).token;
    ids = {};
    for (const t of await db.sql('select id, name from app.teachers')) ids[t.name] = t.id;
    for (const g of await db.sql('select id, no from app.groups')) ids[`g${g.no}`] = g.id;
    const w7 = (await db.one("select id from app.weeks where label = 'W7'")).id;
    await db.call('oh_request_save', {
      p_token: student, p_week: w7, p_topic: '展場動線 & <排隊>', p_progress: '平面圖完成\n下一步：測試', p_link: 'https://drive.google.com/x',
      p_want: 1, p_slots: [{ d: '2026-10-21', t: '10:00' }], p_version: null, p_questions: '動線要單向嗎？\n排隊區放哪裡',
    });
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g2, p_teacher: ids.Prolong, p_d: '2026-10-21', p_t: '10:00' });
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: ids.g1, p_teacher: ids.Joseph, p_d: '2026-10-19', p_t: '17:00', p_force: true });
    await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
  });

  it('keeps the questions a group asks for the PM', async () => {
    const req = async () => db.one(`select id, version, questions from app.requests where group_id = $1`, [ids.g2]);
    expect((await req()).questions).toBe('動線要單向嗎？\n排隊區放哪裡');
    const w7 = (await db.one("select id from app.weeks where label = 'W7'")).id;
    const again = (extra: Record<string, unknown>) =>
      db.call('oh_request_save', {
        p_token: student, p_week: w7, p_topic: '展場動線 & <排隊>', p_progress: '平面圖完成\n下一步：測試', p_link: 'https://drive.google.com/x',
        p_want: 1, p_slots: [{ d: '2026-10-21', t: '10:00' }], ...extra,
      });
    // a page loaded before the field existed sends none: the questions stay
    const saved = await again({ p_version: (await req()).version });
    expect(saved.questions).toBe('動線要單向嗎？\n排隊區放哪裡');
    await expectCode(again({ p_version: saved.version, p_questions: 'x'.repeat(1001) }), 'VALIDATION', 'questions');
    // the PMs see them, and so does their calendar
    const pm = (await db.call('oh_join', { p_code: codes.teachers.Prolong })).token;
    const st = await db.call('oh_teacher_state', { p_token: pm });
    expect(st.sessions.find((x: any) => x.group.no === 2).request.questions).toBe('動線要單向嗎？\n排隊區放哪裡');
    const feed = (await db.one(`select feed from app.teachers where name = 'Prolong'`)).feed;
    const ics = await db.one(`select convert_from(public.oh_calendar(p_feed => $1), 'UTF8') as v`, [feed]);
    expect(String(ics.v).replace(/\r\n /g, '')).toContain('想問的問題：\\n動線要單向嗎？\\n排隊區放哪裡');
  });

  it('works out which Monday the email is about', async () => {
    const week = async (d: string) => (await db.one('select app.mail_week($1::date)::text as v', [d])).v;
    expect(await week('2026-10-19')).toBe('2026-10-19'); // Monday: this week
    expect(await week('2026-10-18')).toBe('2026-10-19'); // Sunday: the coming week
    expect(await week('2026-10-14')).toBe('2026-10-19');
  });

  it('encodes links and escapes text', async () => {
    expect((await db.one(`select app.url_encode('a b/叁&') as v`)).v).toBe('a%20b%2F%E5%8F%81%26');
    expect((await db.one(`select app.html('<b>"x" & ''y''</b>') as v`)).v).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });

  it('lets only admins manage recipients, and checks the addresses', async () => {
    await expectCode(db.call('oh_admin_mail', { p_token: student }), 'FORBIDDEN');
    await expectCode(db.call('oh_admin_mail_save', { p_token: student, p_kind: 'settings', p: { weekly: false } }), 'FORBIDDEN');
    const none = await db.call('oh_admin_mail', { p_token: admin });
    expect(none.settings).toEqual({ weekly: true, preview: true, remind: true, ta_email: '' });
    expect(none.week).toBe('2026-10-19');
    expect(none.teachers.map((t: any) => t.name)).toEqual(['Joseph', 'Prolong', 'Tim']);

    const all = await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'recipient', p: { email: ' office@example.com ', name: '叁式公司' } });
    expect(all).toMatchObject({ email: 'office@example.com', name: '叁式公司', teachers: [], active: true });
    // the shared account and unknown ids are dropped from the teacher list
    const one = await db.call('oh_admin_mail_save', {
      p_token: admin, p_kind: 'recipient', p: { email: 'prolong@example.com', name: 'Prolong', teachers: [ids.Prolong, ids['叁式'], 9999] },
    });
    expect(one.teachers).toEqual([ids.Prolong]);
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'recipient', p: { email: 'tim@example.com', name: 'Tim', teachers: [ids.Tim] } });
    await expectCode(db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'recipient', p: { email: 'OFFICE@example.com' } }), 'DUPLICATE', 'recipient');
    for (const email of ['not an email', '', 'a@b', '<x>@y.com']) {
      await expectCode(db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'recipient', p: { email } }), 'VALIDATION', 'mail');
    }
    await expectCode(db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { ta_email: 'nope' } }), 'VALIDATION', 'mail');
    expect(await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { ta_email: 'ta@example.com' } })).toMatchObject({ ta_email: 'ta@example.com' });
    await expectCode(db.call('oh_admin_mail_delete', { p_token: admin, p_id: 9999 }), 'NOT_FOUND', 'recipient');
  });

  it('writes each recipient the sessions of the teachers they follow', async () => {
    const msgs = await outbox('weekly');
    expect(msgs.map((m: any) => [m.to, m.subject, m.count])).toEqual([
      ['office@example.com', '【Office Hour】本週 2 場（10/19–10/25）', 2],
      ['prolong@example.com', '【Office Hour】Prolong 本週 1 場（10/19–10/25）', 1],
      ['tim@example.com', '【Office Hour】Tim 本週沒有場次（10/19–10/25）', 0],
    ]);
    const [office, prolong, tim] = msgs;
    expect(office.html).toContain('叁式公司 您好');
    expect(office.html).toContain('第 1 組「南宜到達的斜上方」');
    expect(office.html).toContain('第 2 組「看到太陽就知道完蛋了」');
    expect(prolong.html).not.toContain('南宜到達的斜上方');
    // several PMs: a chip per PM with their count; one PM: no chips
    expect(office.html).toContain('>Joseph 1 場</span>');
    expect(office.html).toContain('>Prolong 1 場</span>');
    expect(prolong.html).not.toContain('>Prolong 1 場</span>');
    expect(tim.html).toContain('這週沒有排到 Office Hour');
    // student text is escaped
    expect(prolong.html).toContain('<b>展場動線 &amp; &lt;排隊&gt;</b>');
    expect(prolong.html).not.toContain('<排隊>');
    // what they want to ask, and the folder written out
    expect(prolong.html).toContain('想問的問題</p><p style="margin:2px 0 0;font-size:14px;line-height:1.6;color:#161514;white-space:pre-line;">動線要單向嗎？\n排隊區放哪裡</p>');
    expect(prolong.html).toContain('>drive.google.com/x</a>');
    // colours survive mail apps that drop CSS backgrounds: bgcolor too, and buttons are table cells
    expect(office.html).toContain('<td bgcolor="#161514" style="padding:26px 24px 24px;background-color:#161514;');
    expect(office.html).toMatch(/<td bgcolor="#161514" style="background-color:#161514;[^"]*"><a href="https:\/\/calendar\.google\.com/);
    expect(office.html).not.toMatch(/background:#/);
    expect(prolong.text).toContain('  想問的問題：動線要單向嗎？\n    排隊區放哪裡\n  檔案：https://drive.google.com/x\n');
    // one Google Calendar button per session, with the right UTC times
    expect(prolong.html.match(/action=TEMPLATE/g)).toHaveLength(1);
    expect(prolong.html).toContain('dates=20261021T020000Z/20261021T023000Z');
    expect(prolong.text).toContain('10:00–10:30 Prolong 第 2 組「看到太陽就知道完蛋了」｜展場動線 & <排隊>');
    // and one button that subscribes to the right feed: the PM's own, or the shared account's for everyone
    const feeds = Object.fromEntries((await db.sql('select name, feed from app.teachers')).map((t: any) => [t.name, t.feed]));
    expect(prolong.html).toContain(`p_feed%3D${feeds.Prolong}`);
    expect(office.html).toContain(`p_feed%3D${feeds['叁式']}`);
    expect(office.html).toContain('calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fabc.supabase.co%2Frest%2Fv1%2Frpc%2Foh_calendar');
    expect(tim.html).not.toContain('一鍵把全部場次'); // nothing to subscribe to this week
    expect(office.html).toContain(SITE);
  });

  it('sends each message once a week, unless forced', async () => {
    for (const m of await outbox('weekly')) {
      await db.sql('select app.mail_sent($1, $2::date, $3, $4, $5)', ['weekly', m.week, m.to, m.subject, m.count]);
    }
    expect(await outbox('weekly')).toEqual([]);
    expect(await outbox('weekly', { force: true })).toHaveLength(3);
    const st = await db.call('oh_admin_mail', { p_token: admin });
    expect(st.log).toHaveLength(3);
    expect(st.log[0]).toMatchObject({ kind: 'weekly', week: '2026-10-19' });
  });

  it('previews everything for the admins first', async () => {
    const [p] = await outbox('preview');
    expect(p.to).toBe('ta@example.com');
    expect(p.subject).toBe('【預覽】週一 08:00 要寄出的 Office Hour 通知（10/19–10/25）');
    expect(p.html).toContain('這是預覽');
    expect(p.html).toContain('prolong@example.com（Prolong）：【Office Hour】Prolong 本週 1 場（10/19–10/25）');
    expect(p.html).toContain('第 1 組「南宜到達的斜上方」');
    expect(p.html).toContain('</ul><div style="margin-top:8px;">要調整場次');
    expect(p.html.indexOf('這是預覽')).toBeLessThan(p.html.indexOf('max-width:600px;background-color:#ffffff')); // above the card
    // with no admins' mailbox it goes to the sending account
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { ta_email: '' } });
    expect((await outbox('preview'))[0].to).toBe('sender@example.com');
    // switched off: nothing, unless forced
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { preview: false, weekly: false } });
    expect(await outbox('preview')).toEqual([]);
    expect(await outbox('weekly', { force: false })).toEqual([]);
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { preview: true, weekly: true } });
  });

  it('shows admins exactly what goes out, sent or not', async () => {
    const p = await db.call('oh_admin_mail_preview', { p_token: admin, p_week: '2026-10-21', p_site: SITE, p_api: API, p_key: KEY });
    expect(p.week).toBe('2026-10-19');
    expect(p.messages.map((m: any) => [m.kind, m.to, Boolean(m.sent_at)])).toEqual([
      ['remind', '（寄件的 Gmail）', false],
      ['preview', '（寄件的 Gmail）', false],
      ['weekly', 'office@example.com', true],
      ['weekly', 'prolong@example.com', true],
      ['weekly', 'tim@example.com', true],
    ]);
  });

  it('skips paused recipients and forgets deleted ones', async () => {
    const st = await db.call('oh_admin_mail', { p_token: admin });
    const tim = st.recipients.find((r: any) => r.email === 'tim@example.com');
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'recipient', p: { id: tim.id, active: false } });
    expect((await outbox('weekly', { force: true })).map((m: any) => m.to)).not.toContain('tim@example.com');
    await db.call('oh_admin_mail_delete', { p_token: admin, p_id: tim.id });
    expect((await db.call('oh_admin_mail', { p_token: admin })).recipients).toHaveLength(2);
  });

  it('reminds the admins at the deadline which groups asked for next week', async () => {
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { ta_email: 'ta@example.com' } });
    const missing = (await db.sql('select no from app.groups where active and no <> 2 order by no')).map((g: any) => `第 ${g.no} 組`).join('、');
    // the requests for the week of 10/19 closed on Sunday 10/18 at noon
    await db.setNow('2026-10-18T12:00:00+08:00');
    const [r] = await outbox('remind');
    expect(r).toMatchObject({ kind: 'remind', week: '2026-10-19', to: 'ta@example.com', count: 1 });
    expect(r.subject).toBe('【Office Hour】請審核下週需求：1 組送出（10/19–10/25）');
    expect(r.html).toContain('需求已在 10/18（日）12:00 截止，1 組送出，共想要 1 次');
    expect(r.html).toContain(`沒有送出：</b>${missing}`);
    expect(r.html).toContain('第 2 組');
    expect(r.html).toContain('展場動線 &amp; &lt;排隊&gt;');
    expect(r.html).toContain(`href="${SITE}#/admin"`);
    expect(r.text).toContain('想要 1 次，勾了 1 個時段');
    // sent early by hand, it says when they close
    await db.setNow('2026-10-18T10:00:00+08:00');
    const early = (await outbox('remind'))[0];
    expect(early.html).toContain('需求會在 10/18（日）12:00 截止，目前 1 組送出');
    expect(early.html).toContain(`還沒送出：</b>${missing}`);
    // a closed week has nothing to schedule
    await db.sql(`update app.weeks set open = false where start_date = '2026-10-19'`);
    expect((await outbox('remind'))[0].subject).toBe('【Office Hour】下週沒有開放預約（10/19–10/25）');
    await db.sql(`update app.weeks set open = true where start_date = '2026-10-19'`);
    // once a week, and not at all when switched off
    await db.sql(`select app.mail_sent('remind', '2026-10-19', 'ta@example.com', 'x', 1)`);
    expect(await outbox('remind')).toEqual([]);
    expect(await outbox('remind', { force: true })).toHaveLength(1);
    await db.sql(`delete from app.mail_log where kind = 'remind'`);
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { remind: false } });
    expect(await outbox('remind')).toEqual([]);
    await db.call('oh_admin_mail_save', { p_token: admin, p_kind: 'settings', p: { remind: true, ta_email: '' } });
    await db.setNow('2026-10-14T09:00:00+08:00');
  });

  it('keeps the mail tables private', async () => {
    await db.sql('set role anon');
    await expect(db.sql('select * from app.mail_recipients')).rejects.toThrow(/permission denied/);
    await expect(db.sql(`select app.mail_outbox('weekly', null, '', '', '')`)).rejects.toThrow(/permission denied/);
    await db.sql('reset role');
  });
});
