import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Lesson, LessonsState } from '../../api/types';
import { clock, useLive, useTick } from '../../app/hooks';
import { useApp } from '../../app/session';
import { local } from '../../app/store';
import { HAS_CLOUD, SUPABASE_KEY, SUPABASE_URL } from '../../config';
import { downloadIcs } from '../../lib/files';
import { byWeek, lessonEnd, lessonStart, monday, monthDays, nextLesson, shiftMonth, teacherClass, teacherList } from '../../lib/lessons';
import { addDays, dayLabel, DOW, DOW_SHORT, isoDow, md, minutes, relativeDay, tzNote, untilText } from '../../lib/time';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, LiveBadge, Loading, Place, Seg } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';
import { LessonRow, type LessonPhase } from './parts';

type View = 'list' | 'month';
const VIEW_KEY = 'oh.td.view';

/** The TD 專班 timetable at #/td: public, no sign-in, live. */
export function LessonsPage() {
  const { auth } = useApp();
  const { data, error, reload } = useLive<LessonsState>('oh_lessons', {}, true);
  const title = data?.info.title;

  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);

  const back = auth ? (auth.session.role === 'admin' ? { href: '#/admin/td', label: '回到後台' } : { href: '#/', label: '回到 Office Hour' }) : null;
  return (
    <>
      <header class="topbar">
        <div class="topbar-inner">
          <span class="brand">
            <span class="brand-mark" aria-hidden="true">
              TD
            </span>
            <span class="brand-name">{title ?? 'TD 專班課表'}</span>
          </span>
          <span class="grow" />
          <LiveBadge />
          {back && (
            <a class="btn sm ghost" href={back.href}>
              {back.label}
            </a>
          )}
        </div>
      </header>
      {data ? <LessonsHome st={data} /> : error ? <ErrorState onRetry={reload} /> : <Loading />}
    </>
  );
}

function phaseOf(l: Lesson, now: number, tz: string): LessonPhase {
  if (lessonEnd(l, tz) <= now) return 'past';
  return lessonStart(l, tz) <= now ? 'live' : 'later';
}

