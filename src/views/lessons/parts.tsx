import type { Lesson } from '../../api/types';
import { teacherClass } from '../../lib/lessons';
import { DOW, isoDow, md, relativeDay } from '../../lib/time';
import { Icon } from '../../ui/icons';

export type LessonPhase = 'past' | 'live' | 'later';

/**
 * One lesson in a list. With `onEdit` the whole row is a button (admin);
 * everything inside is phrasing content so that stays valid HTML.
 */
export function LessonRow({
  l,
  teachers,
  today,
  phase = 'later',
  onEdit,
}: {
  l: Lesson;
  teachers: string[];
  today: string;
  phase?: LessonPhase;
  onEdit?: () => void;
}) {
  const rel = relativeDay(l.date, today);
  const cls = ['li top ls-row', teacherClass(teachers, l.teacher), phase === 'past' && 'past', phase === 'live' && 'ls-live', onEdit && 'ls-edit']
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
      {onEdit && <Icon name="edit" class="ls-pen" />}
    </>
  );
  return onEdit ? (
    <button type="button" class={cls} onClick={onEdit}>
      {body}
    </button>
  ) : (
    <div class={cls}>{body}</div>
  );
}
