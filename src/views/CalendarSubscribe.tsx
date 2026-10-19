import { useEffect, useState } from 'preact/hooks';
import { useApi, useBusy } from '../app/hooks';
import { HAS_CLOUD, SUPABASE_KEY, SUPABASE_URL } from '../config';
import { confirm, openDialog } from '../ui/dialog';
import { Icon } from '../ui/icons';
import { Btn, CopyBtn, Spinner } from '../ui/kit';

function feedUrl(feed: string) {
  const u = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/oh_calendar`);
  u.searchParams.set('p_feed', feed);
  u.searchParams.set('apikey', SUPABASE_KEY);
  return u.toString();
}

/**
 * Opens the "subscribe to your calendar" dialog. `download` exports the
 * current sessions once, for people who prefer a plain file.
 */
export function openCalendarDialog(opts: { who: 'teacher' | 'team' | 'student'; download: () => void }) {
  openDialog('訂閱行事曆', (close) => <CalendarDialog who={opts.who} download={opts.download} close={close} />, { wide: 'wide' });
}

function CalendarDialog({ who, download, close }: { who: 'teacher' | 'team' | 'student'; download: () => void; close: () => void }) {
  const { engine, call } = useApi();
  const { busy, run } = useBusy();
  const [feed, setFeed] = useState<string | null>(null);
  const demo = engine?.mode === 'demo' || !HAS_CLOUD;

  useEffect(() => {
    if (demo) return;
    run('load', () => call<{ feed: string }>('oh_calendar_feed')).then((r) => r && setFeed(r.feed));
  }, []);

  const url = feed ? feedUrl(feed) : '';
  const webcal = url.replace(/^https:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;

  const reset = async () => {
    const ok = await confirm({
      title: '重新產生訂閱連結？',
      body: `舊連結會立刻失效${who === 'student' ? '（組員訂閱的也會）' : ''}，需要用新連結重新訂閱一次。連結外流時才需要這麼做`,
      ok: '重新產生',
      danger: true,
    });
    if (!ok) return;
    const r = await run('reset', () => call<{ feed: string }>('oh_calendar_feed', { p_reset: true }), { ok: '已產生新連結' });
    if (r) setFeed(r.feed);
  };

  return (
    <>
      <div class="stack tight">
        <h2>訂閱行事曆</h2>
        <p class="muted small">
          訂閱一次，之後{who === 'team' ? '每位老師的' : who === 'teacher' ? '排給你的' : '你們這組的'}場次都會自動出現在行事曆裡，時間異動或取消也會跟著更新，開始前 15 分鐘提醒
        </p>
      </div>

      {demo ? (
        <div class="notice info">
          <Icon name="info" />
          <span class="small">示範模式沒有雲端資料庫，所以不能訂閱；正式網站可以。你仍然可以下載目前的場次</span>
        </div>
      ) : !feed ? (
        <div class="row" style={{ justifyContent: 'center', padding: '16px' }}>
          <Spinner />
        </div>
      ) : (
        <div class="stack">
          <div class="row wrap">
            <a class="btn primary" href={google} target="_blank" rel="noopener noreferrer">
              <Icon name="calendar" /> 加到 Google 日曆
            </a>
            <a class="btn" href={webcal}>
              <Icon name="calendar" /> Apple 行事曆／Outlook
            </a>
          </div>
          <div class="card sunk tight stack tight">
            <span class="eyebrow">或複製訂閱網址，貼到任何行事曆 App 的「從網址新增」</span>
            <code class="mono tiny" style={{ wordBreak: 'break-all' }}>
              {url}
            </code>
            <div class="row wrap">
              <CopyBtn text={url} label="複製網址" done="已複製訂閱網址" />
              <button type="button" class="link-btn tiny" onClick={reset} disabled={busy === 'reset'}>
                連結外流了？重新產生
              </button>
            </div>
          </div>
          <p class="tiny muted">
            這個網址就是你的行事曆內容{who !== 'student' ? '（包含各組的題目與進度）' : ''}，請不要貼到公開的地方。Google 日曆大約每幾小時更新一次；Apple 行事曆可以在訂閱設定裡改成每 15 分鐘
          </p>
        </div>
      )}

      <div class="actions">
        <Btn icon="download" onClick={download}>
          只下載目前的場次
        </Btn>
        <button type="button" class="btn primary" onClick={close}>
          完成
        </button>
      </div>
    </>
  );
}
