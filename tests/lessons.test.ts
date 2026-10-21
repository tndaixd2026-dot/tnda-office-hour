import { beforeAll, describe, expect, it } from 'vitest';
import type { Lesson } from '../src/api/types';
import {
  byWeek,
  cnNum,
  googleCalendarUrl,
  hourRange,
  lessonDetails,
  lessonSummary,
  lessonTitle,
  monthDays,
  nextLesson,
  scheduleJson,
  shiftMonth,
  teacherClass,
  teacherList,
  unitLabel,
  unitOf,
} from '../src/lib/lessons';
import { instant } from '../src/lib/time';
import { MIGRATIONS } from '../src/db/sql';
import { expectCode, makeDb, type TestDb } from './helpers';

describe('TD lesson helpers', () => {
  const L = (id: number, date: string, start: string, teacher: string): Lesson => ({
    id, date, start, end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, teacher, type: '基礎教學', unit: null, title: '', topic: '',
  });
  const list = [L(1, '2026-10-26', '21:00', '浡崴'), L(2, '2026-10-27', '21:00', '哲瑜'), L(3, '2026-11-08', '10:00', '哲瑜'), L(4, '2026-11-09', '21:00', '浡崴')];

  it('numbers weeks from the first lesson, Monday to Sunday', () => {
    const w = byWeek(list);
    expect(w.map((x) => [x.start, x.no, x.lessons.map((l) => l.id)])).toEqual([
      ['2026-10-26', 1, [1, 2]],
      ['2026-11-02', 2, [3]],
      ['2026-11-09', 3, [4]],
    ]);
    // filtered lists keep the semester's numbering
    expect(byWeek([list[3]], list[0].date)[0].no).toBe(3);
  });

  it('lays out whole weeks for a month', () => {
    const nov = monthDays('2026-11');
    expect(nov[0]).toBe('2026-10-26'); // the Monday before 11/1 (a Sunday)
    expect(nov.at(-1)).toBe('2026-12-06');
    expect(nov.length % 7).toBe(0);
    expect(monthDays('2027-02')[0]).toBe('2027-02-01');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
  });

  it('finds the lesson on now, or the next one', () => {
    const tz = 'Asia/Taipei';
    expect(nextLesson(list, instant('2026-10-26', '21:30', tz), tz)?.id).toBe(1);
    expect(nextLesson(list, instant('2026-10-26', '22:00', tz), tz)?.id).toBe(2);
    expect(nextLesson(list, instant('2026-12-01', '00:00', tz), tz)).toBeUndefined();
  });

  it('sizes the week grid and links one lesson to Google Calendar', () => {
    expect(hourRange(list)).toEqual([10, 22]);
    expect(hourRange([])).toEqual([9, 18]);
    const u = new URL(googleCalendarUrl({ ...list[0], title: 'Houdini 入門' }, 'Asia/Taipei', 'https://meet.google.com/x'));
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('dates')).toBe('20261026T130000Z/20261026T140000Z');
    expect(u.searchParams.get('text')).toBe('TD 基礎教學 · 浡崴｜Houdini 入門');
    expect(u.searchParams.get('location')).toBe('https://meet.google.com/x');
  });

  it('gives each teacher a stable colour and exports schedule.json', () => {
    const t = teacherList(list);
    expect(t).toEqual(['浡崴', '哲瑜']);
    expect([teacherClass(t, '浡崴'), teacherClass(t, '哲瑜')]).toEqual(['tc0', 'tc1']);
    const doc = scheduleJson({ title: 'T', subtitle: 'S', place: '', note: '' }, ['基礎教學'], list);
    expect(doc.sessions[0]).toEqual({ date: '2026-10-26', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', unit: null, title: '', topic: '' });
    expect(doc.sessions[0]).not.toHaveProperty('id');
    expect(doc.units).toEqual([]);
  });

  it('numbers units in Chinese and names a lesson by its unit', () => {
    expect([1, 9, 10, 11, 19, 20, 21, 35, 100].map(cnNum)).toEqual(['一', '九', '十', '十一', '十九', '二十', '二十一', '三十五', '100']);
    const unit = { id: 7, type: '基礎教學', no: 2, title: '粒子', topic: '帶筆電' };
    expect(unitLabel(unit)).toBe('基礎教學（二）');
    const l = { ...list[0], unit: 7, title: '補課' };
    expect(unitOf(l, [unit])).toBe(unit);
    expect(unitOf(list[0], [unit])).toBeUndefined();
    expect(lessonTitle(l, unit)).toBe('粒子｜補課');
    expect(lessonTitle(list[0])).toBe('');
    // the same words as the calendar feed
    expect(lessonSummary(l, unit)).toBe('TD 基礎教學（二）粒子 · 浡崴｜補課');
    expect(lessonSummary(list[0])).toBe('TD 基礎教學 · 浡崴');
    expect(lessonDetails(l, unit)).toBe('基礎教學（二）粒子\n\n帶筆電\n\n補課\n\n講師：浡崴　類型：基礎教學');
    const u = new URL(googleCalendarUrl(l, 'Asia/Taipei', '', unit));
    expect(u.searchParams.get('text')).toBe('TD 基礎教學（二）粒子 · 浡崴｜補課');
    expect(u.searchParams.has('location')).toBe(false);
  });
});

const lesson = (extra: Record<string, unknown> = {}) => ({
  date: '2027-01-06',
  start: '21:00',
  end: '22:00',
  teacher: '浡崴',
  type: '基礎教學',
  title: '',
  topic: '',
  ...extra,
});

describe('TD lessons', () => {
  let db: TestDb;
  let admin: string;
  let student: string;
  let teacher: string;

  beforeAll(async () => {
    db = await makeDb();
    await db.setNow('2026-10-19T09:00:00+08:00');
    const c = await db.codes();
    admin = (await db.call('oh_join', { p_code: c.admin })).token;
    student = (await db.call('oh_join', { p_code: c.groups[2], p_name: '小晴' })).token;
    teacher = (await db.call('oh_join', { p_code: c.teachers.Tim })).token;
  });

  it('starts with the planned semester and is readable without signing in', async () => {
    await db.sql('set role anon');
    const r = await db.call('oh_lessons');
    await db.sql('reset role');
    expect(r.info.title).toBe('TD 專班課表');
    expect(r.types).toEqual(['基礎教學', '案例分享', '駐村創作']);
    // the seeded 解惑時間 lessons were renamed along with the type
    expect(r.lessons.filter((l: any) => l.type === '駐村創作')).toHaveLength(24);
    expect(r.lessons).toHaveLength(84);
    expect(r.lessons[0]).toEqual({
      id: r.lessons[0].id, date: '2026-10-26', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', unit: null, title: '', topic: '',
    });
    expect(r.lessons.at(-1).date).toBe('2027-01-02');
    expect(r.clock.today).toBe('2026-10-19');
    // sorted by date and time
    const keys = r.lessons.map((l: any) => l.date + l.start);
    expect([...keys].sort()).toEqual(keys);
  });

  it('lets only admins change it', async () => {
    for (const t of [student, teacher]) {
      await expectCode(db.call('oh_admin_lesson_save', { p_token: t, p: lesson() }), 'FORBIDDEN');
      await expectCode(db.call('oh_admin_lessons_info', { p_token: t, p: { note: 'x' } }), 'FORBIDDEN');
    }
    await expectCode(db.call('oh_admin_lesson_delete', { p_token: 'x'.repeat(64), p_id: 1 }), 'AUTH');
    await expectCode(db.call('oh_admin_lessons_import', { p_token: student, p: { sessions: [] } }), 'FORBIDDEN');
  });

  it('adds, edits and deletes a lesson, cleaning the text', async () => {
    const added = await db.call('oh_admin_lesson_save', {
      p_token: admin,
      p: lesson({ teacher: '  哲瑜 ', title: ' Houdini\t入門 ', topic: '帶筆電\r\n\n\n\n先裝好軟體' }),
    });
    expect(added).toMatchObject({ date: '2027-01-06', start: '21:00', end: '22:00', teacher: '哲瑜', title: 'Houdini 入門', topic: '帶筆電\n\n先裝好軟體' });
    const moved = await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...lesson({ start: '20:00', end: '21:30', type: '解惑時間' }), id: added.id } });
    // the type's old name still works and is saved as the new one
    expect(moved).toMatchObject({ id: added.id, start: '20:00', end: '21:30', type: '駐村創作', title: '' });
    expect((await db.call('oh_lessons')).lessons).toHaveLength(85);
    expect(await db.call('oh_admin_lesson_delete', { p_token: admin, p_id: added.id })).toEqual({ ok: true });
    await expectCode(db.call('oh_admin_lesson_delete', { p_token: admin, p_id: added.id }), 'NOT_FOUND', 'lesson');
    await expectCode(db.call('oh_admin_lesson_save', { p_token: admin, p: { ...lesson(), id: added.id } }), 'NOT_FOUND', 'lesson');
    const log = await db.sql("select kind, data from app.events where kind like 'config.lesson%' order by id");
    expect(log.map((e: any) => e.kind)).toEqual(['config.lesson', 'config.lesson', 'config.lesson.deleted']);
    expect(log[2].data.label).toBe('1/6 20:00 浡崴');
  });

  it('validates every field', async () => {
    const bad = [
      lesson({ date: 'someday' }),
      lesson({ date: null }),
      lesson({ start: '25:00' }),
      lesson({ end: '21:00' }),
      lesson({ end: '20:00' }),
      lesson({ teacher: '   ' }),
      lesson({ teacher: '一二三四五六七八九十一二三四五六七八九十一' }),
      lesson({ type: '進階課' }),
      lesson({ title: 'x'.repeat(81) }),
      lesson({ topic: 'x'.repeat(1001) }),
      { ...lesson(), id: 'abc' },
    ];
    for (const p of bad) await expectCode(db.call('oh_admin_lesson_save', { p_token: admin, p }), 'VALIDATION', 'lesson');
    await expectCode(db.call('oh_admin_lesson_save', { p_token: admin, p: [] }), 'VALIDATION', 'lesson');
  });

  it('keeps one class at a time, whoever teaches it', async () => {
    // 11/7 17:00–18:00 浡崴 is already there
    await expectCode(
      db.call('oh_admin_lesson_save', { p_token: admin, p: lesson({ date: '2026-11-07', start: '17:30', end: '18:30', teacher: '哲瑜' }) }),
      'LESSON_CLASH',
      '11/7 17:00 浡崴',
    );
    // back to back is fine
    const ok = await db.call('oh_admin_lesson_save', { p_token: admin, p: lesson({ date: '2026-11-07', start: '18:00', end: '19:00' }) });
    // and a lesson never clashes with itself when it is edited
    await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...lesson({ date: '2026-11-07', start: '18:00', end: '19:30' }), id: ok.id } });
    await db.call('oh_admin_lesson_delete', { p_token: admin, p_id: ok.id });
  });

  it('edits the page header', async () => {
    const r = await db.call('oh_admin_lessons_info', {
      p_token: admin, p: { subtitle: ' TNDA 115-1 ', place: 'https://meet.google.com/abc-defg-hij', note: '每堂都會錄影\n\n\n可以回放' },
    });
    expect(r).toEqual({ title: 'TD 專班課表', subtitle: 'TNDA 115-1', place: 'https://meet.google.com/abc-defg-hij', note: '每堂都會錄影\n\n可以回放' });
    await expectCode(db.call('oh_admin_lessons_info', { p_token: admin, p: { title: '' } }), 'VALIDATION', 'lesson_info');
    await expectCode(db.call('oh_admin_lessons_info', { p_token: admin, p: { title: 'x'.repeat(41) } }), 'VALIDATION', 'lesson_info');
    expect((await db.call('oh_lessons')).info.title).toBe('TD 專班課表');
  });

  it('imports a schedule.json as one transaction', async () => {
    const before = (await db.call('oh_lessons')).lessons;
    // a bad row anywhere leaves everything as it was
    await expectCode(
      db.call('oh_admin_lessons_import', { p_token: admin, p: { sessions: [lesson(), lesson({ date: '2027-01-07', type: '進階' })] } }),
      'IMPORT_ROW',
      '2',
    );
    await expectCode(
      db.call('oh_admin_lessons_import', { p_token: admin, p: { sessions: [lesson(), lesson({ start: '21:30', end: '22:30', teacher: '哲瑜' })] } }),
      'LESSON_CLASH',
      '1/6 21:00 浡崴',
    );
    await expectCode(db.call('oh_admin_lessons_import', { p_token: admin, p: { sessions: 'nope' } }), 'VALIDATION', 'lessons');
    expect((await db.call('oh_lessons')).lessons).toEqual(before);

    const r = await db.call('oh_admin_lessons_import', {
      p_token: admin,
      p: {
        title: 'TD 專班課表 115-2',
        subtitle: '',
        types: ['基礎教學', '案例分享', '解惑時間'],
        sessions: [lesson({ title: '開場' }), lesson({ date: '2027-01-07', teacher: '哲瑜', type: '案例分享', topic: '作品集' })],
      },
    });
    expect(r).toEqual({ count: 2 });
    const after = await db.call('oh_lessons');
    expect(after.info).toMatchObject({ title: 'TD 專班課表 115-2', subtitle: '', place: 'https://meet.google.com/abc-defg-hij' });
    expect(after.lessons.map((l: any) => [l.date, l.teacher, l.title, l.topic])).toEqual([
      ['2027-01-06', '浡崴', '開場', ''],
      ['2027-01-07', '哲瑜', '', '作品集'],
    ]);
    // a bare array works too, and an empty title in a file keeps the old one
    await db.call('oh_admin_lessons_import', { p_token: admin, p: [lesson()] });
    await db.call('oh_admin_lessons_import', { p_token: admin, p: { title: '', sessions: [lesson()] } });
    expect((await db.call('oh_lessons')).info.title).toBe('TD 專班課表 115-2');
  });

  it('serves a public calendar feed', async () => {
    await db.call('oh_admin_lessons_import', {
      p_token: admin,
      p: { sessions: [lesson({ title: 'Houdini, 粒子; 入門', topic: '帶筆電\n先裝好軟體' }), lesson({ date: '2027-01-07', teacher: '哲瑜', type: '解惑時間' })] },
    });
    await db.sql('set role anon');
    const text = (await db.one(`select convert_from(public.oh_lessons_calendar(), 'UTF8') as v`)).v as string;
    await db.sql('reset role');
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const unfolded = text.replace(/\r\n /g, '');
    expect(unfolded).toContain('X-WR-CALNAME:TD 專班課表 115-2');
    expect(unfolded).toContain('DTSTART:20270106T130000Z');
    expect(unfolded).toContain('DTEND:20270106T140000Z');
    expect(unfolded).toContain(String.raw`SUMMARY:TD 基礎教學 · 浡崴｜Houdini\, 粒子\; 入門`);
    expect(unfolded).toContain('SUMMARY:TD 駐村創作 · 哲瑜\r\n');
    expect(unfolded).toContain(String.raw`DESCRIPTION:Houdini\, 粒子\; 入門\n\n帶筆電\n先裝好軟體\n\n講師：浡崴　類型：基礎教學`);
    expect(unfolded).toContain('LOCATION:https://meet.google.com/abc-defg-hij');
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(unfolded).toMatch(/UID:td-\d+@tnda-office-hour/);
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('narrows the feed to one teacher', async () => {
    const feed = async (who: string | null) =>
      ((await db.one(`select convert_from(public.oh_lessons_calendar(p_teacher => $1), 'UTF8') as v`, [who])).v as string).replace(/\r\n /g, '');
    const one = await feed(' 哲瑜 ');
    expect(one).toContain('X-WR-CALNAME:TD 專班課表 115-2 · 哲瑜');
    expect(one.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(one).toContain('SUMMARY:TD 駐村創作 · 哲瑜');
    expect((await feed('沒有這個人')).match(/BEGIN:VEVENT/g)).toBeNull();
    expect((await feed(null)).match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it('keeps the tables private', async () => {
    await db.sql('set role anon');
    await expect(db.sql('select * from app.lessons')).rejects.toThrow(/permission denied/);
    await expect(db.sql('select * from app.lesson_info')).rejects.toThrow(/permission denied/);
    await expect(db.sql(`select app.lesson_kinds()`)).rejects.toThrow(/permission denied/);
    await db.sql('reset role');
  });
});

describe('TD units', () => {
  let db: TestDb;
  let admin: string;
  let student: string;
  // the seeded 基礎教學 lessons, by date and start
  const ids: Record<string, number> = {};
  const units = async () => (await db.call('oh_lessons')).units;
  const unitOf = async (id: number) => (await db.call('oh_lessons')).lessons.find((l: any) => l.id === id).unit;

  beforeAll(async () => {
    db = await makeDb();
    await db.setNow('2026-10-19T09:00:00+08:00');
    const c = await db.codes();
    admin = (await db.call('oh_join', { p_code: c.admin })).token;
    student = (await db.call('oh_join', { p_code: c.groups[2], p_name: '小晴' })).token;
    for (const l of (await db.call('oh_lessons')).lessons) ids[`${l.date} ${l.start}`] = l.id;
  });

  it('starts with an outline of ten units per type, topics left empty, and only admins change them', async () => {
    const r = await db.call('oh_lessons');
    expect(r.units).toHaveLength(30);
    for (const t of r.types) {
      const mine = r.units.filter((u: any) => u.type === t);
      expect(mine.map((u: any) => u.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(mine.every((u: any) => u.title === '' && u.topic === '')).toBe(true);
    }
    // in type order, as the pages list them
    expect([...new Set(r.units.map((u: any) => u.type))]).toEqual(r.types);
    expect(r.lessons[0].unit).toBeNull();
    await expectCode(db.call('oh_admin_lesson_unit_save', { p_token: student, p: { type: '基礎教學', title: 'x' } }), 'FORBIDDEN');
    await expectCode(db.call('oh_admin_lesson_unit_delete', { p_token: student, p_id: r.units[0].id }), 'FORBIDDEN');
    // the rest of these start from no units
    await db.sql('delete from app.lesson_units');
  });

  it('fills an outline up to ten without touching the units a type already has', async () => {
    const fresh = await makeDb({ seed: false });
    // what the outline migration does, run again on a type that has two
    await fresh.sql("delete from app.lesson_units where kind = '基礎教學' and sort > 2");
    await fresh.sql("update app.lesson_units set title = '已寫好' where kind = '基礎教學'");
    const outline = MIGRATIONS[MIGRATIONS.length - 1].split('select app.lesson_units_renumber();')[0];
    await fresh.pg.exec(outline.slice(outline.indexOf('-- ten per type')));
    const units = (await fresh.call('oh_lessons')).units.filter((u: any) => u.type === '基礎教學');
    expect(units.map((u: any) => `${u.no}${u.title}`)).toEqual(['1已寫好', '2已寫好', '3', '4', '5', '6', '7', '8', '9', '10']);
    await fresh.pg.close();
  });

  it('numbers units within their type and ticks the lessons that teach them', async () => {
    const one = await db.call('oh_admin_lesson_unit_save', {
      p_token: admin,
      p: { type: '基礎教學', title: ' 介面與\t節點 ', topic: '認識介面\r\n\n\n\n帶筆電', lessons: [ids['2026-10-26 21:00'], ids['2026-11-03 21:00']] },
    });
    expect(one).toEqual({ id: one.id, type: '基礎教學', no: 1, title: '介面與 節點', topic: '認識介面\n\n帶筆電' });
    const two = await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { type: '基礎教學', title: 'SOP 與動態', lessons: [ids['2026-11-02 21:00']] } });
    const share = await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { type: '案例分享', title: '作品集' } });
    expect([two.no, share.no]).toEqual([2, 1]);
    expect((await units()).map((u: any) => [u.type, u.no, u.title])).toEqual([
      ['基礎教學', 1, '介面與 節點'],
      ['基礎教學', 2, 'SOP 與動態'],
      ['案例分享', 1, '作品集'],
    ]);
    expect(await unitOf(ids['2026-10-26 21:00'])).toBe(one.id);
    expect(await unitOf(ids['2026-11-03 21:00'])).toBe(one.id);
    expect(await unitOf(ids['2026-11-02 21:00'])).toBe(two.id);

    // one unit per lesson: ticking it in another unit moves it there, and unticking leaves it without one
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: two.id, title: 'SOP 與動態', lessons: [ids['2026-11-02 21:00'], ids['2026-11-03 21:00']] } });
    expect(await unitOf(ids['2026-11-03 21:00'])).toBe(two.id);
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: one.id, type: '基礎教學', title: '介面與節點', lessons: [] } });
    expect(await unitOf(ids['2026-10-26 21:00'])).toBeNull();
    expect(await unitOf(ids['2026-11-03 21:00'])).toBe(two.id);
    // without `lessons` the ticks stay as they are
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: two.id, title: 'SOP 與動態', topic: '補充' } });
    expect(await unitOf(ids['2026-11-02 21:00'])).toBe(two.id);
    const log = await db.sql("select data from app.events where kind = 'config.lesson_unit' order by id desc limit 1");
    expect(log[0].data.label).toBe('基礎教學（二）');
  });

  it('moves a unit to another number', async () => {
    const [one, two] = await units();
    const three = await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { type: '基礎教學', title: '粒子', no: 1 } });
    expect(three.no).toBe(1);
    const order = async () => (await units()).filter((u: any) => u.type === '基礎教學').map((u: any) => `${u.no}${u.title}`);
    expect(await order()).toEqual(['1粒子', '2介面與節點', '3SOP 與動態']);
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: three.id, title: '粒子', no: 99 } });
    expect(await order()).toEqual(['1介面與節點', '2SOP 與動態', '3粒子']);
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: two.id, title: 'SOP 與動態', no: 1 } });
    expect(await order()).toEqual(['1SOP 與動態', '2介面與節點', '3粒子']);
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: one.id, title: '介面與節點', no: 1 } });
    expect(await order()).toEqual(['1介面與節點', '2SOP 與動態', '3粒子']);
    // deleting one closes the gap and keeps its lessons, without a unit
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: three.id, title: '粒子', lessons: [ids['2026-11-07 17:00']] } });
    expect(await db.call('oh_admin_lesson_unit_delete', { p_token: admin, p_id: one.id })).toEqual({ ok: true });
    expect(await order()).toEqual(['1SOP 與動態', '2粒子']);
    expect(await unitOf(ids['2026-11-07 17:00'])).toBe(three.id);
    expect((await db.call('oh_lessons')).lessons).toHaveLength(84);
    await expectCode(db.call('oh_admin_lesson_unit_delete', { p_token: admin, p_id: one.id }), 'NOT_FOUND', 'unit');
    await expectCode(db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: one.id, title: 'x' } }), 'NOT_FOUND', 'unit');
  });

  it('validates a unit and keeps its lessons of its own type', async () => {
    const [two] = await units();
    const share = ids['2026-11-06 21:00']; // 案例分享
    const bad = [
      { type: '基礎教學', title: 'x'.repeat(81) },
      { type: '基礎教學', title: 'x', topic: 'x'.repeat(1001) },
      { type: '進階課', title: 'x' },
      { title: 'x' },
      { type: '基礎教學', title: 'x', no: 'one' },
      { type: '基礎教學', title: 'x', lessons: 'all' },
      { type: '基礎教學', title: 'x', lessons: ['1'] },
      { id: 'x', title: 'x' },
      { id: two.id, type: '案例分享', title: 'x' }, // the type is fixed
    ];
    for (const p of bad) await expectCode(db.call('oh_admin_lesson_unit_save', { p_token: admin, p }), 'VALIDATION', 'unit');
    await expectCode(db.call('oh_admin_lesson_unit_save', { p_token: admin, p: [] }), 'VALIDATION', 'unit');
    await expectCode(db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: two.id, title: 'x', lessons: [share] } }), 'VALIDATION', 'unit_lessons');
    await expectCode(db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: two.id, title: 'x', lessons: [999999] } }), 'VALIDATION', 'unit_lessons');
    expect((await units())[0].title).toBe('SOP 與動態');
    // the old name of 駐村創作 still works
    const res = await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { type: '解惑時間', title: '期末作品' } });
    expect(res.type).toBe('駐村創作');
    await db.call('oh_admin_lesson_unit_delete', { p_token: admin, p_id: res.id });
    // a unit may wait for its topic
    const blank = await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { type: '駐村創作', title: '   ' } });
    expect(blank).toMatchObject({ type: '駐村創作', no: 1, title: '', topic: '' });
    expect((await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: blank.id } })).title).toBe('');
    await db.call('oh_admin_lesson_unit_delete', { p_token: admin, p_id: blank.id });
  });

  it('sets a lesson unit when it is saved, and drops it when the type changes', async () => {
    const [two] = await units();
    const share = (await units()).find((u: any) => u.type === '案例分享');
    const lesson26 = (await db.call('oh_lessons')).lessons.find((l: any) => l.id === ids['2026-10-26 21:00']);
    const { id, unit, ...p } = lesson26;
    expect(unit).toBeNull();
    expect((await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, unit: two.id } })).unit).toBe(two.id);
    // left out, an edit keeps it
    expect((await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, title: '加開' } })).unit).toBe(two.id);
    // a unit of another type is refused
    await expectCode(db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, unit: share.id } }), 'VALIDATION', 'unit');
    await expectCode(db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, unit: 'x' } }), 'VALIDATION', 'lesson');
    // a new type drops the old unit
    expect((await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, type: '案例分享' } })).unit).toBeNull();
    expect((await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, type: '案例分享', unit: share.id } })).unit).toBe(share.id);
    expect((await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, type: '案例分享', unit: null } })).unit).toBeNull();
    await db.call('oh_admin_lesson_save', { p_token: admin, p: { ...p, id, title: '加開', unit: two.id } });
    const added = await db.call('oh_admin_lesson_save', { p_token: admin, p: lesson({ unit: two.id }) });
    expect(added.unit).toBe(two.id);
    await db.call('oh_admin_lesson_delete', { p_token: admin, p_id: added.id });
  });

  it('names the unit in the calendar feed', async () => {
    const [two] = await units();
    await db.call('oh_admin_lesson_unit_save', { p_token: admin, p: { id: two.id, title: two.title, topic: '補充' } });
    const text = ((await db.one(`select convert_from(public.oh_lessons_calendar(), 'UTF8') as v`)).v as string).replace(/\r\n /g, '');
    expect(text).toContain('SUMMARY:TD 基礎教學（一）SOP 與動態 · 浡崴｜加開\r\n');
    expect(text).toContain(String.raw`DESCRIPTION:基礎教學（一）SOP 與動態\n\n補充\n\n加開\n\n講師：浡崴　類型：基礎教學`);
    expect(text).toContain('SUMMARY:TD 基礎教學 · 哲瑜\r\n'); // 10/27 has no unit
  });

  it('exports and imports units with the timetable', async () => {
    const st = await db.call('oh_lessons');
    const doc = scheduleJson(st.info, st.types, st.lessons.slice(0, 6), st.units);
    expect(doc.units).toEqual([
      { type: '基礎教學', no: 1, title: 'SOP 與動態', topic: '補充' },
      { type: '基礎教學', no: 2, title: '粒子', topic: '' },
      { type: '案例分享', no: 1, title: '作品集', topic: '' },
    ]);
    expect(doc.sessions.map((s) => s.unit)).toEqual([1, null, 1, 1, null, 2]);

    // a file with units replaces them; a session's unit is the unit's number within its type
    const r = await db.call('oh_admin_lessons_import', {
      p_token: admin,
      p: {
        units: [
          { type: '基礎教學', no: 2, title: '節點' },
          { type: '基礎教學', no: 1, title: '介面', topic: '先裝好軟體' },
          { type: '案例分享', title: '業界案例' },
        ],
        sessions: [lesson({ unit: 1 }), lesson({ date: '2027-01-07', unit: 2 }), lesson({ date: '2027-01-08', type: '案例分享', unit: 1 }), lesson({ date: '2027-01-09' })],
      },
    });
    expect(r).toEqual({ count: 4, units: 3 });
    const after = await db.call('oh_lessons');
    expect(after.units.map((u: any) => [u.type, u.no, u.title])).toEqual([
      ['基礎教學', 1, '介面'],
      ['基礎教學', 2, '節點'],
      ['案例分享', 1, '業界案例'],
    ]);
    const no = (l: any) => after.units.find((u: any) => u.id === l.unit)?.no ?? null;
    expect(after.lessons.map(no)).toEqual([1, 2, 1, null]);

    // without units in the file they stay, and sessions name them by number
    expect(await db.call('oh_admin_lessons_import', { p_token: admin, p: { sessions: [lesson({ unit: 2 })] } })).toEqual({ count: 1 });
    const kept = await db.call('oh_lessons');
    expect(kept.units).toHaveLength(3);
    expect(kept.units.find((u: any) => u.id === kept.lessons[0].unit).title).toBe('節點');

    // a unit that is not there, or a bad unit, changes nothing
    const before = await db.call('oh_lessons');
    await expectCode(db.call('oh_admin_lessons_import', { p_token: admin, p: { sessions: [lesson(), lesson({ date: '2027-01-07', unit: 3 })] } }), 'IMPORT_ROW', '2');
    await expectCode(db.call('oh_admin_lessons_import', { p_token: admin, p: { sessions: [lesson({ unit: 'one' })] } }), 'IMPORT_ROW', '1');
    await expectCode(db.call('oh_admin_lessons_import', { p_token: admin, p: { units: [{ type: '基礎教學', title: 'x'.repeat(81) }], sessions: [] } }), 'IMPORT_UNIT', '1');
    await expectCode(
      db.call('oh_admin_lessons_import', { p_token: admin, p: { units: [{ type: '基礎教學', title: 'a' }, { type: '基礎教學', no: 1, title: 'b' }], sessions: [] } }),
      'IMPORT_UNIT',
      '2',
    );
    await expectCode(db.call('oh_admin_lessons_import', { p_token: admin, p: { units: [{ type: '進階', title: 'a' }], sessions: [] } }), 'IMPORT_UNIT', '1');
    await expectCode(db.call('oh_admin_lessons_import', { p_token: admin, p: { units: 'all', sessions: [] } }), 'VALIDATION', 'units');
    expect(await db.call('oh_lessons')).toEqual(before);
    // a unit without a topic yet comes along too
    await db.call('oh_admin_lessons_import', { p_token: admin, p: { units: [{ type: '案例分享' }], sessions: [lesson({ type: '案例分享', unit: 1 })] } });
    expect((await units()).map((u: any) => [u.type, u.no, u.title])).toEqual([['案例分享', 1, '']]);
    // an empty list clears them
    await db.call('oh_admin_lessons_import', { p_token: admin, p: { units: [], sessions: [lesson()] } });
    expect(await units()).toEqual([]);
  });

  it('keeps the table private', async () => {
    await db.sql('set role anon');
    await expect(db.sql('select * from app.lesson_units')).rejects.toThrow(/permission denied/);
    await expect(db.sql(`select app.cn_num(1)`)).rejects.toThrow(/permission denied/);
    await db.sql('reset role');
    const n = await db.one(`select app.cn_num(1) a, app.cn_num(10) b, app.cn_num(12) c, app.cn_num(20) d, app.cn_num(21) e`);
    expect(n).toEqual({ a: '一', b: '十', c: '十二', d: '二十', e: '二十一' });
  });
});
