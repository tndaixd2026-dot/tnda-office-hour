import type { AdminState } from '../../api/types';
import { useApi, useBusy, useLive, useTick } from '../../app/hooks';
import { csvText, download } from '../../lib/files';
import { agoText } from '../../lib/time';
import { Btn, Loading } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';
import { eventClass, eventText } from './common';

export function Overview() {
  const { data: st, error, reload } = useLive<AdminState>('oh_admin_state', {});
  const { call } = useApi();
  const { busy, run } = useBusy();
  const now = useTick();
  if (!st) return error ? <ErrorState onRetry={reload} /> : <Loading />;

  const groups = st.groups.filter((g) => g.active);
  const done = groups.reduce((n, g) => n + g.done, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const engaged = groups.filter((g) => g.total > 0).length;
  const maxTotal = Math.max(1, ...groups.map((g) => g.total));
  const waiting = st.weeks.reduce((n, w) => n + Math.max(0, w.requests - w.scheduled), 0);
  const tName = (id: number) => st.teachers.find((t) => t.id === id)?.name ?? '';
  // staff signing in on a new device is noise in the feed
  const feed = st.events.filter((e) => !(e.kind === 'member.joined' && e.role !== 'student'));

  const exportAll = async () => {
    const r = await run('export', () => call<{ requests: any[]; appointments: any[] }>('oh_admin_export'));
    if (!r) return;
    const day = new Date().toISOString().slice(0, 10);
    download(
      `office-hour-sessions-${day}.csv`,
      csvText(r.appointments, [
        ['week', '週次'],
        ['date', '日期'],
        ['time', '時間'],
        ['group_no', '組別'],
        ['group_name', '組名'],
        ['teacher', st.settings.host_label],
        ['status', '狀態'],
        ['topic', '題目'],
        ['created_by', '安排者'],
        ['published_at', '發布時間'],
        ['cancelled_by', '取消者'],
        ['cancel_reason', '取消原因'],
      ]),
      'text/csv;charset=utf-8',
    );
    download(
      `office-hour-requests-${day}.csv`,
      csvText(r.requests, [
        ['week', '週次'],
        ['week_start', '週一日期'],
        ['group_no', '組別'],
        ['group_name', '組名'],
        ['status', '狀態'],
        ['want', '想約格數'],
        ['topic', '題目'],
        ['questions', '想問的問題'],
        ['progress', '進度'],
        ['link', '連結'],
        ['slots', '可以的時段'],
        ['author', '填寫人'],
        ['created_at', '建立時間'],
        ['updated_at', '更新時間'],
      ]),
      'text/csv;charset=utf-8',
    );
  };

  return (
    <main class="page enter">
      <div class="row between wrap">
        <div class="stack tight">
          <p class="eyebrow">總覽與紀錄</p>
          <h1 class="title-l">本學期的 Office Hour</h1>
        </div>
        <Btn icon="download" loading={busy === 'export'} onClick={exportAll}>
          匯出全部紀錄（CSV）
        </Btn>
      </div>

      <div class="tiles">
        <div class="tile">
          <span class="v">{done}</span>
          <span class="k">已完成場次</span>
        </div>
        <div class="tile">
          <span class="v">{total - done}</span>
          <span class="k">即將進行</span>
        </div>
        <div class="tile">
          <span class="v">
            {engaged}
            <span class="muted" style={{ fontSize: '18px' }}>/{groups.length}</span>
          </span>
          <span class="k">至少約過一次的組</span>
        </div>
        <div class="tile">
          <span class="v" style={waiting ? { color: 'var(--accent-text)' } : undefined}>
            {waiting}
          </span>
          <span class="k">等待排程的需求</span>
        </div>
      </div>

      <div class="split">
        <section class="section" aria-labelledby="ov-groups">
          <div class="section-head">
            <h2 id="ov-groups">各組參與狀況</h2>
            <span class="small muted">次數少的組可以多關心一下</span>
          </div>
          <div class="table-wrap" tabIndex={0} role="region" aria-labelledby="ov-groups">
            <table class="t">
              <thead>
                <tr>
                  <th>小組</th>
                  <th>成員</th>
                  <th style={{ width: '34%' }}>場次（已完成／全部）</th>
                  <th>見過的 {st.settings.host_label}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <span class="row" style={{ gap: '8px' }}>
                        <span class="gno">{g.no}</span>
                        <span>{g.name || `第 ${g.no} 組`}</span>
                      </span>
                    </td>
                    <td class="mono">{g.members}</td>
                    <td>
                      <div class="row">
                        <div class="meter grow" aria-hidden="true">
                          <i style={{ width: `${(g.total / maxTotal) * 100}%`, opacity: g.total ? 1 : 0 }} />
                        </div>
                        <span class="mono small nowrap">
                          {g.done}/{g.total}
                        </span>
                      </div>
                    </td>
                    <td class="small muted">{[...new Set(g.recent_teachers)].map(tName).join('、') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section class="section" aria-labelledby="ov-feed">
          <div class="section-head">
            <h2 id="ov-feed">最新動態</h2>
            <span class="live">
              <i />
              即時
            </span>
          </div>
          <div class="card tight">
            {feed.length ? (
              <div class="feed">
                {feed.map((e) => (
                  <div class={`ev ${eventClass(e.kind)}`} key={e.id}>
                    <i aria-hidden="true" />
                    <div>
                      {eventText(e, st.groups)}
                      <time dateTime={e.at}>{agoText(e.at, now)}</time>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p class="muted small">還沒有任何動態</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
