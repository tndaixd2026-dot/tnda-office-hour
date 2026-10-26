import { beforeAll, describe, expect, it } from 'vitest';
import { expectCode, makeDb, type TestDb } from './helpers';

async function join(db: TestDb, code: string, name?: string): Promise<string> {
  return (await db.call('oh_join', { p_code: code, p_name: name ?? null })).token;
}
async function weekId(db: TestDb, label: string): Promise<number> {
  return (await db.one('select id from app.weeks where label = $1', [label])).id;
}

// Friday noon before W7 (10/19–10/23), which closes on Saturday 10/17 at 20:00
const FRI = '2026-10-16T12:00:00+08:00';

describe('Discord weekly ask', () => {
  let db: TestDb;
  let admin: string;
  let g2: string;
  let w7: number;
  let w8: number;
  let ids: Record<number, number>;
  const CH = (no: number) => `10000000000000000${no}`;
  const member = { nick: '小晴', user: { id: '42', username: 'qing_0921', global_name: 'Qing' } };
  const press = (no: number, custom_id: string, message = `90000000000000000${no}`) =>
    db.one(`select app.discord_interaction($1::jsonb) as r`, [
      JSON.stringify({ type: 3, channel_id: CH(no), member, message: { id: message }, data: { custom_id, component_type: 2 } }),
    ]).then((x) => x.r);
  const submit = (no: number, custom_id: string, values: Record<string, string>) =>
    db.one(`select app.discord_interaction($1::jsonb) as r`, [
      JSON.stringify({
        type: 5,
        channel_id: CH(no),
        member,
        message: { id: `90000000000000000${no}` },
        data: {
          custom_id,
          components: Object.entries(values).map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] })),
        },
      }),
    ]).then((x) => x.r);
  const fields = { topic: '感測器延遲', questions: '要換方案嗎\n預算夠嗎', progress: '原型完成', link: 'https://drive.google.com/drive/folders/x' };
  const labels = (msg: any) => (msg.components[0]?.components ?? []).map((b: any) => b.label);

  beforeAll(async () => {
    db = await makeDb();
    await db.setNow(FRI);
    const c = await db.codes();
    admin = await join(db, c.admin);
    g2 = await join(db, c.groups[2], 'B');
    w7 = await weekId(db, 'W7');
    w8 = await weekId(db, 'W8');
    ids = {};
    for (const g of await db.sql('select id, no from app.groups')) ids[g.no] = g.id;
    // what the sender learns: each group's channel (from its webhook), and the bot
    for (const no of [1, 2, 3, 4, 5, 6, 7]) await db.sql('select app.discord_set_channel($1, $2, true)', [ids[no], CH(no)]);
    await db.sql(`select app.discord_set_bot($1, 'Office Hour', 'https://x.supabase.co/functions/v1/discord', 'https://example.github.io/oh/')`, ['AB'.repeat(32)]);
  });

  it("asks every group about next week's fixed slot, once", async () => {
    const out = await db.sql('select * from app.discord_outbox()');
    expect(out.map((r: any) => r.group_no)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const m = out.find((r: any) => r.group_no === 2);
    expect(m).toMatchObject({ week_id: w7, channel_id: CH(2) });
    expect(m.payload.content).toContain('**📅 W7 10/19–10/23 要約 Office Hour 嗎？**');
    expect(m.payload.content).toContain('10/21（三）10:00–11:00 · Prolong');
    expect(m.payload.content).toContain('請在 10/17（六）20:00 前決定');
    expect(labels(m.payload)).toEqual(['預約這週', '這週不約', '打開網站']);
    expect(m.payload.components[0].components[0].custom_id).toBe(`oh:book:${w7}`);
    expect(m.payload.allowed_mentions).toEqual({ parse: [] });
    for (const r of out) await db.sql('select app.discord_posted($1, $2, $3, $4)', [r.group_id, r.week_id, r.channel_id, `90000000000000000${r.group_no}`]);
    expect(await db.sql('select * from app.discord_outbox()')).toEqual([]);
    expect((await db.sql('select * from app.discord_outbox(true, 2)')).map((r: any) => r.group_no)).toEqual([2]);
    // a channel the bot cannot see gets nothing
    await db.sql('select app.discord_set_channel($1, $2, false)', [ids[2], CH(2)]);
    expect(await db.sql('select * from app.discord_outbox(true, 2)')).toEqual([]);
    await db.sql('select app.discord_set_channel($1, $2, true)', [ids[2], CH(2)]);
  });

  it('opens the booking form, and books from it', async () => {
    const form = await press(2, `oh:book:${w7}`);
    expect(form.type).toBe(9);
    expect(form.data.title).toBe('預約 W7 10/21（三）10:00');
    expect(form.data.custom_id).toBe(`oh:save:${w7}:0`);
    expect(form.data.components.map((r: any) => r.components[0].custom_id)).toEqual(['topic', 'questions', 'progress', 'link']);
    expect(form.data.components[0].components[0].value).toBeUndefined();
    for (const r of form.data.components) expect(r.components[0].label.length).toBeLessThanOrEqual(45);

    const r = await submit(2, form.data.custom_id, fields);
    expect(r.type).toBe(7);
    expect(r.data.content).toContain('**✅ W7 10/19–10/23 已預約 Office Hour**');
    expect(r.data.content).toContain('討論室：<https://meet.google.com/gtj-tcpu-wmu>');
    expect(r.data.content).toContain('題目：感測器延遲');
    expect(r.data.content).toContain('小晴 填的，10/17（六）20:00 前都可以修改或改成這週不約');
    expect(labels(r.data)).toEqual(['修改內容', '這週不約', '打開網站']);
    // the same booking as on the site: confirmed at once, under the nickname
    const st = await db.call('oh_student_state', { p_token: g2 });
    expect(st.request).toMatchObject({ status: 'open', topic: '感測器延遲', author: '小晴', link: fields.link });
    expect(st.appointments).toEqual([expect.objectContaining({ d: '2026-10-21', t: '10:00', status: 'confirmed' })]);
  });

  it('fills the form in again, and refuses a stale one', async () => {
    const form = await press(2, `oh:book:${w7}`);
    expect(form.data.title).toBe('修改 W7 10/21（三）10:00');
    expect(form.data.components[1].components[0].value).toBe('要換方案嗎\n預算夠嗎');
    // a groupmate edits on the site meanwhile
    const st = await db.call('oh_student_state', { p_token: g2 });
    await db.call('oh_booking_save', { p_token: g2, p_week: w7, p_topic: '網站上改的', p_questions: 'q', p_progress: 'p', p_link: fields.link, p_version: st.request.version });
    const r = await submit(2, form.data.custom_id, { ...fields, topic: '舊表單' });
    expect(r).toEqual({ type: 4, data: { content: '組員剛剛也改了這週的預約，請再按一次按鈕看最新的內容', flags: 64 } });
    expect((await db.call('oh_student_state', { p_token: g2 })).request.topic).toBe('網站上改的');
  });

  it('keeps what was typed when the link is not a link', async () => {
    let form = await press(3, `oh:book:${w7}`);
    const r = await submit(3, form.data.custom_id, { ...fields, topic: '第三組的題目', link: 'drive 資料夾' });
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
    expect(r.data.content).toBe('雲端資料夾連結要貼完整網址（https:// 開頭）。再按一次按鈕，剛剛填的內容都還在');
    form = await press(3, `oh:book:${w7}`);
    expect(form.data.components.map((x: any) => x.components[0].value)).toEqual(['第三組的題目', fields.questions, fields.progress, 'drive 資料夾']);
    expect((await submit(3, form.data.custom_id, { ...fields, topic: '第三組的題目' })).type).toBe(7);
    expect(await db.sql('select * from app.discord_drafts')).toEqual([]);
  });

  it('skips the week, and books it after all', async () => {
    let r = await press(4, `oh:skip:${w7}:0`);
    expect(r.type).toBe(7);
    expect(r.data.content).toBe('**W7 10/19–10/23 這週不約**\n小晴 決定的，10/17（六）20:00 前都可以改成預約');
    expect(labels(r.data)).toEqual(['改成預約', '打開網站']);
    const form = await press(4, `oh:book:${w7}`);
    expect(form.data.custom_id).toMatch(new RegExp(`^oh:save:${w7}:[1-9]`));
    r = await submit(4, form.data.custom_id, fields);
    expect(r.data.content).toContain('已預約');
    // a booked group can skip too: its session goes away
    const shown = (await db.one('select app.discord_message($1, $2) as m', [ids[2], w7])).m;
    const skipButton = shown.components[0].components.find((b: any) => b.label === '這週不約');
    r = await press(2, skipButton.custom_id);
    expect(r.data.content).toContain('這週不約');
    expect((await db.call('oh_student_state', { p_token: g2 })).appointments).toEqual([]);
  });

  it("only redraws a message that no longer shows what the group decided", async () => {
    // Friday's message still asks group 6, but a member booked on the site since
    const asked = (await db.one('select app.discord_message($1, $2) as m', [ids[6], w7])).m;
    const stale = asked.components[0].components.find((b: any) => b.label === '這週不約').custom_id;
    expect(stale).toBe(`oh:skip:${w7}:0`);
    const g6 = await join(db, (await db.codes()).groups[6], 'F');
    await db.call('oh_booking_save', { p_token: g6, p_week: w7, p_topic: '網站上約的', p_questions: 'q', p_progress: 'p', p_link: fields.link });
    const r = await press(6, stale);
    expect(r.type).toBe(7);
    expect(r.data.content).toContain('題目：網站上約的');
    expect((await db.call('oh_student_state', { p_token: g6 })).request.status).toBe('open');
  });

  it('only answers in the group\'s own channel', async () => {
    const other = await db.one(`select app.discord_interaction($1::jsonb) as r`, [
      JSON.stringify({ type: 3, channel_id: '555555555555555555', member, message: { id: '900000000000000002' }, data: { custom_id: `oh:skip:${w7}:0` } }),
    ]);
    expect(other.r).toEqual({ type: 4, data: { content: '這個頻道沒有對應的小組，請告訴助教', flags: 64 } });
    // a message the bot did not post, in a channel two groups share, belongs to neither
    await db.sql(`update app.groups set discord_channel = $1 where no = 6`, [CH(5)]);
    expect((await press(5, `oh:skip:${w7}:0`, '1')).data.content).toBe('這個頻道沒有對應的小組，請告訴助教');
    await db.sql(`update app.groups set discord_channel = $1 where no = 6`, [CH(6)]);
    expect((await press(5, 'something:else')).data.content).toBe('這個按鈕已經不能用了');
    expect((await press(5, `oh:book:999999`)).data.content).toBe('這個按鈕已經不能用了');
    expect((await db.one(`select app.discord_interaction('{"type": 1}') as r`)).r).toEqual({ type: 1 });
  });

  it('closes on Saturday at 20:00 and rewrites each message with the outcome', async () => {
    await db.setNow('2026-10-17T20:00:00+08:00');
    // a late press just shows the closed message
    const late = await press(1, `oh:book:${w7}`);
    expect(late.type).toBe(7);
    expect(late.data.content).toBe('**W7 10/19–10/23 沒有預約**\n已在 10/17（六）20:00 截止，這週不排討論');
    expect(labels(late.data)).toEqual(['打開網站']);
    const closing = await db.sql('select * from app.discord_closing()');
    expect(closing.map((c: any) => c.group_no)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const by = (no: number) => closing.find((c: any) => c.group_no === no).payload;
    expect(by(3).content).toContain('**✅ W7 10/19–10/23 已預約 Office Hour**');
    expect(by(3).content).not.toContain('前都可以');
    expect(by(2).content).toBe('**W7 10/19–10/23 這週不約**\n小晴 決定的');
    expect(labels(by(3))).toEqual(['打開網站']);
    for (const c of closing) await db.sql('select app.discord_closed($1)', [c.post_id]);
    expect(await db.sql('select * from app.discord_closing()')).toEqual([]);
    // and the next ask is about W8
    expect((await db.sql('select week_id from app.discord_outbox()'))[0].week_id).toBe(w8);
    await db.setNow(FRI);
  });

  it('shows a holiday, a moved session and a paused week as they are', async () => {
    const msg = async (no: number, week: number) => (await db.one('select app.discord_message($1, $2) as m', [ids[no], week])).m;
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'closure', p: { d: '2026-10-29', reason: '校慶' } }); // a Thursday
    const h = await msg(4, w8);
    expect(h.content).toBe('**W8 10/26–10/30 遇到校慶，停一次**\n固定時段那天放假，這週不用預約');
    expect(labels(h)).toEqual(['打開網站']);
    // 改期 by the admins shows the new time
    const [a] = (await db.call('oh_admin_state', { p_token: admin, p_week: w7 })).appointments.filter((x: any) => x.group_id === ids[3]);
    const prolong = (await db.one(`select id from app.teachers where name = 'Prolong'`)).id;
    await db.call('oh_admin_move', { p_token: admin, p_id: a.id, p_teacher: prolong, p_d: '2026-10-23', p_t: '10:00' });
    expect((await msg(3, w7)).content).toContain('10/23（五）10:00–11:00 · Prolong');
    await db.sql(`update app.weeks set open = false where id = $1`, [w8]);
    expect((await msg(1, w8)).content).toBe('**W8 10/26–10/30 暫停**\n這週不排 Office Hour，有問題可以問助教');
    await db.sql(`update app.weeks set open = true where id = $1`, [w8]);
  });

  it('gives the admins the bot setup, the channels and the messages sent', async () => {
    const st = await db.call('oh_admin_discord', { p_token: admin });
    expect(st).toMatchObject({ ready: true, name: 'Office Hour', checked_at: expect.any(String), week: { id: w7, label: 'W7', deadline: '2026-10-17 20:00' } });
    expect(st).not.toHaveProperty('public_key');
    expect(st.groups).toHaveLength(7);
    expect(st.groups[1]).toMatchObject({ no: 2, webhook: false, channel: true, ready: true, fixed: true });
    expect(st.posts).toHaveLength(7);
    expect(st.posts.find((p: any) => p.group_no === 3)).toMatchObject({ week: 'W7 10/19–10/23', status: 'open', closed_at: expect.any(String) });
    // by now every group has answered, so the preview is group 1's
    expect(st.sample_group).toBe(1);
    expect(st.sample.content).toContain('第 1 組');
    expect((await db.one('select public_key from app.discord_bot')).public_key).toBe('ab'.repeat(32));
    await expectCode(db.call('oh_admin_discord', { p_token: g2 }), 'FORBIDDEN');
  });
});
