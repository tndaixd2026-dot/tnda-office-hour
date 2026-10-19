import { useState } from 'preact/hooks';
import type { SessionInfo, StudentAppointment, StudentState } from '../../api/types';
import { clock, useApi, useBusy, useDiff, useLive, useTick } from '../../app/hooks';
import { go } from '../../app/router';
import { signOut, updateSession } from '../../app/session';
import { downloadIcs } from '../../lib/files';
import { closeRuleText, deadlineText, slotLines, timeRange, minutesText } from '../../lib/format';
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
      if (a.status === 'confirmed' && (!old || old.status !== 'confirmed')) {
        toast(`時間確定了：${dayLabel(a.d)} ${a.t}`, { ms: 7000 });
      } else if (a.status === 'cancelled' && old?.status === 'confirmed' && a.cancelled_by !== next.me.name) {
        toast(`${a.cancelled_by ?? '助教'} 取消了 ${dayLabel(a.d)} ${a.t} 的場次`, { kind: 'error', ms: 8000 });
      }
    }
    const r = next.request;
    const o = prev.request;
    if (r && o && r.id === o.id && r.version > o.version && r.author !== next.me.name) {
      toast(r.status === 'withdrawn' ? `${r.author} 撤回了這週的需求` : `${r.author} 更新了這週的需求`);
    } else if (r && !o && prev.week_id === next.week_id && r.author !== next.me.name) {
      toast(`${r.author} 送出了這週的需求`);
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
  const week = st.weeks.find((w) => w.id === st.week_id) ?? null;
  const upcoming = st.appointments.filter((a) => a.status === 'confirmed' && sessionEnd(a, mins, tz) > now);
  const next = upcoming[0];
  const req = st.request;
  const weekAppts = st.appointments.filter((a) => a.week_id === st.week_id);
  const confirmedThisWeek = weekAppts.filter((a) => a.status === 'confirmed');
  const firstBookable = st.weeks.find((w) => w.bookable);
  const pendingWeek = st.weeks.find((w) => w.requested && w.booked === 0 && addDays(w.start, 6) >= clock.today);

  const cancel = async (a: StudentAppointment) => {
    const reason = await ask({
      title: `取消 ${dayLabel(a.d)} ${a.t} 的 Office Hour？`,
      body: '取消後這個時段會釋出給其他組，助教與 PM 會即時看到',
      label: '原因',
      placeholder: '例：組員生病，想改到下週',
      optional: true,
      maxLength: 200,
      ok: '確定取消',
    });
    if (reason === null) return;
    await run('cancel', () => call('oh_appointment_cancel', { p_id: a.id, p_reason: reason }), { ok: '已取消，時段已釋出' });
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
        location: st.settings.location,
        description: `${st.settings.course_code} ${st.settings.course_title}`.trim(),
      })),
      'Office Hour',
    );
  };

  const withdraw = async () => {
    if (!req) return;
    const ok = await confirm({
      title: '撤回這週的需求？',
      body: '組員和助教都會看到需求已撤回。之後可以隨時重新送出，內容會保留',
      ok: '撤回',
      danger: true,
    });
    if (!ok) return;
    await run('withdraw', () => call('oh_request_withdraw', { p_week: req.week_id, p_version: req.version }), { ok: '已撤回需求' });
    reload();
  };

  const rel = next ? relativeDay(next.d, clock.today) : null;
  const startsIn = next ? instant(next.d, next.t, tz) - now : 0;

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
              <Place value={st.settings.location} />
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
            ) : (
              <span class="small" style={{ opacity: 0.7 }}>
                距離開始不到 {st.settings.cancel_hours} 小時，要取消請在 Discord 告訴助教
              </span>
            )}
          </div>
          {upcoming.length > 1 && (
            <p class="small" style={{ opacity: 0.75 }}>
              之後還有 {upcoming.length - 1} 場：
              {upcoming
                .slice(1)
                .map((a) => `${dayLabel(a.d)} ${a.t}`)
                .join('、')}
            </p>
          )}
        </section>
      ) : pendingWeek ? (
        <section class="hero calm" aria-label="預約狀態">
          <p class="eyebrow">{pendingWeek.label || mdPad(pendingWeek.start)} 的需求已送出</p>
          <h1 class="title-l">助教正在安排時間</h1>
          <p class="muted">時間確定後，這個畫面會即時更新，全組會同時看到</p>
        </section>
      ) : (
        <section class="hero calm" aria-label="預約狀態">
          <p class="eyebrow">
            {st.me.name}，{st.settings.host_label} 的 Office Hour 每次 {minutesText(mins)}
          </p>
          <h1 class="title-l">還沒有排定的時段</h1>
          <p class="muted">勾選你們這週可以的時段，越多越容易排到。整組共用一份需求，誰來填都可以</p>
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
          <span class="small muted">整組共用一份需求，組員的修改會即時同步</span>
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
            status: w.booked > 0 ? `已排 ${w.booked} 場` : w.requested ? '已送出' : !w.open ? '暫停' : w.bookable ? '可預約' : '已截止',
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
                {week.note && <span class="small muted">{week.note}</span>}
                {week.open && (
                  <span class="small muted">
                    預約{week.bookable ? '' : '已在'} {deadlineText(week.deadline)} 截止
                  </span>
                )}
              </div>
              {!week.open ? (
                <span class="chip">暫停預約</span>
              ) : week.bookable ? (
                <span class="chip ok">
                  <span class="dot" />
                  開放預約
                </span>
              ) : (
                <span class="chip">已過預約截止</span>
              )}
            </div>

            {req?.status === 'open' && (
              <ul class="steps" aria-label="進度">
                <li class="done">送出需求</li>
                <li class={confirmedThisWeek.length ? 'done' : 'now'}>{confirmedThisWeek.length ? '助教排程' : st.scheduling ? '助教排程中' : '等待排程'}</li>
                <li class={confirmedThisWeek.length ? 'done' : ''}>時間確定</li>
              </ul>
            )}

            {weekAppts.length > 0 && (
              <div class="list">
                {weekAppts.map((a) => (
                  <ApptRow key={a.id} a={a} mins={mins} tz={tz} now={now} onCancel={() => cancel(a)} />
                ))}
              </div>
            )}

            {req?.status === 'open' ? (
              <div class="stack">
                <div class="row between wrap top">
                  <div class="stack tight grow">
                    <span class="eyebrow">你們想討論</span>
                    <p class="title-m">{req.topic}</p>
                  </div>
                  <span class="chip">想約 {minutesText(req.want * mins)}</span>
                </div>
                <p class="pre muted clamp-3">{req.progress}</p>
                {safeHref(req.link) && (
                  <a class="small row" style={{ gap: '6px', width: 'fit-content' }} href={safeHref(req.link)} target="_blank" rel="noopener noreferrer">
                    <Icon name="external" size={15} />
                    雲端資料夾
                  </a>
                )}
                <div class="stack tight">
                  <span class="eyebrow">可以的時段（{req.slots.length} 格）</span>
                  <div class="row wrap">
                    {slotLines(req.slots).map((l) => (
                      <span class="chip outline" key={l.d}>
                        {l.label} <span class="mono">{l.times.join('、')}</span>
                      </span>
                    ))}
                  </div>
                </div>
                <p class="tiny faint">
                  {req.author} 更新於 {agoText(req.updated_at, now)}
                </p>
                {week.bookable ? (
                  <div class="row wrap">
                    <Btn icon="edit" onClick={() => go(`book/${req.week_id}`)}>
                      修改需求
                    </Btn>
                    {confirmedThisWeek.length === 0 && (
                      <Btn variant="ghost" class="danger" loading={busy === 'withdraw'} onClick={withdraw}>
                        撤回
                      </Btn>
                    )}
                  </div>
                ) : (
                  week.open &&
                  confirmedThisWeek.length === 0 && <p class="small muted">已過預約截止，助教正在排時間。需要調整請在 Discord 告訴助教</p>
                )}
              </div>
            ) : week.bookable ? (
              <div class="stack">
                {req?.status === 'withdrawn' && <p class="small muted">這週的需求已撤回（{req.author}）。重新送出時會帶入原本的內容</p>}
                <p class="muted">
                  勾選這週所有可以的時段，再寫下想討論的題目和目前進度，助教會從中幫你們排 {minutesText(mins)}到{minutesText(mins * st.settings.week_cap)}。請在{' '}
                  {deadlineText(week.deadline)} 前送出，之前都可以修改
                </p>
                <div>
                  <Btn variant="primary" size="lg" icon="arrow" onClick={() => go(`book/${week.id}`)}>
                    {req?.status === 'withdrawn' ? '重新送出需求' : '開始預約'}
                  </Btn>
                </div>
              </div>
            ) : (
              weekAppts.length === 0 && (
                <Empty icon="clock" title={week.open ? '這週已過預約截止' : '這週暫停預約'}>
                  {week.open ? `每週的預約在${closeRuleText(st.settings)} 截止。看看下一週吧` : '有問題可以在 Discord 詢問助教'}
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
            <dt>地點</dt>
            <dd>
              <Place value={st.settings.location} />
            </dd>
          </div>
          <div>
            <dt>錄影</dt>
            <dd>{RECORDING_NOTE}</dd>
          </div>
          <div>
            <dt>每週上限</dt>
            <dd>
              {minutesText(st.settings.week_cap * mins)} <span class="mono muted">（{st.settings.week_cap} 格）</span>
            </dd>
          </div>
          <div>
            <dt>每天上限</dt>
            <dd>
              {minutesText(st.settings.day_cap * mins)} <span class="mono muted">（{st.settings.day_cap} 格）</span>
            </dd>
          </div>
          <div>
            <dt>預約截止</dt>
            <dd>{closeRuleText(st.settings)}</dd>
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
      <div class="when">
        <b>{a.t}</b>
        <span>{dayLabel(a.d)}</span>
      </div>
      <div class="grow stack tight">
        <span class="small">{a.topic ?? 'Office Hour'}</span>
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
