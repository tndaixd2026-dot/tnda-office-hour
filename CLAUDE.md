# Office Hour 預約平台：給 Claude 的工作說明

TN0006「跨域數位製作實務」的 Office Hour 預約平台，名稱是「叁式 ULTRACOMBOS One Hour a Week」（`src/config.ts` 的 `APP_NAME` 和手機用的 `APP_SHORT_NAME`，另外寫在 `index.html`、`public/manifest.webmanifest`、`scripts/send-mail.mjs` 的寄件人名稱，以及信件頁首的 `app.mail_message`／`app.mail_remind`，改名時要新增 migration）。規則是每組有一個固定時段（業師、星期、時間，每次 60 分鐘），每週決定要不要用：送出就排定（設定裡 `slot_minutes` 60、每週上限 1、每天上限 1）。所有畫面即時同步。使用說明、架構圖、展示腳本在 `README.md`。

每週的節奏：之後的每一週都能先約，每週只看自己的截止時間（`app.week_bookable()`；`app.booking_week()` 是下一個還沒截止的週，學生畫面預設和 Discord 詢問用它）；各組在**前一週的週六 20:00** 前按「預約這週」（`oh_booking_save`，題目、想問的問題、進度、雲端連結都必填，直接建立已確認的場次）或「這週不約」（`oh_booking_skip`，`requests.status = 'skipped'`）。截止（設定的 `close_dow`／`close_time`，`app.week_deadline()`）後不能再改（`WEEK_LATE`），已排定的場次在開始前 `cancel_hours` 小時可以自己取消。固定時段那天是全天休息日（`app.fixed_holiday()`）就停一次（`WEEK_HOLIDAY`）。業師臨時有事時，助教在排程頁「代班」「改期」「取消」（`oh_admin_move`、`oh_admin_remove`）；學生之後修改內容不會蓋掉助教的調整。機器人在各組的 Discord 頻道：**週五 08:00** 問下週要不要約，可以直接在 Discord 預約（表單）或不約；**週六 20:00** 截止後訊息改成結果；**週日 08:00** 告訴各組下週的結果（有沒有約都發）；**場次當天 08:00** 提醒那一組。**週日 18:00** 寄預覽到助教信箱，**週一 08:00** 寄信給收件人。週日 12:00 的審核提醒（`app.mail_remind`）已經停用，`lead_days` 也不用了。

老師端是同一個畫面：三位老師（Joseph、Prolong、Tim）和共用帳號「叁式」（`app.teachers.team = true`，給業師公司或老師助理）登入後都看到三位老師的全部場次。共用帳號不會被排進任何場次、不能有開放時段（`app.not_team()` trigger），行事曆包含所有老師的場次。

另外有一份 **TD 專班課表**（週三 VSAI 課程的助教課，和週四的跨域課不是同一批學生），公開頁在 `#/td`，不用登入；助教在後台「TD 課表」編輯、匯入或匯出（格式同原本獨立網站的 `schedule.json`）。資料在 `app.lessons`、`app.lesson_info`、`app.lesson_units`，API 是 `oh_lessons`（公開）、`oh_admin_lesson_*`、`oh_admin_lesson_unit_*`、`oh_admin_lessons_*` 和公開行事曆 `oh_lessons_calendar`。同一時間只能有一堂課（`LESSON_CLASH`）。每種類型可以分成單元（基礎教學（一）、（二）…）：一堂課最多屬於一個同類型的單元（複合外鍵 `(unit_id, kind)`），單元的 `sort` 永遠是 1、2、3…（`app.lesson_units_renumber()`），公開頁、匯出的 JSON 和行事曆都用這個編號；單元的說明是給學生看的。每種類型一開始先列好（一）到（十）（主題可以空著，公開頁只顯示有主題或有排課的單元）。類型比例：`app.lesson_info.ratio`（三個 0–20 的整數，順序同 `app.lesson_kinds()`），前端的 `planRatio()` 算出要改哪幾堂（改動最少、平均分散、沒分單元的優先），`oh_admin_lessons_retype` 再逐堂檢查並一次改完；已經開始的課和 `app.lessons.confirmed`（後台的「已確定」）不能被改（`LESSON_FIXED`）。顏色：類型用 `kindClass()`（`k0`–`k2`，方塊、色條、底色），講師用 `teacherClass()`（`tc0`–`tc3`，圓點），兩組色票分開。課表是公開的：薪資、時數、助教不能上課的日期、週三進階課不要放進去。學生名單（含個資）在 Notion，不要匯入這個平台。

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
- GitHub repo secret `SUPABASE_DB_PASSWORD`：資料庫密碼，給 GitHub Actions 推 migration 和寄信用。更換資料庫密碼時要一起更新（repo → Settings → Secrets and variables → Actions）。
- GitHub repo secret `DISCORD_BOT_TOKEN`：Discord 每週詢問的機器人 Token；`SUPABASE_ACCESS_TOKEN`：部署 Edge Function `supabase/functions/discord` 用的 Supabase Access Token。都由使用者自己設定，沒有設定時對應的步驟會跳過。
- GitHub repo secret `GMAIL_USER`、`GMAIL_APP_PASSWORD`：寄每週信的 Gmail 和它的應用程式密碼（不是登入密碼），由使用者自己設定。收件人的 Email 存在資料庫（`app.mail_recipients`），在後台「寄信通知」維護，不要寫進 repo。Actions 的紀錄是公開的，寄信腳本只能印主旨和數量，不能印 Email。
- `.env.production` 裡的 Supabase publishable key 本來就是公開的（只能呼叫 `oh_*` 函式），可以 commit。

