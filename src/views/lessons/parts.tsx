import type { Lesson, LessonUnit } from '../../api/types';
import { kindClass, lessonKind, lessonTitle, teacherClass } from '../../lib/lessons';
import { DOW, isoDow, md, relativeDay } from '../../lib/time';
import { Icon, type IconName } from '../../ui/icons';

export type LessonPhase = 'past' | 'live' | 'later';

/**
 * One lesson in a list. With `onClick` the whole row is a button (edit in
 * the admin, details on the public page); everything inside is phrasing
 * content so that stays valid HTML. Inside a unit's own list (`inUnit`)
 * the unit is already said, so only the lesson's own title is shown. The
 * row's bar and chip take its type's colour, the dot its teacher's.
 */
export function LessonRow({
  l,
  unit,
  inUnit = false,
  showConfirmed = false,
  types,
  teachers,
  today,
  phase = 'later',
  onClick,
  icon = 'edit',
}: {
  l: Lesson;
  unit?: LessonUnit;
  inUnit?: boolean;
  /** the admin's list says which lessons are 已確定 */
  showConfirmed?: boolean;
  types: string[];
  teachers: string[];
  today: string;
  phase?: LessonPhase;
  onClick?: () => void;
  icon?: IconName;
}) {
  const rel = relativeDay(l.date, today);
  const title = inUnit ? l.title : lessonTitle(l, unit);
  const kind = kindClass(types, l.type);
  const cls = ['li top ls-row', kind, teacherClass(teachers, l.teacher), phase === 'past' && 'past', phase === 'live' && 'ls-live', onClick && 'ls-edit']
    .filter(Boolean)
    .join(' ');
  const body = (
    <>
      <span class="when">
        <b>{md(l.date)}</b>
        <span>{DOW[isoDow(l.date)]}</span>
      </span>
      <span class="grow stack tight">
        <span class="row wrap ls-meta">
          <span class="mono">
            {l.start}–{l.end}
          </span>
          <span class="ls-who">{l.teacher}</span>
          {!inUnit && <span class="chip kind">{lessonKind(l, unit)}</span>}
          {showConfirmed && l.confirmed && <span class="chip ok">已確定</span>}
          {phase === 'live' ? <span class="chip accent">上課中</span> : phase === 'later' && rel && <span class="chip accent">{rel}</span>}
        </span>
        {(title || !inUnit) && <span class={`ls-title ${title ? '' : 'muted'}`}>{title || '標題待定'}</span>}
        {l.topic && <span class="small muted pre ls-topic">{l.topic}</span>}
      </span>
      {onClick && <Icon name={icon} class="ls-pen" />}
    </>
  );
  return onClick ? (
    <button type="button" class={cls} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div class={cls}>{body}</div>
  );
}
