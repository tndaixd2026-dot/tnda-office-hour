import { useState } from 'preact/hooks';
import type { AdminGroup, AdminState, Appointment } from '../../api/types';
import { clock, useApi, useBusy, useDiff, useLive, useTick } from '../../app/hooks';
import { ISSUE } from '../../app/messages';
import { go, href } from '../../app/router';
import { local } from '../../app/store';
import { csvText, download } from '../../lib/files';
import { dayOfWeek, deadlineText, timeRange } from '../../lib/format';
import { addDays, dayLabel, DOW, isoDow, localStamp, mdPad } from '../../lib/time';
import { ask, confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, Loading, Place, WeekStrip, safeHref } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { ErrorState } from '../student/StudentApp';
import { eventText, groupName, siteUrl } from './common';

export function Board({ weekParam }: { weekParam: number | null }) {
  const { data, error, reload } = useLive<AdminState>('oh_admin_state', { p_week: weekParam });
  // announce what students did while this board was open
  useDiff(data, (prev, next) => {
    const seen = prev.events[0]?.id ?? 0;
    const fresh = next.events.filter((e) => e.id > seen && e.role === 'student' && /^(request\.|appt\.cancelled)/.test(e.kind));
    for (const e of fresh.slice(0, 3).reverse()) toast(eventText(e, next.groups), { ms: 6000 });
  });
  if (!data) return error ? <ErrorState onRetry={reload} /> : <Loading />;
  return <BoardView st={data} reload={reload} />;
}

type RowState = 'booked' | 'cancelled' | 'skipped' | 'holiday' | 'nofixed' | 'waiting';

interface Row {
  g: AdminGroup;
  state: RowState;
  /** this week's date and time of the group's fixed slot */
  fixed: { teacher: number; d: string; t: string } | null;
  session: Appointment | null;
  cancelled: Appointment | null;
  holiday: string | undefined;
}

