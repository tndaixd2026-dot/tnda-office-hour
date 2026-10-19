# Office Hour 預約平台：給 Claude 的工作說明

TN0006「跨域數位製作實務」的 Office Hour 預約平台，名稱是「叁式 30 分鐘 一週三次」（`src/config.ts` 的 `APP_NAME`，另外寫在 `index.html` 和 `public/manifest.webmanifest`）。規則是每組每週最多 3 次、每次 30 分鐘、一天一次（設定裡的每週上限 3 格、每天上限 1 格）。學生以小組為單位勾選可以的時段，助教排程後發布，老師只看到排給自己的場次，所有畫面即時同步。使用說明、架構圖、展示腳本在 `README.md`。

另外有一份 **TD 專班課表**（週三 VSAI 課程的助教課，和週四的跨域課不是同一批學生），公開頁在 `#/td`，不用登入；助教在後台「TD 課表」編輯、匯入或匯出（格式同原本獨立網站的 `schedule.json`）。資料在 `app.lessons`、`app.lesson_info`，API 是 `oh_lessons`（公開）、`oh_admin_lesson_*`、`oh_admin_lessons_*` 和公開行事曆 `oh_lessons_calendar`。同一時間只能有一堂課（`LESSON_CLASH`）。課表是公開的：薪資、時數、助教不能上課的日期、週三進階課不要放進去。學生名單（含個資）在 Notion，不要匯入這個平台。

- Repo：`tndaixd2026-dot/tnda-office-hour`（public）
- 網站：https://tndaixd2026-dot.github.io/tnda-office-hour/（示範模式：`#/demo`）
- 資料庫：Supabase 組織「TNDA Office Hour」，東京區，專案 ref 在 `.env.production` 的網址裡

## 使用者的長期要求

- **用繁體中文回覆**。介面文字用繁體中文；程式碼註解和 commit message 沿用既有的英文風格。
- **介面文字結尾不加標點**：網頁上的句子、提示、錯誤訊息、toast 結尾都不加句號（句子中間的標點照常）；首頁大標題不用標點，用換行分開；一行的名稱用空格隔開。問號可以保留。
- **全部免費**：只用免費方案（GitHub Pages／Actions、Supabase Free、jsDelivr、Google Fonts、Discord Webhook）。不要加入需要付款方式或可能收費的服務。只有付費才做得到的功能，要先說明並提出免費的替代做法。
- **改版直接做完再回報**：自己修改、測試、部署，並在正式網站驗證，完成後再用簡短的中文說明結果。
- **品質**：極簡、容易上手；手機寬度可用；淺色和深色模式都要檢查；符合 WCAG 2.2 AA（axe 掃描必須沒有問題）。

## 秘密

- 小組、老師、助教的代碼和資料庫密碼，**不要貼進對話、commit、issue 或 log**。產生或更換後寫進 `.secrets/`。
- `.secrets/`（已 gitignore）：`db-password.txt`、`admin-code.txt`、`project-ref.txt`。換電腦時用 AirDrop 這類離線方式搬，不要經過 Git、Email 或聊天。
- 助教登入連結由使用者自己保管在 repo 外。
- GitHub repo secret `SUPABASE_DB_PASSWORD`：資料庫密碼，給 GitHub Actions 推 migration 用。更換資料庫密碼時要一起更新（repo → Settings → Secrets and variables → Actions）。
- `.env.production` 裡的 Supabase publishable key 本來就是公開的（只能呼叫 `oh_*` 函式），可以 commit。

## 架構

