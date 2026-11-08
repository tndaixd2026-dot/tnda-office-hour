// The TD 專班's weekly round, worked out from the teachers' Notion
// timetable (database 連我阿公都會TD, data source 備課表). Pure functions,
// so tests can run them; scripts/td-weekly.mjs does the fetching and posting.
//
// Only erasable TypeScript here: Node runs this file as it is.

export interface TdFile {
  name: string;
  url: string;
  /** uploaded to Notion: its link expires within the hour, so it is attached */
  hosted: boolean;
  field: '簡報' | '示範檔';
}

export interface TdLesson {
  id: string;
  url: string;
  teacher: string;
  title: string;
  date: string | null;
  start: string | null;
  end: string | null;
  hours: number;
  type: string | null;
  outline: string;
  files: TdFile[];
  confirmed: boolean;
  announced: boolean;
}

export interface Payload {
  content: string;
  allowed_mentions: { parse: string[]; users?: string[] };
  flags?: number;
}

export const TEACHERS: Record<string, string> = {
  哲瑜: '964735370061312011',
  浡崴: '556755936367083520',
};
export const HOURS = 42;
export const NOTION_DB = 'https://www.notion.so/29b0710b322083649c3901c10bf13e64';
export const DATA_SOURCE = '6d30710b-3220-825f-9ed7-07450da492d3';
const KINDS = ['基礎教學', '案例分享', '駐村創作'];
const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const LIMIT = 1900; // Discord allows 2000 characters a message
const SUPPRESS_EMBEDS = 4;

// ---------------------------------------------------------------------
// Notion pages
// ---------------------------------------------------------------------

const text = (p: any): string => (p?.title ?? p?.rich_text ?? []).map((t: any) => t.plain_text ?? '').join('').trim();

function files(p: any, field: TdFile['field']): TdFile[] {
  return (p?.files ?? [])
    .map((f: any): TdFile | null => {
      const url = f.type === 'external' ? f.external?.url : f.file?.url;
      return url ? { name: f.name || '檔案', url, hosted: f.type !== 'external', field } : null;
    })
    .filter(Boolean) as TdFile[];
}

