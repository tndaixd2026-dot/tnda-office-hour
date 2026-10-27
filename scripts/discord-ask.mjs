// Asks each group in its own Discord channel about the coming week; run by
// .github/workflows/discord.yml.
//
//   KIND=setup  connect the bot: store its public key, point its button
//               presses at supabase/functions/discord, and find each group's
//               channel (from the group's webhook) and whether the bot sees it
//   KIND=ask    setup, then each group's message about the next open week,
//               with the buttons to book or skip it (once per group and week)
//   KIND=refresh  setup, then redraw the messages still open as they stand
//               now (after a change on the site, or to the message's layout)
//   KIND=close  setup, then rewrite the messages of the weeks that have
//               closed: the outcome, no buttons
//   ONLY=2      ask just group 2 (to try it out)
//   DISCORD_BOT_TOKEN                   the bot's token
//   SUPABASE_DB_PASSWORD, POOLER_HOST   or DATABASE_URL directly
//   SEND_AT=12:00  wait for this time in Taipei first (at most an hour)
//   FORCE=1        ask again even if this week's message already went out
//   DRY_RUN=1      say what would be sent, send nothing
//
// The messages are written by app.discord_message in the database. The
// repository and these logs are public: they show group numbers, counts
// and Discord's status codes, never the token, a webhook or a message.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const API = 'https://discord.com/api/v10';
const on = (v) => v === '1' || v === 'true';
const kind = ['ask', 'refresh', 'close'].includes(process.env.KIND) ? process.env.KIND : 'setup';
const dry = on(process.env.DRY_RUN);
const force = on(process.env.FORCE);
const only = /^\d+$/.test(process.env.ONLY?.trim() ?? '') ? Number(process.env.ONLY) : null;
const token = process.env.DISCORD_BOT_TOKEN?.trim();
const env = Object.fromEntries(
  readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const site = process.env.SITE_URL || env.VITE_SITE_URL;
const endpoint = `${env.VITE_SUPABASE_URL}/functions/v1/discord`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** One Discord API call as the bot, waiting out rate limits. */
async function discord(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (https://github.com/tndaixd2026-dot/tnda-office-hour, 1)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (r.status === 429 && attempt < 3) {
      await sleep((data?.retry_after ?? 1) * 1000 + 250);
      continue;
    }
    return { ok: r.ok, status: r.status, data };
  }
}
const why = (res) => `${res.status}${res.data?.code ? `/${res.data.code}` : ''}`;

/** Discord lets a bot post only once it has signed in to the gateway at least once. */
function signIn() {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    const done = (ok) => {
      clearTimeout(timer);
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 20_000);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'linux', browser: 'tnda-office-hour', device: 'tnda-office-hour' } } }));
      } else if (m.t === 'READY') done(true);
      else if (m.op === 9) done(false);
    };
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

if (!token) {
  // the weekly ask is optional: until the secret is there, there is nothing to do
  console.log('::notice::Add the bot token as the DISCORD_BOT_TOKEN repository secret to ask the groups in Discord, see README');
  process.exit(0);
}
const url = databaseUrl();
if (!url) {
  console.error('::error::Add the database password as the SUPABASE_DB_PASSWORD repository secret');
  process.exit(1);
}

const db = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
await db.connect();
let failed = 0;

// ---- setup: the bot, where its button presses go, and the channels ----
const me = await discord('GET', '/applications/@me');
if (!me.ok) {
  console.error(`::error::Discord turned the bot token down (${why(me)}): check the DISCORD_BOT_TOKEN repository secret`);
  process.exit(1);
}
const bot = me.data;
const before = (await db.query('select public_key from app.discord_bot where id = 1')).rows[0]?.public_key;
// the key goes in first: the function checks Discord's test request against it
await db.query('select app.discord_set_bot($1, $2, $3, $4)', [bot.verify_key, bot.name, bot.interactions_endpoint_url === endpoint ? endpoint : null, site]);
let registered = bot.interactions_endpoint_url === endpoint;
if (!registered && bot.interactions_endpoint_url) {
  // another service answers this bot's buttons; taking it over would break that
  console.error('::error::This bot already sends its button presses elsewhere: create a separate Discord application for Office Hour, see README');
  failed++;
} else if (!registered) {
  // the function turns away an unsigned request; anything else means it is not there
  const probe = await fetch(endpoint, { method: 'POST', body: '{}' }).then((r) => r.status, () => 0);
  if (probe !== 401) {
    console.error(`::error::supabase/functions/discord is not deployed (${probe}): add the SUPABASE_ACCESS_TOKEN repository secret and run Test and deploy`);
    failed++;
  } else if (!dry) {
    // the function reads the key at most a minute late
    if (before !== bot.verify_key) await sleep(61_000);
    const res = await discord('PATCH', '/applications/@me', { interactions_endpoint_url: endpoint });
    registered = res.ok && res.data?.interactions_endpoint_url === endpoint;
    if (registered) {
      await db.query('select app.discord_set_bot($1, $2, $3, $4)', [bot.verify_key, bot.name, endpoint, site]);
      console.log('the bot sends its button presses to supabase/functions/discord now');
    } else {
      console.error(`::error::Discord did not accept supabase/functions/discord as the interactions endpoint (${why(res)})`);
      failed++;
    }
  }
}
console.log(`bot: ${bot.name}, button presses ${registered ? 'connected' : 'not connected'}`);

