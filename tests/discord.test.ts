import { beforeAll, describe, expect, it } from 'vitest';
import { makeDb, type TestDb } from './helpers';

// A stand-in for pg_net that records what would have been sent.
const FAKE_PG_NET = `
create schema net;
create table net.sent (id bigint generated always as identity, url text, body jsonb);
create table net._http_response (id bigint, status_code int, error_msg text);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                              headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.sent (url, body) values (url, body) returning id $$;
`;

const HOOK = 'https://discord.com/api/webhooks/123/abc_DEF-1';

describe('discord notifications', () => {
  let db: TestDb;
  let admin: string;
  let student: string;
  let w7: number;
  let g2: number;
  let prolong: number;
  const sent = async () => (await db.sql('select url, body from net.sent order by id')).map((r: any) => ({ url: r.url, text: r.body.content, body: r.body }));

  beforeAll(async () => {
    db = await makeDb({ legacy: true });
    await db.pg.exec(FAKE_PG_NET);
    await db.setNow('2026-10-14T09:00:00+08:00');
    const c = await db.codes();
    admin = (await db.call('oh_join', { p_code: c.admin })).token;
    student = (await db.call('oh_join', { p_code: c.groups[2], p_name: '小晴' })).token;
    w7 = (await db.one("select id from app.weeks where label = 'W7'")).id;
    g2 = (await db.one('select id from app.groups where no = 2')).id;
    prolong = (await db.one("select id from app.teachers where name = 'Prolong'")).id;
    await db.call('oh_request_save', {
      p_token: student, p_week: w7, p_topic: '@everyone 展場動線', p_progress: '平面圖完成', p_link: null, p_want: 2,
      p_slots: [{ d: '2026-10-21', t: '10:00' }, { d: '2026-10-23', t: '10:00' }], p_version: null,
    });
  });

  it('stays silent for groups without a webhook', async () => {
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: g2, p_teacher: prolong, p_d: '2026-10-21', p_t: '10:00' });
    await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
    expect(await sent()).toEqual([]);
  });

  it('sends one message per group when a week is published', async () => {
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: g2, webhook: HOOK } });
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: g2, p_teacher: prolong, p_d: '2026-10-23', p_t: '10:00' });
    await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
    const msgs = await sent();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].url).toBe(HOOK);
    expect(msgs[0].text).toContain('Office Hour 時間確定');
    expect(msgs[0].text).toContain('第 2 組「看到太陽就知道完蛋了」');
    expect(msgs[0].text).toContain('10/23（五）10:00–10:30');
    expect(msgs[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  it('announces moves and cancellations', async () => {
    const st = await db.call('oh_admin_state', { p_token: admin, p_week: w7 });
    const fri = st.appointments.find((a: any) => a.d === '2026-10-23');
    await db.call('oh_admin_move', { p_token: admin, p_id: fri.id, p_teacher: prolong, p_d: '2026-10-22', p_t: '10:00', p_force: true });
    await db.call('oh_appointment_cancel', { p_token: student, p_id: fri.id, p_reason: '組員生病' });
    const msgs = (await sent()).slice(1);
    expect(msgs.map((m) => m.text.split('\n')[0])).toEqual(['**Office Hour 時間異動**', '**Office Hour 已取消**']);
    expect(msgs[0].text).toContain('10/23（五）10:00–10:30 → 10/22（四）10:00–10:30');
    expect(msgs[1].text).toContain('小晴 取消：組員生病');
  });

  it('lets admins send a test message and read its status', async () => {
    const r = await db.call('oh_admin_webhook_test', { p_token: admin, p_group: g2 });
    expect(r.available).toBe(true);
    expect(r.request_id).toBeGreaterThan(0);
    expect((await db.call('oh_admin_webhook_status', { p_token: admin, p_request: r.request_id })).state).toBe('pending');
    await db.sql('insert into net._http_response (id, status_code) values ($1, 204)', [r.request_id]);
    expect((await db.call('oh_admin_webhook_status', { p_token: admin, p_request: r.request_id })).state).toBe('ok');
    await db.sql('insert into net._http_response (id, status_code) values (999, 404)');
    expect((await db.call('oh_admin_webhook_status', { p_token: admin, p_request: 999 })).state).toBe('failed');
    const other = (await db.one('select id from app.groups where no = 3')).id;
    await expect(db.call('oh_admin_webhook_test', { p_token: admin, p_group: other })).rejects.toThrow(/NOT_FOUND/);
    await expect(db.call('oh_admin_webhook_test', { p_token: student, p_group: g2 })).rejects.toThrow(/FORBIDDEN/);
  });

  it('never fails a booking when the webhook call breaks', async () => {
    await db.pg.exec(`create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                        headers jsonb default '{}', timeout_milliseconds int default 5000)
                      returns bigint language plpgsql as $$ begin raise exception 'network down'; end $$;`);
    await db.call('oh_admin_assign', { p_token: admin, p_week: w7, p_group: g2, p_teacher: prolong, p_d: '2026-10-22', p_t: '10:30', p_force: true });
    const r = await db.call('oh_admin_publish', { p_token: admin, p_week: w7 });
    expect(r.published).toHaveLength(1);
  });
});

describe('without pg_net', () => {
  it('reports the feature as unavailable', async () => {
    const db = await makeDb({ legacy: true });
    const c = await db.codes();
    const admin = (await db.call('oh_join', { p_code: c.admin })).token;
    const g = (await db.one('select id from app.groups where no = 1')).id;
    await db.call('oh_admin_save', { p_token: admin, p_kind: 'group', p: { id: g, webhook: HOOK } });
    const r = await db.call('oh_admin_webhook_test', { p_token: admin, p_group: g });
    expect(r).toEqual({ request_id: null, available: false });
    expect((await db.call('oh_admin_webhook_status', { p_token: admin, p_request: 1 })).state).toBe('unavailable');
  });
});
