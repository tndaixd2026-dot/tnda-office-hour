import { useState } from 'preact/hooks';
import type { TeacherSession, TeacherState } from '../../api/types';
import { clock, useDiff, useLive, useTick } from '../../app/hooks';
import { signOut } from '../../app/session';
import { MAIL_PREVIEW, RECORDING_NOTE, RECORDING_SHORT } from '../../config';
import { downloadIcs } from '../../lib/files';
import { greeting, timeRange } from '../../lib/format';
import { monday } from '../../lib/lessons';
import { addDays, addMinutes, agoText, DOW, dayLabel, instant, md, relativeDay, tzNote, untilText } from '../../lib/time';
import { confirm } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { BrandMark, Btn, Empty, LiveBadge, Loading, Menu, Place, Seg, safeHref } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { openCalendarDialog } from '../CalendarSubscribe';
import { ErrorState } from '../student/StudentApp';

export function TeacherApp() {
  const { data, error, reload } = useLive<TeacherState>('oh_teacher_state');
  useDiff(data, (prev, next) => {
    const before = new Map(prev.sessions.map((m) => [m.id, m]));
    for (const m of next.sessions) {
      const old = before.get(m.id);
      if (m.status === 'confirmed' && !old) toast(`新的場次：${dayLabel(m.d)} ${m.t} ${m.teacher} 第 ${m.group.no} 組`, { ms: 7000 });
      if (m.status === 'cancelled' && old?.status === 'confirmed') toast(`第 ${m.group.no} 組取消了 ${dayLabel(m.d)} ${m.t}（${m.teacher}）`, { kind: 'error', ms: 8000 });
    }
  });
  return (
    <>
      <header class="topbar">
        <div class="topbar-inner">
          <BrandMark code={data?.settings.course_code} sub={data ? data.settings.host_label : undefined} />
          <span class="grow" />
          <LiveBadge />
          {data && (
            <Menu
              label="帳號選單"
              iconOnly={false}
              trigger={
                <>
                  <Icon name="user" size={16} />
                  <span>{data.me.name}</span>
                  <Icon name="down" size={14} />
                </>
              }
            >
              {(close) => (
                <button
                  type="button"
                  class="mi danger"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    if (await confirm({ title: '登出這台裝置？', body: '之後需要重新輸入名字或代碼才能回來', ok: '登出', danger: true })) signOut();
                  }}
                >
                  <Icon name="logout" /> 登出
                </button>
              )}
            </Menu>
          )}
        </div>
      </header>
      {data ? <TeacherHome st={data} /> : error ? <ErrorState onRetry={reload} /> : <Loading />}
    </>
  );
}

/** Colour of a PM, by their place in the list (same colours as the TD timetable). */
function tc(st: TeacherState, id: number) {
  return `tc${Math.max(0, st.teachers.findIndex((t) => t.id === id)) % 4}`;
}