const unseen = [];
let seen = 0;
for (const g of (await db.query('select * from app.discord_webhooks()')).rows) {
  const hook = await fetch(g.webhook).then(async (r) => (r.ok ? r.json() : null), () => null);
  if (!hook?.channel_id) {
    console.log(`::warning::第 ${g.group_no} 組的 Webhook 已失效，請在後台「小組與邀請」重新連結`);
    await db.query('select app.discord_set_channel($1, null, false)', [g.group_id]);
    continue;
  }
  const ch = await discord('GET', `/channels/${hook.channel_id}`);
  await db.query('select app.discord_set_channel($1, $2, $3)', [g.group_id, hook.channel_id, ch.ok]);
  if (ch.ok) seen++;
  else unseen.push(g.group_no);
}
console.log(`channels: the bot sees ${seen}${unseen.length ? `, not group ${unseen.join(', ')}` : ''}`);
if (unseen.length) console.log(`::warning::機器人看不到第 ${unseen.join('、')} 組的頻道：請在那些頻道的權限加入機器人（檢視頻道、傳送訊息）`);

// ---- ask or close ----
if (process.env.SEND_AT && !dry && kind !== 'setup') {
  const wait = untilTaipei(process.env.SEND_AT);
  if (wait > 0 && wait <= 3600_000) {
    console.log(`waiting ${Math.round(wait / 1000)} s for ${process.env.SEND_AT} Taipei time`);
    await sleep(wait);
  }
}

if (kind === 'ask') {
  if (!registered && !dry) {
    console.error('::error::Not asking: the buttons would not work until the bot is connected (see above)');
    process.exit(1);
  }
  const rows = (await db.query('select * from app.discord_outbox($1, $2)', [force, only])).rows;
  if (rows.length && !dry && !(await signIn())) console.log('::warning::Could not sign the bot in to the Discord gateway; posting anyway');
  let sent = 0;
  for (const r of rows) {
    if (dry) {
      console.log(`第 ${r.group_no} 組：would ask (${r.payload.components[0]?.components.length ?? 0} buttons)`);
      continue;
    }
    const res = await discord('POST', `/channels/${r.channel_id}/messages`, r.payload);
    if (res.ok) {
      await db.query('select app.discord_posted($1, $2, $3, $4)', [r.group_id, r.week_id, r.channel_id, res.data.id]);
      sent++;
    } else {
      console.error(`::error::第 ${r.group_no} 組：Discord 沒有收下訊息（${why(res)}）`);
      failed++;
    }
  }
  console.log(`asked ${sent} of ${rows.length} groups`);
}

if (kind === 'refresh') {
  const rows = (await db.query('select * from app.discord_refreshing()')).rows;
  let done = 0;
  for (const r of rows) {
    if (dry) {
      console.log(`第 ${r.group_no} 組：would redraw`);
      continue;
    }
    const { content, components, allowed_mentions } = r.payload;
    const res = await discord('PATCH', `/channels/${r.channel_id}/messages/${r.message_id}`, { content, components, allowed_mentions });
    if (res.ok) done++;
    else {
      console.error(`::error::第 ${r.group_no} 組：Discord 沒有更新訊息（${why(res)}）`);
      failed++;
    }
  }
  console.log(`redrew ${done} of ${rows.length} messages`);
}

if (kind === 'close') {
  const rows = (await db.query('select * from app.discord_closing()')).rows;
  let done = 0;
  for (const r of rows) {
    if (dry) {
      console.log(`第 ${r.group_no} 組：would close`);
      continue;
    }
    const { content, components, allowed_mentions } = r.payload;
    const res = await discord('PATCH', `/channels/${r.channel_id}/messages/${r.message_id}`, { content, components, allowed_mentions });
    // a message someone deleted has nothing left to close
    if (res.ok || res.status === 404) {
      await db.query('select app.discord_closed($1)', [r.post_id]);
      done++;
    } else {
      console.error(`::error::第 ${r.group_no} 組：Discord 沒有更新訊息（${why(res)}）`);
      failed++;
    }
  }
  console.log(`closed ${done} of ${rows.length} messages`);
}

await db.end();
process.exit(failed ? 1 : 0);
