// Sends the weekly Office Hour email; run by .github/workflows/mail.yml.
//
//   KIND=weekly   each recipient gets this week's sessions (Monday)
//   KIND=remind   the admins' mailbox gets next week's requests (Sunday noon)
//   KIND=preview  the admins' mailbox gets all of it first (Sunday)
//   KIND=test     the email with every PM's sessions for the nearest week
//                 that has some, only to the sending account; nothing is logged
//   KIND=sample   the same, written from the demo's sessions (the site's demo
//                 mode, run here in PGlite) with the real meeting room
//   KIND=sample_all  a test email to every recipient on the 寄信通知 page,
//                 switched on or not: each gets their own PMs' demo sessions,
//                 marked 【測試】; nothing is logged
//   ONLY=叁式公司  with sample_all: just the recipients with this 稱呼
//   SUPABASE_DB_PASSWORD, POOLER_HOST   or DATABASE_URL directly
//   GMAIL_USER, GMAIL_APP_PASSWORD      the account that sends
//   SEND_AT=08:00  wait for this time in Taipei first (at most an hour)
//   FORCE=1        send again even if this week's email already went out
//   DRY_RUN=1      write the messages, send nothing
//   MAIL_TEST=1    "send" to nowhere (for trying the script locally)
//
// The messages are written by app.mail_outbox in the database, so the
// admin page previews exactly what goes out. The repository is public,
// and so are these logs: they show subjects and counts, never addresses.
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import pg from 'pg';

const on = (v) => v === '1' || v === 'true';
const kind = ['remind', 'preview', 'test', 'sample', 'sample_all'].includes(process.env.KIND) ? process.env.KIND : 'weekly';
const dry = on(process.env.DRY_RUN);
const force = on(process.env.FORCE);
const test = on(process.env.MAIL_TEST);
const only = process.env.ONLY?.trim() || null;
const env = Object.fromEntries(
  readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const site = process.env.SITE_URL || env.VITE_SITE_URL;
const user = process.env.GMAIL_USER?.trim() || (test ? 'test@example.com' : undefined);
const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '') || (test ? 'test' : undefined);
const hide = (s) => String(s).replace(/[^\s<>"'@]+@[^\s<>"']+/g, '***');

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(env.VITE_SUPABASE_URL ?? '')?.[1];
  if (!pw || !ref) return null;
  return `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@${process.env.POOLER_HOST}:5432/postgres`;
}

/** Milliseconds until hh:mm today in Taipei (negative once it has passed). */
function untilTaipei(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 3600_000);
  const target = Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth(), taipei.getUTCDate(), h, m) - 8 * 3600_000;
  return target - now.getTime();
}

const SAMPLE_NOTE =
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 0 12px;">' +
  '<tr><td bgcolor="#fbf0dc" style="padding:14px 16px;border:1px solid #e9d3ad;border-radius:12px;background-color:#fbf0dc;font-size:14px;text-align:left;">' +
  '<b>這是範例信。</b>場次、組別和題目都是示範資料，實際的信會在每週一 08:00 依當週發布的場次寄出。' +
  '<div style="margin-top:6px;">最上方的「一鍵把全部場次加到 Google 日曆」訂閱的是正式的行事曆（三位老師的全部場次），助教發布場次後就會自動出現；' +
  '每一場的「加入會議」和「加到 Google 日曆」可以直接試按，後者會打開 Google 日曆，按「儲存」才會加進去</div>' +
  '</td></tr></table>';

const TEST_NOTE =
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 0 12px;">' +
  '<tr><td bgcolor="#fbf0dc" style="padding:14px 16px;border:1px solid #e9d3ad;border-radius:12px;background-color:#fbf0dc;font-size:14px;text-align:left;">' +
  '<b>這是測試信，不用回覆。</b>用來確認您收得到 Office Hour 的通知、版面也正常。下面的場次、組別和題目都是示範資料，請不要加到日曆。' +
  '<div style="margin-top:6px;">正式的信會在每週一 08:00 寄出，內容是當週實際排定的場次。最上方的「一鍵把全部場次加到 Google 日曆」是正式的訂閱連結，現在訂閱之後，場次排定時就會自動出現</div>' +
  '</td></tr></table>';
const TEST_TEXT =
  '這是測試信，不用回覆。下面的場次、組別和題目都是示範資料，請不要加到日曆。正式的信會在每週一 08:00 寄出，內容是當週實際排定的場次。\n\n';

/** The site's demo database: the same migrations, seed and demo data as
 *  demo mode (read from src/db/sql.ts, so the list is never copied). */
async function demoDb(room) {
  const { PGlite } = await import('@electric-sql/pglite');
  const src = readFileSync(new URL('../src/db/sql.ts', import.meta.url), 'utf8');
  const files = Object.fromEntries([...src.matchAll(/^import (\w+) from '\.\.\/\.\.\/supabase\/(.+?)\?raw';$/gm)].map((m) => [m[1], m[2]]));
  const read = (p) => readFileSync(new URL(`../supabase/${p}`, import.meta.url), 'utf8');
  const q = new PGlite();
  await q.exec(/BOOTSTRAP = `([\s\S]*?)`;/.exec(src)[1]);
  for (const name of /MIGRATIONS = \[([^\]]+)\]/.exec(src)[1].split(',')) await q.exec(read(files[name.trim()]));
  await q.exec(read(files.seed));
  await q.exec(readFileSync(new URL('../src/db/demo.sql', import.meta.url), 'utf8'));
  await q.query('update app.settings set location = $1 where id = 1', [room]);
  return q;
}

