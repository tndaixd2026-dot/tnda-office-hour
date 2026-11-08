// The TD 專班's weekly round, run by .github/workflows/td-weekly.yml. The
// timetable lives in the TNDA Notion (database 連我阿公都會TD); the teachers
// edit it there and tick 老師確認 for each lesson.
//
//   KIND=teachers  Saturday 08:00, technical group: each teacher's lessons
//                  next week, with links to check them, and their hours
//   KIND=remind    Sunday 12:00, technical group: lessons still unconfirmed
//   KIND=announce  Sunday 20:00, announcements: next week for the students,
//                  with the files uploaded to Notion attached; held back
//                  (and the TA told) while a lesson is unconfirmed
//   KIND=sync      the site's TD timetable (and its calendar feed) follows
//                  Notion; every other kind does this first as well
//   KIND=check     reads everything and reports counts; posts nothing
//
//   NOTION_TOKEN                the integration 「TD 課表小幫手」
//   DISCORD_TECH_WEBHOOK, DISCORD_ANNOUNCE_WEBHOOK
//   SUPABASE_DB_PASSWORD, POOLER_HOST   or DATABASE_URL, for sync
//   SEND_AT=20:00   wait for this time in Taipei first (at most an hour)
//   START=2026-11-14  scheduled posts start on this date (sync runs anyway)
//   TEST=1          post to the technical group, marked as a test, without
//                   mentions, and mark nothing as announced
//   FORCE=1         announce even with unconfirmed lessons, or again
//   PRINT=1         print the messages instead of posting (local use only:
//                   the Actions logs are public and messages show hours)
//   LESSONS=file    read the lessons from a JSON file instead of Notion
//
// The logs show counts only: never webhooks, hours or message text.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  DATA_SOURCE,
  announceMessage,
  applySync,
  holdMessage,
  hostedFiles,
  inWeek,
  nextWeek,
  parsePage,
  remindMessage,
  syncPlan,
  taipeiToday,
  teachersMessage,
} from './td-weekly-lib.ts';

const on = (v) => v === '1' || v === 'true';
const kind = ['teachers', 'remind', 'announce', 'sync', 'check'].includes(process.env.KIND) ? process.env.KIND : 'check';
const test = on(process.env.TEST);
const force = on(process.env.FORCE);
const print = on(process.env.PRINT);
const now = process.env.FAKE_TIME ? new Date(process.env.FAKE_TIME) : new Date();
const env = Object.fromEntries(
  readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const site = env.VITE_SITE_URL;
const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? 'tndaixd2026-dot/tnda-office-hour'}/actions/workflows/td-weekly.yml`;
const hooks = { tech: process.env.DISCORD_TECH_WEBHOOK?.trim(), announce: process.env.DISCORD_ANNOUNCE_WEBHOOK?.trim() };
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`::error::${msg}`);
};

if (process.env.START && kind !== 'sync' && taipeiToday(now) < process.env.START) {
  console.log(`scheduled runs start on ${process.env.START}; nothing to do`);
  process.exit(0);
}

// ---------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------

async function notion(path, body, method = 'POST') {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) throw new Error('Add the Notion integration secret as the NOTION_TOKEN repository secret');
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const hint = r.status === 404 ? '（資料庫要在 Notion 的「•••」→「連接」加上 TD 課表小幫手）' : '';
    throw new Error(`Notion ${r.status} ${j.code ?? ''}${hint}`);
  }
  return j;
}

async function lessons() {
  if (process.env.LESSONS) return JSON.parse(readFileSync(process.env.LESSONS, 'utf8'));
  const pages = [];
  let cursor;
  do {
    const j = await notion(`/data_sources/${DATA_SOURCE}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...j.results.filter((p) => p.object === 'page' && !p.in_trash && !p.archived));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return pages.map(parsePage);
}

// ---------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------

async function post(where, payload, files = []) {
  if (print) {
    console.log(`----- ${where}${files.length ? ` (+${files.length} file(s): ${files.map((f) => f.name).join(', ')})` : ''}\n${payload.content}`);
    return;
  }
  const hook = hooks[where];
  if (!hook) throw new Error(`Add the ${where === 'tech' ? 'DISCORD_TECH_WEBHOOK' : 'DISCORD_ANNOUNCE_WEBHOOK'} repository secret`);
  const url = `${hook}${hook.includes('?') ? '&' : '?'}wait=true`;
  const init = () => {
    if (!files.length) return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data]), f.name));
    return { method: 'POST', body: fd };
  };
  for (let tries = 0; ; tries++) {
    const r = await fetch(url, init());
    if (r.status === 429 && tries < 3) {
      const j = await r.json().catch(() => ({}));
      await new Promise((ok) => setTimeout(ok, Math.ceil((j.retry_after ?? 2) * 1000)));
      continue;
    }
    if (!r.ok) throw new Error(`Discord ${r.status}`);
    return;
  }
}

const postAll = async (where, list) => {
  for (const p of list) await post(where, p);
};

// Discord takes 10 MB a message without server boosts
const MAX = 9.5 * 1024 * 1024;

