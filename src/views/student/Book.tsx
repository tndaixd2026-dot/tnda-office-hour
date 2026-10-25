import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/engine';
import type { Request, StudentState } from '../../api/types';
import { clock, useApi, useBusy } from '../../app/hooks';
import { go } from '../../app/router';
import { useApp } from '../../app/session';
import { local } from '../../app/store';
import { dayOfWeek, deadlineText, timeRange } from '../../lib/format';
import { addDays, agoText, dayLabel, mdPad } from '../../lib/time';
import { confirm } from '../../ui/dialog';
import { RECORDING_NOTE } from '../../config';
import { Icon } from '../../ui/icons';
import { Btn, Empty, Field, Place } from '../../ui/kit';
import { toast } from '../../ui/toast';

interface Draft {
  topic: string;
  questions: string;
  progress: string;
  link: string;
  base: number | null;
}

const LINK_RE = /^https?:\/\/[^\s/?#]+\.[^\s]*$/i;

function fromRequest(r: Request | null): Draft {
  return {
    topic: r?.topic ?? '',
    questions: r?.questions ?? '',
    progress: r?.progress ?? '',
    link: r?.link ?? '',
    base: r?.version ?? null,
  };
}

/** A draft left on this device, filled out to the current form: drafts
 *  typed by an older form must not break the page. */
function savedDraft(key: string): Draft | null {
  const x = local.get<Partial<Draft>>(key);
  if (!x || typeof x !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    topic: text(x.topic),
    questions: text(x.questions),
    progress: text(x.progress),
    link: text(x.link),
    base: Number.isInteger(x.base) ? x.base! : null,
  };
}

/** Booking (or editing) next week's fixed slot: what to discuss, nothing to pick. */
export function Book({ st, weekId, reload }: { st: StudentState; weekId: number; reload: () => void }) {
  const { call } = useApi();
  const { demo } = useApp();
  const { busy, run } = useBusy(st.settings);
  const week = st.weeks.find((w) => w.id === weekId)!;
  const server = st.request;
  const fixed = st.fixed;
  const mins = st.settings.slot_minutes;
  const booked = server?.status === 'open';
  // the demo lives only in this tab, so its drafts are not kept (and never
  // mix with a real group's draft for the same group and week ids)
  const draftKey = demo ? null : `oh.draft.${st.me.group?.id}.${weekId}`;

  // snap = the server version this edit started from
  const [snap, setSnap] = useState<Draft>(() => fromRequest(server));
  const [d, setD] = useState<Draft>(() => {
    const saved = draftKey ? savedDraft(draftKey) : null;
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

  const errors = {
    topic: !d.topic.trim() ? '請寫下想討論的題目，PM 可以先準備' : d.topic.trim().length > 80 ? '題目最多 80 字' : null,
    questions: !d.questions.trim() ? '請寫下想問 PM 的問題，PM 會在通知信裡先看到' : d.questions.length > 1000 ? '最多 1000 字' : null,
    progress: !d.progress.trim() ? '請簡單說明目前做到哪裡' : d.progress.length > 1000 ? '最多 1000 字' : null,
    link: !d.link.trim() ? '請貼上這次要討論的雲端資料夾連結' : !LINK_RE.test(d.link.trim()) ? '請貼完整網址（https:// 開頭）' : null,
  };
  const valid = !errors.topic && !errors.questions && !errors.progress && !errors.link;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  async function save(version = d.base) {
    setTried(true);
    if (!valid) {
      formRef.current?.querySelector<HTMLElement>('.field.bad input, .field.bad textarea')?.focus();
      return;
    }
    const r = await run(
      'save',
      () =>
        call<Request>('oh_booking_save', {
          p_week: weekId,
          p_topic: d.topic,
          p_questions: d.questions,
          p_progress: d.progress,
          p_link: d.link.trim(),
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
      toast(booked ? '已更新，組員和業師會即時看到' : '預約好了！時間已排定，全組都看得到', { ms: 5000 });
      go('');
      reload();
    }
  }

  async function onConflict() {
    const latest = await call<StudentState>('oh_student_state', { p_week: weekId }).catch(() => null);
    const r = latest?.request ?? null;
    const overwrite = await confirm({
      title: '組員剛剛也改了這週的預約',
      body: r
        ? r.status === 'skipped'
          ? `${r.author} 在 ${agoText(r.updated_at, clock.now())} 把這週改成不約。要用你的內容預約嗎？`
          : `${r.author} 在 ${agoText(r.updated_at, clock.now())} 更新了預約（題目：「${r.topic}」）。要用你的版本覆蓋，還是先看看他們的版本？`
        : '要用你的版本覆蓋嗎？',
      ok: '用我的版本',
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

  const head = (
    <div class="stack">
      <button type="button" class="link-btn small row" style={{ gap: '4px', textDecoration: 'none', width: 'fit-content' }} onClick={back}>
        <Icon name="back" size={16} /> 返回
      </button>
      <h1 class="title-l">
        {booked ? '修改' : '預約'} {week.label || ''}{' '}
        <span class="mono muted" style={{ fontWeight: 500 }}>
          {mdPad(week.start)}–{mdPad(addDays(week.start, 4))}
        </span>
      </h1>
    </div>
  );

  if (!fixed || !week.bookable) {
    return (
      <main class="page">
        {head}
        <Empty icon="clock" title={!fixed ? '還沒有固定時段' : week.holiday ? `這週遇到${week.holiday}，停一次` : '這週現在不能預約'}>
          {!fixed ? '助教設定好你們的固定時段後就能預約，有問題在 Discord 問助教' : '每次只開放下一週，上一週截止後就能預約'}
        </Empty>
      </main>
    );
  }

  const day = dayOfWeek(week.start, fixed.dow);
  return (
    <main class="page">
      {head}

      {remoteChanged && dirty && (
        <div class="notice info" role="status">
          <Icon name="users" />
          <div class="grow">
            <b>{server?.author ?? '組員'}</b> 剛剛{server?.status === 'skipped' ? '把這週改成不約' : '更新了這週的預約'}
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
        <section class="section" aria-labelledby="slot-title">
          <div class="section-head">
            <h2 id="slot-title">
              <span class="gno soft" style={{ marginRight: '8px' }}>
                1
              </span>
              這週的時段
            </h2>
            <span class="small muted">每組固定，每次 1 小時</span>
          </div>
          <div class="card pad-l stack">
            <span class="eyebrow">你們的固定時段</span>
            <p class="title-l">
              {dayLabel(day)} <span class="mono">{timeRange(fixed.t, mins)}</span>
            </p>
            <div class="stack tight">
              {fixed.teacher && (
                <span class="row" style={{ gap: '8px' }}>
                  <Icon name="user" size={16} />
                  {fixed.teacher}
                </span>
              )}
              {fixed.room && (
                <span class="row" style={{ gap: '8px' }}>
                  <Icon name="pin" size={16} />
                  <Place value={fixed.room} />
                </span>
              )}
            </div>
            <p class="small muted">
              送出就直接排定，不用等助教排時間。{deadlineText(week.deadline)} 前都可以修改，或改成這週不約
            </p>
          </div>
        </section>

        <aside class="sticky-side">
          <div class="card pad-l stack loose">
            <h2 class="title-s row">
              <span class="gno soft">2</span>
              寫下想討論的事
            </h2>
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
            <Field label="雲端資料夾連結" error={tried ? errors.link : null} help="請把共用設為「知道連結的任何人都能檢視」，PM 才打得開">
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
                {booked ? '更新內容' : '預約這週'}
              </Btn>
              <p class="tiny faint" style={{ textAlign: 'center' }}>
                同組任何人都能修改。{RECORDING_NOTE}
              </p>
            </div>
          </div>
        </aside>
      </form>
    </main>
  );
}
