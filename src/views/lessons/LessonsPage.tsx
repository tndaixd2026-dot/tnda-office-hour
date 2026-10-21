import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Lesson, LessonInfo, LessonsState, LessonUnit } from '../../api/types';
import { clock, useLive, useMedia, useTick } from '../../app/hooks';
import { useApp } from '../../app/session';
import { local } from '../../app/store';
import { HAS_CLOUD, SUPABASE_KEY, SUPABASE_URL } from '../../config';
import { downloadIcs } from '../../lib/files';
import {
  byWeek,
  googleCalendarUrl,
  hourRange,
  kindClass,
  lessonDetails,
  lessonEnd,
  lessonKind,
  lessonStart,
  lessonSummary,
  lessonTitle,
  monday,
  monthDays,
  nextLesson,
  shiftMonth,
  teacherClass,
  teacherList,
  unitNo,
  unitOf,
  unitShown,
} from '../../lib/lessons';
import { addDays, dayLabel, daysBetween, DOW, DOW_SHORT, isoDow, md, minutes, relativeDay, tzNote, untilText } from '../../lib/time';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, LiveBadge, Loading, Place, Seg } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';
import { LessonRow, type LessonPhase } from './parts';

type View = 'list' | 'week' | 'month' | 'teacher' | 'unit';
const VIEWS: View[] = ['list', 'week', 'month', 'teacher', 'unit'];
const VIEW_KEY = 'oh.td.view';

/** The TD 專班 timetable at #/td (or #/td/<teacher>): public, no sign-in, live. */
export function LessonsPage({ who }: { who?: string }) {
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
      {data ? <LessonsHome st={data} initialWho={who} /> : error ? <ErrorState onRetry={reload} /> : <Loading />}
    </>
  );
}

function phaseOf(l: Lesson, now: number, tz: string): LessonPhase {
  if (lessonEnd(l, tz) <= now) return 'past';
  return lessonStart(l, tz) <= now ? 'live' : 'later';
}

/** Keeps the chosen teacher in the address, so a one-teacher view can be shared. */
function rememberTeacher(who: string) {
  try {
    history.replaceState(null, '', who ? `#/td/${encodeURIComponent(who)}` : '#/td');
  } catch {
    /* sandboxed pages cannot rewrite the address */
  }
}

