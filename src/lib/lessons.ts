// The TD 專班 timetable: grouping, colours and the schedule.json format.
import type { Lesson, LessonInfo } from '../api/types';
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

/** The whole timetable as a schedule.json document (importable again). */
export function scheduleJson(info: LessonInfo, types: string[], lessons: Lesson[]) {
  return {
    title: info.title,
    subtitle: info.subtitle,
    place: info.place,
    note: info.note,
    types,
    sessions: lessons.map(({ date, start, end, teacher, type, title, topic }) => ({ date, start, end, teacher, type, title, topic })),
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
export function googleCalendarUrl(l: Lesson, tz: string, place: string): string {
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', `TD ${l.type} · ${l.teacher}${l.title ? `｜${l.title}` : ''}`);
  u.searchParams.set('dates', `${utcStamp(lessonStart(l, tz))}/${utcStamp(lessonEnd(l, tz))}`);
  u.searchParams.set('details', [l.title, l.topic, `講師：${l.teacher}　類型：${l.type}`].filter(Boolean).join('\n\n'));
  if (place) u.searchParams.set('location', place);
  return u.toString();
}