- 前端：Vite + Preact 11 + TypeScript，hash 路由，`base: './'`，所以換帳號或改 repo 名稱都不影響網站運作。部署在 GitHub Pages；邀請連結從 `location` 組出來。
- 後端：Supabase（Postgres 17）。資料表都放在私有的 `app` schema（RLS 開啟、沒有 policy、沒有 grant）。瀏覽器**只能**呼叫 `public.oh_*`（SECURITY DEFINER、`set search_path = ''`）。登入方式是用代碼或名字換 session token，資料庫只存 token 的 SHA-256。名字登入（`oh_login`）：學生比對 `app.roster`（助教在「小組與邀請」維護的學生名單），老師比對 `app.teachers.name`，助教比對 `app.admins.name`（只限 `name_login` 為 true 的帳號），比較鍵是 `app.name_key()`（NFKC、小寫、去空白）。名為「助教」的原始帳號 `name_login = false`，只能用代碼登入，是備用帳號，`.secrets/admin-code.txt` 就是它的代碼。這是使用者明確選擇的便利性取捨（知道名字就能登入），不要擅自改回代碼制。
- 會議地點與時段容量：所有場次都在設定「地點」裡的同一個 Google Meet 會議室（網址會顯示成連結，`Place` 元件）。所以**同一時段只排一組**，不管幾位老師開放：排程器 `autoSchedule` 的 `perSlot` 預設 1、`app.assign` 對已有別組的時段回報軟性問題 `SLOT_TAKEN`、`oh_student_state` 的 `full` 讓學生看到「已排滿」。要改回多會議室時，這三處要一起改。
- 即時同步：資料表的 statement trigger 呼叫 `app.ping()`，送到私有 Realtime 頻道 `oh-sync`（RLS 只允許收聽）。前端收到後重抓資料（節流 1.5 秒），另外在視窗取得焦點、恢復連線時，以及每 60 秒也會重抓。
- 示範模式（`#/demo`）：在瀏覽器裡用 PGlite 跑**同一套** migration，再載入 `src/db/demo.sql`（日期以今天為基準）。
- Discord：用 pg_net 非同步送出，並設 `allowed_mentions: {parse: []}`，學生寫的 @everyone 不會真的標記所有人。
- 行事曆訂閱：`oh_calendar` 透過 PostgREST 的 `"*/*"` domain 回傳 `text/calendar`。GET 請求會把 `apikey` 當成函式參數傳進來，所以函式簽名必須保留 `apikey`。

| 位置 | 內容 |
|---|---|
| `supabase/migrations/` | 資料表、API 函式、Discord、登入期限、私有即時頻道、行事曆、名字登入與學生名單 |
| `supabase/seed.sql` | 課程初始資料 |
| `src/db/sql.ts` | 示範模式的 bootstrap 和 `MIGRATIONS` 清單 |
| `src/api/` | `cloud.ts`（Supabase）和 `demo.ts`（PGlite）實作同一個 `Engine` 介面 |
| `src/app/` | 登入狀態、hooks（`useLive` 負責即時重抓）、路由 |
| `src/views/` | `student/`、`teacher/`、`admin/`（含 `LessonsAdmin.tsx`）、`lessons/`（TD 課表公開頁）、`Welcome.tsx` |
| `src/lib/` | 時間計算、閃身步排程法（最大流）、ICS／CSV 匯出、TD 課表分組（`lessons.ts`） |
| `src/ui/`、`src/styles/app.css` | 元件、對話框、圖示、toast、樣式 |
| `tests/` | Vitest；資料庫規則用 PGlite 執行真正的 SQL |
| `scripts/` | E2E、axe 掃描、雲端檢查、本機重置、學期重置 |

## 修改流程

1. 修改程式。資料庫變更**只能新增** `supabase/migrations/` 的檔案（已部署的不要改），同時加進 `src/db/sql.ts` 的 `MIGRATIONS`。新的 migration 結尾照既有檔案的做法：撤銷 `app` 函式的 public 執行權，新的 `oh_*` 函式只 grant 給 `anon, authenticated`。
2. 在本機驗證：
   ```bash
   npm run typecheck && npm test
   npm run build && npx vite preview --port 4173 --strictPort &
   node scripts/e2e.mjs http://localhost:4173/
   FAKE_TIME=2026-10-23T19:00:00+08:00 node scripts/e2e.mjs http://localhost:4173/
   node scripts/a11y.mjs http://localhost:4173/
   ```
   要測多人即時同步時，改用本機 Supabase：`colima start`、`supabase start`、`npm run db:reset-local`，再執行 `npm run e2e:cloud -- http://localhost:5173/ LOCALG02 LOCALADMIN01`。這兩個代碼只存在本機資料庫。
