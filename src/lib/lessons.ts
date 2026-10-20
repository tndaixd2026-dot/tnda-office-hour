// The TD 專班 timetable: grouping, colours and the schedule.json format.
import type { Lesson, LessonInfo, LessonUnit } from '../api/types';
import { addDays, instant, isoDow, minutes, toUTC } from './time';

/** Teachers in order of their first lesson; the index picks a colour. */
export function teacherList(lessons: Lesson[]): string[] {
  const out: string[] = [];
  for (const l of lessons) if (!out.includes(l.teacher)) out.push(l.teacher);
  return out;
}

/** Colour class for a teacher (four colours, then they repeat). */
export function teacherClass(teachers: string[], name: string): string {
  return `tc${Math.max(0, teachers.indexOf(name)) % 4}`;
}

export function monday(d: string): string {
  return addDays(d, 1 - isoDow(d));
}

export interface LessonWeek {
  /** Monday */
  start: string;
  /** 1 = the week of the first lesson */
  no: number;
  lessons: Lesson[];
}

/** Lessons by week, numbered from the week of `first` (the first lesson overall). */
export function byWeek(lessons: Lesson[], first = lessons[0]?.date): LessonWeek[] {
  const base = first ? monday(first) : '';
  const weeks = new Map<string, LessonWeek>();
  for (const l of lessons) {
    const start = monday(l.date);
    let w = weeks.get(start);
    if (!w) {
      w = { start, no: Math.round((toUTC(start) - toUTC(base)) / (7 * 86400000)) + 1, lessons: [] };
      weeks.set(start, w);
    }
    w.lessons.push(l);
  }
  return [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export function lessonStart(l: Lesson, tz: string): number {
  return instant(l.date, l.start, tz);
}

export function lessonEnd(l: Lesson, tz: string): number {
  return instant(l.date, l.end, tz);
}

/** The lesson on now, or else the next one. */
export function nextLesson(lessons: Lesson[], now: number, tz: string): Lesson | undefined {
  return lessons.find((l) => lessonEnd(l, tz) > now);
}

/** Every day shown for a month ('YYYY-MM'): Monday before the 1st to Sunday after the last. */
export function monthDays(ym: string): string[] {
  const first = `${ym}-01`;
  const [y, m] = ym.split('-').map(Number);
  const last = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
  const out: string[] = [];
  for (let d = monday(first); d <= addDays(last, 7 - isoDow(last)); d = addDays(d, 1)) out.push(d);
  return out;
}

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1 → 一, 10 → 十, 12 → 十二, 21 → 二十一 (as app.cn_num) */
export function cnNum(n: number): string {
  if (n >= 1 && n <= 9) return CN[n];
  if (n === 10) return '十';
  if (n >= 11 && n <= 19) return `十${CN[n - 10]}`;
  if (n >= 20 && n <= 99) return `${CN[Math.floor(n / 10)]}十${CN[n % 10]}`;
  return String(n);
}

/** "基礎教學（一）" */
export function unitLabel(u: Pick<LessonUnit, 'type' | 'no'>): string {
  return `${u.type}（${cnNum(u.no)}）`;
}

/** "（一）" */
export function unitNo(u: Pick<LessonUnit, 'no'>): string {
  return `（${cnNum(u.no)}）`;
}

export function unitOf(l: Lesson, units: LessonUnit[]): LessonUnit | undefined {
  return l.unit == null ? undefined : units.find((u) => u.id === l.unit);
}

/** "基礎教學（一）", or just the type when the lesson is in no unit. */
export function lessonKind(l: Lesson, u?: LessonUnit): string {
  return u ? unitLabel(u) : l.type;
}

/** What a lesson is called on its own: the unit's topic, then its own title. */
export function lessonTitle(l: Lesson, u?: LessonUnit): string {
  return [u?.title, l.title].filter(Boolean).join('｜');
}

/** A calendar event's title, as the feed writes it (app.lesson_summary). */
export function lessonSummary(l: Lesson, u?: LessonUnit): string {
  return `TD ${lessonKind(l, u)}${u?.title ?? ''} · ${l.teacher}${l.title ? `｜${l.title}` : ''}`;
}

/** A calendar event's description, as the feed writes it (app.lesson_details). */
export function lessonDetails(l: Lesson, u?: LessonUnit): string {
  return [u && unitLabel(u) + u.title, u?.topic, l.title, l.topic, `講師：${l.teacher}　類型：${l.type}`].filter(Boolean).join('\n\n');
}

/** The whole timetable as a schedule.json document (importable again). */
export function scheduleJson(info: LessonInfo, types: string[], lessons: Lesson[], units: LessonUnit[] = []) {
  return {
    title: info.title,
    subtitle: info.subtitle,
    place: info.place,
    note: info.note,
    types,
    units: units.map(({ type, no, title, topic }) => ({ type, no, title, topic })),
    sessions: lessons.map((l) => {
      const { date, start, end, teacher, type, title, topic } = l;
      return { date, start, end, teacher, type, unit: unitOf(l, units)?.no ?? null, title, topic };
    }),
  };
}

/** Whole hours that cover every lesson, for the week grid: [first, last). */
export function hourRange(lessons: Lesson[]): [number, number] {
  if (!lessons.length) return [9, 18];
  const from = Math.min(...lessons.map((l) => minutes(l.start)));
  const to = Math.max(...lessons.map((l) => minutes(l.end)));
  return [Math.floor(from / 60), Math.ceil(to / 60)];
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A link that opens Google Calendar with this one lesson filled in. */
export function googleCalendarUrl(l: Lesson, tz: string, place: string, unit?: LessonUnit): string {
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', lessonSummary(l, unit));
  u.searchParams.set('dates', `${utcStamp(lessonStart(l, tz))}/${utcStamp(lessonEnd(l, tz))}`);
  u.searchParams.set('details', lessonDetails(l, unit));
  if (place) u.searchParams.set('location', place);
  return u.toString();
}
