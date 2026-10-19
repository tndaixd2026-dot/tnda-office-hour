import { beforeAll, describe, expect, it } from 'vitest';
import type { Lesson } from '../src/api/types';
import { byWeek, monthDays, nextLesson, scheduleJson, shiftMonth, teacherClass, teacherList } from '../src/lib/lessons';
import { instant } from '../src/lib/time';
import { expectCode, makeDb, type TestDb } from './helpers';

describe('TD lesson helpers', () => {
  const L = (id: number, date: string, start: string, teacher: string): Lesson => ({
    id, date, start, end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, teacher, type: '基礎教學', title: '', topic: '',
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

  it('gives each teacher a stable colour and exports schedule.json', () => {
    const t = teacherList(list);
    expect(t).toEqual(['浡崴', '哲瑜']);
    expect([teacherClass(t, '浡崴'), teacherClass(t, '哲瑜')]).toEqual(['tc0', 'tc1']);
    const doc = scheduleJson({ title: 'T', subtitle: 'S', place: '', note: '' }, ['基礎教學'], list);
    expect(doc.sessions[0]).toEqual({ date: '2026-10-26', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '', topic: '' });
    expect(doc.sessions[0]).not.toHaveProperty('id');
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
    expect(r.types).toEqual(['基礎教學', '案例分享', '解惑時間']);
    expect(r.lessons).toHaveLength(84);
    expect(r.lessons[0]).toEqual({
      id: r.lessons[0].id, date: '2026-10-26', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '', topic: '',
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
    expect(moved).toMatchObject({ id: added.id, start: '20:00', end: '21:30', type: '解惑時間', title: '' });
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
    expect(unfolded).toContain('SUMMARY:TD 解惑時間 · 哲瑜\r\n');
    expect(unfolded).toContain(String.raw`DESCRIPTION:Houdini\, 粒子\; 入門\n\n帶筆電\n先裝好軟體\n\n講師：浡崴　類型：基礎教學`);
    expect(unfolded).toContain('LOCATION:https://meet.google.com/abc-defg-hij');
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(unfolded).toMatch(/UID:td-\d+@tnda-office-hour/);
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('keeps the tables private', async () => {
    await db.sql('set role anon');
    await expect(db.sql('select * from app.lessons')).rejects.toThrow(/permission denied/);
    await expect(db.sql('select * from app.lesson_info')).rejects.toThrow(/permission denied/);
    await expect(db.sql(`select app.lesson_kinds()`)).rejects.toThrow(/permission denied/);
    await db.sql('reset role');
  });
});