function LessonsHome({ st, initialWho }: { st: LessonsState; initialWho?: string }) {
  const now = useTick();
  const tz = st.clock.tz;
  const teachers = useMemo(() => teacherList(st.lessons), [st.lessons]);
  const [view, setView] = useState<View>(() => {
    const v = local.get<View>(VIEW_KEY);
    return v && VIEWS.includes(v) ? v : 'list';
  });
  const [who, setWho] = useState(initialWho && teachers.includes(initialWho) ? initialWho : '');
  const [kind, setKind] = useState('');
  const [unit, setUnit] = useState<number | null>(null);
  // only units that have lessons are worth filtering by
  const kindUnits = kind ? st.units.filter((u) => u.type === kind && st.lessons.some((l) => l.unit === u.id)) : [];
  const shown = st.lessons.filter((l) => (!who || l.teacher === who) && (!kind || l.type === kind) && (unit == null || l.unit === unit));
  const next = nextLesson(shown, now, tz);
  const first = st.lessons[0];
  const last = st.lessons[st.lessons.length - 1];
  const subscribe = () => openLessonsCalendar(st, who);
  const open = (l: Lesson) => openLesson(l, st, teachers);
  const pick = (v: View) => {
    setView(v);
    local.set(VIEW_KEY, v);
  };
  const pickWho = (t: string) => {
    setWho(t);
    rememberTeacher(t);
  };
  const pickKind = (k: string) => {
    setKind(k);
    setUnit(null);
  };
  const props: ViewProps = { lessons: shown, all: st.lessons, types: st.types, units: st.units, teachers, now, tz, open };

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
        <NextLesson l={next} unit={unitOf(next, st.units)} now={now} tz={tz} place={st.info.place} onSubscribe={subscribe} />
      ) : (
        st.lessons.length > 0 && (
          <div class="hero calm">
            <p class="title-m">{who || kind ? '符合篩選的課都上完了' : '這學期的課都上完了'}</p>
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
                { value: 'week', label: '週曆' },
                { value: 'month', label: '月曆' },
                { value: 'teacher', label: '依講師' },
                { value: 'unit', label: '依單元' },
              ]}
            />
            <Btn size="sm" icon="calendar" onClick={subscribe}>
              訂閱行事曆
            </Btn>
          </div>
        </div>

        {(teachers.length > 1 || st.types.length > 1) && (
          <div class="row wrap ls-filters">
            {teachers.length > 1 && (
              <div class="row wrap" role="group" aria-label="只看哪位講師">
                <span class="tiny muted">講師</span>
                <button type="button" class="ls-tg plain" aria-pressed={!who} onClick={() => pickWho('')}>
                  全部
                </button>
                {teachers.map((t) => (
                  <button type="button" key={t} class={`ls-tg ${teacherClass(teachers, t)}`} aria-pressed={who === t} onClick={() => pickWho(t)}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            {st.types.length > 1 && (
              <div class="row wrap" role="group" aria-label="只看哪種類型">
                <span class="tiny muted">類型</span>
                <button type="button" class="ls-tg plain" aria-pressed={!kind} onClick={() => pickKind('')}>
                  全部
                </button>
                {st.types.map((t) => (
                  <button type="button" key={t} class={`ls-tg kind ${kindClass(st.types, t)}`} aria-pressed={kind === t} onClick={() => pickKind(t)}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            {kindUnits.length > 0 && (
              <div class="row wrap" role="group" aria-label="只看哪個單元">
                <span class="tiny muted">單元</span>
                <button type="button" class="ls-tg plain" aria-pressed={unit == null} onClick={() => setUnit(null)}>
                  全部
                </button>
                {kindUnits.map((u) => (
                  <button type="button" key={u.id} class="ls-tg plain" aria-pressed={unit === u.id} onClick={() => setUnit(u.id)}>
                    {unitNo(u)}
                    {u.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {st.lessons.length === 0 ? (
          <Empty icon="calendar" title="還沒有排課">
            排好後會立刻出現在這裡
          </Empty>
        ) : shown.length === 0 ? (
          <Empty icon="calendar" title="沒有符合篩選的課">
            把講師、類型或單元換回「全部」看看
          </Empty>
        ) : view === 'week' ? (
          <WeekView {...props} />
        ) : view === 'month' ? (
          <MonthView {...props} />
        ) : view === 'teacher' ? (
          <TeacherView {...props} />
        ) : view === 'unit' ? (
          <UnitView {...props} />
        ) : (
          <ListView {...props} />
        )}
      </section>
    </main>
  );
}

function NextLesson({
  l,
  unit,
  now,
  tz,
  place,
  onSubscribe,
}: {
  l: Lesson;
  unit?: LessonUnit;
  now: number;
  tz: string;
  place: string;
  onSubscribe: () => void;
}) {
  const live = lessonStart(l, tz) <= now;
  const rel = relativeDay(l.date, clock.today);
  const title = lessonTitle(l, unit);
  const kind = lessonKind(l, unit);
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
        <p class="title-m">{title || kind}</p>
        <p style={{ opacity: 0.85 }}>
          {l.teacher}
          {title ? ` · ${kind}` : ''}
        </p>
        {unit?.topic && (
          <p class="small pre" style={{ opacity: 0.85 }}>
            {unit.topic}
          </p>
        )}
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
  types: string[];
  units: LessonUnit[];
  teachers: string[];
  now: number;
  tz: string;
  open: (l: Lesson) => void;
}

function Rows({
  list,
  types,
  units,
  inUnit,
  teachers,
  now,
  tz,
  open,
}: { list: Lesson[]; inUnit?: boolean } & Pick<ViewProps, 'types' | 'units' | 'teachers' | 'now' | 'tz' | 'open'>) {
  return (
    <div class="list">
      {list.map((l) => (
        <LessonRow
          key={l.id}
          l={l}
          unit={unitOf(l, units)}
          inUnit={inUnit}
          types={types}
          teachers={teachers}
          today={clock.today}
          phase={phaseOf(l, now, tz)}
          icon="right"
          onClick={() => open(l)}
        />
      ))}
    </div>
  );
}

function ListView({ lessons, all, ...rest }: ViewProps) {
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
          <Rows list={w.lessons} {...rest} />
        </section>
      ))}
    </div>
  );
}

/** The week of today, kept within the semester. */
function startWeek(all: Lesson[]): string {
  const today = clock.today;
  const first = all[0]?.date ?? today;
  const last = all[all.length - 1]?.date ?? today;
  return monday(today < first ? first : today > last ? last : today);
}

function WeekView({ lessons, all, types, units, teachers, now, tz, open }: ViewProps) {
  const phone = useMedia('(max-width: 640px)');
  const [start, setStart] = useState(() => startWeek(all));
  const firstWeek = monday(all[0]?.date ?? clock.today);
  const lastWeek = monday(all[all.length - 1]?.date ?? clock.today);
  const no = daysBetween(firstWeek, start) / 7 + 1;
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const inWeek = lessons.filter((l) => l.date >= start && l.date <= days[6]);
  const [h0, h1] = hourRange(all);
  const thisWeek = monday(clock.today);

  return (
    <div class="stack">
      <div class="row between wrap">
        <div class="row">
          <Btn size="sm" icon="left" aria-label="上一週" disabled={start <= firstWeek} onClick={() => setStart(addDays(start, -7))} />
          <Btn size="sm" icon="right" aria-label="下一週" disabled={start >= lastWeek} onClick={() => setStart(addDays(start, 7))} />
          {start !== thisWeek && thisWeek >= firstWeek && thisWeek <= lastWeek && (
            <Btn size="sm" variant="ghost" onClick={() => setStart(thisWeek)}>
              回到本週
            </Btn>
          )}
        </div>
        <h3 class="title-s" aria-live="polite">
          第 {no} 週 <span class="mono muted small">{md(start)}–{md(days[6])}</span>
          <span class="muted small"> {inWeek.length} 堂</span>
        </h3>
      </div>

      {phone ? (
        inWeek.length === 0 ? (
          <p class="muted small">這週沒有課</p>
        ) : (
          <div class="stack">
            {days
              .filter((d) => inWeek.some((l) => l.date === d))
              .map((d) => (
                <div class="stack tight" key={d}>
                  <h4 class="small" style={{ fontWeight: 700 }}>
                    {relativeDay(d, clock.today) ? `${relativeDay(d, clock.today)}・` : ''}
                    {dayLabel(d)}
                  </h4>
                  <Rows list={inWeek.filter((l) => l.date === d)} types={types} units={units} teachers={teachers} now={now} tz={tz} open={open} />
                </div>
              ))}
          </div>
        )
      ) : (
        <div class="ls-wk-scroll">
          <div class="ls-wk" style={{ '--rows': String(h1 - h0) }}>
            <span class="ls-wk-corner" aria-hidden="true" />
            {days.map((d) => (
              <span class={`ls-wk-dh ${d === clock.today ? 'today' : ''}`} key={d} aria-hidden="true">
                <span>{DOW[isoDow(d)]}</span>
                <b>{md(d)}</b>
              </span>
            ))}
            <span class="ls-wk-hours" aria-hidden="true">
              {Array.from({ length: h1 - h0 }, (_, i) => (
                <span key={i}>{`${String(h0 + i).padStart(2, '0')}:00`}</span>
              ))}
            </span>
            {days.map((d) => (
              <div class={`ls-wk-col ${d === clock.today ? 'today' : ''}`} key={d}>
                {inWeek
                  .filter((l) => l.date === d)
                  .map((l) => {
                    const top = (minutes(l.start) - h0 * 60) / 60;
                    const height = (minutes(l.end) - minutes(l.start)) / 60;
                    const phase = phaseOf(l, now, tz);
                    const unit = unitOf(l, units);
                    const title = lessonTitle(l, unit);
                    return (
                      <button
                        type="button"
                        key={l.id}
                        class={`ls-ev ${kindClass(types, l.type)} ${phase}`}
                        style={{ top: `calc(${top} * var(--hh))`, height: `calc(${height} * var(--hh) - 3px)` }}
                        onClick={() => open(l)}
                      >
                        <span class="sr-only">{dayLabel(d)} </span>
                        <span class="t">
                          {l.start}–{l.end}
                        </span>
                        <span class="n">
                          <span class={`ls-who ${teacherClass(teachers, l.teacher)}`}>{l.teacher}</span> · {lessonKind(l, unit)}
                        </span>
                        {title && <span class="ttl">{title}</span>}
                      </button>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MonthView({ lessons, all, types, units, teachers, now, tz, open }: ViewProps) {
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
                <span class={`ls-m ${kindClass(types, l.type)}`} key={l.id}>
                  <span class="t">{l.start}</span> <span class={`nm ls-who ${teacherClass(teachers, l.teacher)}`}>{l.teacher}</span>
                  <span class="sr-only"> {lessonKind(l, unitOf(l, units))}</span>
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
        {picked.length ? <Rows list={picked} types={types} units={units} teachers={teachers} now={now} tz={tz} open={open} /> : <p class="muted small">這天沒有課</p>}
      </div>
    </div>
  );
}

/** One column per teacher: how many lessons of each type, and what is coming up. */
function TeacherView({ lessons, types, units, teachers, now, tz, open }: ViewProps) {
  const [showPast, setShowPast] = useState(false);
  const who = teachers.filter((t) => lessons.some((l) => l.teacher === t));
  return (
    <div class="stack">
      <button type="button" class="link-btn small" style={{ justifySelf: 'start' }} aria-expanded={showPast} onClick={() => setShowPast(!showPast)}>
        {showPast ? '只看還沒上的課' : '也顯示已結束的課'}
      </button>
      <div class="ls-teachers">
        {who.map((t) => {
          const mine = lessons.filter((l) => l.teacher === t);
          const ahead = mine.filter((l) => lessonEnd(l, tz) > now);
          const list = showPast ? mine : ahead;
          const counts = types.filter((k) => mine.some((l) => l.type === k));
          return (
            <section class="stack tight" key={t} aria-labelledby={`ls-t-${t}`}>
              <h3 class={`ls-wh ${teacherClass(teachers, t)}`} id={`ls-t-${t}`}>
                <span class="ls-who">{t}</span>
                <span class="small muted">
                  共 {mine.length} 堂 還有 {ahead.length} 堂
                </span>
              </h3>
              <div class="row wrap" style={{ gap: '6px' }}>
                {counts.map((k) => (
                  <span class={`chip kind ${kindClass(types, k)}`} key={k}>
                    {k} {mine.filter((l) => l.type === k).length}
                  </span>
                ))}
              </div>
              {list.length ? <Rows list={list} types={types} units={units} teachers={teachers} now={now} tz={tz} open={open} /> : <p class="muted small">沒有還沒上的課</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Each type's units in order, with what they cover and when; then the lessons not in one yet. */
function UnitView({ lessons, all, types, units, teachers, now, tz, open }: ViewProps) {
  // units with no lessons yet show only when nothing is filtered out
  const everything = lessons.length === all.length;
  const rest = { types, units, teachers, now, tz, open };
  // a unit still empty in the outline is left out until it has a topic or lessons
  const listed = units.filter((u) => unitShown(u, all));
  const shown = types.filter((t) => lessons.some((l) => l.type === t) || (everything && listed.some((u) => u.type === t)));
  return (
    <div class="stack loose">
      {!listed.length && <p class="muted small">還沒有分單元，先依類型列出全部的課</p>}
      {shown.map((t) => {
        const mine = listed.filter((u) => u.type === t && (lessons.some((l) => l.unit === u.id) || (everything && !all.some((l) => l.unit === u.id))));
        const loose = lessons.filter((l) => l.type === t && unitOf(l, units) == null);
        return (
          <section class={`stack ${kindClass(types, t)}`} key={t} aria-labelledby={`ls-k-${t}`}>
            <h3 class="title-s" id={`ls-k-${t}`}>
              <span class="sw" aria-hidden="true" />
              {t}
              {mine.length > 0 && <span class="small muted"> {mine.length} 個單元</span>}
            </h3>
            {mine.map((u) => {
              const list = lessons.filter((l) => l.unit === u.id);
              const ahead = list.filter((l) => lessonEnd(l, tz) > now).length;
              return (
                <article class="card tight stack tight ls-unit" key={u.id} aria-labelledby={`ls-u-${u.id}`}>
                  <h4 class="ls-wh" id={`ls-u-${u.id}`}>
                    <span>
                      {unitNo(u)}
                      {u.title || '主題待定'}
                    </span>
                    <span class="small muted">{list.length ? `${list.length} 堂${ahead < list.length ? ` 還有 ${ahead} 堂` : ''}` : '日期待定'}</span>
                  </h4>
                  {u.topic && <p class="small pre">{u.topic}</p>}
                  {list.length > 0 && <Rows list={list} inUnit {...rest} />}
                </article>
              );
            })}
            {loose.length > 0 && (
              <div class="stack tight">
                {mine.length > 0 && <h4 class="small muted">還沒分單元的課</h4>}
                <Rows list={loose} {...rest} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------- one lesson ----------
function openLesson(l: Lesson, st: LessonsState, teachers: string[]) {
  const unit = unitOf(l, st.units);
  const siblings = unit ? st.lessons.filter((x) => x.unit === unit.id) : [];
  openDialog(`${md(l.date)} ${l.start} ${l.teacher}`, (close) => (
    <LessonDetail l={l} unit={unit} siblings={siblings} info={st.info} tz={st.clock.tz} types={st.types} teachers={teachers} close={close} />
  ));
}

function LessonDetail({
  l,
  unit,
  siblings,
  info,
  tz,
  types,
  teachers,
  close,
}: {
  l: Lesson;
  unit?: LessonUnit;
  siblings: Lesson[];
  info: LessonInfo;
  tz: string;
  types: string[];
  teachers: string[];
  close: () => void;
}) {
  const title = lessonTitle(l, unit);
  return (
    <>
      <div class="stack tight">
        <p class="eyebrow">
          {dayLabel(l.date)} {l.start}–{l.end}
        </p>
        <h2 class={title ? '' : 'muted'}>{title || '標題待定'}</h2>
      </div>
      <div class={`row wrap ${teacherClass(teachers, l.teacher)}`}>
        <span class="ls-who">{l.teacher}</span>
        <span class={`chip kind ${kindClass(types, l.type)}`}>{lessonKind(l, unit)}</span>
      </div>
      {unit?.topic && (
        <div class="card sunk tight stack tight">
          <span class="eyebrow">單元說明</span>
          <p class="small pre">{unit.topic}</p>
        </div>
      )}
      {l.topic && <p class="pre">{l.topic}</p>}
      {siblings.length > 1 && (
        <div class="stack tight">
          <span class="eyebrow">這個單元的所有時段</span>
          <ul class="ls-sib">
            {siblings.map((x) => (
              <li key={x.id} class={x.id === l.id ? 'cur' : ''}>
                <span class="mono">
                  {md(x.date)} {DOW[isoDow(x.date)]} {x.start}
                </span>{' '}
                <span class={`ls-who ${teacherClass(teachers, x.teacher)}`}>{x.teacher}</span>
                {x.id === l.id && <span class="chip accent">這堂</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {info.place && (
        <p class="small row" style={{ gap: '6px' }}>
          <Icon name="pin" size={16} />
          <Place value={info.place} />
        </p>
      )}
      <div class="actions">
        <a class="btn" href={googleCalendarUrl(l, tz, info.place, unit)} target="_blank" rel="noopener noreferrer">
          <Icon name="calendar" /> 加到 Google 日曆
        </a>
        <button type="button" class="btn primary" onClick={close}>
          完成
        </button>
      </div>
    </>
  );
}

// ---------- calendar subscription ----------
function feedUrl(teacher: string) {
  const u = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/oh_lessons_calendar`);
  u.searchParams.set('apikey', SUPABASE_KEY);
  if (teacher) u.searchParams.set('p_teacher', teacher);
  return u.toString();
}

export function openLessonsCalendar(st: LessonsState, who = '') {
  openDialog('訂閱行事曆', (close) => <LessonsCalendar st={st} initial={who} close={close} />, { wide: 'wide' });
}

function LessonsCalendar({ st, initial, close }: { st: LessonsState; initial: string; close: () => void }) {
  const { engine } = useApp();
  const teachers = teacherList(st.lessons);
  const [who, setWho] = useState(initial);
  const demo = engine?.mode === 'demo' || !HAS_CLOUD;
  const url = demo ? '' : feedUrl(who);
  const webcal = url.replace(/^https:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  const download = () =>
    downloadIcs(
      who ? `td-lessons-${who}.ics` : 'td-lessons.ics',
      st.lessons
        .filter((l) => !who || l.teacher === who)
        .map((l) => ({
          uid: `td-${l.id}@tnda-office-hour`,
          d: l.date,
          t: l.start,
          minutes: minutes(l.end) - minutes(l.start),
          tz: st.clock.tz,
          title: lessonSummary(l, unitOf(l, st.units)),
          location: st.info.place,
          description: lessonDetails(l, unitOf(l, st.units)),
        })),
      who ? `${st.info.title} · ${who}` : st.info.title,
    );

  return (
    <>
      <div class="stack tight">
        <h2>訂閱行事曆</h2>
        <p class="muted small">訂閱一次，之後加課、改時間或補上標題，行事曆都會自動更新，每堂開始前 15 分鐘提醒</p>
      </div>
      {teachers.length > 1 && (
        <div class="field">
          <span class="label">要訂閱哪些課</span>
          <Seg
            label="要訂閱哪些課"
            value={who}
            onChange={setWho}
            options={[{ value: '', label: '全部' }, ...teachers.map((t) => ({ value: t, label: `只有${t}` }))]}
          />
        </div>
      )}
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
