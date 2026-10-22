import { useState } from 'preact/hooks';
import type { AdminConfig, ConfigGroup, ConfigTeacher } from '../../api/types';
import { useApi, useBusy, useLive, useTick } from '../../app/hooks';
import { agoText } from '../../lib/time';
import { ask, confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, Field, Loading, Menu, QR, Switch, copyText } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { ErrorState } from '../student/StudentApp';
import { siteUrl } from './common';

export const inviteLink = (code: string) => `${siteUrl()}#/join/${code}`;
export const prettyCode = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-');

function useConfig() {
  return useLive<AdminConfig>('oh_admin_config', {});
}

async function rotateFlow(kind: 'group' | 'teacher' | 'admin', label: string, run: ReturnType<typeof useBusy>['run'], call: ReturnType<typeof useApi>['call'], id: number) {
  const choice = await openDialog<'keep' | 'revoke'>('更換代碼', (close) => (
    <>
      <h2>更換{label}的代碼？</h2>
      <p class="muted small">舊代碼和舊的邀請連結會立刻失效。已經登入的裝置要不要一起登出？</p>
      <div class="actions">
        <button type="button" class="btn" onClick={() => close()}>
          取消
        </button>
        <button type="button" class="btn" onClick={() => close('keep')}>
          更換，保留已登入裝置
        </button>
        <button type="button" class="btn danger" onClick={() => close('revoke')}>
          更換並全部登出
        </button>
      </div>
    </>
  ));
  if (!choice) return null;
  return run('rotate', () => call<{ code: string; revoked: number }>('oh_admin_rotate', { p_kind: kind, p_id: id, p_revoke: choice === 'revoke' }), {
    ok: choice === 'revoke' ? '已更換代碼，並登出所有裝置' : '已更換代碼',
  });
}

export function GroupsPage() {
  const { data: cfg, error, reload } = useConfig();
  const { call } = useApi();
  const { busy, run } = useBusy();
  const now = useTick();
  if (!cfg) return error ? <ErrorState onRetry={reload} /> : <Loading />;

  const save = async (p: Record<string, unknown>, ok?: string) => {
    const r = await run('save', () => call('oh_admin_save', { p_kind: 'group', p }), { ok });
    reload();
    return r;
  };

  const add = async () => {
    const name = await ask({ title: '新增小組', label: '組名', placeholder: '可以之後再改', optional: true, maxLength: 40, ok: '新增' });
    if (name === null) return;
    await save({ name }, '已新增小組');
  };

  const wall = () =>
    openDialog(
      '所有小組的邀請 QR Code',
      (close) => (
        <>
          <div class="row between no-print">
            <h2>邀請 QR Code</h2>
            <div class="row">
              <Btn icon="print" onClick={() => window.print()}>
                列印
              </Btn>
              <Btn variant="primary" onClick={() => close()}>
                關閉
              </Btn>
            </div>
          </div>
          <p class="muted small no-print">可以直接投影在教室，各組用手機掃描自己的 QR Code 加入</p>
          <div class="qr-wall">
            {cfg.groups
              .filter((g) => g.active)
              .map((g) => (
                <div class="card" key={g.id}>
                  <div class="row" style={{ justifyContent: 'center' }}>
                    <span class="gno">{g.no}</span>
                    <b>{g.name || `第 ${g.no} 組`}</b>
                  </div>
                  <QR text={inviteLink(g.code)} label={`第 ${g.no} 組邀請 QR Code`} />
                  <span class="mono" style={{ letterSpacing: '0.1em' }}>
                    {prettyCode(g.code)}
                  </span>
                </div>
              ))}
          </div>
        </>
      ),
      { wide: 'xwide' },
    );

  return (
    <main class="page enter">
      <div class="row between wrap">
        <div class="stack tight">
          <p class="eyebrow">小組與邀請</p>
          <h1 class="title-l">{cfg.groups.length} 個小組</h1>
          <p class="muted small" style={{ maxWidth: '560px' }}>
            在每組的「學生名單」填上同學的名字，同學到首頁輸入自己的名字就能登入；也可以把邀請連結貼到各組的 Discord，點開、輸入名字加入。整組共用同一份預約。每組可以搭配一到兩位老師，隨時都能改
          </p>
        </div>
        <div class="row wrap">
          <Btn icon="qr" onClick={wall}>
            投影邀請 QR
          </Btn>
          <Btn variant="primary" icon="plus" loading={busy === 'save'} onClick={add}>
            新增小組
          </Btn>
        </div>
      </div>
      <div class="group-grid">
        {cfg.groups.map((g) => (
          <GroupCard key={g.id} g={g} teachers={cfg.teachers.filter((t) => !t.team && (t.active || g.teacher_ids.includes(t.id)))} now={now} save={save} reload={reload} />
        ))}
      </div>
    </main>
  );
}

