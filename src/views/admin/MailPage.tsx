import { useEffect, useState } from 'preact/hooks';
import type { MailMessage, MailRecipient, MailState } from '../../api/types';
import { useApi, useBusy, useLive } from '../../app/hooks';
import { errorText } from '../../app/messages';
import { MAIL_PREVIEW, MAIL_REMIND, MAIL_SEND, SUPABASE_KEY, SUPABASE_URL } from '../../config';
import { addDays, agoText, md } from '../../lib/time';
import { confirm, openDialog } from '../../ui/dialog';
import { Btn, Empty, Field, Loading, Seg, Switch } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';
import { siteUrl } from './common';

/** Saves and returns null, or returns the error to show in the form. */
type Submit = (fn: string, args: Record<string, unknown>, ok: string) => Promise<string | null>;

export function MailPage() {
  const { data: st, error, reload } = useLive<MailState>('oh_admin_mail', {});
  const { call } = useApi();
  const { busy, run } = useBusy();
  const [ta, setTa] = useState<string | null>(null);
  if (!st) return error ? <ErrorState onRetry={reload} /> : <Loading />;

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
  const setting = (p: Record<string, unknown>, ok: string) => run('settings', () => call('oh_admin_mail_save', { p_kind: 'settings', p }), { ok }).then(reload);
  const remove = async (r: MailRecipient) => {
    if (!(await confirm({ title: `不再寄給 ${r.name || r.email}？`, ok: '刪除', danger: true }))) return false;
    const ok = await run('del', () => call('oh_admin_mail_delete', { p_id: r.id }), { ok: '已刪除收件人' });
    reload();
    return Boolean(ok);
  };
  const edit = (r: MailRecipient | null) =>
    openDialog(r ? '編輯收件人' : '新增收件人', (close) => <RecipientForm r={r} teachers={st.teachers} close={close} submit={submit} remove={remove} />);
  const scope = (r: MailRecipient) =>
    r.teachers.length === 0 || r.teachers.length >= st.teachers.length
      ? '三位老師全部的場次'
      : `${st.teachers.filter((t) => r.teachers.includes(t.id)).map((t) => t.name).join('、')} 的場次`;
  const taValue = ta ?? st.settings.ta_email;

  return (
    <main class="page enter">
      <div class="stack tight">
        <p class="eyebrow">寄信通知</p>
        <h1 class="title-l">每週寄給老師的信</h1>
        <p class="muted small" style={{ maxWidth: '640px' }}>
          {MAIL_SEND} 會自動把這週的場次寄給下面的收件人，每一場都有「加到 Google 日曆」按鈕，也可以一鍵訂閱全部場次。助教信箱會先收到兩封：
          {MAIL_REMIND} 需求截止時的審核提醒，和 {MAIL_PREVIEW} 的預覽
        </p>
      </div>

      <section class="card pad-l stack" aria-labelledby="m-settings">
        <h2 class="title-s" id="m-settings">
          寄送設定
        </h2>
        <Switch checked={st.settings.remind} onChange={(v) => setting({ remind: v }, v ? `${MAIL_REMIND} 會寄提醒` : '已關閉提醒')} label={`${MAIL_REMIND} 寄審核提醒到助教信箱`} />
        <Switch checked={st.settings.preview} onChange={(v) => setting({ preview: v }, v ? `${MAIL_PREVIEW} 會先寄預覽` : '已關閉預覽')} label={`${MAIL_PREVIEW} 先寄預覽到助教信箱`} />
        <Switch checked={st.settings.weekly} onChange={(v) => setting({ weekly: v }, v ? `${MAIL_SEND} 會寄出` : '已暫停週一的信')} label={`${MAIL_SEND} 寄給收件人`} />
        <form
          class="row wrap"
          style={{ alignItems: 'flex-end' }}
          onSubmit={async (e) => {
            e.preventDefault();
            await setting({ ta_email: taValue.trim() }, '已更新助教信箱');
            setTa(null);
          }}
        >
          <div class="grow" style={{ minWidth: '240px' }}>
            <Field label="助教信箱" optional help="收週日的提醒和預覽。沒填的話會寄到寄件的 Gmail">
              <input class="input" type="email" autoComplete="email" maxLength={120} value={taValue} onInput={(e) => setTa((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <Btn type="submit" disabled={taValue.trim() === st.settings.ta_email} loading={busy === 'settings'}>
            儲存
          </Btn>
        </form>
      </section>

      <section class="section" aria-labelledby="m-people">
        <div class="section-head">
          <h2 id="m-people">收件人</h2>
          <Btn variant="primary" size="sm" icon="plus" onClick={() => edit(null)}>
            新增收件人
          </Btn>
        </div>
        {st.recipients.length === 0 ? (
          <Empty icon="send" title="還沒有收件人">
            可以加上三位老師、業師公司的信箱和老師助理，每個人可以選要收哪幾位老師的場次
          </Empty>
        ) : (
          <div class="list">
            {st.recipients.map((r) => (
              <div class={`li ${r.active ? '' : 'inactive'}`} key={r.id} style={{ flexWrap: 'wrap' }}>
                <div class="grow stack" style={{ gap: '0px', minWidth: '180px' }}>
                  <b>{r.name || r.email}</b>
                  {r.name && <span class="small muted">{r.email}</span>}
                  <span class="tiny muted">收 {scope(r)}</span>
                </div>
                <Switch checked={r.active} name={`寄給 ${r.name || r.email}`} onChange={(v) => submit('oh_admin_mail_save', { p_kind: 'recipient', p: { id: r.id, active: v } }, v ? '會寄給這位' : '已暫停寄給這位')} label="" />
                <Btn size="sm" variant="ghost" icon="edit" aria-label={`編輯 ${r.name || r.email}`} onClick={() => edit(r)} />
              </div>
            ))}
          </div>
        )}
      </section>

      <Preview st={st} />

      <section class="section" aria-labelledby="m-log">
        <div class="section-head">
          <h2 id="m-log">寄送紀錄</h2>
        </div>
        {st.log.length === 0 ? (
          <p class="muted small">還沒有寄過信。第一次使用前，請先完成下面的 Gmail 設定</p>
        ) : (
          <div class="table-wrap" tabIndex={0} role="region" aria-labelledby="m-log">
            <table class="t">
              <thead>
                <tr>
                  <th scope="col">寄出</th>
                  <th scope="col">收件人</th>
                  <th scope="col">主旨</th>
                </tr>
              </thead>
              <tbody>
                {st.log.map((l, i) => (
                  <tr key={i}>
                    <td class="nowrap small">{agoText(l.at, Date.now())}</td>
                    <td class="small">{l.email}</td>
                    <td class="small">{l.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details class="card tight">
        <summary class="title-s" style={{ cursor: 'pointer' }}>
          Gmail 設定（只要做一次）
        </summary>
        <ol class="small stack tight" style={{ margin: '12px 0 0', paddingLeft: '20px' }}>
          <li>用要寄信的 Gmail 登入 Google 帳號，在「安全性」開啟兩步驟驗證</li>
          <li>到 myaccount.google.com/apppasswords 建立一組應用程式密碼（名稱可以叫 Office Hour），會得到 16 個字母</li>
          <li>
            到 GitHub repo 的 Settings → Secrets and variables → Actions，新增兩個 secret：<code class="mono">GMAIL_USER</code>（Gmail 地址）和{' '}
            <code class="mono">GMAIL_APP_PASSWORD</code>（剛剛的 16 個字母）。密碼不要貼到其他地方
          </li>
          <li>到 Actions → Weekly email → Run workflow，選「test」寄一封測試信給寄件的 Gmail 自己，不會寄給收件人</li>
        </ol>
      </details>
    </main>
  );
}

/** Exactly what goes out, rendered as the email clients will see it. */
function Preview({ st }: { st: MailState }) {
  const { call } = useApi();
  const [week, setWeek] = useState(st.week);
  const [msgs, setMsgs] = useState<MailMessage[] | null>(null);
  const [pick, setPick] = useState(0);
  const key = JSON.stringify([st.recipients, st.settings]);

  useEffect(() => {
    let live = true;
    call<{ messages: MailMessage[] }>('oh_admin_mail_preview', { p_week: week, p_site: siteUrl(), p_api: SUPABASE_URL, p_key: SUPABASE_KEY })
      .then((r) => live && setMsgs(r.messages))
      .catch(() => live && setMsgs([]));
    return () => {
      live = false;
    };
  }, [week, key]);

  const m = msgs?.[Math.min(pick, (msgs?.length ?? 1) - 1)];
  return (
    <section class="section" aria-labelledby="m-preview">
      <div class="section-head">
        <h2 id="m-preview">預覽</h2>
        <div class="ls-tools">
          <Seg
            label="哪一週的信"
            value={week}
            onChange={(w) => {
              setWeek(w);
              setPick(0);
            }}
            options={[
              { value: addDays(st.week, -7), label: '上一封', sub: `${md(addDays(st.week, -7))} 那週` },
              { value: st.week, label: '下一封', sub: `${md(st.week)} 那週` },
            ]}
          />
        </div>
      </div>
      {!msgs ? (
        <Loading />
      ) : msgs.length === 0 ? (
        <p class="muted small">新增收件人後，這裡會顯示每個人會收到的信</p>
      ) : (
        <div class="stack">
          <Field label="看誰會收到什麼">
            <select class="select" value={pick} onChange={(e) => setPick(Number((e.target as HTMLSelectElement).value))}>
              {msgs.map((x, i) => (
                <option key={i} value={i}>
                  {x.kind === 'remind'
                    ? `審核提醒（${MAIL_REMIND}）→ ${x.to}`
                    : x.kind === 'preview'
                      ? `預覽（${MAIL_PREVIEW}）→ ${x.to}`
                      : `${x.name ? `${x.name} ` : ''}${x.to}`}
                </option>
              ))}
            </select>
          </Field>
          {m && (
            <>
              <p class="small">
                <b>{m.subject}</b>
                <span class="muted">　{m.sent_at ? `已在 ${agoText(m.sent_at, Date.now())}寄出` : '還沒寄出'}</span>
              </p>
              <iframe class="mail-frame" title={`信件預覽：${m.subject}`} sandbox="" srcdoc={m.html} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RecipientForm({
  r,
  teachers,
  close,
  submit,
  remove,
}: {
  r: MailRecipient | null;
  teachers: Array<{ id: number; name: string }>;
  close: () => void;
  submit: Submit;
  remove: (r: MailRecipient) => Promise<boolean>;
}) {
  const [email, setEmail] = useState(r?.email ?? '');
  const [name, setName] = useState(r?.name ?? '');
  const [picked, setPicked] = useState<number[]>(r?.teachers ?? []);
  const [err, setErr] = useState<string | null>(null);
  const all = picked.length === 0;
  const toggle = (id: number) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const msg = await submit(
          'oh_admin_mail_save',
          { p_kind: 'recipient', p: { id: r?.id ?? null, email, name, teachers: picked.length >= teachers.length ? [] : picked } },
          r ? '已更新收件人' : '已新增收件人',
        );
        if (msg) setErr(msg);
        else close();
      }}
    >
      <h2>{r ? '編輯收件人' : '新增收件人'}</h2>
      <Field label="Email" error={err}>
        <input
          class="input"
          type="email"
          required
          autoComplete="off"
          maxLength={120}
          value={email}
          onInput={(e) => {
            setEmail((e.target as HTMLInputElement).value);
            setErr(null);
          }}
        />
      </Field>
      <Field label="稱呼" optional help="信的開頭會寫「○○ 您好」" count={name.length} max={40}>
        <input class="input" maxLength={40} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <fieldset class="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend class="label" style={{ padding: 0, marginBottom: '6px' }}>
          要收哪些老師的場次
        </legend>
        <label class="check">
          <input type="checkbox" checked={all} onChange={() => setPicked([])} />
          三位老師全部
        </label>
        {teachers.map((t) => (
          <label class="check" key={t.id}>
            <input type="checkbox" checked={!all && picked.includes(t.id)} onChange={() => toggle(t.id)} />
            只有 {t.name}
          </label>
        ))}
        <span class="help">勾一位老師時，信裡只有那位的場次，「一鍵加到 Google 日曆」也只訂閱那位的</span>
      </fieldset>
      <div class="actions">
        {r && (
          <button
            type="button"
            class="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              if (await remove(r)) close();
            }}
          >
            刪除
          </button>
        )}
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={!email.trim()}>
          儲存
        </button>
      </div>
    </form>
  );
}