3. 新的 migration 不用手動推：push 到 `main` 後，GitHub Actions 的 `migrate` job 會在測試全部通過後執行 `supabase db push`，再部署網站。其他分支和 PR 只會列出待套用的 migration（dry run）。需要手動推時，在 Mac 上執行 `supabase db push --yes`。**絕對不要**對正式資料庫執行 `supabase db reset`，`scripts/local-reset.sh` 也只能用在本機。
4. Commit 後 push 到 `main`。GitHub Actions 會依序跑型別檢查、測試、建置、三個時間點的 E2E 和 axe 掃描，全部通過才推送 migration、部署到 Pages。用 `gh run watch` 等結果。
5. 到正式網站驗證：`npm run db:test-cloud`（唯讀的雲端安全檢查），再打開網站，親自看一次改過的畫面。

## 容易出錯的地方

- Preact 11 **不會**自動幫數字補 `px`：inline style 要寫成 `'16px'`，不能寫 `16`。
- 所有時間都以 `settings.timezone`（Asia/Taipei）計算。前端測試用 `FAKE_TIME` 模擬時間；資料庫的 `app.now()` 只要不是透過 `authenticator` 連線，就能用 `app.now` 設定值模擬。
- 對話框的自動聚焦要放在 `useLayoutEffect`，否則使用者打字很快時，焦點會被搶走。
- 新增 `oh_*` 函式時要驗證 token，錯誤用 `app.err()` 回傳錯誤代碼，並在 `tests/` 補上測試。
- 連正式資料庫：`PGPASSWORD="$(cat .secrets/db-password.txt)" /opt/homebrew/opt/libpq/bin/psql "postgresql://postgres.$(cat .secrets/project-ref.txt)@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"`

## 定期維護

- **開學前**：
  1. 確認 Supabase 專案沒有暫停。如果暫停了，到後台按 Resume（免費）。
  2. 執行 `gh workflow enable keepalive.yml`。公開 repo 連續 60 天沒有 commit 時，GitHub 會停用這個排程，而且停用後不會自己恢復。
  3. 新學期要清空紀錄時，**先問過使用者**，再執行 `scripts/fresh-start.sql`。執行後所有舊連結都會失效，學生名單也會清空，要請助教重新填。TD 專班課表不會被清掉，要在後台「TD 課表」用匯入換掉。
- Supabase 免費專案閒置 7 天就會暫停，學期中有人使用就不會。暫停前一週和暫停當下，Supabase 都會寄信給組織擁有者。

## 換電腦或換帳號

- 需要安裝：Node 24、`gh`、Supabase CLI；只有本機雲端測試需要 Colima 和 Docker。
- `gh auth login` 登入 `tndaixd2026-dot`，用 `gh repo clone tndaixd2026-dot/tnda-office-hour` 取得 repo，把 `.secrets/` 放到 repo 根目錄，然後執行 `npm ci` 和 `npx playwright install chromium`。
- 執行 `supabase login`，再執行 `supabase link --project-ref "$(cat .secrets/project-ref.txt)"`。登入的 Supabase 帳號必須是組織「TNDA Office Hour」的成員。
- 在 repo 內設定 commit 身分：`git config user.name tndaixd2026-dot`、`git config user.email 317161189+tndaixd2026-dot@users.noreply.github.com`。
- 網址：部署時會自動使用 GitHub Pages 的實際網址。搬到別的帳號後，要把 `README.md`、`.env.production`、`supabase/config.toml` 裡的舊網址一起更新。
- 搬到別的 repo 後，要在新 repo 重新設定 secret `SUPABASE_DB_PASSWORD`，否則 `main` 的部署會在 `migrate` 這一步停下。