function GroupCard({
  g,
  teachers,
  now,
  save,
  reload,
}: {
  g: ConfigGroup;
  teachers: ConfigTeacher[];
  now: number;
  save: (p: Record<string, unknown>, ok?: string) => Promise<unknown>;
  reload: () => void;
}) {
  const { call } = useApi();
  const { busy, run } = useBusy();
  const link = inviteLink(g.code);
  const pairs = teachers.filter((t) => g.teacher_ids.includes(t.id));
  const names = (ts: ConfigTeacher[]) => ts.map((t) => t.name).join('、');
  const togglePair = (t: ConfigTeacher, on: boolean) => {
    const next = teachers.filter((x) => (x.id === t.id ? on : g.teacher_ids.includes(x.id)));
    save({ id: g.id, teacher_ids: next.map((x) => x.id) }, next.length ? `第 ${g.no} 組改成搭配 ${names(next)}` : `第 ${g.no} 組改成不指定老師`);
  };

  const editRoster = async () => {
    let text = g.roster.join('\n');
    // reopen with what was typed if saving fails (e.g. a name already used elsewhere)
    for (;;) {
      const v = await ask({
        title: `第 ${g.no} 組的學生名單`,
        body: '一行一個名字。同學在首頁輸入一樣的名字，就能直接登入這組（不分大小寫、忽略空格）。名字不能和其他組或老師重複',
        label: '學生名單',
        placeholder: '林小晴\n王大明',
        initial: text,
        multiline: true,
        optional: true,
        ok: '儲存',
      });
      if (v === null) return;
      text = v;
      const r = await run('roster', () => call('oh_admin_roster', { p_group: g.id, p_names: v.split('\n') }), { ok: '已更新學生名單' });
      reload();
      if (r) return;
    }
  };
  return (
    <div class={`card stack ${g.active ? '' : 'inactive'}`}>
      <div class="row between">
        <span class="row" style={{ gap: '10px' }}>
          <span class="gno lg">{g.no}</span>
          <b>{g.name || <span class="muted">未命名</span>}</b>
        </span>
        <Menu label={`第 ${g.no} 組選單`} trigger={<Icon name="more" />}>
          {(close) => (
            <>
              <button
                type="button"
                class="mi"
                role="menuitem"
                onClick={async () => {
                  close();
                  const name = await ask({ title: `第 ${g.no} 組的組名`, label: '組名', initial: g.name, optional: true, maxLength: 40, ok: '儲存' });
                  if (name !== null) save({ id: g.id, name }, '已更新');
                }}
              >
                <Icon name="edit" /> 修改組名
              </button>
              <button
                type="button"
                class="mi"
                role="menuitem"
                onClick={async () => {
                  close();
                  const v = await ask({ title: '修改組別編號', label: '編號（1–999）', initial: String(g.no), maxLength: 3, ok: '儲存' });
                  if (v === null) return;
                  const n = Number(v);
                  if (!Number.isInteger(n) || n < 1 || n > 999) return;
                  save({ id: g.id, no: n }, '已更新編號');
                }}
              >
                <Icon name="layers" /> 修改編號
              </button>
              <button
                type="button"
                class="mi"
                role="menuitem"
                onClick={async () => {
                  close();
                  await rotateFlow('group', `第 ${g.no} 組`, run, call, g.id);
                  reload();
                }}
              >
                <Icon name="rotate" /> 更換邀請代碼
              </button>
              {!g.used && (
                <button
                  type="button"
                  class="mi danger"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    if (!(await confirm({ title: `刪除第 ${g.no} 組？`, body: '這組還沒有任何預約紀錄，刪除後無法復原', ok: '刪除', danger: true }))) return;
                    await run('del', () => call('oh_admin_delete', { p_kind: 'group', p_id: g.id }), { ok: '已刪除' });
                    reload();
                  }}
                >
                  <Icon name="trash" /> 刪除小組
                </button>
              )}
            </>
          )}
        </Menu>
      </div>
      <fieldset class="field pairs">
        <legend class="label">搭配老師（最多兩位）</legend>
        <div class="row wrap">
          {teachers.map((t) => {
            const on = g.teacher_ids.includes(t.id);
            return (
              <label class="check" key={t.id}>
                <input type="checkbox" checked={on} disabled={!on && pairs.length >= 2} onChange={() => togglePair(t, !on)} />
                {t.name}
                {t.active ? '' : '（停用中）'}
              </label>
            );
          })}
        </div>
        <span class="help">{pairs.length ? `只會排到 ${names(pairs)} 的時段，學生也只看得到這些時段` : '都不勾時，所有老師的時段都可以排'}</span>
      </fieldset>
      <div class="card sunk tight stack tight">
        <span class="eyebrow">邀請代碼</span>
        <span class="mono" style={{ fontSize: '19px', letterSpacing: '0.12em', fontWeight: 500 }}>
          {prettyCode(g.code)}
        </span>
        <span class="row">
          <Btn size="sm" icon="copy" onClick={() => copyText(link, '已複製邀請連結')}>
            邀請連結
          </Btn>
          <Btn
            size="sm"
            icon="qr"
            aria-label="顯示 QR Code"
            onClick={() =>
              openDialog('邀請 QR Code', (close) => (
                <>
                  <h2>
                    第 {g.no} 組{g.name ? `「${g.name}」` : ''}
                  </h2>
                  <QR text={link} label="邀請 QR Code" />
                  <p class="mono small" style={{ wordBreak: 'break-all' }}>
                    {link}
                  </p>
                  <div class="actions">
                    <CopyBtn text={link} label="複製連結" />
                    <button type="button" class="btn primary" onClick={() => close()}>
                      完成
                    </button>
                  </div>
                </>
              ))
            }
          />
        </span>
      </div>
      <div class="stack tight">
        <div class="row between">
          <span class="eyebrow">學生名單 {g.roster.length} 人</span>
          <Btn size="sm" variant="ghost" icon="edit" loading={busy === 'roster'} onClick={editRoster} aria-label={`編輯第 ${g.no} 組的學生名單`}>
            編輯
          </Btn>
        </div>
        {g.roster.length ? (
          <div class="row wrap">
            {g.roster.map((n) => (
              <span key={n} class="chip outline">
                {n}
              </span>
            ))}
          </div>
        ) : (
          <span class="small muted">還沒有名單。加入名字後，同學在首頁輸入名字就能登入這組</span>
        )}
      </div>
      <div class="stack tight">
        <span class="eyebrow">已登入 {g.members.length} 人</span>
        {g.members.length ? (
          <div class="row wrap">
            {g.members.map((m) => (
              <button
                type="button"
                key={m.id}
                class="chip outline"
                style={{ cursor: 'pointer' }}
                title={`加入於 ${agoText(m.created_at, now)}，最近 ${agoText(m.seen_at, now)}使用`}
                onClick={async () => {
                  if (!(await confirm({ title: `讓「${m.name}」登出？`, body: '這台裝置之後需要重新登入。適合用在有人換手機、或填錯組的時候', ok: '登出這個裝置', danger: true }))) return;
                  await run('revoke', () => call('oh_admin_delete', { p_kind: 'session', p_id: m.id }), { ok: '已登出' });
                  reload();
                }}
              >
                {m.name}
                <Icon name="x" size={12} />
              </button>
            ))}
          </div>
        ) : (
          <span class="small muted">還沒有人登入</span>
        )}
      </div>
      <DiscordRow g={g} save={save} />
      <Switch checked={g.active} onChange={(v) => save({ id: g.id, active: v }, v ? '已啟用' : '已停用，這組的成員會被登出')} label={g.active ? '啟用中' : '已停用'} />
    </div>
  );
}

const HOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

function DiscordRow({ g, save }: { g: ConfigGroup; save: (p: Record<string, unknown>, ok?: string) => Promise<unknown> }) {
  const { call } = useApi();
  const { busy, run } = useBusy();

  const link = () =>
    openDialog('連結 Discord 頻道', (close) => <WebhookForm g={g} close={close} save={save} />);

  const test = async () => {
    const r = await run('test', () => call<{ request_id: number | null; available: boolean }>('oh_admin_webhook_test', { p_group: g.id }));
    if (!r) return;
    if (!r.available || !r.request_id) {
      toast('這個環境不會真的傳送 Discord 訊息（示範模式）');
      return;
    }
    toast('已送出測試訊息，確認中…');
    for (const wait of [1500, 2500, 4000]) {
      await new Promise((res) => setTimeout(res, wait));
      const s = await call<{ state: string; code?: number }>('oh_admin_webhook_status', { p_request: r.request_id }).catch(() => null);
      if (!s || s.state === 'pending') continue;
      if (s.state === 'ok') toast(`Discord 已收到：第 ${g.no} 組的頻道會收到通知`, { ms: 5000 });
      else
        toast(
          s.code === 404 || s.code === 401
            ? '這個 Webhook 已失效，請在 Discord 重新建立後再貼上'
            : `Discord 沒有收到（狀態碼 ${s.code ?? '未知'}），請檢查 Webhook`,
          { kind: 'error', ms: 8000 },
        );
      return;
    }
    toast('Discord 還沒回應，請稍後到頻道確認是否收到測試訊息');
  };

  return (
    <div class="row between wrap" style={{ gap: '8px' }}>
      <span class="row small" style={{ gap: '6px' }}>
        <Icon name="chat" size={16} />
        {g.webhook ? (
          <span class="chip ok">
            <span class="dot" />
            Discord 自動通知
          </span>
        ) : (
          <span class="muted">Discord 未連結</span>
        )}
      </span>
      <span class="row" style={{ gap: '6px' }}>
        {g.webhook && (
          <Btn size="sm" variant="ghost" loading={busy === 'test'} onClick={test}>
            傳送測試
          </Btn>
        )}
        <Btn size="sm" variant={g.webhook ? 'ghost' : undefined} onClick={link}>
          {g.webhook ? '更改' : '連結頻道'}
        </Btn>
      </span>
    </div>
  );
}

