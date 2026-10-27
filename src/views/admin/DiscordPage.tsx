import type { ComponentChildren } from 'preact';
import type { DiscordGroup, DiscordMessage, DiscordState } from '../../api/types';
import { useLive } from '../../app/hooks';
import { deadlineText } from '../../lib/format';
import { addDays, agoText, dayLabel, mdPad } from '../../lib/time';
import { Icon } from '../../ui/icons';
import { Loading } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';

const STATUS: Record<string, string> = { open: '已預約', skipped: '這週不約' };
const KIND: Record<string, string> = { ask: '詢問', summary: '下週結果', today: '當天提醒' };
const PLAN: Array<[string, string]> = [
  ['週五 08:00', '問下週要不要約。按「要預約」會跳出表單，填好題目、想問的問題、進度和雲端連結送出就排定；按「不預約」就記下來'],
  ['週六 20:00', '截止，詢問改成結果，按鈕拿掉'],
  ['週日 08:00', '告訴各組下週的結果，有沒有約都會發'],
  ['當天 08:00', '提醒當天有場次的組：時間、業師、討論室和題目'],
];

export function DiscordPage() {
  const { data: st, error, reload } = useLive<DiscordState>('oh_admin_discord', {});
  if (!st) return error ? <ErrorState onRetry={reload} /> : <Loading />;
  const now = Date.now();
  const seen = st.groups.filter((g) => g.ready).length;
  const week = st.week;

  return (
    <main class="page enter">
      <div class="stack tight">
        <p class="eyebrow">Discord 詢問</p>
        <h1 class="title-l">每週在各組頻道發的訊息</h1>
        <p class="muted small" style={{ maxWidth: '640px' }}>
          機器人在各組自己的 Discord 頻道發訊息，組員不用打開網站就能預約或不約
        </p>
      </div>

      <dl class="dc-plan">
        {PLAN.map(([when, what]) => (
          <div key={when}>
            <dt class="mono">{when}</dt>
            <dd class="small">{what}</dd>
          </div>
        ))}
      </dl>

      <section class="card pad-l stack" aria-labelledby="d-bot">
        <div class="row between wrap">
          <h2 class="title-s" id="d-bot">
            機器人
          </h2>
          {st.ready ? (
            <span class="chip ok">
              <span class="dot" />
              已連接
            </span>
          ) : (
            <span class="chip warn">還沒連接</span>
          )}
        </div>
        {st.ready ? (
          <p class="small">
            {st.name}，看得到 {seen} 組的頻道{st.checked_at ? `，${agoText(st.checked_at, now)}檢查過` : ''}
          </p>
        ) : (
          <SetupSteps />
        )}
        {week && (
          <p class="small muted">
            下一次：{dayLabel(addDays(week.deadline.slice(0, 10), -1))} 08:00 詢問 {week.label ? `${week.label} ` : ''}
            {mdPad(week.start)}–{mdPad(addDays(week.start, 4))}，{deadlineText(week.deadline)} 截止
          </p>
        )}
      </section>

      <section class="section" aria-labelledby="d-groups">
        <div class="section-head">
          <h2 id="d-groups">各組頻道</h2>
          <span class="small muted">從各組連結的 Webhook 找到頻道</span>
        </div>
        <div class="list">
          {st.groups.map((g) => (
            <div class="li" key={g.id}>
              <div class="grow stack" style={{ gap: '0px' }}>
                <b>第 {g.no} 組</b>
                {g.name && <span class="small muted">{g.name}</span>}
              </div>
              <GroupChip g={g} />
            </div>
          ))}
        </div>
      </section>

      {st.sample && (
        <section class="section" aria-labelledby="d-preview">
          <div class="section-head">
            <h2 id="d-preview">訊息預覽</h2>
            <span class="small muted">以第 {st.sample_group} 組現在的狀態為例</span>
          </div>
          <div class="dc-previews">
            {(
              [
                ['週五 08:00 詢問', st.sample],
                ['週日 08:00 下週結果', st.sample_summary],
                ['當天 08:00 提醒', st.sample_today],
              ] as const
            ).map(
              ([label, m]) =>
                m && (
                  <div class="stack tight" key={label}>
                    <h3 class="small muted">{label}</h3>
                    <MessagePreview m={m} name={st.name} now={now} />
                  </div>
                ),
            )}
          </div>
        </section>
      )}

      <section class="section" aria-labelledby="d-log">
        <div class="section-head">
          <h2 id="d-log">發送紀錄</h2>
        </div>
        {st.posts.length === 0 ? (
          <p class="muted small">還沒有發過訊息</p>
        ) : (
          <div class="table-wrap" tabIndex={0} role="region" aria-labelledby="d-log">
            <table class="t">
              <thead>
                <tr>
                  <th scope="col">訊息</th>
                  <th scope="col">週次／日期</th>
                  <th scope="col">組別</th>
                  <th scope="col">發出</th>
                  <th scope="col">回覆</th>
                </tr>
              </thead>
              <tbody>
                {st.posts.map((p) => (
                  <tr key={p.id}>
                    <td class="nowrap small">{KIND[p.kind]}</td>
                    <td class="nowrap small mono">{p.week}</td>
                    <td class="nowrap small">第 {p.group_no} 組</td>
                    <td class="nowrap small">{agoText(p.posted_at, now)}</td>
                    <td class="nowrap small">
                      {p.kind !== 'ask' ? (
                        <span class="muted">—</span>
                      ) : (
                        <>
                          {(p.status && STATUS[p.status]) || (p.closed_at ? '沒有回覆' : '還沒決定')}
                          {p.closed_at ? <span class="muted"> · 已截止</span> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function GroupChip({ g }: { g: DiscordGroup }) {
  if (!g.fixed) return <span class="chip">沒有固定時段</span>;
  if (!g.webhook) return <span class="chip warn">沒有連結 Webhook</span>;
  if (!g.channel) return <span class="chip">還沒找到頻道</span>;
  if (!g.ready) return <span class="chip warn">機器人看不到頻道</span>;
  return (
    <span class="chip ok">
      <span class="dot" />
      會收到詢問
    </span>
  );
}

function SetupSteps() {
  return (
    <div class="stack tight small">
      <p>第一次使用要先設定機器人（只需要做一次，由管理 GitHub 的人操作）</p>
      <ol class="stack tight" style={{ margin: 0, paddingLeft: '20px' }}>
        <li>到 Discord Developer Portal 建立新的 Application，在 Bot 頁按 Reset Token，複製 Token</li>
        <li>在 OAuth2 的 URL Generator 勾選 bot，權限勾「檢視頻道」「傳送訊息」，用產生的網址把機器人加進伺服器</li>
        <li>在各組的頻道（或整個分類）的權限加入這個機器人</li>
        <li>在 GitHub 的 repo 設定新增 Secret：DISCORD_BOT_TOKEN（剛剛的 Token）和 SUPABASE_ACCESS_TOKEN（Supabase 帳號的 Access Token）</li>
        <li>在 GitHub Actions 依序執行 Test and deploy、Discord weekly ask（setup），這裡就會顯示已連接</li>
      </ol>
    </div>
  );
}

/** "4 天後": Discord's <t:…:R> countdown, roughly. */
function countdown(unix: number, now: number) {
  const ms = unix * 1000 - now;
  const [n, unit] = Math.abs(ms) >= 86_400_000 ? [ms / 86_400_000, '天'] : Math.abs(ms) >= 3_600_000 ? [ms / 3_600_000, '小時'] : [ms / 60_000, '分鐘'];
  return `${Math.round(Math.abs(n))} ${unit}${ms >= 0 ? '後' : '前'}`;
}

/** Discord's inline marks: **bold**, ~~struck~~, [links](<url>), <url>, <t:…:R> and \-escapes. */
function inline(text: string, now: number): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /\\([\\*_~`|<>#[\]()-])|\*\*(.+?)\*\*|~~(.+?)~~|\[([^\]]+)\]\(<?(https?:\/\/[^)>\s]+)>?\)|<(https?:\/\/[^>\s]+)>|<t:(\d+):R>/g;
  let last = 0;
  for (const x of text.matchAll(re)) {
    out.push(text.slice(last, x.index));
    if (x[1]) out.push(x[1]);
    else if (x[2]) out.push(<b>{inline(x[2], now)}</b>);
    else if (x[3]) out.push(<s>{inline(x[3], now)}</s>);
    else if (x[4])
      out.push(
        <a href={x[5]} target="_blank" rel="noopener noreferrer">
          {x[4]}
        </a>,
      );
    else if (x[6]) out.push(x[6]);
    else out.push(countdown(Number(x[7]), now));
    last = x.index + x[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const BLOCKS: Array<[string, string]> = [['### ', 'dc-h3'], ['## ', 'dc-h2'], ['-# ', 'dc-sub'], ['> ', 'dc-quote']];

/** Roughly how Discord shows the message: headings, small text, quotes, the buttons. */
function MessagePreview({ m, name, now }: { m: DiscordMessage; name: string | null; now: number }) {
  const buttons = m.components.flatMap((row) => row.components);
  return (
    <div class="dc-msg">
      <div class="dc-head">
        <span class="dc-avatar" aria-hidden="true">
          OH
        </span>
        <b>{name ?? 'Office Hour'}</b>
        <span class="dc-tag">機器人</span>
      </div>
      <div class="dc-body">
        {m.content.split('\n').map((line, i) => {
          const [mark, cls] = BLOCKS.find(([p]) => line.startsWith(p)) ?? ['', ''];
          return (
            <p key={i} class={cls}>
              {inline(line.slice(mark.length), now)}
            </p>
          );
        })}
      </div>
      {buttons.length > 0 && (
        <div class="dc-buttons">
          {buttons.map((b) => (
            <span key={b.label} class={`dc-btn s${b.style}`}>
              {b.label}
              {b.style === 5 && <Icon name="external" size={14} />}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