const url = databaseUrl();
if (!url) {
  console.error('::error::Add the database password as the SUPABASE_DB_PASSWORD repository secret');
  process.exit(1);
}
if (!dry && (!user || !pass)) {
  console.error('::error::Add GMAIL_USER and GMAIL_APP_PASSWORD (a Gmail app password) as repository secrets, see the admin page 寄信通知');
  process.exit(1);
}

if (process.env.SEND_AT && !dry) {
  const wait = untilTaipei(process.env.SEND_AT);
  if (wait > 0 && wait <= 3600_000) {
    console.log(`waiting ${Math.round(wait / 1000)} s for ${process.env.SEND_AT} Taipei time`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const db = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
await db.connect();
// Monday's email is about the week it starts; Sunday's reminder and preview,
// the coming one; a test, the first week from this one on with sessions (or
// the last)
const from = {
  weekly: 'app.today()',
  remind: 'app.mail_week(app.today())',
  preview: 'app.mail_week(app.today())',
  test: `coalesce((select min(a.d) from app.appointments a where a.status = 'confirmed'
                     and a.d >= app.today() - (extract(isodow from app.today())::int - 1)),
                  (select max(a.d) from app.appointments a where a.status = 'confirmed'), app.today())`,
};
const weekOf = async (q, k) => (await q.query(`select (x - (extract(isodow from x)::int - 1))::text as w from (select ${from[k]} as x) s`)).rows[0].w;
const urls = [site, env.VITE_SUPABASE_URL, env.VITE_SUPABASE_KEY];
let week;
let list;
if (kind === 'test') {
  // the email with every PM's sessions, and only ever to the sending account
  week = await weekOf(db, 'test');
  const m = (await db.query(`select app.mail_message($1::date, '{}', null, $2, $3, $4) as v`, [week, ...urls])).rows[0].v;
  list = [{ ...m, to: user, subject: `【測試】${m.subject}` }];
} else if (kind === 'sample' || kind === 'sample_all') {
  const room = (await db.query('select location from app.settings where id = 1')).rows[0].location;
  const q = await demoDb(room);
  week = await weekOf(q, 'test');
  // demo and real PMs are matched by name; the calendar links get the real
  // feeds, since the site does not know the demo's
  const demo = new Map((await q.query('select id, name, feed from app.teachers')).rows.map((t) => [t.name, t]));
  const real = (await db.query('select id, name, feed from app.teachers')).rows;
  const swap = (str) => real.reduce((acc, t) => (demo.get(t.name)?.feed && t.feed ? acc.split(demo.get(t.name).feed).join(t.feed) : acc), str);
  const people =
    kind === 'sample'
      ? [{ email: user, name: '叁式', teachers: [] }]
      : (await db.query('select email, name, teachers from app.mail_recipients order by id')).rows.filter((r) => !only || r.name === only);
  if (kind === 'sample_all' && only && people.length === 0) {
    console.error(`::error::No recipient is called ${only} on the 寄信通知 page`);
    process.exit(1);
  }
  list = [];
  for (const r of people) {
    const ids = r.teachers.map((id) => demo.get(real.find((t) => t.id === id)?.name)?.id).filter(Boolean);
    const m = (await q.query(`select app.mail_message($1::date, $2::int[], $3, $4, $5, $6) as v`, [week, ids, r.name || null, ...urls])).rows[0].v;
    list.push(
      kind === 'sample'
        ? { ...m, to: r.email, subject: `【範例】${m.subject}`, html: swap(m.html).replace('<!--banner-->', SAMPLE_NOTE), text: swap(m.text) }
        : { ...m, to: r.email, subject: `【測試】${m.subject}`, html: swap(m.html).replace('<!--banner-->', TEST_NOTE), text: TEST_TEXT + swap(m.text) },
    );
  }
} else {
  week = await weekOf(db, kind);
  list = (await db.query('select app.mail_outbox($1, $2::date, $3, $4, $5, $6, $7) as v', [kind, week, ...urls, user ?? null, force])).rows[0].v;
}
console.log(`${kind} email for the week of ${week}: ${list.length} message(s) to send`);

const mailer = dry ? null : nodemailer.createTransport(test ? { jsonTransport: true } : { service: 'gmail', auth: { user, pass } });
let failed = 0;
for (const [i, m] of list.entries()) {
  const label = `#${i + 1} ${m.subject}`;
  if (dry) {
    console.log(`  would send ${label}`);
    continue;
  }
  try {
    await mailer.sendMail({ from: { name: '叁式 30 分鐘 一週三次', address: user }, to: m.to, subject: m.subject, html: m.html, text: m.text });
    if (!['test', 'sample', 'sample_all'].includes(kind)) await db.query('select app.mail_sent($1, $2::date, $3, $4, $5)', [m.kind, m.week, m.to, m.subject, m.count]);
    console.log(`  sent ${label}`);
  } catch (e) {
    failed++;
    console.log(`::error::could not send ${label}: ${hide(e?.message ?? e)}`);
  }
}
await db.end();
process.exit(failed ? 1 : 0);