function WebhookForm({ g, close, save }: { g: ConfigGroup; close: () => void; save: (p: Record<string, unknown>, ok?: string) => Promise<unknown> }) {
  const [url, setUrl] = useState(g.webhook ?? '');
  const v = url.trim();
  const bad = v !== '' && !HOOK_RE.test(v);
  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (bad) return;
        const r = await save({ id: g.id, webhook: v || null }, v ? '已連結 Discord，之後的排程會自動通知' : '已取消 Discord 連結');
        if (r) close();
      }}
    >
      <h2>
        第 {g.no} 組的 Discord 通知
      </h2>
      <ol class="small muted" style={{ margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' }}>
        <li>在 Discord 對這組的頻道按「編輯頻道」→「整合」→「Webhook」</li>
        <li>按「新 Webhook」，再按「複製 Webhook 網址」</li>
        <li>貼到下面。之後時間確定、異動或取消時，這個頻道會自動收到訊息</li>
      </ol>
      <Field label="Webhook 網址" error={bad ? '這不是 Discord 的 Webhook 網址' : null} help="只有助教看得到這個網址">
        <input
          class="input mono"
          style={{ fontSize: '13px' }}
          value={url}
          placeholder="https://discord.com/api/webhooks/…"
          spellcheck={false}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
        />
      </Field>
      <div class="actions">
        {g.webhook && (
          <button type="button" class="btn danger" onClick={() => setUrl('')}>
            清除
          </button>
        )}
        <button type="button" class="btn" onClick={close}>
          取消
        </button>
        <button type="submit" class="btn primary" disabled={bad}>
          儲存
        </button>
      </div>
    </form>
  );
}

