import { describe, expect, it } from 'vitest';
import {
  announceMessage,
  applySync,
  holdMessage,
  hostedFiles,
  hours,
  nextWeek,
  parsePage,
  parseTime,
  remindMessage,
  syncPlan,
  teachersMessage,
  type TdLesson,
} from '../scripts/td-weekly-lib';
import { makeDb } from './helpers';

// Saturday 11/14 08:00 in Taipei: next week is 11/16–11/22
const SAT = new Date('2026-11-14T08:00:00+08:00');

let n = 0;
const lesson = (o: Partial<TdLesson>): TdLesson => ({
  id: `p${++n}`,
  url: `https://www.notion.so/p${n}`,
  teacher: '哲瑜',
  title: '課',
  date: '2026-11-17',
  start: '21:00',
  end: '22:00',
  hours: 1,
  type: '基礎教學',
  outline: '',
  files: [],
  confirmed: false,
  announced: false,
  ...o,
});

describe('TD weekly: Notion pages', () => {
  it('reads times, dates, files and the checkboxes', () => {
    expect(parseTime('21:00–22:00')).toEqual(['21:00', '22:00']);
    expect(parseTime('20:00-22:00')).toEqual(['20:00', '22:00']);
    expect(parseTime('9:30')).toEqual(['09:30', '10:30']);
    expect(parseTime('晚上')).toBeNull();
    expect(parseTime('22:00–21:00')).toBeNull();

    const l = parsePage({
      id: 'abc',
      url: 'https://www.notion.so/abc',
      properties: {
        課程名稱: { title: [{ plain_text: 'TOPs：' }, { plain_text: '無敵的遮罩' }] },
        講師: { select: { name: '哲瑜' } },
        上課日期: { date: { start: '2026-11-08' } },
        課程時間: { rich_text: [{ plain_text: '20:00–22:00' }] },
        類型: { select: { name: '基礎教學' } },
        課程大綱: { rich_text: [{ plain_text: '1. 基本形狀\n2. 顏色' }] },
        簡報網址: { url: 'https://drive.google.com/s' },
        簡報連結: { files: [{ type: 'file', name: 'mask.pdf', file: { url: 'https://s3/mask.pdf' } }] },
        示範檔: { files: [{ type: 'external', name: 'demo.toe', external: { url: 'https://drive.google.com/d' } }] },
        老師確認: { checkbox: true },
        已公告: { checkbox: false },
      },
    });
    expect(l).toMatchObject({ title: 'TOPs：無敵的遮罩', date: '2026-11-08', start: '20:00', end: '22:00', hours: 2, confirmed: true, announced: false });
    expect(l.files).toEqual([
      { name: '簡報', url: 'https://drive.google.com/s', hosted: false, field: '簡報' },
      { name: 'mask.pdf', url: 'https://s3/mask.pdf', hosted: true, field: '簡報' },
      { name: 'demo.toe', url: 'https://drive.google.com/d', hosted: false, field: '示範檔' },
    ]);
    expect(parsePage({ id: 'x', url: 'u', properties: {} })).toMatchObject({ date: null, start: null, teacher: '', confirmed: false });
  });

  it('knows next week and the hours', () => {
    expect(nextWeek(SAT)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(nextWeek(new Date('2026-11-15T20:00:00+08:00'))).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    // just past midnight on Sunday in Taipei is still Saturday in UTC
    expect(nextWeek(new Date('2026-11-15T00:30:00+08:00'))).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    const list = [
      lesson({ date: '2026-11-13', hours: 1 }),
      lesson({ date: '2026-11-14', start: '10:00', end: '12:00', hours: 2 }),
      lesson({ date: '2026-11-17' }),
      lesson({ date: null }),
      lesson({ teacher: '浡崴' }),
    ];
    // the 11/14 lesson has not ended at 08:00
    expect(hours(list, '哲瑜', SAT)).toEqual({ done: 1, planned: 4, undated: 1 });
  });
});

describe('TD weekly: messages', () => {
  const list = [
    lesson({ teacher: '哲瑜', date: '2026-11-17', title: 'VJ 系統案例分享 1', type: '案例分享', confirmed: true }),
    lesson({ teacher: '哲瑜', date: '2026-11-21', start: '10:00', end: '11:00', title: 'UI 基礎：如何排版', outline: '1. 格線\n\n2. 對齊' }),
    lesson({ teacher: '浡崴', date: '2026-11-16', title: '案例分享 (一)', type: '案例分享', files: [{ name: 'a.toe', url: 'https://s3/a', hosted: true, field: '示範檔' }, { name: '簡報', url: 'https://drive/x', hosted: false, field: '簡報' }] }),
    lesson({ teacher: '浡崴', date: '2026-11-10', title: '上週的課' }),
    lesson({ teacher: '浡崴', date: '2026-11-23', title: '下下週的課' }),
  ];

  it('asks each teacher about next week, with their hours', () => {
    const [m] = teachersMessage(list, SAT);
    expect(m.content).toContain('11/16（一） – 11/22（日）');
    expect(m.content).toContain('**哲瑜** <@964735370061312011>');
    expect(m.content).toContain('**浡崴** <@556755936367083520>');
    expect(m.content).toContain('11/17（二） 21:00–22:00 [VJ 系統案例分享 1](<https://www.notion.so/');
    expect(m.content).toContain('✅ 已確認');
    expect(m.content).toContain('⬜ 待確認');
    expect(m.content).not.toContain('上週的課');
    expect(m.content).not.toContain('下下週的課');
    expect(m.content).toContain('時數：已上 0・已排 2・總共 42 小時（還有 40 小時沒排）');
    expect(m.allowed_mentions).toEqual({ parse: [], users: ['964735370061312011', '556755936367083520'] });
    // a test pings nobody
    const [t] = teachersMessage(list, SAT, true);
    expect(t.content).toContain('【測試訊息');
    expect(t.content).not.toContain('<@');
    expect(t.allowed_mentions.users).toEqual([]);
  });

  it('reminds only about unconfirmed lessons, and only those teachers', () => {
    const sun = new Date('2026-11-15T12:00:00+08:00');
    const [m] = remindMessage(list, sun);
    expect(m.content).not.toContain('VJ 系統案例分享 1');
    expect(m.content).toContain('UI 基礎：如何排版');
    expect(m.allowed_mentions.users).toEqual(['556755936367083520', '964735370061312011']);
    expect(remindMessage(list.map((l) => ({ ...l, confirmed: true })), sun)).toEqual([]);
    expect(holdMessage(list, sun, 'https://github.com/x')[0].content).toContain('還有 2 堂老師沒確認');
  });

  it('announces next week for the students, with no hours and no pings', () => {
    const sun = new Date('2026-11-15T20:00:00+08:00');
    const all = announceMessage(list, sun, { place: 'https://meet.google.com/qjq-osdm-moo', site: 'https://x.github.io/oh/' });
    const text = all.map((m) => m.content).join('\n');
    expect(text).toContain('全部在 Google Meet 上課：https://meet.google.com/qjq-osdm-moo');
    expect(text.indexOf('11/16（一）')).toBeLessThan(text.indexOf('11/17（二）'));
    expect(text).toContain('> 1. 格線\n> 2. 對齊');
    expect(text).toContain('📎 [簡報](<https://drive/x>)');
    expect(text).toContain('📎 a.toe（檔案在下面，請先下載）');
    expect(text).toContain('https://x.github.io/oh/#/td');
    expect(text).not.toMatch(/小時|<@|notion\.so/);
    expect(all.every((m) => m.allowed_mentions.parse.length === 0)).toBe(true);
    expect(hostedFiles(list, sun)).toEqual([{ label: '11/16（一） 浡崴｜案例分享 (一)', files: [list[2].files[0]] }]);
    expect(announceMessage([], sun, { place: '', site: 's' })[0].content).toContain('下週沒有課');
  });

  it('splits long messages under Discord’s limit', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      lesson({ date: `2026-11-${16 + (i % 7)}`, start: `${String(8 + (i % 14)).padStart(2, '0')}:00`, end: `${String(9 + (i % 14)).padStart(2, '0')}:00`, title: `很長的課名 ${i} ${'字'.repeat(40)}`, outline: '大綱\n'.repeat(6) }),
    );
    const all = announceMessage(many, new Date('2026-11-15T20:00:00+08:00'), { place: '', site: 's' });
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((m) => m.content.length <= 2000)).toBe(true);
  });
});

