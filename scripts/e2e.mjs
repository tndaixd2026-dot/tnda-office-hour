// End-to-end walk through every role, in a real browser, against the
// production build running in demo mode (the full SQL backend on PGlite).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/e2e.mjs http://localhost:4173/
//
// Exits non-zero on the first failed step or on any page error.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173/';
const problems = [];
let step = '';

function check(cond, msg) {
  if (!cond) throw new Error(`${step}: ${msg}`);
}

let current = null; // the page under test, for failure screenshots
async function run(name, fn) {
  step = name;
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    if (current) await current.screenshot({ path: `e2e-failure.png`, fullPage: true }).catch(() => {});
    throw e;
  }
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });

async function session(viewport, isMobile = false) {
  const ctx = await browser.newContext({
    viewport,
    isMobile,
    hasTouch: isMobile,
    deviceScaleFactor: 1,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  current = page;
  // FAKE_TIME=2026-10-14T00:30:00+08:00 runs the whole walk at that moment
  if (process.env.FAKE_TIME) await page.clock.install({ time: new Date(process.env.FAKE_TIME) });
  page.on('pageerror', (e) => problems.push(`[${step}] page error: ${e.message}`));
  page.on('console', (m) => {
    // the fake clock tries to run in the email preview too, whose sandbox (rightly) says no
    const harness = /Blocked script execution in 'about:srcdoc'/.test(m.text());
    if (m.type() === 'error' && !harness && !/favicon|fonts\.g/.test(m.text())) problems.push(`[${step}] console: ${m.text()}`);
  });
  page.on('dialog', (d) => d.dismiss());
  return { ctx, page };
}

const role = async (page, name) => {
  await page.locator('.demobar').getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(500);
};

try {
  console.log('desktop');
  const { ctx, page } = await session({ width: 1440, height: 900 });

  await run('welcome screen', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '輸入你的名字' }).waitFor();
    check(await page.getByRole('button', { name: /試玩示範/ }).isVisible(), 'demo button missing');
    check(await page.getByRole('link', { name: '查看 TD 專班課表' }).isVisible(), 'TD timetable link missing');
    // invite codes are one tap away, and back
    await page.getByRole('button', { name: '我有邀請代碼' }).click();
    await page.getByRole('heading', { name: '輸入邀請代碼' }).waitFor();
    await page.getByRole('button', { name: '改用名字登入' }).click();
    await page.getByRole('heading', { name: '輸入你的名字' }).waitFor();
  });

  await run('demo boots in the browser', async () => {
    await page.getByRole('button', { name: /試玩示範/ }).click();
    await page.locator('.demobar').waitFor({ timeout: 60000 });
    await page.getByText('下一次 Office Hour').waitFor();
  });

  await run('student books a week', async () => {
    // the first week that still says 可預約
    const open = page.locator('.weeks .wk', { hasText: '可預約' }).first();
    await open.click();
    await page.getByRole('button', { name: '開始預約' }).click();
    await page.getByRole('heading', { name: /勾選可以的時段/ }).waitFor();
    const cells = page.locator('button.cell[aria-pressed="false"]');
    check((await cells.count()) >= 3, 'not enough open cells');
    await cells.nth(0).click();
    await cells.nth(3).click(); // nth re-evaluates; picks another free cell
    check((await page.locator('button.cell[aria-pressed="true"]').count()) === 2, 'two cells should be picked');
    // keyboard: arrows move focus, space toggles
    const firstCell = page.locator('button.cell[data-r]').first();
    await firstCell.focus();
    const before = await page.evaluate(() => document.activeElement?.getAttribute('data-k'));
    await page.keyboard.press('ArrowDown');
    const after = await page.evaluate(() => document.activeElement?.getAttribute('data-k'));
    check(before && after && before !== after, 'arrow keys should move between cells');
    const wasOn = await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'));
    await page.keyboard.press('Space');
    const nowOn = await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'));
    check(wasOn !== nowOn, 'space should toggle a cell');
    await page.keyboard.press('Space');
    // validation: empty topic
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await page.getByText('請寫下想討論的題目').waitFor();
    await page.getByLabel('想討論的題目').fill('E2E：互動裝置的動線');
    await page.getByLabel('目前進度').fill('E2E 測試進度');
    await page.getByLabel('雲端資料夾連結').fill('not a url');
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await page.getByText('請貼完整網址').waitFor();
    await page.getByLabel('雲端資料夾連結').fill('https://drive.google.com/drive/folders/e2e');
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await page.getByText('E2E：互動裝置的動線').waitFor();
    await page.getByText('等待排程').first().waitFor();
  });

  await run('student edits and sees the change', async () => {
    await page.getByRole('button', { name: '修改需求' }).click();
    await page.getByLabel('想討論的題目').fill('E2E：改過的題目');
    await page.getByRole('button', { name: '更新需求' }).click();
    await page.getByText('E2E：改過的題目').waitFor();
  });

  await run('admin auto-schedules and publishes', async () => {
    await role(page, '助教');
    await page.getByRole('heading', { name: /需求/ }).first().waitFor();
    const auto = page.getByRole('button', { name: '閃身步排程法' });
    await auto.waitFor();
    check(await auto.isEnabled(), 'auto-schedule should be enabled with pending requests');
    await auto.click();
    await page.getByRole('dialog', { name: '閃身步排程法結果' }).waitFor();
    const drafts = await page.getByRole('dialog').locator('.li').count();
    check(drafts > 0, 'auto-schedule produced no drafts');
    await page.getByRole('button', { name: '直接發布' }).click();
    await page.getByRole('dialog', { name: /已發布/ }).waitFor();
    check((await page.getByRole('dialog').locator('pre').count()) > 0, 'no notice messages');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.waitForTimeout(400);
    check(!(await page.getByRole('button', { name: /發布 \d+ 筆/ }).count()), 'drafts should be gone after publish');
  });

  await run('admin assigns a slot by hand and removes it', async () => {
    const lane = page.locator('button.lane:not(.filled):not(:disabled)').first();
    await lane.click();
    const dlg = page.getByRole('dialog', { name: '安排小組' });
    await dlg.waitFor();
    const first = dlg.getByRole('button', { name: '安排' }).first();
    if (await first.count()) {
      await first.click();
    } else {
      await dlg.locator('summary').click();
      await dlg.locator('details button').first().click();
    }
    // rule breaking asks for confirmation
    const confirmBreak = page.getByRole('button', { name: '仍要安排' });
    if (await confirmBreak.isVisible().catch(() => false)) await confirmBreak.click();
    await page.locator('.lane.filled.draft').first().waitFor();
    await page.locator('.lane.filled.draft').first().click();
    await page.getByRole('button', { name: '移除草稿' }).click();
    await page.waitForTimeout(400);
  });

  await run('admin pages render', async () => {
    for (const [label, heading] of [
      ['總覽與紀錄', '本學期的 Office Hour'],
      ['小組與邀請', /個小組/],
      ['老師', '叁式 PM'],
      ['時段與週次', '什麼時候可以約'],
      ['寄信通知', '每週寄給老師的信'],
      ['設定', '課程與規則'],
    ]) {
      await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: label }).click();
      await page.getByRole('heading', { name: heading }).first().waitFor();
    }
  });

  await run('admin edits a group roster', async () => {
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '小組與邀請' }).click();
    await page.getByRole('button', { name: '編輯第 1 組的學生名單' }).click();
    const d = page.getByRole('dialog', { name: '第 1 組的學生名單' });
    await d.getByLabel('學生名單').fill('吳思妤\nE2E 同學\n張家豪');
    await d.getByRole('button', { name: '儲存' }).click();
    await page.getByText('已更新學生名單').waitFor();
    await page.locator('.chip', { hasText: 'E2E 同學' }).waitFor();
    // a name already on another group's roster is refused, and the text is kept
    await page.getByRole('button', { name: '編輯第 1 組的學生名單' }).click();
    await d.getByLabel('學生名單').fill('吳思妤\n陳柏宇');
    await d.getByRole('button', { name: '儲存' }).click();
    await page.getByText(/「陳柏宇」已經在其他組/).waitFor();
    check((await d.getByLabel('學生名單').inputValue()).includes('陳柏宇'), 'roster text should be kept after an error');
    await d.getByRole('button', { name: '取消' }).click();
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '設定' }).click();
    await page.getByRole('heading', { name: '課程與規則' }).first().waitFor();
  });

  await run('admin sets up the weekly email and previews it', async () => {
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '寄信通知' }).click();
    await page.getByRole('button', { name: '新增收件人' }).click();
    const d = page.getByRole('dialog', { name: '新增收件人' });
    await d.getByLabel('Email').fill('e2e@localhost'); // the browser lets it through; the server does not
    await d.getByRole('button', { name: '儲存' }).click();
    await d.getByText('請輸入正確的 Email').waitFor();
    await d.getByLabel('Email').fill('e2e@example.com');
    await d.getByLabel('稱呼').fill('E2E 老師');
    await d.getByLabel('只有 Prolong').check();
    await d.getByRole('button', { name: '儲存' }).click();
    await page.getByText('已新增收件人').waitFor();
    await page.getByText('收 Prolong 的場次').waitFor();
    await page.getByLabel('看誰會收到什麼').selectOption({ label: 'E2E 老師 e2e@example.com' });
    await page.locator('iframe.mail-frame').waitFor();
    check((await page.locator('iframe.mail-frame').getAttribute('srcdoc'))?.includes('E2E 老師 您好'), 'the preview should be the recipient\'s email');
    // first in the list: the admins' Sunday-noon reminder to schedule
    check(await page.getByRole('switch', { name: '週日 12:00 寄審核提醒到助教信箱' }).isChecked(), 'the reminder should be on');
    await page.getByLabel('看誰會收到什麼').selectOption({ index: 0 });
    await page.waitForFunction(() => document.querySelector('iframe.mail-frame')?.getAttribute('srcdoc')?.includes('打開排程'));
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '設定' }).click();
    await page.getByRole('heading', { name: '課程與規則' }).first().waitFor();
    check((await page.getByLabel('截止的星期').inputValue()) === '7' && (await page.getByLabel('截止的時間').inputValue()) === '12:00', 'requests should close on Sunday at noon');
  });

  await run('admin changes a setting', async () => {
    await page.getByLabel('給學生的公告').fill('E2E 公告：下週改到 Discord 大廳');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await page.getByText('設定已儲存').waitFor();
  });

  await run('admin adds availability and a holiday', async () => {
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '時段與週次' }).click();
    await page.getByRole('button', { name: '新增時段' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('星期').selectOption('6');
    await d.getByLabel('開始').selectOption('13:00');
    await d.getByLabel('結束').selectOption('14:00');
    await d.getByRole('button', { name: '儲存' }).click();
    await page.getByText('已儲存時段').waitFor();
    await page.getByText('週六').waitFor();
    await page.getByRole('button', { name: '新增休息日' }).click();
    const reason = page.getByRole('dialog').getByLabel('說明');
    await reason.fill('E2E 休息');
    if (process.env.DEBUG) console.log('    reason value:', await reason.inputValue(), '| date:', await page.getByRole('dialog').getByLabel('日期').inputValue());
    await page.getByRole('dialog').getByRole('button', { name: '儲存' }).click();
    if (process.env.DEBUG) {
      await page.waitForTimeout(1200);
      console.log('    toasts:', await page.locator('.toast').allTextContents(), '| dialogs:', await page.getByRole('dialog').count());
    }
    await page.getByText('E2E 休息').waitFor();
  });

  await run('admin opens the QR wall', async () => {
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '小組與邀請' }).click();
    await page.getByRole('button', { name: '投影邀請 QR' }).click();
    await page.getByRole('dialog').locator('.qr svg').first().waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '關閉' }).click();
  });

  // past weeks are folded away; open them so a lesson is found whatever today is
  const unfoldPast = async () => {
    const past = page.getByRole('button', { name: /顯示已結束的/ });
    if (await past.count()) await past.click();
  };

  await run('admin edits the TD timetable', async () => {
    await page.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: 'TD 課表' }).click();
    await page.getByRole('heading', { name: '課程', exact: true }).waitFor();
    // one class at a time: the clash is explained in the form, which stays open
    await page.getByRole('button', { name: '新增一堂' }).click();
    const d = page.getByRole('dialog', { name: '新增一堂課' });
    await d.getByLabel('日期').fill('2027-01-02');
    await d.getByLabel('開始').selectOption('17:00');
    await d.getByLabel('講師').fill('哲瑜');
    await d.getByRole('button', { name: '儲存' }).click();
    await d.getByText('和 1/2 17:00 浡崴 的課時間重疊').waitFor();
    await d.getByLabel('開始').selectOption('18:00');
    check((await d.getByLabel('結束').inputValue()) === '19:00', 'moving the start should keep the length');
    await d.getByLabel('標題').fill('E2E 加開');
    await d.getByRole('button', { name: '儲存' }).click();
    await page.getByText('已新增').waitFor();
    await unfoldPast();
    await page.getByRole('button', { name: /E2E 加開/ }).click();
    const e = page.getByRole('dialog', { name: '編輯課程' });
    await e.getByLabel('內容說明').fill('E2E 說明：帶筆電');
    await e.getByRole('button', { name: '儲存' }).click();
    await page.getByText('E2E 說明：帶筆電').waitFor();
    await page.getByRole('button', { name: '編輯頁面資訊' }).click();
    const info = page.getByRole('dialog', { name: '編輯頁面資訊' });
    await info.getByLabel('公告').fill('E2E 公告：TD 改線上');
    await info.getByRole('button', { name: '儲存' }).click();
    await page.getByText('已更新頁面資訊').waitFor();
  });

  await run('the public TD page shows it, with filters and a month view', async () => {
    await page.getByRole('link', { name: '打開公開頁' }).click();
    await page.getByRole('heading', { name: '全部課程' }).waitFor();
    await page.getByText('E2E 公告：TD 改線上').waitFor();
    await unfoldPast();
    await page.getByText('E2E 加開').waitFor();
    // one teacher only, and the address says so (so it can be shared)
    const byTeacher = page.getByRole('group', { name: '只看哪位講師' });
    await byTeacher.getByRole('button', { name: '哲瑜' }).click();
    check((await page.locator('.ls-row .ls-who', { hasText: '浡崴' }).count()) === 0, 'another teacher is still listed');
    check(decodeURIComponent(await page.evaluate(() => location.hash)) === '#/td/哲瑜', 'the address should name the teacher');
    // the week grid opens a lesson with an add-to-Google-Calendar link
    await page.getByRole('button', { name: '週曆', exact: true }).click();
    await page.locator('.ls-wk').waitFor();
    const lastWeek = page.getByRole('button', { name: '下一週' });
    while ((await page.locator('.ls-ev').count()) === 0 && (await lastWeek.isEnabled())) await lastWeek.click();
    await page.locator('.ls-ev').first().click();
    const google = await page.getByRole('dialog').getByRole('link', { name: '加到 Google 日曆' }).getAttribute('href');
    check(google?.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE'), 'a lesson should link to Google Calendar');
    await page.getByRole('dialog').getByRole('button', { name: '完成' }).click();
    await byTeacher.getByRole('button', { name: '全部' }).click();
    await page.getByRole('button', { name: '依講師', exact: true }).click();
    await page.getByRole('heading', { name: /^浡崴/ }).waitFor();
    await page.getByRole('heading', { name: /^哲瑜/ }).waitFor();
    await page.getByRole('button', { name: '月曆', exact: true }).click();
    await page.locator('.ls-cal').waitFor();
    await page.locator('button.ls-day').first().click();
    check((await page.locator('.ls-row').count()) > 0, 'the picked day should list its lessons');
    await page.getByRole('button', { name: '清單', exact: true }).click();
    await page.getByRole('button', { name: '訂閱行事曆' }).first().click();
    await page.getByRole('dialog', { name: '訂閱行事曆' }).getByRole('button', { name: '完成' }).click();
    await page.getByRole('link', { name: '回到後台' }).click();
    await page.getByRole('heading', { name: '課程', exact: true }).waitFor();
  });

  await run('admin deletes a TD lesson', async () => {
    await unfoldPast();
    await page.getByRole('button', { name: /E2E 加開/ }).click();
    await page.getByRole('dialog', { name: '編輯課程' }).getByRole('button', { name: '刪除' }).click();
    await page.getByRole('dialog', { name: /刪除 1\/2 18:00 哲瑜 的課/ }).getByRole('button', { name: '刪除' }).click();
    await page.getByText('已刪除').waitFor();
    await page.getByRole('button', { name: /E2E 加開/ }).waitFor({ state: 'detached' });
  });

  await run('admin exports the TD timetable and imports it back', async () => {
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下載 JSON' }).click()]);
    const doc = JSON.parse(await (await import('node:fs/promises')).readFile(await file.path(), 'utf8'));
    check(Array.isArray(doc.sessions) && doc.sessions.length > 80 && doc.sessions[0].date, 'export should be a schedule.json');
    doc.sessions = doc.sessions.slice(0, 3);
    await page.locator('input[type="file"]').setInputFiles({ name: 'td.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
    await page.getByRole('dialog', { name: /用檔案裡的 3 堂取代/ }).getByRole('button', { name: '匯入' }).click();
    await page.getByText('已匯入 3 堂').waitFor();
    await page.getByText('共 3 堂').waitFor();
  });

  await run('student sees the notice and the published session', async () => {
    await role(page, '學生');
    await page.getByText('E2E 公告').waitFor();
    check(await page.locator('.hero').isVisible(), 'hero missing');
    check((await page.locator('.rules').textContent()).includes('前一週的週日 12:00'), 'the rules should give the weekly deadline');
  });

  await run('teachers share one view of every PM', async () => {
    await role(page, '老師');
    await page.getByRole('heading', { name: '這週一覽' }).waitFor();
    const byTeacher = page.getByRole('group', { name: '只看哪位老師' });
    check((await byTeacher.getByRole('button').count()) === 4, 'every PM plus 全部 should be offered');
    check((await page.getByText('你的場次').count()) > 0, 'the signed-in PM should see their own sessions marked');
    await byTeacher.getByRole('button', { name: /^Prolong/ }).click();
    check((await page.locator('.li .ls-who', { hasText: 'Joseph' }).count()) === 0, 'another PM is still listed');
    await byTeacher.getByRole('button', { name: /^全部/ }).click();
    await page.getByRole('button', { name: /^下週/ }).click();
    await page.getByRole('heading', { name: '下週一覽' }).waitFor();
  });

  await ctx.close();

  console.log('mobile');
  const m = await session({ width: 390, height: 844 }, true);
  await run('mobile demo + booking grid', async () => {
    await m.page.goto(base + '#/demo', { waitUntil: 'domcontentloaded' });
    await m.page.locator('.demobar').waitFor({ timeout: 60000 });
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    await m.page.locator('.weeks .wk', { hasText: '可預約' }).first().click();
    await m.page.getByRole('button', { name: '開始預約' }).click();
    await m.page.locator('button.cell').first().tap();
    check((await m.page.locator('button.cell[aria-pressed="true"]').count()) === 1, 'tap should pick a cell');
    const overflow2 = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow2 <= 0, `booking page scrolls sideways by ${overflow2}px`);
  });
  await run('mobile admin shows one day at a time', async () => {
    await role(m.page, '助教');
    await m.page.locator('.matrix').waitFor();
    const cols = await m.page.locator('.matrix .mh').count();
    check(cols === 1, `expected 1 day column, got ${cols}`);
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `admin page scrolls sideways by ${overflow}px`);
  });
  await run('mobile teacher view and email page fit the screen', async () => {
    await m.page.locator('.demobar').getByRole('button', { name: '老師', exact: true }).click();
    await m.page.getByRole('heading', { name: '這週一覽' }).waitFor();
    let overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `teacher view scrolls sideways by ${overflow}px`);
    await m.page.locator('.demobar').getByRole('button', { name: '助教', exact: true }).click();
    await m.page.locator('.matrix').waitFor();
    await m.page.evaluate(() => (location.hash = '#/admin/mail'));
    await m.page.getByRole('heading', { name: '每週寄給老師的信' }).waitFor();
    overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `email page scrolls sideways by ${overflow}px`);
  });
  await run('mobile TD timetable fits the screen', async () => {
    await m.page.evaluate(() => (location.hash = '#/td'));
    await m.page.getByRole('heading', { name: '全部課程' }).waitFor();
    for (const view of ['週曆', '月曆', '依講師', '清單']) {
      await m.page.getByRole('button', { name: view, exact: true }).click();
      const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `TD ${view} scrolls sideways by ${overflow}px`);
    }
  });
  await m.ctx.close();
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nE2E FAILED');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nE2E passed');
