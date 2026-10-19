// Automated accessibility scan (axe-core, WCAG 2.2 AA) of every main screen
// in demo mode.   node scripts/a11y.mjs http://localhost:4173/
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173/';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
const results = [];

async function scan(page, name) {
  // inject through the CDP so the page's CSP does not block it
  await page.evaluate(axeSource);
  const r = await page.evaluate(async () =>
    // @ts-ignore
    window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }),
  );
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.impact === 'moderate');
  results.push({ name, bad });
  console.log(`${bad.length ? '✗' : '✓'} ${name}${bad.length ? `: ${bad.length} issue(s)` : ''}`);
  for (const v of bad) {
    console.log(`   - [${v.impact}] ${v.id}: ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) console.log(`       ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`);
  }
}

for (const scheme of ['light', 'dark']) {
  console.log(`\n${scheme}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await scan(page, 'welcome');
  await page.goto(base + '#/demo', { waitUntil: 'domcontentloaded' });
  await page.locator('.demobar').waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await scan(page, 'student home');
  await page.locator('.weeks .wk', { hasText: '可預約' }).first().click();
  await page.getByRole('button', { name: '開始預約' }).click();
  await page.locator('button.cell').first().click();
  await page.waitForTimeout(400);
  await scan(page, 'student booking');
  await page.locator('.demobar').getByRole('button', { name: '助教', exact: true }).click();
  await page.waitForTimeout(900);
  await scan(page, 'admin board');
  for (const [link, label] of [['總覽與紀錄', 'admin overview'], ['小組與邀請', 'admin groups'], ['老師', 'admin teachers'], ['時段與週次', 'admin calendar'], ['寄信通知', 'admin weekly email'], ['設定', 'admin settings'], ['TD 課表', 'admin TD timetable']]) {
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: link }).click();
    await page.waitForTimeout(700);
    await scan(page, label);
  }
  await page.getByRole('button', { name: '新增一堂' }).click();
  await page.waitForTimeout(400);
  await scan(page, 'admin TD lesson form');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await page.getByRole('link', { name: '打開公開頁' }).click();
  await page.getByRole('heading', { name: '全部課程' }).waitFor();
  await page.waitForTimeout(700);
  await scan(page, 'TD timetable (list)');
  await page.getByRole('button', { name: '週曆', exact: true }).click();
  await page.waitForTimeout(400);
  await scan(page, 'TD timetable (week)');
  await page.getByRole('button', { name: '月曆', exact: true }).click();
  await page.waitForTimeout(400);
  await scan(page, 'TD timetable (month)');
  await page.getByRole('button', { name: '依講師', exact: true }).click();
  await page.waitForTimeout(400);
  await scan(page, 'TD timetable (by teacher)');
  await page.locator('.ls-row').first().click();
  await page.waitForTimeout(400);
  await scan(page, 'TD lesson details');
  await page.getByRole('dialog').getByRole('button', { name: '完成' }).click();
  await page.getByRole('button', { name: '清單', exact: true }).click();
  await page.getByRole('button', { name: '訂閱行事曆' }).first().click();
  await page.waitForTimeout(400);
  await scan(page, 'TD subscribe dialog');
  await page.getByRole('dialog').getByRole('button', { name: '完成' }).click();
  await page.locator('.demobar').getByRole('button', { name: '老師', exact: true }).click();
  await page.waitForTimeout(900);
  await scan(page, 'teacher');
  await ctx.close();
}
await browser.close();
const total = results.reduce((n, r) => n + r.bad.length, 0);
console.log(total ? `\n${total} accessibility issue(s)` : '\nNo serious accessibility issues');
process.exit(total ? 1 : 0);
