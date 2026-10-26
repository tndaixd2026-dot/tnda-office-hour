import { useState } from 'preact/hooks';
import type { SessionInfo, StudentAppointment, StudentState, StudentWeek } from '../../api/types';
import { clock, useApi, useBusy, useDiff, useLive, useTick } from '../../app/hooks';
import { go } from '../../app/router';
import { signOut, updateSession } from '../../app/session';
import { downloadIcs } from '../../lib/files';
import { closeRuleText, dayOfWeek, deadlineText, fixedText, timeRange, minutesText } from '../../lib/format';
import { addDays, addMinutes, agoText, dayLabel, instant, mdPad, relativeDay, tzNote, untilText } from '../../lib/time';
import { ask, confirm } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { RECORDING_NOTE, RECORDING_SHORT } from '../../config';
import { Icon } from '../../ui/icons';
import { BrandMark, Btn, Empty, LiveBadge, Loading, Menu, Place, WeekStrip, safeHref } from '../../ui/kit';
import { openCalendarDialog } from '../CalendarSubscribe';
import { Book } from './Book';

export function StudentApp({ route }: { route: string[] }) {
  const [week, setWeek] = useState<number | null>(null);
  const bookWeek = route[0] === 'book' ? Number(route[1]) || null : null;
  const { data, error, reload } = useLive<StudentState>('oh_student_state', { p_week: bookWeek ?? week });

  // say out loud what changed while the page was open
  useDiff(data, (prev, next) => {
    const before = new Map(prev.appointments.map((a) => [a.id, a]));
    for (const a of next.appointments) {
      const old = before.get(a.id);
      // a booking by someone else in the group, or a change by the admins
      const mine = next.request?.week_id === a.week_id && next.request.author === next.me.name && next.request.version !== prev.request?.version;
      if (a.status === 'confirmed' && !old && !mine) {
        toast(`排定了：${dayLabel(a.d)} ${a.t}`, { ms: 7000 });
      } else if (a.status === 'confirmed' && old?.status === 'confirmed' && (old.d !== a.d || old.t !== a.t || old.teacher !== a.teacher)) {
        toast(`時間異動：${dayLabel(a.d)} ${a.t}${a.teacher ? ` · ${a.teacher}` : ''}`, { ms: 8000 });
      } else if (a.status === 'cancelled' && old?.status === 'confirmed' && a.cancelled_by !== next.me.name) {
        toast(`${a.cancelled_by ?? '助教'} 取消了 ${dayLabel(a.d)} ${a.t} 的場次`, { kind: 'error', ms: 8000 });
      }
    }
    const r = next.request;
    const o = prev.request;
    if (r && o && r.id === o.id && r.version > o.version && r.author !== next.me.name) {
      toast(r.status === 'skipped' ? `${r.author} 把這週改成不約` : `${r.author} 更新了這週的預約`);
    } else if (r && !o && prev.week_id === next.week_id && r.author !== next.me.name) {
      toast(r.status === 'skipped' ? `${r.author} 決定這週不約` : `${r.author} 預約了這週`);
    }
  });

  if (!data) {
    return (
      <>
        <StudentTop />
        {error ? <ErrorState onRetry={reload} /> : <Loading />}
      </>
    );
  }
  return (
    <>
      <StudentTop st={data} />
      {bookWeek ? (
        data.week_id === bookWeek ? (
          <Book key={bookWeek} st={data} weekId={bookWeek} reload={reload} />
        ) : (
          <Loading />
        )
      ) : (
        <Home st={data} setWeek={setWeek} reload={reload} />
      )}
    </>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div class="center-screen">
      <div class="stack" style={{ justifyItems: 'center', maxWidth: '360px' }}>
        <Icon name="wave" size={28} />
        <p class="title-m">暫時連不上</p>
        <p class="muted small">可能是網路不穩，資料都還在。恢復連線後會自動更新</p>
        <Btn icon="rotate" onClick={onRetry}>
          重新載入
        </Btn>
      </div>
    </div>
  );
}

