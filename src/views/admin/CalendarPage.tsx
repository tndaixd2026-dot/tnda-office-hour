import { useState } from 'preact/hooks';
import type { AdminConfig, Block, Closure } from '../../api/types';
import { clock, useApi, useBusy, useLive } from '../../app/hooks';
import { addDays, DOW, hm, isoDow, md, mdPad } from '../../lib/time';
import { confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, Empty, Field, Loading, Seg, Switch } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';

const TIMES = Array.from({ length: (23 - 7) * 2 + 1 }, (_, i) => hm(7 * 60 + i * 30));

export function CalendarPage() {
  const { data: cfg, error, reload } = useLive<AdminConfig>('oh_admin_config', {});
  const { call } = useApi();
  const { run } = useBusy();
  if (!cfg) return error ? <ErrorState onRetry={reload} /> : <Loading />;

  const tName = (id: number | null) => (id === null ? '所有人' : cfg.teachers.find((t) => t.id === id)?.name ?? '—');
  const save = async (kind: string, p: Record<string, unknown>, ok?: string) => {
    const r = await run('save', () => call('oh_admin_save', { p_kind: kind, p }), { ok });
    reload();
    return r;
  };
  const del = async (kind: string, id: number, title: string) => {
    if (!(await confirm({ title, ok: '刪除', danger: true }))) return;
    await run('del', () => call('oh_admin_delete', { p_kind: kind, p_id: id }), { ok: '已刪除' });
    reload();
  };

  const recurring = cfg.blocks.filter((b) => b.dow !== null);
  const oneOff = cfg.blocks.filter((b) => b.on_date !== null && b.on_date >= clock.today);
  const closures = cfg.closures.filter((c) => c.d >= addDays(clock.today, -7));

  return (
    <main class="page enter">
      <div class="stack tight">
        <p class="eyebrow">時段與週次</p>
        <h1 class="title-l">什麼時候可以約</h1>
        <p class="muted small" style={{ maxWidth: '600px' }}>
          開放時段決定學生能勾哪些格子；休息日會整天關閉；週次決定學生可以預約哪幾週。改動會立刻同步到所有人的畫面
        </p>
      </div>

      <section class="section" aria-labelledby="c-blocks">
        <div class="section-head">
          <h2 id="c-blocks">每週開放時段</h2>
          <Btn variant="primary" size="sm" icon="plus" onClick={() => editBlock(cfg, null, save)}>
            新增時段
          </Btn>
        </div>
        {recurring.length === 0 ? (
          <Empty icon="clock" title="還沒有開放時段" />
        ) : (
          <div class="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {[1, 2, 3, 4, 5, 6, 7]
              .filter((dow) => recurring.some((b) => b.dow === dow))
              .map((dow) => (
                <div class="tile" key={dow} style={{ gap: '10px' }}>
                  <b>{DOW[dow]}</b>
                  {recurring
                    .filter((b) => b.dow === dow)
                    .map((b) => (
                      <BlockRow key={b.id} b={b} name={tName(b.teacher_id)} onEdit={() => editBlock(cfg, b, save)} onDelete={() => del('block', b.id, `刪除${DOW[dow]} ${b.start}–${b.end}（${tName(b.teacher_id)}）？`)} />
                    ))}
                </div>
              ))}
          </div>
        )}
        {oneOff.length > 0 && (
          <div class="card tight stack tight">
            <span class="eyebrow">單次加開</span>
            {oneOff.map((b) => (
              <BlockRow key={b.id} b={b} name={tName(b.teacher_id)} onEdit={() => editBlock(cfg, b, save)} onDelete={() => del('block', b.id, '刪除這個單次時段？')} />
            ))}
          </div>
        )}
      </section>

      <section class="section" aria-labelledby="c-closures">
        <div class="section-head">
          <h2 id="c-closures">休息日與請假</h2>
          <Btn size="sm" icon="plus" onClick={() => editClosure(cfg, null, save)}>
            新增休息日
          </Btn>
        </div>
        {closures.length === 0 ? (
          <p class="muted small">沒有設定休息日。國定假日或老師請假時，在這裡加上就會自動關閉當天的時段</p>
        ) : (
          <div class="list">
            {closures.map((c) => (
              <div class="li" key={c.id}>
                <div class="when">
                  <b>{md(c.d)}</b>
                  <span>{DOW[isoDow(c.d)]}</span>
                </div>
                <div class="grow">
                  <span class={`chip ${c.teacher_id === null ? 'danger' : 'warn'}`}>{c.teacher_id === null ? '全部休息' : `${tName(c.teacher_id)} 請假`}</span>{' '}
                  <span class="small">{c.reason}</span>
                </div>
                <Btn size="sm" variant="ghost" icon="edit" aria-label="編輯" onClick={() => editClosure(cfg, c, save)} />
                <Btn size="sm" variant="ghost" icon="trash" aria-label="刪除" onClick={() => del('closure', c.id, `刪除 ${md(c.d)} 的休息日？`)} />
              </div>
            ))}
          </div>
        )}
      </section>

      <Weeks cfg={cfg} save={save} del={del} reload={reload} />
    </main>
  );
}