## 架構

- 前端：Vite + Preact 11 + TypeScript，hash 路由，`base: './'`，所以換帳號或改 repo 名稱都不影響網站運作。部署在 GitHub Pages；邀請連結從 `location` 組出來。
- 後端：Supabase（Postgres 17）。資料表都放在私有的 `app` schema（RLS 開啟、沒有 policy、沒有 grant）。瀏覽器**只能**呼叫 `public.oh_*`（SECURITY DEFINER、`set search_path = ''`）。登入方式是用代碼或名字換 session token，資料庫只存 token 的 SHA-256。名字登入（`oh_login`）：學生比對 `app.roster`（助教在「小組與邀請」維護的學生名單），老師比對 `app.teachers.name`，助教比對 `app.admins.name`（只限 `name_login` 為 true 的帳號），比較鍵是 `app.name_key()`（NFKC、小寫、去空白）。名為「助教」的原始帳號 `name_login = false`，只能用代碼登入，是備用帳號，`.secrets/admin-code.txt` 就是它的代碼。這是使用者明確選擇的便利性取捨（知道名字就能登入），不要擅自改回代碼制。
- 固定時段：`app.groups.teacher_id`／`slot_dow`／`slot_time`（三個都有或都沒有，`oh_admin_save` 的 `group` 檢查；時間要整點），助教在「小組與邀請」每組卡片的「固定時段」設定。共用帳號不能當固定業師（`app.not_team()` trigger）。學生畫面的 `oh_student_state.fixed`、每週的 `status`／`bookable`／`holiday`。
- 討論室：每位業師一間 Google Meet（`app.teachers.room`，老師頁「設定討論室」），`app.room_of()` 沒有設定時退回設定的「地點」。學生、老師畫面、行事曆（`oh_calendar`）、每週的信（`app.mail_message`）和 Discord 通知都用場次業師的討論室，所以同一時段可以有好幾組，`app.assign` 不再檢查 `SLOT_TAKEN`／`NOT_REQUESTED`。
- 舊制還留在資料庫裡但畫面不用了：勾選時段的 `oh_request_save`／`oh_request_withdraw`、閃身步排程法（`src/lib/scheduler.ts`、`oh_admin_apply`）。舊制的測試用 `makeDb({ legacy: true })` 跑在舊設定上。
- 即時同步：資料表的 statement trigger 呼叫 `app.ping()`，送到私有 Realtime 頻道 `oh-sync`（RLS 只允許收聽）。前端收到後重抓資料（節流 1.5 秒），另外在視窗取得焦點、恢復連線時，以及每 60 秒也會重抓。
- 示範模式（`#/demo`）：在瀏覽器裡用 PGlite 跑**同一套** migration，再載入 `src/db/demo.sql`（日期以今天為基準）。
- Discord：用 pg_net 非同步送出，並設 `allowed_mentions: {parse: []}`，學生寫的 @everyone 不會真的標記所有人。
- 行事曆訂閱：`oh_calendar` 透過 PostgREST 的 `"*/*"` domain 回傳 `text/calendar`。GET 請求會把 `apikey` 當成函式參數傳進來，所以函式簽名必須保留 `apikey`。
- Discord 每週詢問：`.github/workflows/discord.yml` 執行 `scripts/discord-ask.mjs`（每天 08:00 `morning`：當天提醒 `today`，週五加上詢問 `ask`、週日加上下週結果 `summary`；週六 20:01 `close`；手動可選 `setup`、`ask`、`summary`、`today`，或用 `refresh` 把還沒截止的詢問更新成現在的樣子）。腳本每次都先做設定：從 `GET /applications/@me` 讀出 Public Key 存進 `app.discord_bot`，把機器人的 Interactions Endpoint 設成 Edge Function（只在原本是空的時候設，不搶別的服務），從各組的 Webhook 查出頻道（`groups.discord_channel`、`discord_ready`）。詢問是 `app.discord_message`、下週結果是 `app.discord_summary`、當天提醒是 `app.discord_today_message`，發過的記在 `app.discord_posts`／`app.discord_notes`，每組每則只發一次。訊息用 Discord 的 markdown（`##` 標題、`###` 時間、`-#` 小字，截止時間用 `<t:…:R>` 倒數；學生和助教打的字一律經過 `app.discord_escape`）。按鈕和表單由 `supabase/functions/discord`（驗證 Ed25519 簽章，`handler.ts` 不依賴執行環境、`tests/discord-function.test.ts` 直接測它）交給 `app.discord_interaction`，用 `app.booking_save`／`app.booking_skip` 預約，規則和網站相同。「這週不約」按鈕帶著畫出訊息時的版本，舊訊息上按只會更新訊息。Edge Function 由 `deploy.yml` 的 `migrate` job 用 `SUPABASE_ACCESS_TOKEN` 部署（`--use-api`，關閉 JWT 檢查，`supabase/config.toml` 的 `[functions.discord]`）。
- 每週寄信：`.github/workflows/mail.yml` 執行 `scripts/send-mail.mjs`（用 `SUPABASE_DB_PASSWORD` 連 pooler，用 Gmail SMTP 寄）。信的內容全部由 `app.mail_outbox`／`app.mail_message` 在資料庫產生，後台預覽（`oh_admin_mail_preview`）和實際寄出的是同一份；`app.mail_log` 防止同一週重複寄（`FORCE=1` 才會再寄）。本機試跑：`DATABASE_URL=… KIND=weekly MAIL_TEST=1 node scripts/send-mail.mjs`。