/** One week: each group's fixed hour, what they decided, and the session to adjust. */
function BoardView({ st, reload }: { st: AdminState; reload: () => void }) {
  const { call } = useApi();
  const { busy, run } = useBusy(st.settings);
  const now = useTick(60000);
  const week = st.weeks.find((w) => w.id === st.week_id) ?? null;
  const mins = st.settings.slot_minutes;
  const nowStamp = localStamp(now, st.clock.tz);
  const tName = (id: number) => st.teachers.find((t) => t.id === id)?.name ?? '—';
  const room = (id: number) => st.teachers.find((t) => t.id === id)?.room ?? st.settings.location;
  const slotMap = new Map(st.slots.map((s) => [`${s.d} ${s.t}`, s]));
  const holidays = new Map(st.closures.filter((c) => c.teacher_id === null).map((c) => [c.d, c.reason || '放假']));

  if (!week) {
    return (
      <main class="page">
        <Empty icon="calendar" title="還沒有任何週次">
          先到「時段與週次」建立學期的週次
        </Empty>
      </main>
    );
  }

  const open = nowStamp < week.deadline;
  const active = st.groups.filter((g) => g.active);
  const rows: Row[] = active
    .map((g) => {
      const req = st.requests.find((r) => r.group_id === g.id) ?? null;
      const mine = st.appointments.filter((a) => a.group_id === g.id).sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
      const session = mine.find((a) => a.status !== 'cancelled') ?? null;
      const cancelled = mine.find((a) => a.status === 'cancelled') ?? null;
      const fixed = g.teacher_id && g.slot_dow && g.slot_time ? { teacher: g.teacher_id, d: dayOfWeek(week.start, g.slot_dow), t: g.slot_time } : null;
      const holiday = fixed ? holidays.get(fixed.d) : undefined;
      const state: RowState = session
        ? 'booked'
        : req?.status === 'skipped'
          ? 'skipped'
          : cancelled
            ? 'cancelled'
            : holiday
              ? 'holiday'
              : !fixed
                ? 'nofixed'
                : 'waiting';
      return { g, state, fixed, session, cancelled, holiday };
    })
    .sort((a, b) => (a.fixed ? `${a.fixed.d} ${a.fixed.t}` : `z${a.g.no}`).localeCompare(b.fixed ? `${b.fixed.d} ${b.fixed.t}` : `z${b.g.no}`));
  const count = (s: RowState) => rows.filter((r) => r.state === s).length;
  const waiting = rows.filter((r) => r.state === 'waiting');

  // ---------- actions ----------
  async function move(a: Appointment, teacher: number, d: string, t: string) {
    if (a.teacher_id === teacher && a.d === d && a.t === t) return;
    const payload = { p_id: a.id, p_teacher: teacher, p_d: d, p_t: t };
    let issues: string | null = null;
    const r = await run('move', () => call('oh_admin_move', payload), {
      onError: (e) => {
        if (e.code !== 'NEEDS_FORCE') return false;
        issues = e.detail;
        return true;
      },
      ok: '已更新，學生和業師會即時看到',
    });
    if (!r && issues) {
      const list = (issues as string).split(',').map((x) => ISSUE[x] ?? x);
      const ok = await confirm({
        title: '這樣安排會打破規則',
        body: (
          <>
            <ul style={{ margin: '0px', paddingLeft: '18px' }}>
              {list.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p>如果已經和業師確認過，仍然可以安排</p>
          </>
        ),
        ok: '仍要安排',
      });
      if (ok) await run('move', () => call('oh_admin_move', { ...payload, p_force: true }), { ok: '已更新，學生和業師會即時看到' });
    }
    reload();
  }

  async function substitute(a: Appointment) {
    const others = st.teachers.filter((t) => t.active && t.id !== a.teacher_id);
    const tid = await openDialog<number>('代班', (close) => (
      <>
        <div class="stack tight">
          <p class="eyebrow">
            {groupName(st.groups, a.group_id)} · {dayLabel(a.d)} {timeRange(a.t, mins)} · 原本 {tName(a.teacher_id)}
          </p>
          <h2>請哪位業師代班？</h2>
          <p class="small muted">時間不變，學生畫面會換成代班業師的討論室</p>
        </div>
        <div class="list">
          {others.map((t) => {
            const taken = st.appointments.some((x) => x.status !== 'cancelled' && x.teacher_id === t.id && x.d === a.d && x.t === a.t);
            const free = slotMap.get(`${a.d} ${a.t}`)?.teachers.includes(t.id);
            return (
              <div class="li" key={t.id}>
                <TeacherDot id={t.id} teachers={st.teachers} />
                <span class="grow stack" style={{ gap: '0px' }}>
                  <b class="small">{t.name}</b>
                  <span class="tiny muted">{taken ? '這個時段已有場次' : free ? '這個時段有開放' : '不在開放時段，要先和業師確認'}</span>
                </span>
                <Btn size="sm" variant={free && !taken ? 'primary' : undefined} disabled={taken} onClick={() => close(t.id)}>
                  代班
                </Btn>
              </div>
            );
          })}
        </div>
        <div class="actions">
          <button type="button" class="btn" onClick={() => close()}>
            關閉
          </button>
        </div>
      </>
    ));
    if (tid) await move(a, tid, a.d, a.t);
  }

  async function reschedule(a: Appointment) {
    // the same PM's free open hours this week; a backup hour is one no group has fixed
    const fixedKeys = new Set(active.filter((g) => g.teacher_id && g.slot_dow).map((g) => `${g.teacher_id} ${g.slot_dow} ${g.slot_time}`));
    const free = st.slots
      .filter(
        (s) =>
          s.teachers.includes(a.teacher_id) &&
          `${s.d} ${s.t}` >= nowStamp &&
          !(s.d === a.d && s.t === a.t) &&
          !st.appointments.some((x) => x.status !== 'cancelled' && x.teacher_id === a.teacher_id && x.d === s.d && x.t === s.t),
      )
      .map((s) => ({ ...s, backup: !fixedKeys.has(`${a.teacher_id} ${isoDow(s.d)} ${s.t}`) }));
    const pick = await openDialog<{ d: string; t: string }>('改期', (close) => (
      <>
        <div class="stack tight">
          <p class="eyebrow">
            {groupName(st.groups, a.group_id)} · 原本 {dayLabel(a.d)} {timeRange(a.t, mins)} · {tName(a.teacher_id)}
          </p>
          <h2>改到什麼時候？</h2>
        </div>
        {free.length ? (
          <div class="list">
            {free.map((s) => (
              <div class="li" key={`${s.d} ${s.t}`}>
                <span class="grow">
                  {dayLabel(s.d)} <span class="mono">{timeRange(s.t, mins)}</span>
                </span>
                {s.backup && <span class="chip ok">備案時段</span>}
                <Btn size="sm" variant={s.backup ? 'primary' : undefined} onClick={() => close({ d: s.d, t: s.t })}>
                  改到這裡
                </Btn>
              </div>
            ))}
          </div>
        ) : (
          <p class="small muted">{tName(a.teacher_id)} 這週沒有其他空的開放時段</p>
        )}
        <OtherTime start={week!.start} onPick={(d, t) => close({ d, t })} />
        <div class="actions">
          <button type="button" class="btn" onClick={() => close()}>
            關閉
          </button>
        </div>
      </>
    ));
    if (pick) await move(a, a.teacher_id, pick.d, pick.t);
  }

  async function cancelSession(a: Appointment) {
    const reason = await ask({
      title: `取消${groupName(st.groups, a.group_id)}的 ${dayLabel(a.d)} ${a.t}？`,
      body: '這組和業師的畫面會立刻顯示已取消',
      label: '原因（會顯示給這組）',
      placeholder: '例：業師臨時有事，這週停一次',
      optional: true,
      maxLength: 200,
      ok: '取消這場',
    });
    if (reason === null) return;
    await run('remove', () => call('oh_admin_remove', { p_id: a.id, p_reason: reason }), { ok: '已取消' });
    reload();
  }

  /** Put a group in its fixed slot by hand (e.g. it asked the admins after the deadline). */
  async function place(r: Row) {
    if (!r.fixed) return;
    const ok = await confirm({
      title: `幫${groupName(st.groups, r.g.id)}排進固定時段？`,
      body: `${dayLabel(r.fixed.d)} ${timeRange(r.fixed.t, mins)} · ${tName(r.fixed.teacher)}。這組和業師會立刻看到`,
      ok: '排進去',
    });
    if (!ok) return;
    const a = await run('place', () =>
      call('oh_admin_assign', { p_week: st.week_id, p_group: r.g.id, p_teacher: r.fixed!.teacher, p_d: r.fixed!.d, p_t: r.fixed!.t, p_force: true }),
    );
    if (a) await run('place', () => call('oh_admin_publish', { p_week: st.week_id }), { ok: '已排定' });
    reload();
  }

  const exportWeek = () => {
    const list = rows.map((r) => {
      const a = r.session;
      return {
        group: r.g.no,
        name: r.g.name,
        state: STATE_TEXT[r.state](open),
        date: a?.d ?? '',
        time: a ? timeRange(a.t, mins) : '',
        teacher: a ? tName(a.teacher_id) : '',
        topic: st.requests.find((x) => x.group_id === r.g.id && x.status === 'open')?.topic ?? '',
      };
    });
    download(
      `office-hour-${week.label || week.start}.csv`,
      csvText(list, [
        ['group', '組別'],
        ['name', '組名'],
        ['state', '狀態'],
        ['date', '日期'],
        ['time', '時間'],
        ['teacher', st.settings.host_label],
        ['topic', '題目'],
      ]),
      'text/csv;charset=utf-8',
    );
  };

  return (
    <main class="page" style={{ gap: '20px' }}>
      <SetupGuide st={st} />
      <div class="stack">
        <div class="row between wrap">
          <div class="stack tight">
            <p class="eyebrow">排程</p>
            <h1 class="title-l">
              {week.label && <span class="mono">{week.label} </span>}
              <span class="mono muted" style={{ fontWeight: 500 }}>
                {mdPad(week.start)}–{mdPad(addDays(week.start, 4))}
              </span>
            </h1>
          </div>
          <Btn icon="download" onClick={exportWeek}>
            匯出本週
          </Btn>
        </div>
        <p class="small muted">
          {open
            ? `各組在 ${deadlineText(week.deadline)} 前決定要不要約，送出就排定`
            : `已在 ${deadlineText(week.deadline)} 截止。業師臨時有事時，可以在下面安排代班、改期或取消`}
        </p>
        <WeekStrip
          value={st.week_id}
          onPick={(id) => go(`admin/board/${id}`)}
          items={st.weeks.map((w) => ({
            id: w.id,
            start: w.start,
            label: w.label,
            past: addDays(w.start, 6) < clock.today,
            on: w.scheduled > 0,
            status: !w.open ? '暫停' : `${w.scheduled} 組預約`,
          }))}
        />
        <div class="stat-pills" aria-label="本週統計">
          <span class="chip ok">已預約 {count('booked')} 組</span>
          <span class="chip">這週不約 {count('skipped')} 組</span>
          {waiting.length > 0 && <span class="chip warn">{open ? '還沒回覆' : '沒有預約'} {waiting.length} 組</span>}
          {count('cancelled') > 0 && <span class="chip danger">已取消 {count('cancelled')} 組</span>}
        </div>
        {open && waiting.length > 0 && (
          <div class="card sunk tight stack tight">
            <span class="small">
              <b>還沒回覆：</b>
              {waiting.map((r) => `第 ${r.g.no} 組`).join('、')}
            </span>
            <div>
              <CopyBtn
                text={`提醒：${week.label || mdPad(week.start)} 的 Office Hour 要在 ${deadlineText(week.deadline)} 前決定要不要約，請到平台按「預約這週」或「這週不約」：${siteUrl()}`}
                label="複製提醒訊息"
              />
            </div>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <Empty icon="users" title="還沒有小組">
          到「小組與邀請」新增小組
        </Empty>
      ) : (
        <div class="stack">
          {rows.map((r) => (
            <GroupRow
              key={r.g.id}
              r={r}
              st={st}
              open={open}
              nowStamp={nowStamp}
              tName={tName}
              room={room}
              busy={busy}
              onSubstitute={substitute}
              onReschedule={reschedule}
              onCancel={cancelSession}
              onPlace={place}
            />
          ))}
        </div>
      )}
    </main>
  );
}

const STATE_TEXT: Record<RowState, (open: boolean) => string> = {
  booked: () => '已預約',
  cancelled: () => '已取消',
  skipped: () => '這週不約',
  holiday: () => '放假',
  nofixed: () => '沒有固定時段',
  waiting: (open) => (open ? '還沒回覆' : '沒有預約'),
};
const STATE_CHIP: Record<RowState, string> = { booked: 'ok', cancelled: 'danger', skipped: '', holiday: '', nofixed: 'warn', waiting: 'warn' };

function GroupRow({
  r,
  st,
  open,
  nowStamp,
  tName,
  room,
  busy,
  onSubstitute,
  onReschedule,
  onCancel,
  onPlace,
}: {
  r: Row;
  st: AdminState;
  open: boolean;
  nowStamp: string;
  tName: (id: number) => string;
  room: (id: number) => string;
  busy: string | null;
  onSubstitute: (a: Appointment) => void;
  onReschedule: (a: Appointment) => void;
  onCancel: (a: Appointment) => void;
  onPlace: (r: Row) => void;
}) {
  const mins = st.settings.slot_minutes;
  const req = st.requests.find((x) => x.group_id === r.g.id && x.status === 'open');
  const a = r.session ?? r.cancelled;
  const moved = a && r.fixed && (a.d !== r.fixed.d || a.t !== r.fixed.t);
  const swapped = a && r.fixed && a.teacher_id !== r.fixed.teacher;
  const past = a ? `${a.d} ${a.t}` < nowStamp : false;
  const leave = a ? st.closures.find((c) => c.teacher_id === a.teacher_id && c.d === a.d) : undefined;
  const offHours = r.session && !st.slots.some((s) => s.d === r.session!.d && s.t === r.session!.t && s.teachers.includes(r.session!.teacher_id));
  return (
    <section class="card stack" aria-label={groupName(st.groups, r.g.id)}>
      <div class="row between wrap">
        <span class="row" style={{ gap: '10px' }}>
          <span class="gno">{r.g.no}</span>
          <b>{r.g.name || `第 ${r.g.no} 組`}</b>
        </span>
        <span class={`chip ${STATE_CHIP[r.state]}`}>{STATE_TEXT[r.state](open)}</span>
      </div>

      <p class="small muted">
        {r.fixed ? (
          <>
            固定時段：{dayLabel(r.fixed.d)} <span class="mono">{timeRange(r.fixed.t, mins)}</span> · {tName(r.fixed.teacher)}
            {r.holiday ? `（${r.holiday}）` : ''}
          </>
        ) : (
          <>
            還沒有固定時段，到<a href={href('admin/groups')}>小組與邀請</a>設定
          </>
        )}
      </p>

      {a && (
        <div class={`li ${a.status === 'cancelled' ? 'cancelled' : ''}`} style={{ borderRadius: 'var(--r)', border: '1px solid var(--line)' }}>
          <div class="when">
            <b>{a.t}</b>
            <span>{dayLabel(a.d)}</span>
          </div>
          <div class="grow stack tight">
            <span class="small row wrap" style={{ gap: '6px' }}>
              <TeacherDot id={a.teacher_id} teachers={st.teachers} />
              {tName(a.teacher_id)}
              {swapped && <span class="chip accent">代班</span>}
              {moved && <span class="chip accent">改期</span>}
              {a.status === 'draft' && <span class="chip">草稿</span>}
            </span>
            {a.status === 'cancelled' ? (
              <span class="tiny">
                {a.cancelled_by} 取消{a.cancel_reason ? `：${a.cancel_reason}` : ''}
              </span>
            ) : (
              <span class="tiny muted">
                <Place value={room(a.teacher_id)} full />
              </span>
            )}
          </div>
          {a.status === 'cancelled' ? <span class="chip danger">已取消</span> : past ? <span class="chip">已結束</span> : null}
        </div>
      )}

      {r.session && !past && (leave || offHours) && (
        <div class="notice warn">
          <Icon name="alert" />
          <span class="small">
            {leave ? `${tName(r.session.teacher_id)} 這天請假${leave.reason ? `（${leave.reason}）` : ''}` : `不在 ${tName(r.session.teacher_id)} 的開放時段`}，請安排代班、改期或取消
          </span>
        </div>
      )}

      {req && (
        <div class="stack tight">
          <span class="title-s">{req.topic}</span>
          {req.questions && (
            <div class="qbox">
              <span class="eyebrow">想問 PM 的問題</span>
              <p class="pre small">{req.questions}</p>
            </div>
          )}
          <p class="pre small muted clamp-3">{req.progress}</p>
          {safeHref(req.link) && (
            <a class="small row" style={{ gap: '6px', width: 'fit-content' }} href={safeHref(req.link)} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={15} />
              雲端資料夾
            </a>
          )}
          <span class="tiny faint">{req.author} 送出</span>
        </div>
      )}

      {r.session && !past && (
        <div class="row wrap">
          <Btn size="sm" icon="users" loading={busy === 'move'} onClick={() => onSubstitute(r.session!)}>
            代班
          </Btn>
          <Btn size="sm" icon="calendar" loading={busy === 'move'} onClick={() => onReschedule(r.session!)}>
            改期
          </Btn>
          <Btn size="sm" variant="ghost" class="danger" loading={busy === 'remove'} onClick={() => onCancel(r.session!)}>
            取消
          </Btn>
        </div>
      )}
      {!r.session && r.fixed && !r.holiday && r.fixed.d + ' ' + r.fixed.t >= nowStamp && (r.state === 'cancelled' || (r.state === 'waiting' && !open)) && (
        <div>
          <Btn size="sm" icon="plus" loading={busy === 'place'} onClick={() => onPlace(r)}>
            排進固定時段
          </Btn>
        </div>
      )}
    </section>
  );
}

/** Any hour of the week, for a time outside the PM's open hours. */
function OtherTime({ start, onPick }: { start: string; onPick: (d: string, t: string) => void }) {
  const days = [1, 2, 3, 4, 5, 6, 7].map((i) => dayOfWeek(start, i));
  const hours = Array.from({ length: 15 }, (_, i) => `${String(8 + i).padStart(2, '0')}:00`);
  const [d, setD] = useState(days[0]);
  const [t, setT] = useState('10:00');
  return (
    <details>
      <summary class="small muted" style={{ cursor: 'pointer' }}>
        其他時間
      </summary>
      <div class="row wrap" style={{ marginTop: '10px', gap: '8px' }}>
        <label class="sr-only" for="other-day">
          日期
        </label>
        <select id="other-day" class="select" style={{ width: 'auto' }} value={d} onChange={(e) => setD((e.target as HTMLSelectElement).value)}>
          {days.map((x) => (
            <option key={x} value={x}>
              {DOW[isoDow(x)]} {x.slice(5).replace('-', '/')}
            </option>
          ))}
        </select>
        <label class="sr-only" for="other-time">
          開始時間
        </label>
        <select id="other-time" class="select" style={{ width: 'auto' }} value={t} onChange={(e) => setT((e.target as HTMLSelectElement).value)}>
          {hours.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <Btn size="sm" onClick={() => onPick(d, t)}>
          改到這個時間
        </Btn>
      </div>
    </details>
  );
}

const TEACHER_HUES = ['#2f5bd3', '#0f8a6a', '#b4237a', '#b45309', '#0e7490', '#6d28d9', '#4d7c0f'];

/** A small coloured initial, so each teacher's lane reads at a glance. */
export function TeacherDot({ id, teachers }: { id: number; teachers: Array<{ id: number; name: string }> }) {
  const i = Math.max(0, teachers.findIndex((t) => t.id === id));
  const name = teachers[i]?.name ?? '?';
  return (
    <span class="tdot" style={{ '--tc': TEACHER_HUES[i % TEACHER_HUES.length] }} title={name} aria-hidden="true">
      {[...name][0]?.toUpperCase()}
    </span>
  );
}

/** First-week checklist until every group has someone in it. */
function SetupGuide({ st }: { st: AdminState }) {
  const [hidden, setHidden] = useState(() => local.get<boolean>('oh.setup.hidden') === true);
  const active = st.groups.filter((g) => g.active);
  const joined = active.filter((g) => g.members > 0).length;
  if (hidden || (active.length > 0 && joined === active.length)) return null;
  const steps: Array<{ done: boolean; title: string; body: string; href: string; cta: string }> = [
    {
      done: joined === active.length && active.length > 0,
      title: `邀請各組加入（${joined}/${active.length} 組已有人加入）`,
      body: '把每組的邀請連結貼到該組的 Discord，或在課堂上投影 QR Code 讓大家掃描',
      href: href('admin/groups'),
      cta: '小組與邀請',
    },
    {
      done: false,
      title: '把專屬連結傳給老師',
      body: '老師打開就能看到自己的場次，也能訂閱行事曆，不需要任何設定',
      href: href('admin/teachers'),
      cta: '老師',
    },
    {
      done: false,
      title: '確認開放時段與週次',
      body: '國定假日、老師請假、哪幾週開放預約，都在這裡調整',
      href: href('admin/calendar'),
      cta: '時段與週次',
    },
  ];
  return (
    <section class="card stack" aria-labelledby="setup-title">
      <div class="row between">
        <h2 id="setup-title" class="title-s">開始使用</h2>
        <button
          type="button"
          class="link-btn tiny"
          onClick={() => {
            local.set('oh.setup.hidden', true);
            setHidden(true);
          }}
        >
          不再顯示
        </button>
      </div>
      <ol class="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {steps.map((x, i) => (
          <li key={x.title} class="row top" style={{ gap: '12px' }}>
            <span class={`gno ${x.done ? '' : 'soft'}`} aria-hidden="true">
              {x.done ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <div class="grow stack tight">
              <b class="small">{x.title}</b>
              <span class="small muted">{x.body}</span>
            </div>
            <a class="btn sm" href={x.href}>
              {x.cta}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