function BlockRow({ b, name, onEdit, onDelete }: { b: Block; name: string; onEdit: () => void; onDelete: () => void }) {
  return (
    <div class="row" style={{ gap: '6px' }}>
      <div class="grow stack" style={{ gap: '0px' }}>
        <span class="mono small">
          {b.on_date ? `${md(b.on_date)} ` : ''}
          {b.start}–{b.end}
        </span>
        <span class="tiny muted">
          {name}
          {(b.valid_from || b.valid_to) && ` · ${b.valid_from ? md(b.valid_from) : ''}～${b.valid_to ? md(b.valid_to) : ''}`}
        </span>
      </div>
      <Btn size="sm" variant="ghost" icon="edit" aria-label="編輯時段" onClick={onEdit} />
      <Btn size="sm" variant="ghost" icon="trash" aria-label="刪除時段" onClick={onDelete} />
    </div>
  );
}

type Save = (kind: string, p: Record<string, unknown>, ok?: string) => Promise<unknown>;

function editBlock(cfg: AdminConfig, b: Block | null, save: Save) {
  openDialog(b ? '編輯時段' : '新增時段', (close) => <BlockForm cfg={cfg} b={b} close={close} save={save} />);
}

function BlockForm({ cfg, b, close, save }: { cfg: AdminConfig; b: Block | null; close: () => void; save: Save }) {
  const [teacher, setTeacher] = useState(b?.teacher_id ?? cfg.teachers.find((t) => t.active && !t.team)?.id ?? 0);
  const [kind, setKind] = useState<'weekly' | 'once'>(b?.on_date ? 'once' : 'weekly');
  const [dow, setDow] = useState(b?.dow ?? 1);
  const [date, setDate] = useState(b?.on_date ?? clock.today);
  const [start, setStart] = useState(b?.start ?? '10:00');
  const [end, setEnd] = useState(b?.end ?? '12:00');
  const [from, setFrom] = useState(b?.valid_from ?? '');
  const [to, setTo] = useState(b?.valid_to ?? '');
  const bad = end <= start;
  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (bad || !teacher) return;
        const r = await save(
          'block',
          {
            id: b?.id,
            teacher_id: teacher,
            dow: kind === 'weekly' ? dow : null,
            on_date: kind === 'once' ? date : null,
            start,
            end,
            valid_from: kind === 'weekly' && from ? from : null,
            valid_to: kind === 'weekly' && to ? to : null,
          },
          '已儲存時段',
        );
        if (r) close();
      }}
    >
      <h2>{b ? '編輯時段' : '新增開放時段'}</h2>
      <Field label="老師">
        <select class="select" value={teacher} onChange={(e) => setTeacher(Number((e.target as HTMLSelectElement).value))}>
          {cfg.teachers.filter((t) => !t.team).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.active ? '' : '（停用中）'}
            </option>
          ))}
        </select>
      </Field>
      <Seg
        label="類型"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'weekly', label: '每週固定' },
          { value: 'once', label: '單次加開' },
        ]}
      />
      {kind === 'weekly' ? (
        <Field label="星期">
          <select class="select" value={dow} onChange={(e) => setDow(Number((e.target as HTMLSelectElement).value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d} value={d}>
                {DOW[d]}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="日期">
          <input class="input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} required />
        </Field>
      )}
      <div class="row" style={{ alignItems: 'flex-end' }}>
        <Field label="開始">
          <select class="select" value={start} onChange={(e) => setStart((e.target as HTMLSelectElement).value)}>
            {TIMES.slice(0, -1).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <span class="muted" style={{ paddingBottom: '12px' }}>
          –
        </span>
        <Field label="結束" error={bad ? '結束要晚於開始' : null}>
          <select class="select" value={end} onChange={(e) => setEnd((e.target as HTMLSelectElement).value)}>
            {TIMES.slice(1).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
      </div>
      {kind === 'weekly' && (
        <details open={Boolean(from || to)}>
          <summary class="small muted" style={{ cursor: 'pointer' }}>
            只在某段期間有效（選填）
          </summary>
          <div class="row" style={{ marginTop: '10px' }}>
            <Field label="從">
              <input class="input" type="date" value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="到">
              <input class="input" type="date" value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
        </details>
      )}
      <div class="actions">
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={bad || !teacher}>
          儲存
        </button>
      </div>
    </form>
  );
}

function editClosure(cfg: AdminConfig, c: Closure | null, save: Save) {
  openDialog(c ? '編輯休息日' : '新增休息日', (close) => <ClosureForm cfg={cfg} c={c} close={close} save={save} />);
}

function ClosureForm({ cfg, c, close, save }: { cfg: AdminConfig; c: Closure | null; close: () => void; save: Save }) {
  const [d, setD] = useState(c?.d ?? clock.today);
  const [who, setWho] = useState<number | 0>(c?.teacher_id ?? 0);
  const [reason, setReason] = useState(c?.reason ?? '');
  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await save('closure', { id: c?.id, d, teacher_id: who || null, reason }, '已儲存');
        if (r) close();
      }}
    >
      <h2>{c ? '編輯休息日' : '新增休息日'}</h2>
      <Field label="日期">
        <input class="input" type="date" value={d} required onInput={(e) => setD((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="誰休息">
        <select class="select" value={who} onChange={(e) => setWho(Number((e.target as HTMLSelectElement).value))}>
          <option value={0}>所有人（假日）</option>
          {cfg.teachers.filter((t) => !t.team).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} 請假
            </option>
          ))}
        </select>
      </Field>
      <Field label="說明" optional help="例：元旦、校慶、出差。會顯示在時段表上">
        <input class="input" value={reason} maxLength={40} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
      </Field>
      <p class="tiny muted">已經排定在這天的場次不會自動取消，請到排程頁確認</p>
      <div class="actions">
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary">
          儲存
        </button>
      </div>
    </form>
  );
}