function StudentTop({ st }: { st?: StudentState }) {
  const { call } = useApi();
  const { run } = useBusy();
  const g = st?.me.group;
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <a href="#/" class="brand" style={{ textDecoration: 'none' }}>
          <BrandMark code={st?.settings.course_code} />
          <span class="sr-only">（回到首頁）</span>
        </a>
        <span class="grow" />
        <LiveBadge />
        {st && g && (
          <Menu
            label="帳號選單"
            iconOnly={false}
            trigger={
              <>
                <span class="gno">{g.no}</span>
                <span class="nowrap" style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {st.me.name}
                </span>
                <Icon name="down" size={14} />
              </>
            }
          >
            {(close) => (
              <>
                <div class="mh">
                  第 {g.no} 組{g.name ? `「${g.name}」` : ''}
                  <br />
                  組員：{st.members.join('、')}
                </div>
                <button
                  type="button"
                  class="mi"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    const name = await ask({ title: '修改名字', label: '你的名字', initial: st.me.name, maxLength: 20, ok: '儲存' });
                    if (!name) return;
                    const s = await run('rename', () => call<SessionInfo>('oh_rename', { p_name: name }), { ok: '已更新名字' });
                    if (s) updateSession(s);
                  }}
                >
                  <Icon name="edit" /> 修改名字
                </button>
                <button
                  type="button"
                  class="mi danger"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    if (await confirm({ title: '登出這台裝置？', body: '之後需要重新輸入名字或邀請代碼才能回來', ok: '登出', danger: true })) signOut();
                  }}
                >
                  <Icon name="logout" /> 登出
                </button>
              </>
            )}
          </Menu>
        )}
      </div>
    </header>
  );
}

function sessionEnd(a: { d: string; t: string }, minutes: number, tz: string) {
  return instant(a.d, addMinutes(a.t, minutes), tz);
}