/** "21:00–22:00" → ["21:00", "22:00"]; just a start time means an hour. */
export function parseTime(s: string): [string, string] | null {
  const pad = (h: string, m: string) => `${h.padStart(2, '0')}:${m}`;
  const m = /(\d{1,2})[:：](\d{2})(?:\s*[-–—~～至到]\s*(\d{1,2})[:：](\d{2}))?/.exec(s);
  if (!m) return null;
  const start = pad(m[1], m[2]);
  const end = m[3] ? pad(m[3], m[4]) : pad(String(Number(m[1]) + 1), m[2]);
  return end > start ? [start, end] : null;
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

export function parsePage(page: any): TdLesson {
  const p = page.properties ?? {};
  const time = parseTime(text(p['課程時間']));
  const slides = p['簡報網址']?.url as string | null | undefined;
  return {
    id: page.id,
    url: page.url,
    teacher: p['講師']?.select?.name ?? '',
    title: text(p['課程名稱']),
    date: p['上課日期']?.date?.start?.slice(0, 10) ?? null,
    start: time?.[0] ?? null,
    end: time?.[1] ?? null,
    hours: time ? (minutes(time[1]) - minutes(time[0])) / 60 : 1,
    type: p['類型']?.select?.name ?? null,
    outline: text(p['課程大綱']),
    files: [
      ...(slides ? [{ name: '簡報', url: slides, hosted: false, field: '簡報' as const }] : []),
      ...files(p['簡報連結'], '簡報'),
      ...files(p['示範檔'], '示範檔'),
    ],
    confirmed: p['老師確認']?.checkbox === true,
    announced: p['已公告']?.checkbox === true,
  };
}

// ---------------------------------------------------------------------
// Dates, all in Taipei
// ---------------------------------------------------------------------

export function taipeiToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Monday to Sunday of the week after this one. */
export function nextWeek(now: Date): { from: string; to: string } {
  const today = taipeiToday(now);
  const iso = dow(today) || 7;
  const from = addDays(today, 8 - iso);
  return { from, to: addDays(from, 6) };
}

/** "11/16（一）" */
export function day(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${DOW[dow(date)]}）`;
}

const endsBefore = (l: TdLesson, now: Date) =>
  !!l.date && new Date(`${l.date}T${l.end ?? '23:59'}:00+08:00`).getTime() <= now.getTime();

const order = (a: TdLesson, b: TdLesson) =>
  `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`) || a.teacher.localeCompare(b.teacher);

export function inWeek(list: TdLesson[], week: { from: string; to: string }): TdLesson[] {
  return list.filter((l) => l.date && l.date >= week.from && l.date <= week.to).sort(order);
}

export function teachersOf(list: TdLesson[]): string[] {
  const names = new Set(list.map((l) => l.teacher).filter(Boolean));
  return [...Object.keys(TEACHERS), ...[...names].filter((t) => !(t in TEACHERS))];
}

export function hours(list: TdLesson[], teacher: string, now: Date) {
  const mine = list.filter((l) => l.teacher === teacher);
  const dated = mine.filter((l) => l.date);
  const sum = (xs: TdLesson[]) => xs.reduce((n, l) => n + l.hours, 0);
  return { done: sum(dated.filter((l) => endsBefore(l, now))), planned: sum(dated), undated: mine.length - dated.length };
}

const num = (n: number) => String(Math.round(n * 10) / 10);

// ---------------------------------------------------------------------
// Discord messages
// ---------------------------------------------------------------------

const range = (week: { from: string; to: string }) => `${day(week.from)} – ${day(week.to)}`;
const time = (l: TdLesson) => (l.start ? `${l.start}–${l.end}` : '時間未填');
const link = (l: TdLesson) => `[${clip(l.title || '未命名', 60).replace(/[[\]]/g, '')}](<${l.url}>)`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const who = (teacher: string, test: boolean) => (TEACHERS[teacher] && !test ? `<@${TEACHERS[teacher]}>` : `@${teacher}`);

/** Splits into messages of at most LIMIT characters, at block boundaries. */
export function pack(blocks: string[], extra: Omit<Payload, 'content'>): Payload[] {
  const out: string[] = [];
  let cur = '';
  for (const b of blocks.map((x) => clip(x, LIMIT))) {
    if (cur && cur.length + 2 + b.length > LIMIT) {
      out.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out.map((content) => ({ content, ...extra }));
}

function mentions(teachers: string[], test: boolean) {
  const users = test ? [] : teachers.map((t) => TEACHERS[t]).filter(Boolean);
  return { allowed_mentions: { parse: [] as string[], users }, flags: SUPPRESS_EMBEDS };
}

const TEST = '【測試訊息，不用理會】';

/** Saturday 08:00, technical group: each teacher checks next week. */
export function teachersMessage(list: TdLesson[], now: Date, test = false): Payload[] {
  const week = nextWeek(now);
  const next = inWeek(list, week);
  const names = teachersOf(list);
  const blocks = [
    `${test ? TEST + '\n' : ''}**TD 下週課表確認｜${range(week)}**\n` +
      '請在**週日 18:00 前**到 Notion 看一下自己下週的課\n' +
      '・沒問題：每一堂勾「老師確認」\n' +
      '・要調整：直接在 Notion 改日期、時間或內容，改好再勾\n' +
      '・簡報和示範檔：上傳到那一堂的「簡報連結」「示範檔」，或把雲端連結貼在「簡報網址」\n' +
      '週日 20:00 會把下週課表和檔案發到公告欄',
  ];
  for (const t of names) {
    const mine = next.filter((l) => l.teacher === t);
    const h = hours(list, t, now);
    const left = HOURS - h.planned;
    const lines = mine.map(
      (l) => `・${day(l.date!)} ${time(l)} ${link(l)}｜${l.type ?? '類型未填'}｜${l.confirmed ? '✅ 已確認' : '⬜ 待確認'}` +
        (l.files.length ? `｜📎 ${l.files.length}` : ''),
    );
    blocks.push(
      `**${t}** ${who(t, test)}\n` +
        (lines.length ? lines.join('\n') : '・下週沒有課') +
        `\n時數：已上 ${num(h.done)}・已排 ${num(h.planned)}・總共 ${HOURS} 小時` +
        (left > 0 ? `（還有 ${num(left)} 小時沒排）` : left < 0 ? `（多排了 ${num(-left)} 小時）` : '') +
        (h.undated ? `\n另外有 ${h.undated} 堂還沒有日期` : ''),
    );
  }
  blocks.push(`Notion 課表：<${NOTION_DB}>`);
  return pack(blocks, mentions(names, test));
}

/** Sunday 12:00, technical group: only the lessons not yet confirmed. */
export function remindMessage(list: TdLesson[], now: Date, test = false): Payload[] {
  const week = nextWeek(now);
  const open = inWeek(list, week).filter((l) => !l.confirmed);
  if (!open.length) return [];
  const names = [...new Set(open.map((l) => l.teacher))];
  const blocks = [`${test ? TEST + '\n' : ''}**TD 下週還沒確認的課｜${range(week)}**\n請在今天 18:00 前到 Notion 勾「老師確認」，要調整的話直接改`];
  for (const t of names) {
    const mine = open.filter((l) => l.teacher === t);
    blocks.push(`${who(t, test)} 還有 ${mine.length} 堂\n` + mine.map((l) => `・${day(l.date!)} ${time(l)} ${link(l)}`).join('\n'));
  }
  return pack(blocks, mentions(names, test));
}

/** Sunday 20:00, when lessons are still unconfirmed: the TA decides. */
export function holdMessage(list: TdLesson[], now: Date, runUrl: string, test = false): Payload[] {
  const open = inWeek(list, nextWeek(now)).filter((l) => !l.confirmed);
  return pack(
    [
      `${test ? TEST + '\n' : ''}**TD 下週課表先不發到公告欄**：還有 ${open.length} 堂老師沒確認\n` +
        open.map((l) => `・${day(l.date!)} ${time(l)} ${l.teacher} ${link(l)}`).join('\n'),
      `確認好之後，助教打開 <${runUrl}>，按「Run workflow」，種類選 announce 再按綠色按鈕，就會發出`,
    ],
    { allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS },
  );
}

/** Sunday 20:00, announcements: next week for the students. The files
 *  uploaded to Notion follow in their own messages (see hostedFiles). */
export function announceMessage(list: TdLesson[], now: Date, opts: { place: string; site: string; test?: boolean }): Payload[] {
  const week = nextWeek(now);
  const next = inWeek(list, week);
  const head =
    `${opts.test ? TEST + '\n' : ''}## TD 專班下週課表\n**${range(week)}**` +
    (opts.place ? `\n全部在 Google Meet 上課：${opts.place}` : '');
  const blocks = [head];
  if (!next.length) blocks.push('下週沒有課');
  for (const l of next) {
    const outline = l.outline
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((s) => `> ${clip(s, 80)}`)
      .join('\n');
    const linked = l.files.filter((f) => !f.hosted).map((f) => `[${f.field === '簡報' && f.name === '簡報' ? '簡報' : clip(f.name, 40)}](<${f.url}>)`);
    const hosted = l.files.filter((f) => f.hosted);
    blocks.push(
      `**${day(l.date!)} ${time(l)}｜${l.teacher}｜${l.type ?? ''}**\n${clip(l.title, 80)}` +
        (outline ? `\n${outline}` : '') +
        (linked.length ? `\n📎 ${linked.join('・')}` : '') +
        (hosted.length ? `\n📎 ${hosted.map((f) => f.name).join('・')}（檔案在下面，請先下載）` : ''),
    );
  }
  blocks.push(`完整課表、加到 Google 日曆：<${opts.site}#/td>`);
  return pack(blocks, { allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS });
}

/** The uploaded files of next week's lessons, grouped by lesson. */
export function hostedFiles(list: TdLesson[], now: Date): { label: string; files: TdFile[] }[] {
  return inWeek(list, nextWeek(now))
    .filter((l) => l.files.some((f) => f.hosted))
    .map((l) => ({ label: `${day(l.date!)} ${l.teacher}｜${clip(l.title, 60)}`, files: l.files.filter((f) => f.hosted) }));
}

// ---------------------------------------------------------------------
// The site's TD timetable follows Notion
// ---------------------------------------------------------------------

export interface SiteLesson {
  id?: number;
  date: string;
  start: string;
  end: string;
  teacher: string;
  type: string;
  title: string;
  topic: string;
  confirmed?: boolean;
}

export interface SyncPlan {
  from: string | null;
  deletes: number[];
  saves: SiteLesson[];
  skipped: string[];
}

// the database's app.clean and app.clean_multiline, so an unchanged lesson
// compares equal and is left alone
const one = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const multi = (s: string) =>
  s
    .replace(/\r\n/g, '\n')
    .replace(/[\u0001-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '');

const key = (l: { date: string; start: string; teacher: string }) => `${l.date} ${l.start} ${l.teacher}`;

/** What to change on the site so its lessons from the first Notion date on
 *  match Notion's. A lesson keeps its id (and so its calendar event and
 *  unit) when its date, start and teacher stay the same. */
export function syncPlan(notion: TdLesson[], site: SiteLesson[]): SyncPlan {
  const skipped: string[] = [];
  const want = new Map<string, SiteLesson>();
  for (const l of [...notion].sort(order)) {
    if (!l.date) continue;
    const label = `${l.date} ${l.teacher} ${l.title}`;
    if (!l.start || !l.end || !l.teacher) {
      skipped.push(`${label}：沒有時間或講師`);
      continue;
    }
    const v: SiteLesson = {
      date: l.date,
      start: l.start,
      end: l.end,
      teacher: clip(one(l.teacher), 20),
      type: l.type && KINDS.includes(l.type) ? l.type : '基礎教學',
      title: clip(one(l.title), 80),
      topic: multi(clip(multi(l.outline), 1000)),
      confirmed: l.confirmed,
    };
    if (want.has(key(v))) {
      skipped.push(`${label}：同一時間重複`);
      continue;
    }
    want.set(key(v), v);
  }
  const from = [...want.values()].reduce<string | null>((m, l) => (m === null || l.date < m ? l.date : m), null);
  if (from === null) return { from, deletes: [], saves: [], skipped };
  const deletes: number[] = [];
  const saves: SiteLesson[] = [];
  const kept = new Set<string>();
  for (const s of site.filter((x) => x.date >= from)) {
    const w = want.get(key(s));
    if (!w || kept.has(key(s))) {
      deletes.push(s.id!);
      continue;
    }
    kept.add(key(s));
    if (w.end !== s.end || w.type !== s.type || w.title !== s.title || w.topic !== s.topic || w.confirmed !== s.confirmed) {
      saves.push({ ...w, id: s.id });
    }
  }
  for (const [k, w] of want) if (!kept.has(k)) saves.push(w);
  saves.sort((a, b) => (a.id === undefined ? 1 : 0) - (b.id === undefined ? 1 : 0));
  return { from, deletes, saves, skipped };
}

interface Q {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Applies a plan as an admin called 「Notion 同步」, all or nothing. The
 *  session exists only inside the transaction. */
export async function applySync(db: Q, plan: SyncPlan, token: string): Promise<void> {
  if (!plan.deletes.length && !plan.saves.length) return;
  await db.query('begin');
  try {
    const { rows } = await db.query(
      `insert into app.sessions (token_hash, role, admin_id, name)
       select app.hash_token($1), 'admin', a.id, 'Notion 同步' from app.admins a where a.active order by a.id limit 1
       returning id`,
      [token],
    );
    if (!rows.length) throw new Error('no active admin');
    for (const id of plan.deletes) await db.query('select public.oh_admin_lesson_delete($1, $2)', [token, id]);
    for (const s of plan.saves) await db.query('select public.oh_admin_lesson_save($1, $2::jsonb)', [token, JSON.stringify(s)]);
    await db.query('delete from app.sessions where id = $1', [rows[0].id]);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