export function TeachersPage() {
  const { data: cfg, error, reload } = useConfig();
  const { call } = useApi();
  const { busy, run } = useBusy();
  if (!cfg) return error ? <ErrorState onRetry={reload} /> : <Loading />;
  const host = cfg.settings.host_label;

  const save = async (p: Record<string, unknown>, ok?: string) => {
    await run('save', () => call('oh_admin_save', { p_kind: 'teacher', p }), { ok });
    reload();
  };

  return (
    <main class="page enter">
      <div class="row between wrap">
        <div class="stack tight">
          <p class="eyebrow">老師</p>
          <h1 class="title-l">{host}</h1>
          <p class="muted small" style={{ maxWidth: '560px' }}>
            老師到首頁輸入自己的名字就能登入，或打開專屬連結。每位老師看到的都是同一個畫面：三位老師這週和下週的全部場次、各組題目與進度，自己的會標出來。老師不需要做任何設定
          </p>
        </div>
        <Btn
          variant="primary"
          icon="plus"
          loading={busy === 'save'}
          onClick={async () => {
            const name = await ask({ title: `新增${host}`, label: '名字', maxLength: 40, ok: '新增' });
            if (name) save({ name }, '已新增。記得到「時段與週次」設定開放時段');
          }}
        >
          新增老師
        </Btn>
      </div>
      {cfg.teachers.filter((t) => !t.team).length === 0 ? (
        <Empty icon="user" title="還沒有老師" />
      ) : (
        <div class="list">
          {cfg.teachers
            .filter((t) => !t.team)
            .map((t) => (
              <TeacherRow key={t.id} t={t} save={save} reload={reload} />
            ))}
        </div>
      )}
      {cfg.teachers.some((t) => t.team) && (
        <section class="section" aria-labelledby="t-shared">
          <div class="section-head">
            <h2 id="t-shared">共用帳號</h2>
          </div>
          <p class="muted small" style={{ maxWidth: '600px' }}>
            給業師公司或老師助理用：輸入這個名字或打開專屬連結就能登入，看到的是同一個畫面，不會被排進任何場次。訂閱行事曆會包含三位老師的全部場次
          </p>
          <div class="list">
            {cfg.teachers
              .filter((t) => t.team)
              .map((t) => (
                <TeacherRow key={t.id} t={t} save={save} reload={reload} />
              ))}
          </div>
        </section>
      )}
    </main>
  );
}

function TeacherRow({ t, save, reload }: { t: ConfigTeacher; save: (p: Record<string, unknown>, ok?: string) => Promise<void>; reload: () => void }) {
  const { call } = useApi();
  const { run } = useBusy();
  const link = inviteLink(t.code);
  return (
    <div class={`li ${t.active ? '' : 'inactive'}`} style={{ flexWrap: 'wrap' }}>
      <div class="grow stack" style={{ gap: '2px', minWidth: '160px' }}>
        <b>{t.name}</b>
        <span class="tiny muted">{t.devices ? `${t.devices} 台裝置登入中` : '還沒有登入'}</span>
      </div>
      <span class="mono small" style={{ letterSpacing: '0.08em' }}>
        {prettyCode(t.code)}
      </span>
      <Btn size="sm" icon="copy" onClick={() => copyText(link, `已複製 ${t.name} 的專屬連結`)}>
        專屬連結
      </Btn>
      <Switch checked={t.active} name={`${t.name} 啟用中`} onChange={(v) => save({ id: t.id, active: v }, v ? '已啟用' : '已停用：這位老師的時段不再開放')} label="" />
      <Menu label={`${t.name} 選單`} trigger={<Icon name="more" />}>
        {(close) => (
          <>
            <button
              type="button"
              class="mi"
              role="menuitem"
              onClick={async () => {
                close();
                const name = await ask({ title: '修改名字', label: '名字', initial: t.name, maxLength: 40, ok: '儲存' });
                if (name) save({ id: t.id, name }, '已更新');
              }}
            >
              <Icon name="edit" /> 修改名字
            </button>
            <button
              type="button"
              class="mi"
              role="menuitem"
              onClick={async () => {
                close();
                await rotateFlow('teacher', t.name, run, call, t.id);
                reload();
              }}
            >
              <Icon name="rotate" /> 更換代碼
            </button>
            {!t.used && (
              <button
                type="button"
                class="mi danger"
                role="menuitem"
                onClick={async () => {
                  close();
                  if (!(await confirm({ title: `刪除 ${t.name}？`, body: '會一併刪除這位老師的開放時段', ok: '刪除', danger: true }))) return;
                  await run('del', () => call('oh_admin_delete', { p_kind: 'teacher', p_id: t.id }), { ok: '已刪除' });
                  reload();
                }}
              >
                <Icon name="trash" /> 刪除
              </button>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}

export { rotateFlow };