async function sendFiles(where, list) {
  const tooBig = [];
  for (const { label, files } of hostedFiles(list, now)) {
    const got = [];
    for (const f of files) {
      try {
        const r = await fetch(f.url);
        if (!r.ok) throw new Error(String(r.status));
        const data = new Uint8Array(await r.arrayBuffer());
        if (data.length > MAX) tooBig.push(`${label}：${f.name}（${(data.length / 1048576).toFixed(1)} MB）`);
        else got.push({ name: f.name, data });
      } catch (e) {
        fail(`could not download a file of a lesson: ${e.message}`);
        tooBig.push(`${label}：${f.name}（下載失敗）`);
      }
    }
    // as few messages as fit: at most ten files and MAX bytes each
    let batch = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await post(where, { content: `📎 **${label}**`, allowed_mentions: { parse: [] } }, batch);
      batch = [];
      size = 0;
    };
    for (const f of got) {
      if (batch.length === 10 || size + f.data.length > MAX) await flush();
      batch.push(f);
      size += f.data.length;
    }
    await flush();
  }
  return tooBig;
}

// ---------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(env.VITE_SUPABASE_URL ?? '')?.[1];
  if (!pw || !ref) return null;
  return `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@${process.env.POOLER_HOST}:5432/postgres`;
}

async function siteState() {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/rpc/oh_lessons`, {
    method: 'POST',
    headers: { apikey: env.VITE_SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`oh_lessons ${r.status}`);
  return r.json();
}

async function sync(list, apply) {
  const state = await siteState();
  const plan = syncPlan(list, state.lessons);
  console.log(
    `site timetable from ${plan.from ?? '-'}: ${plan.deletes.length} to remove, ${plan.saves.filter((s) => s.id).length} to change, ` +
      `${plan.saves.filter((s) => !s.id).length} to add, ${plan.skipped.length} Notion row(s) skipped`,
  );
  if (!apply || (!plan.deletes.length && !plan.saves.length)) return state;
  const url = databaseUrl();
  if (!url) throw new Error('Add the database password as the SUPABASE_DB_PASSWORD repository secret');
  const db = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await db.connect();
  try {
    await applySync(db, plan, randomBytes(32).toString('hex'));
  } finally {
    await db.end();
  }
  console.log('site timetable updated');
  return state;
}

// ---------------------------------------------------------------------

function untilTaipei(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date(now.getTime() + 8 * 3600_000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, m) - 8 * 3600_000 - now.getTime();
}
if (process.env.SEND_AT && !print) {
  const wait = untilTaipei(process.env.SEND_AT);
  if (wait > 0 && wait <= 3600_000) {
    console.log(`waiting ${Math.round(wait / 1000)} s for ${process.env.SEND_AT} Taipei time`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const list = await lessons();
const week = nextWeek(now);
const next = inWeek(list, week);
console.log(
  `${kind}${test ? ' (test)' : ''}: ${list.length} Notion row(s), ${list.filter((l) => l.date).length} with a date; ` +
    `next week ${week.from}–${week.to}: ${next.length} lesson(s), ${next.filter((l) => l.confirmed).length} confirmed, ` +
    `${next.reduce((n, l) => n + l.files.length, 0)} file(s)`,
);

let place = '';
try {
  place = (await sync(list, kind !== 'check' && !print && !process.env.LESSONS)).info?.place ?? '';
} catch (e) {
  fail(`could not update the site's timetable: ${e.message}`);
}

const where = (w) => (test ? 'tech' : w);
try {
  if (kind === 'check') {
    for (const [name, hook] of Object.entries(hooks)) {
      if (!hook) fail(`the ${name} webhook secret is missing`);
      else {
        const r = await fetch(hook);
        if (r.ok) console.log(`${name} webhook: ok`);
        else fail(`the ${name} webhook answered ${r.status}`);
      }
    }
  } else if (kind === 'teachers') {
    const m = teachersMessage(list, now, test);
    await postAll(where('tech'), m);
    console.log(`posted ${m.length} message(s)`);
  } else if (kind === 'remind') {
    const m = remindMessage(list, now, test);
    await postAll(where('tech'), m);
    console.log(m.length ? `posted ${m.length} message(s)` : 'every lesson next week is confirmed; nothing to post');
  } else if (kind === 'announce') {
    if (!force && next.length && next.every((l) => l.announced)) {
      console.log('next week was announced already; run with force to post again');
    } else if (!force && next.some((l) => !l.confirmed)) {
      const m = holdMessage(list, now, runUrl, test);
      await postAll('tech', m);
      console.log('held back: some lessons are unconfirmed; told the technical group');
    } else {
      const m = announceMessage(list, now, { place, site, test });
      await postAll(where('announce'), m);
      const tooBig = await sendFiles(where('announce'), list);
      if (tooBig.length) {
        await post('tech', {
          content: `${test ? '【測試訊息，不用理會】\n' : ''}**這些檔案沒辦法放上公告欄**，請放到雲端資料夾，再把連結貼到公告欄\n${tooBig.map((s) => `・${s}`).join('\n')}`,
          allowed_mentions: { parse: [] },
        });
      }
      if (!test && !print && !process.env.LESSONS) {
        for (const l of next) await notion(`/pages/${l.id}`, { properties: { 已公告: { checkbox: true } } }, 'PATCH');
      }
      console.log(`announced ${next.length} lesson(s) in ${m.length} message(s); ${tooBig.length} file(s) too big`);
    }
  }
} catch (e) {
  fail(e.message);
}
process.exit(failed ? 1 : 0);
