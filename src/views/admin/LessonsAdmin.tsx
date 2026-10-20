import { useId, useRef, useState } from 'preact/hooks';
import type { Lesson, LessonInfo, LessonsState, LessonUnit } from '../../api/types';
import { clock, useApi, useBusy, useLive } from '../../app/hooks';
import { errorText } from '../../app/messages';
import { download } from '../../lib/files';
import { byWeek, monday, scheduleJson, teacherList, unitLabel, unitNo, unitOf } from '../../lib/lessons';
import { addDays, DOW, hm, isoDow, md, minutes } from '../../lib/time';
import { confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, Field, Loading, Place, Seg } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { LessonRow } from '../lessons/parts';
import { ErrorState } from '../student/StudentApp';
import { siteUrl } from './common';

// 07:00 … 24:00 in half hours
const TIMES = Array.from({ length: (24 - 7) * 2 + 1 }, (_, i) => hm(7 * 60 + i * 30));

/** A time list that also holds `v`, for lessons imported at odd minutes. */
function withValue(list: string[], v: string): string[] {
  return list.includes(v) ? list : [...list, v].sort();
}

/** Saves and returns null, or returns the error to show in the form. */
type Submit = (fn: string, args: Record<string, unknown>, ok: string) => Promise<string | null>;