function TeacherHome({ st }: { st: TeacherState }) {
  const now = useTick();
  const mins = st.settings.slot_minutes;
  const tz = st.clock.tz;
  const thisWeek = monday(clock.today);
  const [week, setWeek] = useState(thisWeek);
  const [who, setWho] = useState(0);
  const end = (s: { d: string; t: string }) => instant(s.d, addMinutes(s.t, mins), tz);
  const live = st.sessions.filter((s) => s.status === 'confirmed');
  const upcoming = live.filter((s) => end(s) > now);
  const next = upcoming.find((s) => !who || s.teacher_id === who);
  const past = live.filter((s) => end(s) <= now).reverse();
  const inWeek = st.sessions.filter((s) => s.d >= week && s.d <= addDays(week, 6));
  const confirmedInWeek = inWeek.filter((s) => s.status === 'confirmed');
  const shown = inWeek.filter((s) => !who || s.teacher_id === who);
  const thisWeekCount = live.filter((s) => s.d >= thisWeek && s.d <= addDays(thisWeek, 6)).length;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
  const team = st.me.team;

  const byDay = new Map<string, TeacherSession[]>();
  for (const s of shown) byDay.set(s.d, [...(byDay.get(s.d) ?? []), s]);

  const subscribe = () =>
    openCalendarDialog({
      who: team ? 'team' : 'teacher',
      download: () =>
        downloadIcs(
          team ? 'office-hour-all.ics' : 'office-hour-pm.ics',
          upcoming
            .filter((s) => team || s.mine)
            .map((s) => ({
              uid: `oh-${s.id}@tnda-office-hour`,
              d: s.d,
              t: s.t,
              minutes: mins,
              tz,
              title: `Office Hour · ${team ? `${s.teacher} · ` : ''}第 ${s.group.no} 組${s.request?.topic ? `｜${s.request.topic}` : ''}`,
              location: st.settings.location,
              description: [s.request?.questions && `想問的問題：\n${s.request.questions}`, s.request?.progress, s.request?.link]
                .filter(Boolean)
                .join('\n\n'),
            })),
          `Office Hour · ${st.me.name}`,
        ),
    });

  return (
    <main class="page enter">
      <div class="stack tight">
        <p class="eyebrow">
          {greeting(hour)}，{st.me.name}
        </p>
        <h1 class="title-l">{thisWeekCount ? `這週有 ${thisWeekCount} 場 Office Hour` : '這週沒有排定的 Office Hour'}</h1>
        <p class="small muted row" style={{ gap: '6px' }}>
          <Icon name="video" size={16} />
          {RECORDING_NOTE}
        </p>
      </div>

      {next && (
        <section class="hero" aria-label="下一場">
          <div class="row between wrap">
            <p class="eyebrow">下一場</p>
            <span class="countdown">
              <Icon name="clock" size={14} />
              {untilText(instant(next.d, next.t, tz) - now)}
            </span>
          </div>
          <div class="stack tight">
            <span class="day">
              {relativeDay(next.d, clock.today) ? `${relativeDay(next.d, clock.today)}・` : ''}
              {dayLabel(next.d)}
            </span>
            <span class="num-xl">{timeRange(next.t, mins)}</span>
            {tzNote(tz) && <span class="small" style={{ opacity: 0.7 }}>以上為{tzNote(tz)}</span>}
          </div>
          <div class="stack tight">
            <p class="title-m">
              {next.teacher} · 第 {next.group.no} 組{next.group.name ? `「${next.group.name}」` : ''}
            </p>
            {next.request && <p style={{ opacity: 0.85 }}>{next.request.topic}</p>}
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
          </div>
          <div class="row wrap">
            {safeHref(next.request?.link) && (
              <a class="btn solid" href={safeHref(next.request?.link)} target="_blank" rel="noopener noreferrer">
                <Icon name="external" /> 打開雲端資料夾
              </a>
            )}
            <Btn icon="calendar" onClick={subscribe}>
              訂閱行事曆
            </Btn>
          </div>
        </section>
      )}

      <section class="section" aria-labelledby="t-week">
        <div class="section-head">
          <h2 id="t-week">{week === thisWeek ? '這週' : '下週'}一覽</h2>
          <div class="row wrap ls-tools">
            <Seg
              label="哪一週"
              value={week}
              onChange={setWeek}
              options={[
                { value: thisWeek, label: '這週', sub: `${md(thisWeek)}–${md(addDays(thisWeek, 6))}` },
                { value: addDays(thisWeek, 7), label: '下週', sub: `${md(addDays(thisWeek, 7))}–${md(addDays(thisWeek, 13))}` },
              ]}
            />
            <Btn size="sm" icon="calendar" onClick={subscribe}>
              訂閱行事曆
            </Btn>
          </div>
        </div>

        <div class="row wrap" role="group" aria-label="只看哪位老師">
          <button type="button" class="ls-tg plain" aria-pressed={!who} onClick={() => setWho(0)}>
            全部 {confirmedInWeek.length} 場
          </button>
          {st.teachers.map((t) => (
            <button type="button" key={t.id} class={`ls-tg ${tc(st, t.id)}`} aria-pressed={who === t.id} onClick={() => setWho(t.id)}>
              {t.name} {confirmedInWeek.filter((s) => s.teacher_id === t.id).length} 場
            </button>
          ))}
        </div>

        {byDay.size === 0 ? (
          <Empty icon="calendar" title={week === thisWeek ? '這週還沒有排定的場次' : '下週還沒有排定的場次'}>
            {week === thisWeek ? '助教排好時間後，這裡會即時出現各組的題目與進度' : `助教會在 ${MAIL_PREVIEW} 前排好下週的場次，這裡會即時更新`}
          </Empty>
        ) : (
          <>
            {!who && st.teachers.length > 1 && <Overview st={st} days={[...byDay.keys()]} sessions={shown} />}
            <div class="stack">
              {[...byDay.entries()].map(([d, list]) => (
                <div class="stack tight" key={d}>
                  <h3 class="small" style={{ fontWeight: 700 }}>
                    {relativeDay(d, clock.today) ? `${relativeDay(d, clock.today)}・` : ''}
                    {dayLabel(d)}
                  </h3>
                  <div class="list">
                    {list.map((s) => (
                      <SessionCard key={s.id} s={s} st={st} mins={mins} now={now} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section class="section" aria-labelledby="t-avail">
        <div class="section-head">
          <h2 id="t-avail">開放時段</h2>
          <span class="small muted">需要調整請聯絡助教</span>
        </div>
        {st.teachers.map((t) => {
          const blocks = st.blocks.filter((b) => b.teacher_id === t.id);
          const off = st.closures.filter((c) => c.teacher_id === t.id);
          return (
            <div class={`row wrap ${tc(st, t.id)}`} key={t.id} style={{ gap: '8px' }}>
              <span class="ls-who" style={{ minWidth: '90px' }}>
                {t.name}
              </span>
              {blocks.length ? (
                blocks.map((b, i) => (
                  <span class="chip outline" key={i}>
                    {b.dow ? `每${DOW[b.dow]}` : `${md(b.on_date!)}（單次）`}{' '}
                    <span class="mono">
                      {b.start}–{b.end}
                    </span>
                    {b.valid_to && <span class="faint">至 {md(b.valid_to)}</span>}
                  </span>
                ))
              ) : (
                <span class="small muted">沒有開放時段</span>
              )}
              {off.map((c, i) => (
                <span class="chip warn" key={`c${i}`}>
                  {md(c.d)} {c.reason || '請假'}
                </span>
              ))}
            </div>
          );
        })}
        {st.closures.some((c) => c.teacher_id === null) && (
          <div class="row wrap">
            {st.closures
              .filter((c) => c.teacher_id === null)
              .map((c, i) => (
                <span class="chip" key={i}>
                  {md(c.d)} {c.reason || '休息'}
                </span>
              ))}
          </div>
        )}
      </section>

      {past.length > 0 && <PastSessions list={past} st={st} />}
    </main>
  );
}

/** Days down, PMs across: who has what this week, at a glance. */
function Overview({ st, days, sessions }: { st: TeacherState; days: string[]; sessions: TeacherSession[] }) {
  return (
    // scrolls sideways on phones, so keyboard users need to reach it
    <div class="table-wrap" tabIndex={0} role="region" aria-label="每位老師的場次">
      <table class="t">
        <caption class="sr-only">每位老師的場次</caption>
        <thead>
          <tr>
            <th scope="col">日期</th>
            {st.teachers.map((t) => (
              <th scope="col" key={t.id} class={tc(st, t.id)}>
                <span class="ls-who">{t.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d} class={d === clock.today ? 'mine' : undefined}>
              <th scope="row" class="nowrap" style={{ fontWeight: 600 }}>
                {dayLabel(d)}
              </th>
              {st.teachers.map((t) => {
                const list = sessions.filter((s) => s.d === d && s.teacher_id === t.id);
                return (
                  <td key={t.id}>
                    {list.length === 0 ? (
                      <>
                        <span class="faint" aria-hidden="true">
                          —
                        </span>
                        <span class="sr-only">沒有場次</span>
                      </>
                    ) : (
                      <span class="stack" style={{ gap: '2px' }}>
                        {list.map((s) => (
                          <span key={s.id} class={`small nowrap ${s.status === 'cancelled' ? 'faint' : ''}`}>
                            <span class="mono">{s.t}</span> 第 {s.group.no} 組{s.status === 'cancelled' ? '（已取消）' : ''}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionCard({ s, st, mins, now }: { s: TeacherSession; st: TeacherState; mins: number; now: number }) {
  const [open, setOpen] = useState(false);
  const cancelled = s.status === 'cancelled';
  const past = instant(s.d, addMinutes(s.t, mins), st.clock.tz) <= now;
  const r = s.request;
  return (
    <div class={`li top ${cancelled ? 'cancelled' : past ? 'past' : ''}`} style={s.mine && !cancelled ? { boxShadow: 'inset 3px 0 0 var(--accent)' } : undefined}>
      <div class="when">
        <b>{s.t}</b>
        <span class="mono">{addMinutes(s.t, mins)}</span>
      </div>
      <div class="grow stack tight">
        <div class={`row wrap ${tc(st, s.teacher_id)}`} style={{ gap: '8px' }}>
          <span class="ls-who">{s.teacher}</span>
          {s.mine && <span class="chip accent">你的場次</span>}
          <span class="gno">{s.group.no}</span>
          <b>{s.group.name || `第 ${s.group.no} 組`}</b>
          {cancelled && <span class="chip danger">已取消{s.cancel_reason ? `：${s.cancel_reason}` : ''}</span>}
        </div>
        {r ? (
          <>
            <p style={{ fontWeight: 600 }}>{r.topic}</p>
            {r.questions && (
              <div class="qbox">
                <span class="tiny muted" style={{ fontWeight: 700 }}>
                  想問的問題
                </span>
                <p class="small pre">{r.questions}</p>
              </div>
            )}
            <p class={`small muted pre ${open ? '' : 'clamp-2'}`}>{r.progress}</p>
            <div class="row wrap small">
              {r.progress.length > 60 && (
                <button type="button" class="link-btn" onClick={() => setOpen(!open)}>
                  {open ? '收起' : '展開進度'}
                </button>
              )}
              {safeHref(r.link) && (
                <a href={safeHref(r.link)} target="_blank" rel="noopener noreferrer" class="row" style={{ gap: '4px' }}>
                  <Icon name="external" size={14} /> 雲端資料夾
                </a>
              )}
              <span class="faint tiny">
                {r.author} · {agoText(r.updated_at, now)}更新
              </span>
            </div>
          </>
        ) : (
          <p class="small muted">這組沒有填寫題目</p>
        )}
      </div>
    </div>
  );
}

function PastSessions({ list, st }: { list: TeacherSession[]; st: TeacherState }) {
  const [open, setOpen] = useState(false);
  return (
    <section class="section" aria-labelledby="t-past">
      <div class="section-head">
        <h2 id="t-past">最近四週已完成</h2>
        <button type="button" class="link-btn small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '收起' : `顯示 ${list.length} 場`}
        </button>
      </div>
      {open && (
        <div class="list">
          {list.map((s) => (
            <div class="li past" key={s.id}>
              <div class="when">
                <b>{s.t}</b>
                <span>{dayLabel(s.d)}</span>
              </div>
              <div class={`grow row wrap ${tc(st, s.teacher_id)}`} style={{ gap: '8px' }}>
                <span class="ls-who">{s.teacher}</span>
                <span class="gno soft">{s.group.no}</span>
                {s.request?.topic ?? '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
