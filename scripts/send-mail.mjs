// Sends the weekly Office Hour email; run by .github/workflows/mail.yml.
//
//   KIND=weekly   each recipient gets this week's sessions (Monday)
//   KIND=preview  the admins' mailbox gets all of it first (Sunday)
//   KIND=test     this week's email with every PM's sessions, only to the
//                 sending account itself; nothing is logged
//   SUPABASE_DB_PASSWORD, POOLER_HOST   or DATABASE_URL directly
//   GMAIL_USER, GMAIL_APP_PASSWORD      the account that sends
//   SEND_AT=09:00  wait for this time in Taipei first (at most an hour)
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
const kind = ['preview', 'test'].includes(process.env.KIND) ? process.env.KIND : 'weekly';
const dry = on(process.env.DRY_RUN);
const force = on(process.env.FORCE);
const test = on(process.env.MAIL_TEST);
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
// Monday's email (and a test) is about the week it starts; Sunday's preview, the coming one
const week = (
  await db.query(
    `select (case when $1 <> 'preview' then app.today() - (extract(isodow from app.today())::int - 1)
                  else app.mail_week(app.today()) end)::text as w`,
    [kind],
  )
).rows[0].w;
const urls = [site, env.VITE_SUPABASE_URL, env.VITE_SUPABASE_KEY];
let list;
if (kind === 'test') {
  // the email with every PM's sessions, and only ever to the sending account
  const m = (await db.query(`select app.mail_message($1::date, '{}', null, $2, $3, $4) as v`, [week, ...urls])).rows[0].v;
  list = [{ ...m, to: user, subject: `【測試】${m.subject}` }];
} else {
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
    if (kind !== 'test') await db.query('select app.mail_sent($1, $2::date, $3, $4, $5)', [m.kind, m.week, m.to, m.subject, m.count]);
    console.log(`  sent ${label}`);
  } catch (e) {
    failed++;
    console.log(`::error::could not send ${label}: ${hide(e?.message ?? e)}`);
  }
}
await db.end();
process.exit(failed ? 1 : 0);