function Home({ st, setWeek, reload }: { st: StudentState; setWeek: (id: number) => void; reload: () => void }) {
  const now = useTick();
  const { call } = useApi();
  const { busy, run } = useBusy(st.settings);
  const mins = st.settings.slot_minutes;
  const tz = st.clock.tz;
  const fixed = st.fixed;
  const week = st.weeks.find((w) => w.id === st.week_id) ?? null;
  const upcoming = st.appointments.filter((a) => a.status === 'confirmed' && sessionEnd(a, mins, tz) > now);
  const next = upcoming[0];
  const req = st.request;
  const weekAppts = st.appointments.filter((a) => a.week_id === st.week_id);
  const firstBookable = st.weeks.find((w) => w.bookable && !w.status);
  const closed = (w: StudentWeek) => instant(w.deadline.slice(0, 10), w.deadline.slice(11), tz) <= now;
  const nextWeek = next ? st.weeks.find((w) => w.id === next.week_id) : undefined;

  const cancel = async (a: StudentAppointment) => {
    const reason = await ask({
      title: `取消 ${dayLabel(a.d)} ${a.t} 的 Office Hour？`,
      body: '業師和助教會即時看到',
      label: '原因',
      placeholder: '例：組員生病，這週先不討論',
      optional: true,
      maxLength: 200,
      ok: '確定取消',
    });
    if (reason === null) return;
    await run('cancel', () => call('oh_appointment_cancel', { p_id: a.id, p_reason: reason }), { ok: '已取消' });
    reload();
  };

  const skip = async (w: StudentWeek) => {
    const ok = await confirm({
      title: `${w.label || mdPad(w.start)} 這週不約？`,
      body:
        req?.status === 'open'
          ? '已排定的時段會取消，業師和組員都會看到。截止前都可以再改回預約，內容會保留'
          : '業師和組員會知道你們這週不約。截止前都可以改回預約',
      ok: '這週不約',
    });
    if (!ok) return;
    await run('skip', () => call('oh_booking_skip', { p_week: w.id, p_version: req?.week_id === w.id ? req.version : null }), { ok: '已改成這週不約' });
    reload();
  };

  const addToCalendar = (list: StudentAppointment[]) => {
    const g = st.me.group!;
    downloadIcs(
      list.length === 1 ? `office-hour-${list[0].d}.ics` : 'office-hour.ics',
      list.map((a) => ({
        uid: `oh-${a.id}@tnda-office-hour`,
        d: a.d,
        t: a.t,
        minutes: mins,
        tz,
        title: `Office Hour · 第 ${g.no} 組${a.topic ? `｜${a.topic}` : ''}`,
        location: a.room ?? st.settings.location,
        description: `${st.settings.course_code} ${st.settings.course_title}`.trim(),
      })),
      'Office Hour',
    );
  };

  const rel = next ? relativeDay(next.d, clock.today) : null;
  const startsIn = next ? instant(next.d, next.t, tz) - now : 0;
  const weekStatus = (w: StudentWeek) =>
    w.booked > 0
      ? '已預約'
      : w.status === 'skipped'
        ? '這週不約'
        : !w.open
          ? '暫停'
          : w.holiday
            ? '放假'
            : w.bookable
              ? '可預約'
              : closed(w)
                ? '沒有預約'
                : '還不能約';

  return (
    <main class="page enter">
      {st.settings.notice && (
        <div class="notice">
          <Icon name="info" />
          <span class="pre">{st.settings.notice}</span>
        </div>
      )}

      {next ? (
        <section class="hero" aria-label="下一次 Office Hour">
          <div class="row between wrap">
            <p class="eyebrow">下一次 Office Hour</p>
            <span class="countdown">
              <Icon name="clock" size={14} />
              {untilText(startsIn)}
            </span>
          </div>
          <div class="when">
            <div class="stack tight">
              <span class="day">
                {rel ? `${rel}・` : ''}
                {dayLabel(next.d)}
              </span>
              <span class="num-xl">{timeRange(next.t, mins)}</span>
              {tzNote(tz) && <span class="small" style={{ opacity: 0.7 }}>以上為{tzNote(tz)}</span>}
            </div>
          </div>
          <div class="meta">
            <span>
              <Icon name="pin" size={16} />
              <Place value={next.room ?? st.settings.location} />
            </span>
            <span>
              <Icon name="video" size={16} />
              {RECORDING_SHORT}
            </span>
            {next.teacher && (
              <span>
                <Icon name="user" size={16} />
                {next.teacher}
              </span>
            )}
            {next.topic && (
              <span>
                <Icon name="chat" size={16} />
                {next.topic}
              </span>
            )}
          </div>
          <div class="row wrap">
            <Btn class="solid" icon="calendar" onClick={() => openCalendarDialog({ who: 'student', download: () => addToCalendar(upcoming) })}>
              加入行事曆
            </Btn>
            {next.can_cancel ? (
              <Btn variant="ghost" loading={busy === 'cancel'} onClick={() => cancel(next)}>
                取消這次
              </Btn>
            ) : nextWeek && !closed(nextWeek) ? (
              <span class="small" style={{ opacity: 0.7 }}>
                {deadlineText(nextWeek.deadline)} 前都可以修改，或改成這週不約
              </span>
            ) : (
              <span class="small" style={{ opacity: 0.7 }}>
                距離開始不到 {st.settings.cancel_hours} 小時，要取消請在 Discord 告訴助教
              </span>
            )}
          </div>
        </section>
      ) : !fixed ? (
        <section class="hero calm" aria-label="預約狀態">
          <p class="eyebrow">{st.me.name}，歡迎</p>
          <h1 class="title-l">助教還沒設定你們的固定時段</h1>
          <p class="muted">設定好之後就能在這裡預約。有問題可以在 Discord 問助教</p>
        </section>
      ) : (
        <section class="hero calm" aria-label="預約狀態">
          <p class="eyebrow">
            你們的固定時段{fixed.teacher ? ` · ${fixed.teacher}` : ''}
          </p>
          <h1 class="title-l">{fixedText(fixed, mins)}</h1>
          <p class="muted">每週要不要約，在前一週的週六 20:00 前決定，之後幾週也可以先約好。要約就寫好題目、想問的問題、進度和雲端連結，送出就排定</p>
          {firstBookable && (
            <div class="row wrap">
              <Btn variant="primary" size="lg" icon="arrow" onClick={() => go(`book/${firstBookable.id}`)}>
                預約 {firstBookable.label || mdPad(firstBookable.start)}
              </Btn>
              <span class="small muted">{deadlineText(firstBookable.deadline)} 截止</span>
            </div>
          )}
        </section>
      )}

      <section class="section" aria-labelledby="sec-week">
        <div class="section-head">
          <h2 id="sec-week">每週預約</h2>
          <span class="small muted">整組一起決定，組員的修改會即時同步</span>
        </div>
        <WeekStrip
          value={st.week_id}
          onPick={setWeek}
          items={st.weeks.map((w) => ({
            id: w.id,
            start: w.start,
            label: w.label,
            past: addDays(w.start, 6) < clock.today,
            on: w.booked > 0,
            status: weekStatus(w),
          }))}
        />
        {week && (
          <div class="card pad-l stack loose">
            <div class="row between wrap top">
              <div class="stack tight">
                <h3 class="title-m">
                  {week.label && <span class="mono">{week.label} · </span>}
                  {mdPad(week.start)}–{mdPad(addDays(week.start, 4))}
                </h3>
                {fixed && !week.holiday && (
                  <span class="small">
                    {dayLabel(dayOfWeek(week.start, fixed.dow))} <span class="mono">{timeRange(fixed.t, mins)}</span>
                    {fixed.teacher ? ` · ${fixed.teacher}` : ''}
                  </span>
                )}
                {week.note && <span class="small muted">{week.note}</span>}
                {week.open && fixed && !week.holiday && (
                  <span class="small muted">
                    {closed(week) ? '已在' : ''} {deadlineText(week.deadline)} 截止
                  </span>
                )}
              </div>
              {!week.open ? (
                <span class="chip">暫停</span>
              ) : week.holiday ? (
                <span class="chip">放假</span>
              ) : week.bookable ? (
                <span class="chip ok">
                  <span class="dot" />
                  開放預約
                </span>
              ) : closed(week) ? (
                <span class="chip">已截止</span>
              ) : (
                <span class="chip">還不能約</span>
              )}
            </div>

            {weekAppts.length > 0 && (
              <div class="list">
                {weekAppts.map((a) => (
                  <ApptRow key={a.id} a={a} mins={mins} tz={tz} now={now} onCancel={() => cancel(a)} />
                ))}
              </div>
            )}

            {!fixed ? (
              <Empty icon="clock" title="還沒有固定時段">
                助教設定好之後就能預約
              </Empty>
            ) : week.holiday ? (
              <Empty icon="calendar" title={`這週遇到${week.holiday}，停一次`}>
                固定時段那天放假，這週不用預約
              </Empty>
            ) : req?.status === 'open' ? (
              <div class="stack">
                <div class="stack tight">
                  <span class="eyebrow">你們想討論</span>
                  <p class="title-m">{req.topic}</p>
                </div>
                {req.questions && (
                  <div class="qbox">
                    <span class="eyebrow">想問 PM 的問題</span>
                    <p class="pre">{req.questions}</p>
                  </div>
                )}
                <p class="pre muted clamp-3">{req.progress}</p>
                {safeHref(req.link) && (
                  <a class="small row" style={{ gap: '6px', width: 'fit-content' }} href={safeHref(req.link)} target="_blank" rel="noopener noreferrer">
                    <Icon name="external" size={15} />
                    雲端資料夾
                  </a>
                )}
                <p class="tiny faint">
                  {req.author} 更新於 {agoText(req.updated_at, now)}
                </p>
                {week.bookable ? (
                  <div class="row wrap">
                    <Btn icon="edit" onClick={() => go(`book/${req.week_id}`)}>
                      修改內容
                    </Btn>
                    <Btn variant="ghost" class="danger" loading={busy === 'skip'} onClick={() => skip(week)}>
                      這週不約
                    </Btn>
                  </div>
                ) : (
                  closed(week) && <p class="small muted">已過截止，內容不能再改。要調整請在 Discord 告訴助教</p>
                )}
              </div>
            ) : req?.status === 'skipped' ? (
              <div class="stack">
                <p class="title-m">這週不約</p>
                <p class="small muted">
                  {req.author} 在 {agoText(req.updated_at, now)}決定的
                  {week.bookable ? `，${deadlineText(week.deadline)} 前都可以改回預約` : ''}
                </p>
                {week.bookable && (
                  <div>
                    <Btn icon="arrow" onClick={() => go(`book/${week.id}`)}>
                      改成預約
                    </Btn>
                  </div>
                )}
              </div>
            ) : week.bookable ? (
              <div class="stack">
                <p class="muted">
                  這週要約嗎？要約就寫下題目、想問 PM 的問題、目前進度和雲端連結，送出就排定。請在 {deadlineText(week.deadline)} 前決定
                </p>
                <div class="row wrap">
                  <Btn variant="primary" size="lg" icon="arrow" onClick={() => go(`book/${week.id}`)}>
                    預約這週
                  </Btn>
                  <Btn size="lg" loading={busy === 'skip'} onClick={() => skip(week)}>
                    這週不約
                  </Btn>
                </div>
              </div>
            ) : (
              weekAppts.length === 0 && (
                <Empty icon="clock" title={!week.open ? '這週暫停' : closed(week) ? '這週沒有預約' : '還不能約'}>
                  {!week.open ? '有問題可以在 Discord 詢問助教' : closed(week) ? `每週的預約在${closeRuleText(st.settings)} 截止` : '助教設定好固定時段後就能預約'}
                </Empty>
              )
            )}
          </div>
        )}
      </section>

      <History
        st={st}
        now={now}
        onCancel={cancel}
        onCalendar={() => openCalendarDialog({ who: 'student', download: () => addToCalendar(st.appointments.filter((a) => a.status === 'confirmed')) })}
      />

      <section class="section" aria-labelledby="sec-rules">
        <div class="section-head">
          <h2 id="sec-rules">預約規則</h2>
        </div>
        <dl class="rules">
          <div>
            <dt>固定時段</dt>
            <dd>
              {fixed ? (
                <>
                  {fixedText(fixed, mins)}
                  {fixed.teacher ? ` · ${fixed.teacher}` : ''}
                </>
              ) : (
                '助教還沒設定'
              )}
            </dd>
          </div>
          <div>
            <dt>討論室</dt>
            <dd>
              <Place value={fixed?.room ?? st.settings.location} />
            </dd>
          </div>
          <div>
            <dt>次數</dt>
            <dd>每週一次，每次 {minutesText(mins)}</dd>
          </div>
          <div>
            <dt>預約截止</dt>
            <dd>{closeRuleText(st.settings)}</dd>
          </div>
          <div>
            <dt>錄影</dt>
            <dd>{RECORDING_NOTE}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

function ApptRow({ a, mins, tz, now, onCancel }: { a: StudentAppointment; mins: number; tz: string; now: number; onCancel: () => void }) {
  const end = instant(a.d, addMinutes(a.t, mins), tz);
  const past = end <= now;
  const cancelled = a.status === 'cancelled';
  return (
    <div class={`li ${cancelled ? 'cancelled' : ''} ${past && !cancelled ? 'past' : ''}`}>
      <div class="when short">
        <b>{a.t}</b>
        <span>{dayLabel(a.d)}</span>
      </div>
      <div class="grow stack tight">
        <span class="small">{a.topic ?? 'Office Hour'}</span>
        {a.teacher && <span class="tiny muted">{a.teacher}</span>}
        {cancelled && (
          <span class="tiny">
            {a.cancelled_by} 取消{a.cancel_reason ? `：${a.cancel_reason}` : ''}
          </span>
        )}
      </div>
      {cancelled ? (
        <span class="chip danger">已取消</span>
      ) : past ? (
        <span class="chip">已結束</span>
      ) : a.can_cancel ? (
        <Btn size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Btn>
      ) : (
        <span class="chip ok">
          <span class="dot" />
          已排定
        </span>
      )}
    </div>
  );
}

function History({
  st,
  now,
  onCancel,
  onCalendar,
}: {
  st: StudentState;
  now: number;
  onCancel: (a: StudentAppointment) => void;
  onCalendar: () => void;
}) {
  const [all, setAll] = useState(false);
  const mins = st.settings.slot_minutes;
  const list = [...st.appointments].sort((a, b) => (b.d + b.t).localeCompare(a.d + a.t));
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 5);
  return (
    <section class="section" aria-labelledby="sec-history">
      <div class="section-head">
        <h2 id="sec-history">全部紀錄</h2>
        <span class="row wrap" style={{ gap: '12px' }}>
          <span class="small muted">
            本學期已和 {st.settings.host_label} 討論 {list.filter((a) => a.status === 'confirmed' && instant(a.d, a.t, st.clock.tz) < now).length} 次
          </span>
          <Btn size="sm" icon="calendar" onClick={onCalendar}>
            訂閱行事曆
          </Btn>
        </span>
      </div>
      <div class="list">
        {shown.map((a) => (
          <ApptRow key={a.id} a={a} mins={mins} tz={st.clock.tz} now={now} onCancel={() => onCancel(a)} />
        ))}
      </div>
      {list.length > 5 && (
        <button type="button" class="link-btn small" style={{ justifySelf: 'start' }} onClick={() => setAll(!all)}>
          {all ? '收起' : `顯示全部 ${list.length} 筆`}
        </button>
      )}
    </section>
  );
}