function LessonsHome({ st }: { st: LessonsState }) {
  const now = useTick();
  const tz = st.clock.tz;
  const teachers = useMemo(() => teacherList(st.lessons), [st.lessons]);
  const [view, setView] = useState<View>(() => (local.get<View>(VIEW_KEY) === 'month' ? 'month' : 'list'));
  const [hideTeachers, setHideTeachers] = useState<string[]>([]);
  const [hideTypes, setHideTypes] = useState<string[]>([]);
  const shown = st.lessons.filter((l) => !hideTeachers.includes(l.teacher) && !hideTypes.includes(l.type));
  const next = nextLesson(st.lessons, now, tz);
  const first = st.lessons[0];
  const last = st.lessons[st.lessons.length - 1];
  const subscribe = () => openLessonsCalendar(st);
  const pick = (v: View) => {
    setView(v);
    local.set(VIEW_KEY, v);
  };
  const toggle = (list: string[], set: (l: string[]) => void, x: string) => set(list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  return (
    <main class="page enter">
      <div class="stack tight">
        {st.info.subtitle && <p class="eyebrow">{st.info.subtitle}</p>}
        <h1 class="title-l">{st.info.title}</h1>
        {first && (
          <p class="small muted">
            {md(first.date)}–{md(last.date)} 共 {st.lessons.length} 堂{tzNote(tz) ? ` 時間都是${tzNote(tz)}` : ''}
          </p>
        )}
        {st.info.place && (
          <p class="small row" style={{ gap: '6px' }}>
            <Icon name="pin" size={16} />
            <Place value={st.info.place} />
          </p>
        )}
      </div>

      {st.info.note && (
        <div class="notice info">
          <Icon name="info" />
          <span class="pre">{st.info.note}</span>
        </div>
      )}

      {next ? (
        <NextLesson l={next} now={now} tz={tz} place={st.info.place} onSubscribe={subscribe} />
      ) : (
        st.lessons.length > 0 && (
          <div class="hero calm">
            <p class="title-m">這學期的課都上完了</p>
          </div>
        )
      )}

      <section class="section" aria-labelledby="ls-all">
        <div class="section-head">
          <h2 id="ls-all">全部課程</h2>
          <div class="row wrap ls-tools">
            <Seg<View>
              label="檢視方式"
              value={view}
              onChange={pick}
              options={[
                { value: 'list', label: '清單' },
                { value: 'month', label: '月曆' },
              ]}
            />
            <Btn size="sm" icon="calendar" onClick={subscribe}>
              訂閱行事曆
            </Btn>
          </div>
        </div>

        {(teachers.length > 1 || st.types.length > 1) && (
          <div class="row wrap ls-filters">
            <div class="row wrap" role="group" aria-label="依講師篩選">
              <span class="tiny muted">講師</span>
              {teachers.map((t) => (
                <button
                  type="button"
                  key={t}
                  class={`ls-tg ${teacherClass(teachers, t)}`}
                  aria-pressed={!hideTeachers.includes(t)}
                  onClick={() => toggle(hideTeachers, setHideTeachers, t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div class="row wrap" role="group" aria-label="依類型篩選">
              <span class="tiny muted">類型</span>
              {st.types.map((t) => (
                <button type="button" key={t} class="ls-tg plain" aria-pressed={!hideTypes.includes(t)} onClick={() => toggle(hideTypes, setHideTypes, t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {st.lessons.length === 0 ? (
          <Empty icon="calendar" title="還沒有排課">
            排好後會立刻出現在這裡
          </Empty>
        ) : shown.length === 0 ? (
          <Empty icon="calendar" title="沒有符合篩選的課">
            點上面的講師或類型，把它們重新打開
          </Empty>
        ) : view === 'list' ? (
          <ListView lessons={shown} all={st.lessons} teachers={teachers} now={now} tz={tz} />
        ) : (
          <MonthView lessons={shown} all={st.lessons} teachers={teachers} now={now} tz={tz} />
        )}
      </section>
    </main>
  );
}

function NextLesson({ l, now, tz, place, onSubscribe }: { l: Lesson; now: number; tz: string; place: string; onSubscribe: () => void }) {
  const live = lessonStart(l, tz) <= now;
  const rel = relativeDay(l.date, clock.today);
  return (
    <section class="hero" aria-labelledby="ls-next">
      <div class="row between wrap">
        <p class="eyebrow" id="ls-next">
          {live ? '正在上課' : '下一堂'}
        </p>
        <span class="countdown">
          <Icon name="clock" size={14} />
          {live ? `${l.end} 下課` : untilText(lessonStart(l, tz) - now)}
        </span>
      </div>
      <div class="stack tight">
        <span class="day">
          {rel ? `${rel}・` : ''}
          {dayLabel(l.date)}
        </span>
        <span class="num-xl">
          {l.start}–{l.end}
        </span>
      </div>
      <div class="stack tight">
        <p class="title-m">{l.title || l.type}</p>
        <p style={{ opacity: 0.85 }}>
          {l.teacher}
          {l.title ? ` · ${l.type}` : ''}
        </p>
        {l.topic && (
          <p class="small pre" style={{ opacity: 0.85 }}>
            {l.topic}
          </p>
        )}
      </div>
      {place && (
        <div class="meta">
          <span>
            <Icon name="pin" size={16} />
            <Place value={place} />
          </span>
        </div>
      )}
      <div class="row wrap">
        <Btn icon="calendar" onClick={onSubscribe}>
          訂閱行事曆
        </Btn>
      </div>
    </section>
  );
}

interface ViewProps {
  lessons: Lesson[];
  all: Lesson[];
  teachers: string[];
  now: number;
  tz: string;
}

function ListView({ lessons, all, teachers, now, tz }: ViewProps) {
  const [showPast, setShowPast] = useState(false);
  const thisWeek = monday(clock.today);
  const weeks = byWeek(lessons, all[0]?.date);
  const past = weeks.filter((w) => w.start < thisWeek);
  const visible = showPast ? weeks : weeks.filter((w) => w.start >= thisWeek);
  return (
    <div class="stack loose">
      {past.length > 0 && (
        <button type="button" class="link-btn small" style={{ justifySelf: 'start' }} aria-expanded={showPast} onClick={() => setShowPast(!showPast)}>
          {showPast ? '收起已結束的週' : `顯示已結束的 ${past.length} 週`}
        </button>
      )}
      {visible.length === 0 && <p class="muted small">這學期的課都上完了</p>}
      {visible.map((w) => (
        <section class="stack tight" key={w.start} aria-labelledby={`ls-w-${w.start}`}>
          <h3 class="ls-wh" id={`ls-w-${w.start}`}>
            <span>第 {w.no} 週</span>
            <span class="small muted mono">
              {md(w.start)}–{md(addDays(w.start, 6))}
            </span>
            <span class="small muted">{w.lessons.length} 堂</span>
            {w.start === thisWeek && <span class="chip accent">本週</span>}
          </h3>
          <div class="list">
            {w.lessons.map((l) => (
              <LessonRow key={l.id} l={l} teachers={teachers} today={clock.today} phase={phaseOf(l, now, tz)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MonthView({ lessons, all, teachers, now, tz }: ViewProps) {
  const today = clock.today;
  const first = all[0]?.date ?? today;
  const last = all[all.length - 1]?.date ?? today;
  const start = today < first ? first : today > last ? last : today;
  const [ym, setYm] = useState(start.slice(0, 7));
  const [sel, setSel] = useState(start);

  const byDay = new Map<string, Lesson[]>();
  for (const l of lessons) byDay.set(l.date, [...(byDay.get(l.date) ?? []), l]);
  const move = (n: number) => {
    const m = shiftMonth(ym, n);
    setYm(m);
    setSel(today.startsWith(m) ? today : (lessons.find((l) => l.date.startsWith(m))?.date ?? `${m}-01`));
  };
  const [y, mo] = ym.split('-').map(Number);
  const picked = byDay.get(sel) ?? [];

  return (
    <div class="stack">
      <div class="row between">
        <Btn size="sm" icon="left" aria-label="上個月" disabled={ym <= first.slice(0, 7)} onClick={() => move(-1)} />
        <h3 class="title-s" aria-live="polite">
          {y} 年 {mo} 月
        </h3>
        <Btn size="sm" icon="right" aria-label="下個月" disabled={ym >= last.slice(0, 7)} onClick={() => move(1)} />
      </div>
      <div class="ls-cal">
        {DOW_SHORT.slice(1).map((w) => (
          <span class="ls-dh" key={w} aria-hidden="true">
            {w}
          </span>
        ))}
        {monthDays(ym).map((d) => {
          if (!d.startsWith(ym)) return <span class="ls-day out" key={d} />;
          const list = byDay.get(d) ?? [];
          const inner = (
            <>
              <span class="n">{Number(d.slice(8))}</span>
              <span class="sr-only">
                日 {DOW[isoDow(d)]}
                {list.length ? ` ${list.length} 堂` : ''}
              </span>
              {list.map((l) => (
                <span class={`ls-m ${teacherClass(teachers, l.teacher)}`} key={l.id}>
                  <span class="t">{l.start}</span> <span class="nm">{l.teacher}</span>
                  <span class="sr-only"> {l.type}</span>
                </span>
              ))}
            </>
          );
          const cls = `ls-day ${d === today ? 'today' : ''}`;
          return list.length ? (
            <button type="button" key={d} class={cls} aria-pressed={d === sel} onClick={() => setSel(d)}>
              {inner}
            </button>
          ) : (
            <span key={d} class={`${cls} none`}>
              {inner}
            </span>
          );
        })}
      </div>
      <div class="stack tight">
        <h3 class="title-s">
          {md(sel)}（{DOW[isoDow(sel)]}）
        </h3>
        {picked.length ? (
          <div class="list">
            {picked.map((l) => (
              <LessonRow key={l.id} l={l} teachers={teachers} today={today} phase={phaseOf(l, now, tz)} />
            ))}
          </div>
        ) : (
          <p class="muted small">這天沒有課</p>
        )}
      </div>
    </div>
  );
}

// ---------- calendar subscription ----------
function feedUrl() {
  const u = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/oh_lessons_calendar`);
  u.searchParams.set('apikey', SUPABASE_KEY);
  return u.toString();
}

export function openLessonsCalendar(st: LessonsState) {
  openDialog('訂閱行事曆', (close) => <LessonsCalendar st={st} close={close} />, { wide: 'wide' });
}

function LessonsCalendar({ st, close }: { st: LessonsState; close: () => void }) {
  const { engine } = useApp();
  const demo = engine?.mode === 'demo' || !HAS_CLOUD;
  const url = demo ? '' : feedUrl();
  const webcal = url.replace(/^https:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  const download = () =>
    downloadIcs(
      'td-lessons.ics',
      st.lessons.map((l) => ({
        uid: `td-${l.id}@tnda-office-hour`,
        d: l.date,
        t: l.start,
        minutes: minutes(l.end) - minutes(l.start),
        tz: st.clock.tz,
        title: `TD ${l.type} · ${l.teacher}${l.title ? `｜${l.title}` : ''}`,
        location: st.info.place,
        description: [l.title, l.topic, `講師：${l.teacher}　類型：${l.type}`].filter(Boolean).join('\n\n'),
      })),
      st.info.title,
    );

  return (
    <>
      <div class="stack tight">
        <h2>訂閱行事曆</h2>
        <p class="muted small">訂閱一次，之後加課、改時間或補上標題，行事曆都會自動更新，每堂開始前 15 分鐘提醒</p>
      </div>
      {demo ? (
        <div class="notice info">
          <Icon name="info" />
          <span class="small">示範模式沒有雲端資料庫，所以不能訂閱；正式網站可以。你仍然可以下載目前的課表</span>
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
            </div>
          </div>
          <p class="tiny muted">這是公開的課表，網址可以直接分享給同學。Google 日曆大約每幾小時更新一次</p>
        </div>
      )}
      <div class="actions">
        <Btn icon="download" onClick={download}>
          只下載目前的課表
        </Btn>
        <button type="button" class="btn primary" onClick={close}>
          完成
        </button>
      </div>
    </>
  );
}