function Weeks({ cfg, save, del, reload }: { cfg: AdminConfig; save: Save; del: (k: string, id: number, t: string) => Promise<void>; reload: () => void }) {
  const { call } = useApi();
  const { run } = useBusy();
  const generate = () =>
    openDialog('產生週次', (close) => <GenerateForm close={close} run={run} call={call} reload={reload} />);
  return (
    <section class="section" aria-labelledby="c-weeks">
      <div class="section-head">
        <h2 id="c-weeks">週次</h2>
        <Btn size="sm" icon="plus" onClick={generate}>
          產生週次
        </Btn>
      </div>
      {cfg.weeks.length === 0 ? (
        <Empty icon="calendar" title="還沒有週次">
          按「產生週次」一次建立整個學期
        </Empty>
      ) : (
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>週次</th>
                <th>日期</th>
                <th>備註</th>
                <th>開放預約</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cfg.weeks.map((w) => (
                <tr key={w.id} class={addDays(w.start, 6) < clock.today ? 'muted' : undefined}>
                  <td>
                    <input
                      class="input sm mono"
                      style={{ width: '76px' }}
                      value={w.label}
                      maxLength={12}
                      aria-label="週次名稱"
                      onChange={(e) => save('week', { id: w.id, label: (e.target as HTMLInputElement).value })}
                    />
                  </td>
                  <td class="mono nowrap">
                    {mdPad(w.start)}–{mdPad(addDays(w.start, 6))}
                  </td>
                  <td>
                    <input
                      class="input sm"
                      value={w.note}
                      maxLength={60}
                      placeholder="例：期中週"
                      aria-label="備註"
                      onChange={(e) => save('week', { id: w.id, note: (e.target as HTMLInputElement).value })}
                    />
                  </td>
                  <td>
                    <Switch
                      checked={w.open}
                      name={`${w.label || mdPad(w.start)} 開放預約`}
                      onChange={(v) => save('week', { id: w.id, open: v }, v ? '已開放' : '已暫停這週的預約')}
                      label=""
                    />
                  </td>
                  <td>
                    {!w.used && <Btn size="sm" variant="ghost" icon="trash" aria-label="刪除週次" onClick={() => del('week', w.id, `刪除 ${w.label || mdPad(w.start)}？`)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function GenerateForm({ close, run, call, reload }: { close: () => void; run: ReturnType<typeof useBusy>['run']; call: ReturnType<typeof useApi>['call']; reload: () => void }) {
  const [start, setStart] = useState(clock.today);
  const [count, setCount] = useState(16);
  const [first, setFirst] = useState(1);
  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run('gen', () => call<{ added: number }>('oh_admin_weeks_generate', { p_start: start, p_count: count, p_first_no: first }));
        if (r) {
          reload();
          close();
        }
      }}
    >
      <h2>產生週次</h2>
      <p class="muted small">從選定日期所在的那一週開始，連續建立數週。已經存在的週次會略過</p>
      <Field label="從哪一天開始">
        <input class="input" type="date" required value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} />
      </Field>
      <div class="row">
        <Field label="幾週">
          <input class="input" type="number" min={1} max={52} value={count} onInput={(e) => setCount(Number((e.target as HTMLInputElement).value))} />
        </Field>
        <Field label="第一週的編號" help="會命名為 W1、W2…">
          <input class="input" type="number" min={0} max={99} value={first} onInput={(e) => setFirst(Number((e.target as HTMLInputElement).value))} />
        </Field>
      </div>
      <div class="actions">
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary">
          <Icon name="plus" /> 產生
        </button>
      </div>
    </form>
  );
}
