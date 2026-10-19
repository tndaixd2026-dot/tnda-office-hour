// Read-only checks against the live Supabase project: the API answers,
// private tables stay private, bad tokens are refused, realtime connects.
//   node scripts/cloud-smoke.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_KEY;
const headers = { apikey: key, 'Content-Type': 'application/json' };
const fails = [];
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails.push(msg);
};

const rpc = (fn, body = {}) => fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });

let r = await rpc('oh_public');
const pub = await r.json();
ok(r.ok && pub.settings && pub.clock, 'oh_public answers with settings and clock');

r = await fetch(`${url}/rest/v1/groups?select=*`, { headers });
ok(!r.ok, 'tables are not reachable through REST');

r = await fetch(`${url}/rest/v1/rpc/week_slots`, { method: 'POST', headers, body: '{"p_week":1}' });
ok(!r.ok, 'internal functions are not exposed');

r = await rpc('oh_admin_state', { p_token: 'x'.repeat(64) });
const e = await r.json();
ok(r.status === 400 && e.message === 'AUTH', 'bad tokens are refused');

r = await rpc('oh_peek', { p_code: 'ZZZZZZZZ' });
ok((await r.json()).ok === false, 'unknown codes are rejected');

r = await rpc('oh_login', { p_name: `沒有這個人${Date.now()}` });
const login = await r.json();
ok(r.ok && login.ok === false && login.error === 'NAME_UNKNOWN' && !login.token, 'unknown names are rejected');

r = await fetch(`${url}/graphql/v1`, { method: 'POST', headers, body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }) });
const gql = await r.json().catch(() => ({}));
const fields = gql?.data?.__schema?.queryType?.fields?.map((f) => f.name) ?? [];
ok(!fields.some((f) => /groups|sessions|requests|appointments/i.test(f)), 'GraphQL exposes no tables');

r = await fetch(`${url}/rest/v1/rpc/oh_calendar?p_feed=${'0'.repeat(32)}&apikey=${key}`);
const cal = await r.text();
ok(r.ok && /text\/calendar/.test(r.headers.get('content-type') ?? '') && cal.startsWith('BEGIN:VCALENDAR') && !cal.includes('VEVENT'),
  'calendar feeds answer as text/calendar and reveal nothing for unknown links');

r = await rpc('oh_lessons');
const td = await r.json();
ok(r.ok && Array.isArray(td.lessons) && td.info?.title, 'the TD timetable is public');

r = await rpc('oh_admin_mail', { p_token: 'x'.repeat(64) });
ok(r.status === 400 && (await r.json()).message === 'AUTH', 'email recipients are for admins only');

r = await rpc('oh_admin_lesson_save', { p_token: 'x'.repeat(64), p: {} });
ok(r.status === 400 && (await r.json()).message === 'AUTH', 'only admins can change the TD timetable');

r = await fetch(`${url}/rest/v1/rpc/oh_lessons_calendar?apikey=${key}`);
const tdCal = await r.text();
ok(r.ok && /text\/calendar/.test(r.headers.get('content-type') ?? '') && tdCal.startsWith('BEGIN:VCALENDAR'), 'the TD calendar feed answers as text/calendar');

const sb = createClient(url, key);
const status = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('TIMEOUT'), 15000);
  sb.channel('oh-sync', { config: { private: true } }).subscribe((s) => {
    if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR') {
      clearTimeout(t);
      resolve(s);
    }
  });
});
ok(status === 'SUBSCRIBED', 'realtime channel connects');

// browsers must not be able to broadcast on the channel
const spy = createClient(url, key);
const heard = [];
const ear = spy.channel('oh-sync', { config: { private: true } }).on('broadcast', { event: 'change' }, (m) => heard.push(m));
await new Promise((r) => ear.subscribe((s) => s === 'SUBSCRIBED' && r()));
const mouth = createClient(url, key).channel('oh-sync', { config: { private: true } });
await new Promise((r) => mouth.subscribe((s) => s === 'SUBSCRIBED' && r()));
await mouth.send({ type: 'broadcast', event: 'change', payload: { t: 'spoof' } });
await new Promise((r) => setTimeout(r, 1500));
ok(heard.length === 0, 'clients cannot broadcast fake changes');
await sb.removeAllChannels();

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`);
  process.exit(1);
}
console.log('\nCloud checks passed');
process.exit(0);