| 位置 | 內容 |
|---|---|
| `supabase/migrations/` | 資料表、API 函式、Discord、登入期限、私有即時頻道、行事曆、名字登入與學生名單、TD 課表、單元與類型比例、老師共用畫面、每週截止、每週寄信、固定時段與業師討論室、提前預約、Discord 每週詢問 |
| `supabase/functions/discord/` | Discord 按鈕和表單的 Edge Function（Deno，有自己的 `deno.json`） |
| `supabase/seed.sql` | 課程初始資料 |
| `src/db/sql.ts` | 示範模式的 bootstrap 和 `MIGRATIONS` 清單 |
| `src/api/` | `cloud.ts`（Supabase）和 `demo.ts`（PGlite）實作同一個 `Engine` 介面 |
| `src/app/` | 登入狀態、hooks（`useLive` 負責即時重抓）、路由 |
| `src/views/` | `student/`、`teacher/`、`admin/`（含 `LessonsAdmin.tsx`）、`lessons/`（TD 課表公開頁）、`Welcome.tsx` |
| `src/lib/` | 時間計算、閃身步排程法（舊制，最大流）、ICS／CSV 匯出、TD 課表分組（`lessons.ts`） |
| `src/ui/`、`src/styles/app.css` | 元件、對話框、圖示、toast、樣式 |
| `tests/` | Vitest；資料庫規則用 PGlite 執行真正的 SQL |
| `scripts/` | E2E、axe 掃描、雲端檢查、本機重置、學期重置、每週寄信（`send-mail.mjs`）、Discord 每週詢問（`discord-ask.mjs`） |

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
- Supabase 對 API 請求載入了 pg-safeupdate：函式裡的 `delete`、`update` **一定要有 WHERE**，要全部就寫 `where true`，否則正式網站會出現「21000 DELETE requires a WHERE clause」（PGlite 和本機測試不會報錯，`tests/safeupdate.test.ts` 會檢查）。
- 連正式資料庫：`PGPASSWORD="$(cat .secrets/db-password.txt)" /opt/homebrew/opt/libpq/bin/psql "postgresql://postgres.$(cat .secrets/project-ref.txt)@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"`

## 定期維護

- **開學前**：
  1. 確認 Supabase 專案沒有暫停。如果暫停了，到後台按 Resume（免費）。
  2. 執行 `gh workflow enable keepalive.yml`、`gh workflow enable mail.yml` 和 `gh workflow enable discord.yml`。公開 repo 連續 60 天沒有 commit 時，GitHub 會停用排程，而且停用後不會自己恢復。
  3. 新學期要清空紀錄時，**先問過使用者**，再執行 `scripts/fresh-start.sql`。執行後所有舊連結都會失效，學生名單也會清空，要請助教重新填。TD 專班課表不會被清掉，要在後台「TD 課表」用匯入換掉。
- Supabase 免費專案閒置 7 天就會暫停，學期中有人使用就不會。暫停前一週和暫停當下，Supabase 都會寄信給組織擁有者。

## 換電腦或換帳號

- 需要安裝：Node 24、`gh`、Supabase CLI；只有本機雲端測試需要 Colima 和 Docker。
- `gh auth login` 登入 `tndaixd2026-dot`，用 `gh repo clone tndaixd2026-dot/tnda-office-hour` 取得 repo，把 `.secrets/` 放到 repo 根目錄，然後執行 `npm ci` 和 `npx playwright install chromium`。
- 執行 `supabase login`，再執行 `supabase link --project-ref "$(cat .secrets/project-ref.txt)"`。登入的 Supabase 帳號必須是組織「TNDA Office Hour」的成員。
- 在 repo 內設定 commit 身分：`git config user.name tndaixd2026-dot`、`git config user.email 317161189+tndaixd2026-dot@users.noreply.github.com`。
- 網址：部署時會自動使用 GitHub Pages 的實際網址。搬到別的帳號後，要把 `README.md`、`.env.production`、`supabase/config.toml` 裡的舊網址一起更新。
- 搬到別的 repo 後，要在新 repo 重新設定 secret `SUPABASE_DB_PASSWORD`，否則 `main` 的部署會在 `migrate` 這一步停下。
