import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/engine';
import type { Request, StudentState } from '../../api/types';
import { clock, useApi, useBusy } from '../../app/hooks';
import { go } from '../../app/router';
import { useApp } from '../../app/session';
import { local } from '../../app/store';
import { minutesText, slotLines } from '../../lib/format';
import { addDays, agoText, mdPad } from '../../lib/time';
import { confirm } from '../../ui/dialog';
import { RECORDING_NOTE } from '../../config';
import { Icon } from '../../ui/icons';
import { Btn, Field, Seg, WeekStrip } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SlotGrid, slotKey } from './SlotGrid';

interface Draft {
  picks: string[];
  want: number;
  topic: string;
  questions: string;
  progress: string;
  link: string;
  base: number | null;
}

const LINK_RE = /^https?:\/\/[^\s/?#]+\.[^\s]*$/i;

function fromRequest(r: Request | null): Draft {
  return {
    picks: r ? r.slots.map((s) => slotKey(s.d, s.t)) : [],
    want: r?.want ?? 1,
    topic: r?.topic ?? '',
    questions: r?.questions ?? '',
    progress: r?.progress ?? '',
    link: r?.link ?? '',
    base: r?.version ?? null,
  };
}

/** A draft left on this device, filled out to the current form: drafts
 *  typed before a field existed must not break the page. */
function savedDraft(key: string, cap: number): Draft | null {
  const x = local.get<Partial<Draft>>(key);
  if (!x || typeof x !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    picks: Array.isArray(x.picks) ? x.picks.filter((k): k is string => typeof k === 'string') : [],
    want: Number.isInteger(x.want) ? Math.min(Math.max(x.want!, 1), cap) : 1,
    topic: text(x.topic),
    questions: text(x.questions),
    progress: text(x.progress),
    link: text(x.link),
    base: Number.isInteger(x.base) ? x.base! : null,
  };
}

export function Book({ st, weekId, reload }: { st: StudentState; weekId: number; reload: () => void }) {
  const { call } = useApi();
  const { demo } = useApp();
  const { busy, run } = useBusy(st.settings);
  const week = st.weeks.find((w) => w.id === weekId)!;
  const server = st.request;
  // the demo lives only in this tab, so its drafts are not kept (and never
  // mix with a real group's draft for the same group and week ids)
  const draftKey = demo ? null : `oh.draft.${st.me.group?.id}.${weekId}`;

  // snap = the server version this edit started from
  const [snap, setSnap] = useState<Draft>(() => fromRequest(server));
  const [d, setD] = useState<Draft>(() => {
    const saved = draftKey ? savedDraft(draftKey, st.settings.week_cap) : null;
    // a draft left on this device only wins if it was based on the version we still see
    if (saved && saved.base === (server?.version ?? null)) return saved;
    return fromRequest(server);
  });
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(snap), [d, snap]);
  useEffect(() => {
    if (!draftKey) return;
    if (dirty) local.set(draftKey, d);
    else local.remove(draftKey);
  }, [d, dirty]);

  const adopt = (r: Request | null) => {
    const next = fromRequest(r);
    setSnap(next);
    setD(next);
  };

  // a teammate saved while this page was open
  const remoteChanged = (server?.version ?? null) !== snap.base;
  useEffect(() => {
    if (remoteChanged && !dirty) adopt(server);
  }, [server?.version]);

  const picks = useMemo(() => new Set(d.picks), [d.picks]);
  const saved = useMemo(() => new Set(server?.slots.map((s) => slotKey(s.d, s.t)) ?? []), [server]);
  const validKeys = useMemo(() => new Set(st.slots.map((s) => slotKey(s.d, s.t))), [st.slots]);
  const effective = d.picks.filter((k) => validKeys.has(k));
  const days = new Set(effective.map((k) => k.slice(0, 10)));
  const mins = st.settings.slot_minutes;

  const errors = {
    picks: effective.length === 0 ? '請在時段表至少勾選一格' : null,
    topic: !d.topic.trim() ? '請寫下想討論的題目，PM 可以先準備' : d.topic.trim().length > 80 ? '題目最多 80 字' : null,
    questions: !d.questions.trim() ? '請寫下想問 PM 的問題，PM 會在通知信裡先看到' : d.questions.length > 1000 ? '最多 1000 字' : null,
    progress: !d.progress.trim() ? '請簡單說明目前做到哪裡' : d.progress.length > 1000 ? '最多 1000 字' : null,
    link: d.link.trim() && !LINK_RE.test(d.link.trim()) ? '請貼完整網址（https:// 開頭）' : null,
  };
  const valid = !errors.picks && !errors.topic && !errors.questions && !errors.progress && !errors.link;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = (k: string, on: boolean) =>
    setD((x) => ({ ...x, picks: on ? [...new Set([...x.picks, k])] : x.picks.filter((p) => p !== k) }));

  async function save(version = d.base) {
    setTried(true);
    if (!valid) {
      const first = formRef.current?.querySelector<HTMLElement>('.field.bad input, .field.bad textarea');
      if (errors.picks) document.getElementById('grid-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else first?.focus();
      return;
    }
    const slots = effective.map((k) => ({ d: k.slice(0, 10), t: k.slice(11) }));
    const r = await run(
      'save',
      () =>
        call<Request>('oh_request_save', {
          p_week: weekId,
          p_topic: d.topic,
          p_questions: d.questions,
          p_progress: d.progress,
          p_link: d.link.trim() || null,
          p_want: d.want,
          p_slots: slots,
          p_version: version,
        }),
      {
        onError: (e: ApiError) => {
          if (e.code !== 'CONFLICT') return false;
          onConflict();
          return true;
        },
      },
    );
    if (r) {
      if (draftKey) local.remove(draftKey);
      toast(server?.status === 'open' ? '需求已更新，組員會即時看到' : '已送出！助教排好時間後，首頁會即時更新', { ms: 5000 });
      go('');
      reload();
    }
  }

  async function onConflict() {
    const latest = await call<StudentState>('oh_student_state', { p_week: weekId }).catch(() => null);
    const r = latest?.request ?? null;
    const overwrite = await confirm({
      title: '組員剛剛也改了這份需求',
      body: r ? `${r.author} 在 ${agoText(r.updated_at, clock.now())} 更新了需求（題目：「${r.topic}」）。要用你的版本覆蓋，還是先看看他們的版本？` : '要用你的版本覆蓋嗎？',
      ok: '用我的版本覆蓋',
      cancel: '看他們的版本',
    });
    if (overwrite) {
      save(r?.version ?? null);
    } else {
      adopt(r);
      reload();
    }
  }

  const back = async () => {
    if (dirty && !(await confirm({ title: '放棄這次的修改？', body: '還沒送出的內容會保留在這台裝置上，下次回來可以繼續', ok: '先離開', cancel: '繼續填' }))) return;
    go('');
  };

  const weekOptions = st.weeks.filter((w) => w.open && (w.bookable || w.id === weekId));
  // "n 次" reads with the platform's name; the hint under the grid says how many days it takes
  const total = (m: number) => (m < 60 ? `${m} 分鐘` : `${m / 60} 小時`);
  const wantOptions = Array.from({ length: st.settings.week_cap }, (_, i) => i + 1).map((n) => ({
    value: n,
    label: `${n} 次`,
    sub: total(n * mins),
  }));
  const needDays = Math.ceil(d.want / st.settings.day_cap);

  return (
    <main class="page">
      <div class="stack">
        <button type="button" class="link-btn small row" style={{ gap: '4px', textDecoration: 'none', width: 'fit-content' }} onClick={back}>
          <Icon name="back" size={16} /> 返回
        </button>
        <div class="row between wrap">
          <h1 class="title-l">
            {server?.status === 'open' ? '修改' : '預約'} {week.label || ''}{' '}
            <span class="mono muted" style={{ fontWeight: 500 }}>
              {mdPad(week.start)}–{mdPad(addDays(week.start, 4))}
            </span>
          </h1>
        </div>
        {weekOptions.length > 1 && (
          <WeekStrip
            value={weekId}
            onPick={async (id) => {
              if (id === weekId) return;
              if (dirty && !(await confirm({ title: '切換週次？', body: '這週還沒送出的內容會保留在這台裝置上', ok: '切換' }))) return;
              go(`book/${id}`, { replace: true });
            }}
            items={weekOptions.map((w) => ({ id: w.id, start: w.start, label: w.label, status: w.requested ? '已送出' : '可預約', on: w.requested }))}
          />
        )}
      </div>

      {remoteChanged && dirty && (
        <div class="notice info" role="status">
          <Icon name="users" />
          <div class="grow">
            <b>{server?.author ?? '組員'}</b> 剛剛{server?.status === 'withdrawn' ? '撤回' : '更新'}了這份需求
          </div>
          <Btn size="sm" onClick={() => adopt(server)}>
            載入最新版本
          </Btn>
        </div>
      )}

      <form
        ref={formRef}
        class="split"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section class="section" aria-labelledby="grid-title" id="grid-top">
          <div class="section-head">
            <h2 id="grid-title">
              <span class="gno soft" style={{ marginRight: '8px' }}>
                1
              </span>
              勾選可以的時段
            </h2>
            <span class="small muted">可複選，勾越多越容易排到</span>
          </div>
          <SlotGrid
            weekStart={week.start}
            today={clock.today}
            slots={st.slots}
            closures={st.closures}
            picks={picks}
            saved={saved}
            slotMinutes={mins}
            onChange={toggle}
          />
          <ul class="legend">
            <li>
              <span class="sw" />
              可預約
            </li>
            <li>
              <span class="sw pick" />
              已勾選
            </li>
            <li>
              <span class="sw late" />
              已過截止
            </li>
            <li>
              <span class="sw hotdots" aria-hidden="true">
                <i />
                <i />
              </span>
              其他組也勾了
            </li>
          </ul>
          <div class="card sunk tight stack tight" aria-live="polite">
            {effective.length ? (
              <>
                <p class="small">
                  已勾選 <b class="mono">{effective.length}</b> 格，分布在 <b class="mono">{days.size}</b> 天
                </p>
                <div class="row wrap">
                  {slotLines(effective.map((k) => ({ d: k.slice(0, 10), t: k.slice(11) }))).map((l) => (
                    <span class="chip outline" key={l.d}>
                      {l.label} <span class="mono">{l.times.join('、')}</span>
                    </span>
                  ))}
                </div>
                {days.size < needDays && (
                  <p class="small" style={{ color: 'var(--warn)' }}>
                    想約 {minutesText(d.want * mins)} 需要分 {needDays} 天，請至少勾選 {needDays} 天的時段
                  </p>
                )}
              </>
            ) : (
              <p class={`small ${tried ? '' : 'muted'}`} style={tried ? { color: 'var(--danger)' } : undefined}>
                {tried ? errors.picks : '還沒勾選。點一下格子就能勾選，再點一次取消；用滑鼠可以按住拖曳一次選多格'}
              </p>
            )}
          </div>
        </section>

        <aside class="sticky-side">
          <div class="card pad-l stack loose">
            <h2 class="title-s row">
              <span class="gno soft">2</span>
              寫下想討論的事
            </h2>
            <div class="field">
              <span class="label">想約幾次</span>
              <Seg label="想約幾次" value={d.want} options={wantOptions} onChange={(v) => set('want', v)} />
            </div>
            <Field label="想討論的題目" error={tried ? errors.topic : null} count={d.topic.length} max={80}>
              <input
                class="input"
                value={d.topic}
                maxLength={80}
                placeholder="例：互動裝置的感測器要選哪一種"
                onInput={(e) => set('topic', (e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field
              label="想問 PM 的問題"
              error={tried ? errors.questions : null}
              count={d.questions.length}
              max={1000}
              help="一行一個問題。PM 會在週一的通知信裡先看到，可以事先準備"
            >
              <textarea
                class="textarea"
                value={d.questions}
                maxLength={1000}
                rows={4}
                placeholder={'例：\n感測延遲 0.3 秒，觀眾感覺得到嗎\n換成 ToF 感測器值得多花預算嗎'}
                onInput={(e) => set('questions', (e.target as HTMLTextAreaElement).value)}
              />
            </Field>
            <Field label="目前進度" error={tried ? errors.progress : null} count={d.progress.length} max={1000}>
              <textarea
                class="textarea"
                value={d.progress}
                maxLength={1000}
                rows={4}
                placeholder="例：企劃書已完成，正在做第一版原型，卡在感測延遲"
                onInput={(e) => set('progress', (e.target as HTMLTextAreaElement).value)}
              />
            </Field>
            <Field
              label="雲端資料夾連結"
              optional
              error={tried ? errors.link : null}
              help="請把共用設為「知道連結的任何人都能檢視」，PM 才打得開"
            >
              <input
                class="input"
                type="url"
                inputMode="url"
                value={d.link}
                placeholder="https://drive.google.com/…"
                onInput={(e) => set('link', (e.target as HTMLInputElement).value)}
              />
            </Field>
            <div class="stack tight">
              <Btn type="submit" variant="primary" size="lg" block loading={busy === 'save'}>
                {server?.status === 'open' ? '更新需求' : '送出預約需求'}
              </Btn>
              <p class="tiny faint" style={{ textAlign: 'center' }}>
                同組任何人都能修改這份需求，助教會從勾選的時段中安排。{RECORDING_NOTE}
              </p>
            </div>
          </div>
        </aside>
      </form>
    </main>
  );
}