describe('TD weekly: the site follows Notion', () => {
  it('plans the fewest changes and keeps lessons before Notion starts', () => {
    const site = [
      { id: 1, date: '2026-10-20', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '更早的課', topic: '', confirmed: false },
      { id: 2, date: '2026-11-02', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '02', topic: '', confirmed: false },
      { id: 3, date: '2026-11-07', start: '20:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '不上了', topic: '', confirmed: false },
      { id: 4, date: '2026-11-09', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '舊名', topic: '', confirmed: false },
    ];
    const notion = [
      lesson({ teacher: '浡崴', date: '2026-11-02', title: '02' }),
      lesson({ teacher: '浡崴', date: '2026-11-09', title: '03 | TOP 入門', outline: '• 一\n\n\n• 二  ' }),
      lesson({ teacher: '哲瑜', date: '2026-11-14', start: '10:00', end: '11:00', title: '新的課', type: null, confirmed: true }),
      lesson({ teacher: '哲瑜', date: '2026-11-14', start: '10:00', end: '11:00', title: '重複' }),
      lesson({ teacher: '浡崴', date: null, title: '還沒排' }),
      lesson({ teacher: '浡崴', date: '2026-11-30', start: null, end: null, title: '沒時間' }),
    ];
    const plan = syncPlan(notion, site);
    expect(plan.from).toBe('2026-11-02');
    expect(plan.deletes).toEqual([3]);
    expect(plan.saves).toEqual([
      { id: 4, date: '2026-11-09', start: '21:00', end: '22:00', teacher: '浡崴', type: '基礎教學', title: '03 | TOP 入門', topic: '• 一\n\n• 二', confirmed: false },
      { date: '2026-11-14', start: '10:00', end: '11:00', teacher: '哲瑜', type: '基礎教學', title: '新的課', topic: '', confirmed: true },
    ]);
    expect(plan.skipped).toHaveLength(2);
    // once applied, nothing is left to do
    const after = [site[0], site[1], { ...plan.saves[0] }, { ...plan.saves[1], id: 5 }] as any[];
    expect(syncPlan(notion, after)).toMatchObject({ deletes: [], saves: [] });
  });

  it('applies the plan as a short-lived admin, all or nothing', async () => {
    const db = await makeDb();
    await db.setNow('2026-11-08T10:00:00+08:00');
    const before = (await db.call('oh_lessons')).lessons;
    const notion = [
      lesson({ teacher: '浡崴', date: '2026-11-09', title: '03 | TOP 入門' }),
      lesson({ teacher: '哲瑜', date: '2026-11-14', start: '10:00', end: '12:00', title: '聲音驅動影像' }),
    ];
    const plan = syncPlan(notion, before);
    const q = { query: async (s: string, p?: unknown[]) => ({ rows: (await db.pg.query(s, p)).rows as any[] }) };
    await applySync(q, plan, 'a'.repeat(64));
    const after = (await db.call('oh_lessons')).lessons;
    expect(after.filter((l: any) => l.date >= '2026-11-09')).toMatchObject([
      { date: '2026-11-09', start: '21:00', teacher: '浡崴', title: '03 | TOP 入門' },
      { date: '2026-11-14', start: '10:00', end: '12:00', teacher: '哲瑜', title: '聲音驅動影像' },
    ]);
    expect(after.filter((l: any) => l.date < '2026-11-09')).toEqual(before.filter((l: any) => l.date < '2026-11-09'));
    expect(await db.sql("select 1 from app.sessions where name = 'Notion 同步'")).toEqual([]);
    expect((await db.sql("select actor_name from app.events where kind like 'config.lesson%'")).every((e) => e.actor_name === 'Notion 同步')).toBe(true);

    // a clash undoes everything
    const clash = { from: '2026-11-09', deletes: [], saves: [{ date: '2026-11-14', start: '11:00', end: '12:00', teacher: '浡崴', type: '基礎教學', title: 'x', topic: '' }], skipped: [] };
    await expect(applySync(q, clash, 'b'.repeat(64))).rejects.toThrow();
    expect((await db.call('oh_lessons')).lessons).toEqual(after);
    expect(await db.sql("select 1 from app.sessions where name = 'Notion 同步'")).toEqual([]);
  });
});