export function LessonsAdmin() {
  const { data: st, error, reload } = useLive<LessonsState>('oh_lessons', {}, true);
  const { call } = useApi();
  const { run } = useBusy();
  const [showPast, setShowPast] = useState(false);
  const [tab, setTab] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  if (!st) return error ? <ErrorState onRetry={reload} /> : <Loading />;

  const kind = st.types.includes(tab) ? tab : st.types[0];
  const kindUnits = st.units.filter((u) => u.type === kind);
  const loose = st.lessons.filter((l) => l.type === kind && l.unit == null).length;

  const teachers = teacherList(st.lessons);
  const publicUrl = `${siteUrl()}#/td`;
  const thisWeek = monday(clock.today);
  const weeks = byWeek(st.lessons);
  const past = weeks.filter((w) => w.start < thisWeek);
  const visible = showPast ? weeks : weeks.filter((w) => w.start >= thisWeek);

  const submit: Submit = async (fn, args, ok) => {
    let msg: string | null = null;
    const r = await run('save', () => call(fn, args), {
      ok,
      onError: (e) => {
        msg = errorText(e);
        return true;
      },
    });
    if (r) reload();
    return r ? null : (msg ?? errorText(null));
  };

  const remove = async (l: Lesson) => {
    if (!(await confirm({ title: `刪除 ${md(l.date)} ${l.start} ${l.teacher} 的課？`, body: '公開頁和訂閱的行事曆會跟著拿掉這堂', ok: '刪除', danger: true }))) return false;
    const r = await run('del', () => call('oh_admin_lesson_delete', { p_id: l.id }), { ok: '已刪除' });
    if (r) reload();
    return Boolean(r);
  };

  const edit = (l: Lesson | null) =>
    openDialog(l ? '編輯課程' : '新增一堂課', (close) => (
      <LessonForm l={l} teachers={teachers} types={st.types} units={st.units} close={close} submit={submit} remove={remove} />
    ));

  const removeUnit = async (u: LessonUnit) => {
    const n = st.lessons.filter((l) => l.unit === u.id).length;
    const ok = await confirm({
      title: `刪除${unitLabel(u)}？`,
      body: n ? `這個單元的 ${n} 堂課會變成還沒分單元，課本身不會刪掉。後面的單元編號會往前補` : '後面的單元編號會往前補',
      ok: '刪除',
      danger: true,
    });
    if (!ok) return false;
    const r = await run('del', () => call('oh_admin_lesson_unit_delete', { p_id: u.id }), { ok: '已刪除單元' });
    if (r) reload();
    return Boolean(r);
  };

  const editUnit = (u: LessonUnit | null) =>
    openDialog(
      u ? `編輯${unitLabel(u)}` : `新增${kind}單元`,
      (close) => (
        <UnitForm u={u} type={u?.type ?? kind} units={st.units} lessons={st.lessons} today={clock.today} close={close} submit={submit} remove={removeUnit} />
      ),
      { wide: 'wide' },
    );

  const editInfo = () => openDialog('編輯頁面資訊', (close) => <InfoForm info={st.info} close={close} submit={submit} />);

  const exportJson = () =>
    download('td-schedule.json', `${JSON.stringify(scheduleJson(st.info, st.types, st.lessons, st.units), null, 1)}\n`, 'application/json;charset=utf-8');

  const importJson = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let doc: unknown;
    try {
      doc = JSON.parse(await file.text());
    } catch {
      toast('這個檔案不是有效的 JSON', { kind: 'error' });
      return;
    }
    const list = Array.isArray(doc) ? doc : (doc as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(list)) {
      toast('檔案裡找不到 sessions 清單', { kind: 'error' });
      return;
    }
    const units = (doc as { units?: unknown } | null)?.units;
    const ok = await confirm({
      title: `用檔案裡的 ${list.length} 堂取代目前的 ${st.lessons.length} 堂？`,
      body: `目前的課會全部換掉${Array.isArray(units) ? `，單元也會換成檔案裡的 ${units.length} 個` : ''}，公開頁和訂閱的行事曆也會跟著更新。想留一份備份，先按「下載 JSON」`,
      ok: '匯入',
      danger: true,
    });
    if (!ok) return;
    const r = await run('import', () => call<{ count: number; units?: number }>('oh_admin_lessons_import', { p: doc }));
    if (r) {
      toast(r.units == null ? `已匯入 ${r.count} 堂` : `已匯入 ${r.count} 堂和 ${r.units} 個單元`);
      reload();
    }
  };

  return (
    <main class="page enter">
      <div class="stack tight">
        <p class="eyebrow">TD 專班</p>
        <h1 class="title-l">{st.info.title}</h1>
        <p class="muted small" style={{ maxWidth: '600px' }}>
          這份課表是公開的，不用登入就能看。在這裡改動，公開頁和訂閱的行事曆會跟著更新
        </p>
      </div>

      <div class="card tight stack tight">
        <span class="eyebrow">公開網址</span>
        <code class="mono small" style={{ wordBreak: 'break-all' }}>
          {publicUrl}
        </code>
        <div class="row wrap">
          <CopyBtn text={publicUrl} label="複製網址" done="已複製公開網址" />
          <a class="btn sm" href="#/td">
            <Icon name="arrow" size={16} /> 打開公開頁
          </a>
        </div>
      </div>

      <section class="section" aria-labelledby="l-info">
        <div class="section-head">
          <h2 id="l-info">頁面資訊</h2>
          <Btn size="sm" icon="edit" onClick={editInfo}>
            編輯頁面資訊
          </Btn>
        </div>
        <dl class="kv">
          <dt>標題</dt>
          <dd>{st.info.title}</dd>
          <dt>副標題</dt>
          <dd>{st.info.subtitle || <span class="muted">未填</span>}</dd>
          <dt>上課地點</dt>
          <dd>{st.info.place ? <Place value={st.info.place} /> : <span class="muted">未填</span>}</dd>
          <dt>公告</dt>
          <dd class="pre">{st.info.note || <span class="muted">未填</span>}</dd>
        </dl>
      </section>

      <section class="section" aria-labelledby="l-units">
        <div class="section-head">
          <h2 id="l-units">單元</h2>
          <span class="grow" />
          <Btn variant="primary" size="sm" icon="plus" onClick={() => editUnit(null)}>
            新增單元
          </Btn>
        </div>
        <p class="muted small" style={{ maxWidth: '600px' }}>
          每種類型可以分成幾個單元，例如基礎教學（一）、（二）。勾選每個單元在哪幾堂上，學生會在公開頁看到單元的主題和說明
        </p>
        <Seg label="單元的類型" value={kind} onChange={setTab} options={st.types.map((t) => ({ value: t, label: t }))} />
        {kindUnits.length === 0 ? (
          <Empty icon="layers" title={`${kind}還沒有單元`}>
            按「新增單元」，填主題，再勾選要上這個單元的日期
          </Empty>
        ) : (
          <div class="list">
            {kindUnits.map((u) => {
              const mine = st.lessons.filter((l) => l.unit === u.id);
              return (
                <button type="button" key={u.id} class="li top ls-edit" onClick={() => editUnit(u)}>
                  <span class="ls-no">{unitNo(u)}</span>
                  <span class="grow stack tight">
                    <span class="ls-title">{u.title}</span>
                    <span class="small muted">{mine.length ? `${mine.map((l) => `${md(l.date)} ${l.teacher}`).join('、')} 共 ${mine.length} 堂` : '還沒勾日期'}</span>
                  </span>
                  <Icon name="edit" class="ls-pen" />
                </button>
              );
            })}
          </div>
        )}
        {st.lessons.some((l) => l.type === kind) && (
          <p class="small muted">{loose ? `${kind}還沒分單元的課：${loose} 堂` : `${kind}的課都分好單元了`}</p>
        )}
      </section>

      <section class="section" aria-labelledby="l-list">
        <div class="section-head">
          <h2 id="l-list">課程</h2>
          <span class="grow small muted">共 {st.lessons.length} 堂</span>
          <Btn variant="primary" size="sm" icon="plus" onClick={() => edit(null)}>
            新增一堂
          </Btn>
        </div>
        {st.lessons.length === 0 ? (
          <Empty icon="calendar" title="還沒有排課">
            按「新增一堂」，或用下面的匯入一次放進整份課表
          </Empty>
        ) : (
          <div class="stack loose">
            {past.length > 0 && (
              <button type="button" class="link-btn small" style={{ justifySelf: 'start' }} aria-expanded={showPast} onClick={() => setShowPast(!showPast)}>
                {showPast ? '收起已結束的週' : `顯示已結束的 ${past.length} 週`}
              </button>
            )}
            {visible.map((w) => (
              <div class="stack tight" key={w.start}>
                <h3 class="ls-wh">
                  <span>第 {w.no} 週</span>
                  <span class="small muted mono">
                    {md(w.start)}–{md(addDays(w.start, 6))}
                  </span>
                  <span class="small muted">{w.lessons.length} 堂</span>
                </h3>
                <div class="list">
                  {w.lessons.map((l) => (
                    <LessonRow
                      key={l.id}
                      l={l}
                      unit={unitOf(l, st.units)}
                      teachers={teachers}
                      today={clock.today}
                      phase={l.date < clock.today ? 'past' : 'later'}
                      onClick={() => edit(l)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section class="section" aria-labelledby="l-io">
        <div class="section-head">
          <h2 id="l-io">匯入與匯出</h2>
        </div>
        <p class="muted small" style={{ maxWidth: '600px' }}>
          檔案格式和原本的 schedule.json 一樣，另外多了單元。匯入會取代目前全部的課，適合新學期一次換掉整份課表
        </p>
        <div class="row wrap">
          <Btn icon="download" onClick={exportJson}>
            下載 JSON
          </Btn>
          <Btn icon="layers" onClick={() => fileRef.current?.click()}>
            匯入 JSON
          </Btn>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="選擇要匯入的 JSON 檔" onChange={importJson} />
        </div>
      </section>
    </main>
  );
}

function LessonForm({
  l,
  teachers,
  types,
  units,
  close,
  submit,
  remove,
}: {
  l: Lesson | null;
  teachers: string[];
  types: string[];
  units: LessonUnit[];
  close: () => void;
  submit: Submit;
  remove: (l: Lesson) => Promise<boolean>;
}) {
  const [date, setDate] = useState(l?.date ?? clock.today);
  const [start, setStart] = useState(l?.start ?? '21:00');
  const [end, setEnd] = useState(l?.end ?? '22:00');
  const [teacher, setTeacher] = useState(l?.teacher ?? teachers[0] ?? '');
  const [type, setType] = useState(l?.type ?? types[0]);
  const [unit, setUnit] = useState<number | null>(l?.unit ?? null);
  const [title, setTitle] = useState(l?.title ?? '');
  const [topic, setTopic] = useState(l?.topic ?? '');
  const [err, setErr] = useState<string | null>(null);
  const listId = useId();
  const typeUnits = units.filter((u) => u.type === type);
  const badTime = end <= start;
  const ready = !badTime && Boolean(date) && teacher.trim().length > 0;

  // moving the start keeps the length of the lesson
  const changeStart = (v: string) => {
    const length = Math.max(30, minutes(end) - minutes(start));
    setStart(v);
    setEnd(hm(Math.min(24 * 60, minutes(v) + length)));
    setErr(null);
  };

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        const msg = await submit('oh_admin_lesson_save', { p: { id: l?.id ?? null, date, start, end, teacher, type, unit, title, topic } }, l ? '已儲存' : '已新增');
        if (msg) setErr(msg);
        else close();
      }}
    >
      <h2>{l ? '編輯課程' : '新增一堂課'}</h2>
      <Field label="日期">
        <input
          class="input"
          type="date"
          required
          value={date}
          onInput={(e) => {
            setDate((e.target as HTMLInputElement).value);
            setErr(null);
          }}
        />
      </Field>
      <div class="row" style={{ alignItems: 'flex-end' }}>
        <Field label="開始">
          <select class="select" value={start} onChange={(e) => changeStart((e.target as HTMLSelectElement).value)}>
            {withValue(TIMES.slice(0, -1), start).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <span class="muted" style={{ paddingBottom: '12px' }}>
          –
        </span>
        <Field label="結束" error={badTime ? '結束要晚於開始' : null}>
          <select
            class="select"
            value={end}
            onChange={(e) => {
              setEnd((e.target as HTMLSelectElement).value);
              setErr(null);
            }}
          >
            {withValue(TIMES.slice(1), end).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="講師" help={teachers.length ? `可以直接選：${teachers.join('、')}` : undefined}>
        <input
          class="input"
          list={listId}
          required
          maxLength={20}
          value={teacher}
          onInput={(e) => {
            setTeacher((e.target as HTMLInputElement).value);
            setErr(null);
          }}
        />
      </Field>
      <datalist id={listId}>
        {teachers.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div class="field">
        <span class="label">類型</span>
        <Seg
          label="類型"
          value={type}
          onChange={(t) => {
            // a unit belongs to one type
            setType(t);
            setUnit(t === l?.type ? l.unit : null);
          }}
          options={types.map((t) => ({ value: t, label: t }))}
        />
      </div>
      {typeUnits.length > 0 && (
        <Field label="單元" optional>
          <select class="select" value={unit ?? ''} onChange={(e) => setUnit(Number((e.target as HTMLSelectElement).value) || null)}>
            <option value="">還沒分單元</option>
            {typeUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {unitNo(u)}
                {u.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="標題" optional help={typeUnits.length ? '有單元時可以留空，公開頁會顯示單元主題' : '空白時公開頁會顯示「標題待定」'} count={title.length} max={80}>
        <input class="input" maxLength={80} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="內容說明" optional count={topic.length} max={1000}>
        <textarea class="textarea" maxLength={1000} value={topic} onInput={(e) => setTopic((e.target as HTMLTextAreaElement).value)} />
      </Field>
      {err && (
        <p class="small" role="alert" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div class="actions">
        {l && (
          <button
            type="button"
            class="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              if (await remove(l)) close();
            }}
          >
            刪除
          </button>
        )}
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={!ready}>
          儲存
        </button>
      </div>
    </form>
  );
}

function UnitForm({
  u,
  type,
  units,
  lessons,
  today,
  close,
  submit,
  remove,
}: {
  u: LessonUnit | null;
  type: string;
  units: LessonUnit[];
  lessons: Lesson[];
  today: string;
  close: () => void;
  submit: Submit;
  remove: (u: LessonUnit) => Promise<boolean>;
}) {
  const others = units.filter((x) => x.type === type && x.id !== u?.id);
  const places = others.length + 1;
  const [no, setNo] = useState(u?.no ?? places);
  const [title, setTitle] = useState(u?.title ?? '');
  const [topic, setTopic] = useState(u?.topic ?? '');
  const [picked, setPicked] = useState<number[]>(() => (u ? lessons.filter((l) => l.unit === u.id).map((l) => l.id) : []));
  const [err, setErr] = useState<string | null>(null);
  const choices = lessons.filter((l) => l.type === type);
  const ready = title.trim().length > 0;
  const toggle = (id: number) => {
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
    setErr(null);
  };

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        const msg = await submit('oh_admin_lesson_unit_save', { p: { id: u?.id ?? null, type, no, title, topic, lessons: picked } }, u ? '已儲存單元' : '已新增單元');
        if (msg) setErr(msg);
        else close();
      }}
    >
      <h2>{u ? `編輯${unitLabel(u)}` : `新增${type}單元`}</h2>
      {places > 1 && (
        <Field label="編號" help="改編號時，其他單元會跟著往前或往後移">
          <select class="select" value={no} onChange={(e) => setNo(Number((e.target as HTMLSelectElement).value))}>
            {Array.from({ length: places }, (_, i) => (
              <option key={i} value={i + 1}>
                {unitLabel({ type, no: i + 1 })}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="主題" count={title.length} max={80}>
        <input
          class="input"
          required
          maxLength={80}
          value={title}
          onInput={(e) => {
            setTitle((e.target as HTMLInputElement).value);
            setErr(null);
          }}
        />
      </Field>
      <Field label="說明" optional help="學生會在公開頁看到，例如這個單元會教什麼、要先準備什麼" count={topic.length} max={1000}>
        <textarea class="textarea" maxLength={1000} value={topic} onInput={(e) => setTopic((e.target as HTMLTextAreaElement).value)} />
      </Field>
      <fieldset class="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend class="label" style={{ padding: 0, marginBottom: '6px' }}>
          哪幾堂上這個單元
        </legend>
        {choices.length === 0 ? (
          <p class="small muted">還沒有{type}的課，先在「課程」新增</p>
        ) : (
          <div class="ls-picks">
            {choices.map((l) => {
              const other = l.unit != null && l.unit !== u?.id ? units.find((x) => x.id === l.unit) : undefined;
              return (
                <label class={`check ${l.date < today ? 'muted' : ''}`} key={l.id}>
                  <input type="checkbox" checked={picked.includes(l.id)} onChange={() => toggle(l.id)} />
                  <span>
                    {md(l.date)} {DOW[isoDow(l.date)]} <span class="mono">{l.start}</span> {l.teacher}
                    {other && !picked.includes(l.id) && <span class="tiny muted">　目前在{unitNo(other)}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <span class="help">已勾 {picked.length} 堂。一堂課只屬於一個單元，勾選別的單元的課會把它移過來</span>
      </fieldset>
      {err && (
        <p class="small" role="alert" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div class="actions">
        {u && (
          <button
            type="button"
            class="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              if (await remove(u)) close();
            }}
          >
            刪除單元
          </button>
        )}
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={!ready}>
          儲存
        </button>
      </div>
    </form>
  );
}

function InfoForm({ info, close, submit }: { info: LessonInfo; close: () => void; submit: Submit }) {
  const [v, setV] = useState<LessonInfo>(info);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof LessonInfo) => (e: Event) => {
    setV({ ...v, [k]: (e.target as HTMLInputElement).value });
    setErr(null);
  };
  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.title.trim()) return;
        const msg = await submit('oh_admin_lessons_info', { p: v }, '已更新頁面資訊');
        if (msg) setErr(msg);
        else close();
      }}
    >
      <h2>編輯頁面資訊</h2>
      <Field label="標題" count={v.title.length} max={40}>
        <input class="input" required maxLength={40} value={v.title} onInput={set('title')} />
      </Field>
      <Field label="副標題" optional count={v.subtitle.length} max={80} help="顯示在標題上方，例如學期和課程名稱">
        <input class="input" maxLength={80} value={v.subtitle} onInput={set('subtitle')} />
      </Field>
      <Field label="上課地點" optional help="貼 Google Meet 或 Discord 網址會變成連結">
        <input class="input" maxLength={200} value={v.place} onInput={set('place')} />
      </Field>
      <Field label="公告" optional count={v.note.length} max={500} help="顯示在公開頁最上面，例如請假、補課或錄影說明">
        <textarea class="textarea" maxLength={500} value={v.note} onInput={set('note')} />
      </Field>
      {err && (
        <p class="small" role="alert" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div class="actions">
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={!v.title.trim()}>
          儲存
        </button>
      </div>
    </form>
  );
}
