import type { Lesson } from '../../api/types';
import { teacherClass } from '../../lib/lessons';
import { DOW, isoDow, md, relativeDay } from '../../lib/time';
import { Icon, type IconName } from '../../ui/icons';

export type LessonPhase = 'past' | 'live' | 'later';

/**
 * One lesson in a list. With `onClick` the whole row is a button (edit in
 * the admin, details on the public page); everything inside is phrasing
 * content so that stays valid HTML.
 */
export function LessonRow({
  l,
  teachers,
  today,
  phase = 'later',
  onClick,
  icon = 'edit',
}: {
  l: Lesson;
  teachers: string[];
  today: string;
  phase?: LessonPhase;
  onClick?: () => void;
  icon?: IconName;
}) {
  const rel = relativeDay(l.date, today);
  const cls = ['li top ls-row', teacherClass(teachers, l.teacher), phase === 'past' && 'past', phase === 'live' && 'ls-live', onClick && 'ls-edit']
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
          <span class="chip">{l.type}</span>
          {phase === 'live' ? <span class="chip accent">上課中</span> : phase === 'later' && rel && <span class="chip accent">{rel}</span>}
        </span>
        <span class={`ls-title ${l.title ? '' : 'muted'}`}>{l.title || '標題待定'}</span>
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
