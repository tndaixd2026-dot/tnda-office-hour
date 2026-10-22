import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AdminState, Appointment, Request } from '../../api/types';
import { clock, useApi, useBusy, useDiff, useLive, useMedia, useTick } from '../../app/hooks';
import { ISSUE } from '../../app/messages';
import { go, href } from '../../app/router';
import { local } from '../../app/store';
import { csvText, download } from '../../lib/files';
import { MAIL_PREVIEW, MAIL_SEND } from '../../config';
import { deadlineText, minutesText, slotLines, timeRange } from '../../lib/format';
import { autoSchedule } from '../../lib/scheduler';
import { addDays, addMinutes, agoText, dayLabel, DOW, isoDow, localStamp, md, mdPad, minutes } from '../../lib/time';
import { ask, confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, Loading, Menu, WeekStrip, copyText, safeHref } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { ErrorState } from '../student/StudentApp';
import { eventText, groupName, noticeText, siteUrl } from './common';

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

function BoardView({ st, reload }: { st: AdminState; reload: () => void }) {
  const { call } = useApi();
  const { busy, run } = useBusy(st.settings);
  const now = useTick(60000);
  const [focus, setFocus] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const compact = useMedia('(max-width: 720px)');
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => {
    setFocus(null);
    setDay(null);
  }, [st.week_id]);

  const week = st.weeks.find((w) => w.id === st.week_id) ?? null;
  const mins = st.settings.slot_minutes;
  const tz = st.clock.tz;
  const weekCap = st.settings.week_cap;
  const live = st.appointments.filter((a) => a.status !== 'cancelled');
  const drafts = st.appointments.filter((a) => a.status === 'draft');
  const cancelled = st.appointments.filter((a) => a.status === 'cancelled');
  const openReqs = st.requests.filter((r) => r.status === 'open');
  const countFor = (gid: number) => live.filter((a) => a.group_id === gid).length;
  const needOf = (r: Request) => Math.min(r.want, weekCap) - countFor(r.group_id);
  const pending = openReqs.filter((r) => needOf(r) > 0);
  const activeGroups = st.groups.filter((g) => g.active);
  const missing = activeGroups.filter((g) => !openReqs.some((r) => r.group_id === g.id));
  const scheduledGroups = new Set(st.appointments.filter((a) => a.status === 'confirmed').map((a) => a.group_id));
  const tName = (id: number) => st.teachers.find((t) => t.id === id)?.name ?? '—';
  const gOf = (id: number) => st.groups.find((g) => g.id === id);

  // ---------- grid geometry ----------
  const days = useMemo(() => {
    if (!week) return [];
    return [0, 1, 2, 3, 4, 5, 6]
      .map((i) => addDays(week.start, i))
      .filter((d, i) => i < 5 || st.slots.some((s) => s.d === d) || live.some((a) => a.d === d));
  }, [week?.start, st.slots, st.appointments]);
  const times = useMemo(() => {
    const set = new Set([...st.slots.map((s) => s.t), ...live.map((a) => a.t)]);
    return [...set].sort((a, b) => minutes(a) - minutes(b));
  }, [st.slots, st.appointments]);
  const slotMap = useMemo(() => new Map(st.slots.map((s) => [`${s.d} ${s.t}`, s])), [st.slots]);
  const demandMap = useMemo(() => {
    const m = new Map<string, Request[]>();
    for (const r of openReqs) for (const s of r.slots) m.set(`${s.d} ${s.t}`, [...(m.get(`${s.d} ${s.t}`) ?? []), r]);
    return m;
  }, [st.requests]);
  const focusKeys = useMemo(() => {
    const r = openReqs.find((x) => x.group_id === focus);
    return new Set(r?.slots.map((s) => `${s.d} ${s.t}`) ?? []);
  }, [focus, st.requests]);
  const holidays = new Map(st.closures.filter((c) => c.teacher_id === null).map((c) => [c.d, c.reason]));
  const nowStamp = localStamp(now, tz);
  const maxDemand = Math.max(1, ...[...demandMap.values()].map((rs) => rs.filter((r) => needOf(r) > 0).length));
  const attention = live.filter((a) => !slotMap.get(`${a.d} ${a.t}`)?.teachers.includes(a.teacher_id) && `${a.d} ${a.t}` >= nowStamp).length;

  // phones show one day at a time
  const dayLoad = (d: string) => st.slots.filter((s) => s.d === d).length + live.filter((a) => a.d === d).length;
  const dayWant = (d: string) => openReqs.filter((r) => needOf(r) > 0 && r.slots.some((s) => s.d === d)).length;
  const defaultDay = days.find((d) => dayWant(d) > 0) ?? days.find((d) => d >= clock.today && dayLoad(d) > 0) ?? days.find((d) => dayLoad(d) > 0) ?? days[0];
  const shownDays = compact && days.length ? [day && days.includes(day) ? day : defaultDay] : days;
  const shownTimes = compact
    ? times.filter((t) => shownDays.some((d) => slotMap.has(`${d} ${t}`) || live.some((a) => a.d === d && a.t === t)))
    : times;

  // ---------- actions ----------
  async function assign(args: { group: number; teacher: number; d: string; t: string; moveId?: number }) {
    const moving = args.moveId ? st.appointments.find((a) => a.id === args.moveId) : null;
    if (moving && moving.d === args.d && moving.t === args.t && moving.teacher_id === args.teacher) return;
    if (moving?.status === 'confirmed') {
      const ok = await confirm({
        title: '移動已發布的場次？',
        body: `${groupName(st.groups, moving.group_id)} 會從 ${dayLabel(moving.d)} ${moving.t} 改到 ${dayLabel(args.d)} ${args.t}（${tName(args.teacher)}）。這組和老師的畫面會立刻更新，有連結 Discord 的話也會收到通知`,
        ok: '移動',
      });
      if (!ok) return;
    }
    const fn = args.moveId ? 'oh_admin_move' : 'oh_admin_assign';
    const payload: Record<string, unknown> = args.moveId
      ? { p_id: args.moveId, p_teacher: args.teacher, p_d: args.d, p_t: args.t }
      : { p_week: st.week_id, p_group: args.group, p_teacher: args.teacher, p_d: args.d, p_t: args.t };
    let issues: string | null = null;
    const r = await run('assign', () => call(fn, payload), {
      onError: (e) => {
        if (e.code !== 'NEEDS_FORCE') return false;
        issues = e.detail;
        return true;
      },
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
            <p>如果已經和這組或老師確認過，仍然可以安排</p>
          </>
        ),
        ok: '仍要安排',
      });
      if (ok) await run('assign', () => call(fn, { ...payload, p_force: true }));
    }
    reload();
  }

  async function remove(a: Appointment) {
    const g = groupName(st.groups, a.group_id);
    if (a.status === 'draft') {
      await run('remove', () => call('oh_admin_remove', { p_id: a.id }));
    } else {
      const reason = await ask({
        title: `取消${g}的 ${dayLabel(a.d)} ${a.t}？`,
        body: '這組和老師的畫面會立刻顯示已取消，時段也會釋出',
        label: '原因（會顯示給這組）',
        optional: true,
        maxLength: 200,
        ok: '取消這場',
      });
      if (reason === null) return;
      await run('remove', () => call('oh_admin_remove', { p_id: a.id, p_reason: reason }), { ok: '已取消' });
    }
    reload();
  }

  async function auto() {
    const proposal = autoSchedule({
      slots: st.slots,
      appointments: st.appointments,
      requests: st.requests,
      groups: st.groups,
      weekCap,
      dayCap: st.settings.day_cap,
      notBefore: nowStamp,
    });
    if (!proposal.length) {
      toast('沒有可以再自動安排的組別：待排的組勾的時段都已經滿了');
      return;
    }
    const r = await run('auto', () => call<{ count: number }>('oh_admin_apply', { p_week: st.week_id, p_items: proposal }));
    if (!r) {
      reload();
      return;
    }
    reload();
    const served = new Map<number, number>();
    for (const p of proposal) served.set(p.group_id, (served.get(p.group_id) ?? 0) + 1);
    const left = pending.filter((q) => needOf(q) - (served.get(q.group_id) ?? 0) > 0);
    const go2 = await openDialog<boolean>('閃身步排程法結果', (close) => (
      <>
        <div class="stack tight">
          <p class="eyebrow">閃身步排程法</p>
          <h2>已建立 {proposal.length} 筆草稿</h2>
          <p class="muted small">優先照顧本學期討論次數較少、較早送出的組。有搭配老師的組只排給那位老師，其他組盡量延續上次的 {st.settings.host_label}。草稿只有助教看得到</p>
        </div>
        <div class="list">
          {proposal.map((p, i) => (
            <div class="li" key={i}>
              <span class="gno">{gOf(p.group_id)?.no}</span>
              <span class="grow">{dayLabel(p.d)} <span class="mono">{timeRange(p.t, mins)}</span></span>
              <span class="small muted">{tName(p.teacher_id)}</span>
            </div>
          ))}
        </div>
        {left.length > 0 && (
          <div class="notice warn">
            <Icon name="alert" />
            <span>
              {left.map((q) => groupName(st.groups, q.group_id)).join('、')} 勾選的時段已經排滿，沒辦法再安排。可以在 Discord 請他們多勾幾格，或手動安排其他時段
            </span>
          </div>
        )}
        <div class="actions">
          <button type="button" class="btn" onClick={() => close(false)}>
            先檢查一下
          </button>
          <button type="button" class="btn primary" data-autofocus onClick={() => close(true)}>
            直接發布
          </button>
        </div>
      </>
    ));
    if (go2) publish(true);
  }

  async function publish(skipConfirm = false) {
    const n = drafts.length || undefined;
    if (!skipConfirm) {
      const ok = await confirm({
        title: `發布 ${n ?? ''} 筆排程？`,
        body: '發布後，各組與老師的畫面會立刻更新',
        ok: '發布',
      });
      if (!ok) return;
    }
    const r = await run('publish', () => call<{ published: Appointment[] }>('oh_admin_publish', { p_week: st.week_id }));
    reload();
    if (!r) return;
    if (!r.published.length) {
      toast('沒有需要發布的草稿');
      return;
    }
    const all = [...st.appointments.filter((a) => a.status === 'confirmed'), ...r.published];
    showNotices([...new Set(r.published.map((a) => a.group_id))], all, `已發布 ${r.published.length} 筆排程`);
  }

  function showNotices(groupIds: number[], appts: Appointment[], title = '通知訊息') {
    const texts = groupIds
      .map((gid) => ({ gid, text: noticeText(st, gid, appts, siteUrl()) }))
      .sort((a, b) => (gOf(a.gid)?.no ?? 0) - (gOf(b.gid)?.no ?? 0));
    openDialog(title, (close) => (
      <>
        <div class="stack tight">
          <h2>{title}</h2>
          <p class="muted small">各組在平台上已經看得到；有連結 Discord 的組別也已經自動收到通知。其他組可以複製下面的訊息，貼到他們的聊天室</p>
        </div>
        <div class="stack">
          {texts.map(({ gid, text }) => (
            <div class="card sunk tight stack tight" key={gid}>
              <pre class="pre small" style={{ margin: '0px', fontFamily: 'inherit' }}>
                {text}
              </pre>
              <div>
                <CopyBtn text={text} label={`複製第 ${gOf(gid)?.no} 組`} />
              </div>
            </div>
          ))}
        </div>
        <div class="actions">
          <Btn icon="copy" onClick={() => copyText(texts.map((x) => x.text).join('\n\n'), '已複製全部訊息')}>
            複製全部
          </Btn>
          <button type="button" class="btn primary" onClick={() => close()}>
            完成
          </button>
        </div>
      </>
    ), { wide: 'wide' });
  }

  async function discard() {
    if (!(await confirm({ title: `清除 ${drafts.length} 筆草稿？`, body: '只會刪除還沒發布的草稿，已發布的不受影響', ok: '清除', danger: true }))) return;
    await run('discard', () => call('oh_admin_discard', { p_week: st.week_id }), { ok: '已清除草稿' });
    reload();
  }

  function openCell(d: string, t: string, teacher: number) {
    const key = `${d} ${t}`;
    // groups paired with another teacher go last
    const elsewhere = (gid: number) => {
      const p = gOf(gid)?.teacher_id;
      return p != null && p !== teacher;
    };
    const cands = (demandMap.get(key) ?? [])
      .slice()
      .sort((a, b) => Number(elsewhere(a.group_id)) - Number(elsewhere(b.group_id)) || needOf(b) - needOf(a) || a.created_at.localeCompare(b.created_at));
    const others = activeGroups.filter((g) => !cands.some((c) => c.group_id === g.id));
    const busyGroups = new Set(live.filter((a) => a.d === d && a.t === t).map((a) => a.group_id));
    openDialog<number>('安排小組', (close) => (
      <>
        <div class="stack tight">
          <p class="eyebrow">
            {dayLabel(d)} {timeRange(t, mins)} · {tName(teacher)}
          </p>
          <h2>要安排哪一組？</h2>
        </div>
        {cands.length ? (
          <div class="list">
            {cands.map((r) => {
              const g = gOf(r.group_id)!;
              const have = countFor(r.group_id);
              const sameDay = live.some((a) => a.group_id === r.group_id && a.d === d);
              const blocked = busyGroups.has(r.group_id);
              const other = elsewhere(r.group_id);
              return (
                <div class="li" key={r.id}>
                  <span class="gno">{g.no}</span>
                  <div class="grow stack" style={{ gap: '0px' }}>
                    <b class="small">{g.name || `第 ${g.no} 組`}</b>
                    <span class="tiny muted clamp-2">{r.topic}</span>
                  </div>
                  {other ? (
                    <span class="chip warn">搭配 {tName(g.teacher_id!)}</span>
                  ) : (
                    <span class={`chip ${have >= Math.min(r.want, weekCap) ? 'ok' : sameDay ? 'warn' : ''}`}>
                      {sameDay ? '當天已有' : `已排 ${have}/${Math.min(r.want, weekCap)}`}
                    </span>
                  )}
                  <Btn size="sm" variant={have < r.want && !sameDay && !other ? 'primary' : undefined} disabled={blocked} onClick={() => close(r.group_id)}>
                    安排
                  </Btn>
                </div>
              );
            })}
          </div>
        ) : (
          <p class="muted small">沒有小組勾選這個時段</p>
        )}
        {others.length > 0 && (
          <details>
            <summary class="small muted" style={{ cursor: 'pointer' }}>
              其他小組（沒有勾選這格）
            </summary>
            <div class="row wrap" style={{ marginTop: '10px' }}>
              {others.map((g) => (
                <Btn size="sm" key={g.id} disabled={busyGroups.has(g.id)} onClick={() => close(g.id)}>
                  <span class="gno soft" style={{ minWidth: '20px', height: '20px', fontSize: '11px' }}>
                    {g.no}
                  </span>
                  {g.name || `第 ${g.no} 組`}
                </Btn>
              ))}
            </div>
          </details>
        )}
        <div class="actions">
          <button type="button" class="btn" onClick={() => close()}>
            關閉
          </button>
        </div>
      </>
    )).then((gid) => {
      if (gid) assign({ group: gid, teacher, d, t });
    });
  }

  function openAppt(a: Appointment) {
    const g = gOf(a.group_id);
    const r = st.requests.find((x) => x.group_id === a.group_id);
    openDialog<'remove'>('場次詳情', (close) => (
      <>
        <div class="stack tight">
          <p class="eyebrow">
            {dayLabel(a.d)} {timeRange(a.t, mins)} · {tName(a.teacher_id)}
          </p>
          <h2 class="row">
            <span class="gno">{g?.no}</span>
            {g?.name || `第 ${g?.no} 組`}
          </h2>
          <span class={`chip ${a.status === 'draft' ? 'accent' : 'ok'}`} style={{ width: 'fit-content' }}>
            {a.status === 'draft' ? '草稿：還沒發布' : '已發布'}
          </span>
        </div>
        {r && (
          <dl class="kv">
            <dt>題目</dt>
            <dd>{r.topic}</dd>
            {r.questions && (
              <>
                <dt>想問的問題</dt>
                <dd class="pre">{r.questions}</dd>
              </>
            )}
            <dt>進度</dt>
            <dd class="pre">{r.progress}</dd>
            {safeHref(r.link) && (
              <>
                <dt>資料</dt>
                <dd>
                  <a href={safeHref(r.link)} target="_blank" rel="noopener noreferrer">
                    雲端資料夾
                  </a>
                </dd>
              </>
            )}
            <dt>填寫</dt>
            <dd>
              {r.author} · {agoText(r.updated_at, clock.now())}
            </dd>
          </dl>
        )}
        <p class="tiny faint">
          {a.created_by} 安排{a.published_at ? `，${agoText(a.published_at, clock.now())}發布` : ''}。在桌機上可以直接把這格拖到其他時段
        </p>
        <div class="actions">
          <button type="button" class="btn danger" onClick={() => close('remove')}>
            {a.status === 'draft' ? '移除草稿' : '取消這場'}
          </button>
          <button type="button" class="btn primary" onClick={() => close()}>
            完成
          </button>
        </div>
      </>
    )).then((v) => {
      if (v === 'remove') remove(a);
    });
  }

  const exportWeek = () => {
    const rows = live
      .slice()
      .sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t))
      .map((a) => ({
        date: a.d,
        time: timeRange(a.t, mins),
        group: gOf(a.group_id)?.no,
        name: gOf(a.group_id)?.name,
        teacher: tName(a.teacher_id),
        status: a.status === 'draft' ? '草稿' : '已發布',
        topic: st.requests.find((r) => r.group_id === a.group_id)?.topic ?? '',
      }));
    download(
      `office-hour-${week?.label || week?.start}.csv`,
      csvText(rows, [
        ['date', '日期'],
        ['time', '時間'],
        ['group', '組別'],
        ['name', '組名'],
        ['teacher', st.settings.host_label],
        ['status', '狀態'],
        ['topic', '題目'],
      ]),
      'text/csv;charset=utf-8',
    );
  };

  if (!week) {
    return (
      <main class="page">
        <Empty icon="calendar" title="還沒有任何週次">
          先到「時段與週次」建立學期的週次
        </Empty>
      </main>
    );
  }

  const requestsSorted = st.requests.slice().sort((a, b) => {
    const rank = (r: Request) => (r.status !== 'open' ? 3 : needOf(r) > 0 ? (countFor(r.group_id) ? 1 : 0) : 2);
    return rank(a) - rank(b) || a.created_at.localeCompare(b.created_at);
  });

  return (
    <main class="page" style={{ gap: '20px' }}>
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
          <div class="toolbar">
            <Btn icon="spark" onClick={auto} loading={busy === 'auto'} disabled={!pending.length}>
              閃身步排程法
            </Btn>
            <Btn variant="primary" icon="send" onClick={() => publish()} loading={busy === 'publish'} disabled={!drafts.length}>
              發布{drafts.length ? ` ${drafts.length} 筆` : ''}
            </Btn>
            <Menu label="更多動作" trigger={<Icon name="more" />}>
              {(close) => (
                <>
                  <button
                    type="button"
                    class="mi"
                    role="menuitem"
                    disabled={!scheduledGroups.size}
                    onClick={() => {
                      close();
                      showNotices([...scheduledGroups], st.appointments, '本週通知訊息');
                    }}
                  >
                    <Icon name="chat" /> 本週通知訊息
                  </button>
                  <button
                    type="button"
                    class="mi"
                    role="menuitem"
                    onClick={() => {
                      close();
                      exportWeek();
                    }}
                  >
                    <Icon name="download" /> 匯出本週（CSV）
                  </button>
                  <button
                    type="button"
                    class="mi danger"
                    role="menuitem"
                    disabled={!drafts.length}
                    onClick={() => {
                      close();
                      discard();
                    }}
                  >
                    <Icon name="trash" /> 清除草稿
                  </button>
                </>
              )}
            </Menu>
          </div>
        </div>
        {nowStamp < week.deadline ? (
          <p class="small muted">學生的需求在 {deadlineText(week.deadline)} 截止，截止後就不能再修改</p>
        ) : (
          nowStamp < `${week.start} 00:00` && (
            <div class="notice warn">
              <Icon name="clock" />
              <span class="small">
                需求已在 {deadlineText(week.deadline)} 截止。請在 {MAIL_PREVIEW} 前排好並發布，{MAIL_SEND} 會把這週的場次寄給老師
              </span>
            </div>
          )
        )}
        <WeekStrip
          value={st.week_id}
          onPick={(id) => go(`admin/board/${id}`)}
          items={st.weeks.map((w) => ({
            id: w.id,
            start: w.start,
            label: w.label,
            past: addDays(w.start, 6) < clock.today,
            pip: w.drafts > 0,
            on: w.requests > w.scheduled,
            status: !w.open ? '暫停' : w.requests ? `${w.scheduled}/${w.requests} 組已排` : '沒有需求',
          }))}
        />
        <div class="stat-pills" aria-label="本週統計">
          <span class="chip">需求 {openReqs.length} 組</span>
          <span class="chip ok">已發布 {scheduledGroups.size} 組</span>
          {drafts.length > 0 && <span class="chip accent">草稿 {drafts.length} 筆</span>}
          {pending.length > 0 && <span class="chip warn">待排 {pending.length} 組</span>}
          {missing.length > 0 && <span class="chip outline">未送出 {missing.length} 組</span>}
          {!week.open && <span class="chip danger">本週暫停預約</span>}
          {attention > 0 && (
            <span class="chip danger">
              <Icon name="alert" size={13} />
              {attention} 場不在開放時段
            </span>
          )}
        </div>
      </div>

      <SetupGuide st={st} />

      <div class="board">
        <section aria-label="排程表" class="stack">
          {times.length === 0 ? (
            <Empty icon="calendar" title="這週沒有開放時段">
              到「時段與週次」設定老師的開放時段
            </Empty>
          ) : (
            <>
            {compact && (
              <div class="weeks" role="group" aria-label="選擇日期">
                {days.map((d) => (
                  <button type="button" key={d} class="wk" style={{ minWidth: '72px' }} aria-pressed={d === shownDays[0]} onClick={() => setDay(d)}>
                    <span class="w">{DOW[isoDow(d)]}</span>
                    <span class="d">{md(d)}</span>
                    <span class={`s ${dayWant(d) ? 'on' : ''}`}>{dayWant(d) ? `${dayWant(d)} 組想要` : dayLoad(d) ? `${live.filter((a) => a.d === d).length} 場` : '—'}</span>
                  </button>
                ))}
              </div>
            )}
            <div class="matrix-scroll">
              <div class="matrix" style={{ '--cols': shownDays.length }}>
                <div class="corner" />
                {shownDays.map((d) => (
                  <div class="mh" key={d}>
                    <b>{DOW[isoDow(d)]}</b>
                    <span>{md(d)}</span>
                    {holidays.has(d) && <span class="tag">{holidays.get(d) || '休息'}</span>}
                    {st.closures
                      .filter((c) => c.d === d && c.teacher_id !== null)
                      .map((c) => (
                        <span class="tag" key={c.id}>
                          {tName(c.teacher_id!)} 請假{c.reason ? `（${c.reason}）` : ''}
                        </span>
                      ))}
                  </div>
                ))}
                {shownTimes.map((t, ti) => [
                  ti > 0 && minutes(t) - minutes(shownTimes[ti - 1]) > mins ? (
                    <div class="gapr" key={`gap-${t}`}>
                      {addMinutes(shownTimes[ti - 1], mins)}–{t} 不開放
                    </div>
                  ) : null,
                  <div class="mt" key={`t-${t}`}>
                    {t}
                  </div>,
                  ...shownDays.map((d) => {
                    const key = `${d} ${t}`;
                    const slot = slotMap.get(key);
                    const here = live.filter((a) => a.d === d && a.t === t);
                    const lanes = st.teachers
                      .filter((x) => slot?.teachers.includes(x.id) || here.some((a) => a.teacher_id === x.id))
                      .map((x) => x.id);
                    const past = `${d} ${t}` < nowStamp;
                    const want = (demandMap.get(key) ?? []).filter((r) => needOf(r) > 0 && !here.some((a) => a.group_id === r.group_id));
                    // groups paired with another teacher do not count in this teacher's lane
                    const wantFor = (tid: number) =>
                      want.filter((r) => {
                        const p = gOf(r.group_id)?.teacher_id;
                        return p == null || p === tid;
                      }).length;
                    if (!lanes.length) return <div class={`mc off`} key={key} aria-hidden="true" />;
                    // demand heat, like the original prototype: darker = more groups want this slot
                    const heat = !past && want.length ? Math.min(1, want.length / maxDemand) : 0;
                    return (
                      <div
                        class={`mc ${past ? 'past' : ''} ${focusKeys.has(key) ? 'hl' : ''} ${heat ? 'heat' : ''}`}
                        key={key}
                        style={heat ? { '--heat': `${Math.round(6 + heat * 22)}%` } : undefined}
                      >
                        {lanes.map((tid) => {
                          const a = here.find((x) => x.teacher_id === tid);
                          const laneKey = `${key} ${tid}`;
                          if (a) {
                            const g = gOf(a.group_id);
                            // e.g. the teacher took the day off after this was booked
                            const offHours = !slot?.teachers.includes(tid);
                            return (
                              <button
                                type="button"
                                key={laneKey}
                                class={`lane filled ${a.status === 'draft' ? 'draft' : ''} ${offHours ? 'off-hours' : ''}`}
                                title={offHours ? `${tName(tid)} 這個時段不在開放時間內（可能請假），請移動或取消` : undefined}
                                draggable
                                onDragStart={(e) => {
                                  setDragId(a.id);
                                  e.dataTransfer?.setData('text/plain', String(a.id));
                                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                                }}
                                onDragEnd={() => {
                                  setDragId(null);
                                  setDropKey(null);
                                }}
                                onClick={() => openAppt(a)}
                              >
                                <TeacherDot id={tid} teachers={st.teachers} />
                                <span class="lno">{g?.no}</span>
                                <span class="gname">{g?.name || `第 ${g?.no} 組`}</span>
                                {offHours && <Icon name="alert" size={14} />}
                                <span class="sr-only">
                                  ，{dayLabel(d)} {t}，{tName(tid)}
                                  {a.status === 'draft' ? '，草稿' : '，已發布'}
                                  {offHours ? '，注意：不在老師的開放時段' : ''}
                                </span>
                              </button>
                            );
                          }
                          const available = slot?.teachers.includes(tid);
                          return (
                            <button
                              type="button"
                              key={laneKey}
                              class={`lane ${dropKey === laneKey ? 'drop' : ''}`}
                              disabled={!available}
                              onClick={() => openCell(d, t, tid)}
                              onDragOver={(e) => {
                                if (dragId === null) return;
                                e.preventDefault();
                                if (dropKey !== laneKey) setDropKey(laneKey);
                              }}
                              onDragLeave={() => setDropKey((k) => (k === laneKey ? null : k))}
                              onDrop={(e) => {
                                e.preventDefault();
                                const a = st.appointments.find((x) => x.id === dragId);
                                setDragId(null);
                                setDropKey(null);
                                if (a) assign({ group: a.group_id, teacher: tid, d, t, moveId: a.id });
                              }}
                            >
                              <TeacherDot id={tid} teachers={st.teachers} />
                              {wantFor(tid) > 0 ? (
                                <span class="want">{wantFor(tid)} 組想要</span>
                              ) : (
                                <span class="faint">空檔</span>
                              )}
                              <span class="sr-only">
                                ，{dayLabel(d)} {t}，{tName(tid)}
                                {wantFor(tid) > 0 ? '，空檔' : ''}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  }),
                ])}
              </div>
            </div>
            </>
          )}
          <ul class="legend">
            {st.teachers
              .filter((x) => x.active)
              .map((x) => (
                <li key={x.id}>
                  <TeacherDot id={x.id} teachers={st.teachers} />
                  {x.name}
                </li>
              ))}
            <li>
              <span class="sw" style={{ background: 'var(--ink)', borderColor: 'var(--ink)' }} />
              已發布
            </li>
            <li>
              <span class="sw" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)', borderStyle: 'dashed' }} />
              草稿（只有助教看得到）
            </li>
            <li>
              <span class="sw none" />
              空檔，點一下安排
            </li>
            <li>
              <span class="sw" style={{ background: 'var(--accent-soft)', boxShadow: 'inset 0 0 0 2px var(--accent)' }} />
              選取小組勾的時段
            </li>
          </ul>
        </section>

        <aside class="stack" aria-label="需求">
          <div class="section-head">
            <h2 class="title-s">需求 · {openReqs.length} 組</h2>
            {focus !== null && (
              <button type="button" class="link-btn small" onClick={() => setFocus(null)}>
                清除選取
              </button>
            )}
          </div>
          {requestsSorted.length === 0 && <Empty icon="users" title="這週還沒有任何需求" />}
          {requestsSorted.map((r) => {
            const g = gOf(r.group_id);
            const have = countFor(r.group_id);
            const target = Math.min(r.want, weekCap);
            const hasDraft = drafts.some((a) => a.group_id === r.group_id);
            const status =
              r.status !== 'open' ? (
                <span class="chip">已撤回</span>
              ) : have >= target ? (
                <span class={`chip ${hasDraft ? 'accent' : 'ok'}`}>{hasDraft ? '草稿' : '已排定'}</span>
              ) : have > 0 ? (
                <span class="chip accent">
                  已排 {have}/{target}
                </span>
              ) : (
                <span class="chip warn">待排</span>
              );
            const days = new Set(r.slots.map((s) => s.d)).size;
            return (
              <button type="button" key={r.id} class={`req ${focus === r.group_id ? 'on' : ''}`} onClick={() => setFocus(focus === r.group_id ? null : r.group_id)} aria-pressed={focus === r.group_id}>
                <div class="row between">
                  <span class="row" style={{ gap: '8px' }}>
                    <span class="gno">{g?.no}</span>
                    <b class="small">{g?.name || `第 ${g?.no} 組`}</b>
                  </span>
                  {status}
                </div>
                <span class="topic">{r.topic}</span>
                <span class="prog clamp-2 pre">{r.progress}</span>
                <span class="meta">
                  想約 {minutesText(r.want * mins)}{g?.teacher_id ? ` · 搭配 ${tName(g.teacher_id)}` : ''} · 勾了 {r.slots.length} 格 / {days} 天 · {r.author} {agoText(r.updated_at, now)}
                </span>
                {focus === r.group_id && (
                  <span class="stack tight">
                    {slotLines(r.slots).map((l) => (
                      <span class="tiny" key={l.d}>
                        {l.label} <span class="mono">{l.times.join('、')}</span>
                      </span>
                    ))}
                    {safeHref(r.link) && (
                      <a class="tiny" href={safeHref(r.link)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                        雲端資料夾 ↗
                      </a>
                    )}
                  </span>
                )}
              </button>
            );
          })}
          {missing.length > 0 && (
            <div class="card sunk tight stack tight">
              <span class="small">
                <b>還沒送出：</b>
                {missing.map((g) => `第 ${g.no} 組`).join('、')}
              </span>
              <div>
                <CopyBtn
                  text={`提醒：${week.label || mdPad(week.start)} 的 Office Hour 預約在 ${deadlineText(week.deadline)} 截止，請在那之前到平台勾選可以的時段：${siteUrl()}`}
                  label="複製提醒訊息"
                />
              </div>
            </div>
          )}
          {cancelled.length > 0 && (
            <details class="small">
              <summary class="muted" style={{ cursor: 'pointer' }}>
                本週已取消 {cancelled.length} 場
              </summary>
              <div class="stack tight" style={{ marginTop: '8px' }}>
                {cancelled.map((a) => (
                  <span key={a.id} class="muted">
                    {groupName(st.groups, a.group_id)} {dayLabel(a.d)} {a.t}：{a.cancelled_by} 取消{a.cancel_reason ? `（${a.cancel_reason}）` : ''}
                  </span>
                ))}
              </div>
            </details>
          )}
        </aside>
      </div>
    </main>
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
