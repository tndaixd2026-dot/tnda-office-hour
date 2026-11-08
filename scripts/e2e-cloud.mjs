// Multi-user test against a real Supabase stack (local `supabase start`):
// two teammates edit the same request at once, an admin publishes, and
// everyone's screen updates in real time.
//
//   node scripts/e2e-cloud.mjs http://localhost:5173/ <group code> <admin code>
import { chromium } from 'playwright';

const [base = 'http://localhost:5173/', groupCode, adminCode] = process.argv.slice(2);
if (!groupCode || !adminCode) {
  console.error('usage: node scripts/e2e-cloud.mjs <url> <group code> <admin code>');
  process.exit(2);
}
const problems = [];
const RUN = Date.now().toString(36).slice(-5);
let step = '';
const check = (c, m) => {
  if (!c) throw new Error(`${step}: ${m}`);
};
async function run(name, fn) {
  step = name;
  const t0 = Date.now();
  await fn();
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
async function person() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${step}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|fonts\.g|WebSocket|status of 400/.test(m.text())) problems.push(`[${step}] console: ${m.text()}`);
  });
  return page;
}

async function join(page, code, name) {
  await page.goto(`${base}#/join/${code}`, { waitUntil: 'networkidle' });
  if (name) {
    await page.getByLabel('你的名字').fill(name);
    await page.getByRole('button', { name: '加入小組' }).click();
  } else {
    await page.getByRole('button', { name: '進入' }).click();
  }
}

try {
  const a = await person();
  const b = await person();
  const admin = await person();

  await run('two teammates and an admin sign in', async () => {
    await join(a, groupCode, `組員甲-${RUN}`);
    await join(b, groupCode, `組員乙-${RUN}`);
    await join(admin, adminCode);
    await a.getByText('每週預約').waitFor();
    await b.getByText('每週預約').waitFor();
    await admin.locator('.stat-pills').waitFor();
  });

  let weekLabel = '';
  await run('A books the week; B sees it appear', async () => {
    const wk = a.locator('.weeks .wk', { hasText: '可預約' }).first();
    weekLabel = (await wk.locator('.w').textContent()) ?? '';
    await wk.click();
    await a.getByRole('button', { name: /預約這週|改成預約/ }).first().click();
    await a.getByLabel('想討論的題目').fill(`甲的題目-${RUN}`);
    await a.getByLabel('想問 PM 的問題').fill('甲想問的問題');
    await a.getByLabel('目前進度').fill('甲寫的進度');
    await a.getByLabel('雲端資料夾連結').fill('https://drive.google.com/drive/folders/e2e-cloud');
    await a.getByRole('button', { name: '預約這週' }).click();
    await a.getByText(`甲的題目-${RUN}`).first().waitFor();
    await b.locator('.weeks .wk', { hasText: weekLabel }).first().click();
    await b.getByText(`甲的題目-${RUN}`).first().waitFor({ timeout: 10000 });
  });

  await run('B edits while A edits; the conflict is caught', async () => {
    await a.getByRole('button', { name: '修改內容' }).click();
    await b.getByRole('button', { name: '修改內容' }).click();
    await a.getByLabel('想討論的題目').fill(`甲改過的題目-${RUN}`);
    await b.getByLabel('想討論的題目').fill(`乙改過的題目-${RUN}`);
    await a.getByRole('button', { name: '更新內容' }).click();
    await a.getByText(`甲改過的題目-${RUN}`).first().waitFor();
    // B is now editing an outdated version: a banner appears, saving asks what to do
    await b.getByText(/剛剛更新了這週的預約/).waitFor({ timeout: 10000 });
    await b.getByRole('button', { name: '更新內容' }).click();
    await b.getByRole('dialog', { name: '組員剛剛也改了這週的預約' }).waitFor();
    await b.getByRole('button', { name: '用我的版本' }).click();
    await b.getByText(`乙改過的題目-${RUN}`).first().waitFor();
    await a.getByText(`乙改過的題目-${RUN}`).first().waitFor({ timeout: 10000 });
  });

  await run('the admin and both teammates see the session without reloading', async () => {
    await admin.locator('.weeks .wk', { hasText: weekLabel }).first().click();
    await admin.getByText(`乙改過的題目-${RUN}`).first().waitFor({ timeout: 10000 });
    await b.locator('.hero').getByText('下一次 Office Hour').waitFor({ timeout: 10000 });
  });

  await run('a cancellation reaches the admin', async () => {
    const cancel = a.getByRole('button', { name: '取消這次' });
    if (await cancel.count()) {
      await cancel.click();
      await a.getByRole('dialog').getByLabel(/原因/).fill('E2E 取消');
      await a.getByRole('button', { name: '確定取消' }).click();
      await admin.getByText(/取消了/).first().waitFor({ timeout: 10000 });
    } else {
      console.log('    (session within the cut-off; skipped)');
    }
  });

  await run('a revoked device is signed out', async () => {
    await admin.getByRole('complementary', { name: '管理選單' }).getByRole('link', { name: '小組與邀請' }).click();
    const chip = admin.locator('button.chip', { hasText: `組員乙-${RUN}` }).first();
    await chip.click();
    await admin.getByRole('button', { name: '登出這個裝置' }).click();
    await b.reload();
    await b.getByRole('heading', { name: '輸入邀請代碼' }).waitFor({ timeout: 10000 });
  });
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nCLOUD E2E FAILED');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nCloud E2E passed');
