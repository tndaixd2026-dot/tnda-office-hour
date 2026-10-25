import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/engine';
import type { JoinResult, PeekResult, Settings } from '../api/types';
import { errorText } from '../app/messages';
import { go } from '../app/router';
import { signedIn, startDemo, useApp } from '../app/session';
import { APP_NAME, APP_SHORT_NAME, HAS_CLOUD, RECORDING_NOTE } from '../config';
import { closeRuleText, minutesText } from '../lib/format';
import { Icon } from '../ui/icons';
import { BrandMark, Btn, Field } from '../ui/kit';

const ROLE_TEXT = {
  teacher: '查看每位老師的 Office Hour 行程，以及每組事先寫好的題目與進度',
  admin: '管理預約需求、排程、小組代碼與所有設定',
};

function formatCode(v: string) {
  const c = v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  return c.length > 4 ? c.replace(/(.{4})(?=.)/g, '$1-') : c;
}

/** A clock face with a whole hour lit: one Office Hour a week. */
export function ClockArt() {
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <svg class="clockface" viewBox="0 0 400 400" aria-hidden="true">
      <circle cx="200" cy="200" r="166" class="orange" />
      <circle cx="200" cy="200" r="194" fill="none" stroke="currentColor" stroke-opacity="0.14" />
      {ticks.map((i) => {
        const a = (i / 60) * Math.PI * 2;
        const long = i % 5 === 0;
        const r1 = long ? 170 : 180;
        return (
          <line
            key={i}
            x1={200 + Math.sin(a) * r1}
            y1={200 - Math.cos(a) * r1}
            x2={200 + Math.sin(a) * 188}
            y2={200 - Math.cos(a) * 188}
            stroke="currentColor"
            stroke-opacity={long ? 0.75 : 0.28}
            stroke-width={long ? 3 : 1.4}
          />
        );
      })}
      <line x1="200" y1="200" x2="200" y2="58" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
      <line x1="200" y1="200" x2="200" y2="326" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
      <g class="sweep">
        <line x1="200" y1="226" x2="200" y2="44" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" />
      </g>
      <circle cx="200" cy="200" r="10" fill="currentColor" />
      <circle cx="200" cy="200" r="4" fill="var(--accent)" />
    </svg>
  );
}

export function Welcome({ initialCode }: { initialCode?: string }) {
  const { engine, demoLoading } = useApp();
  const [settings, setSettings] = useState<Settings | null>(null);
  // students and teachers sign in by name; invite links (and admins) use codes
  const [mode, setMode] = useState<'name' | 'code'>(initialCode ? 'code' : 'name');
  const [who, setWho] = useState('');
  const [code, setCode] = useState(formatCode(initialCode ?? ''));
  const [peek, setPeek] = useState<PeekResult | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const whoRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  function switchMode(m: 'name' | 'code') {
    setMode(m);
    setErr(null);
    setTimeout(() => (m === 'name' ? whoRef : codeRef).current?.focus(), 0);
  }

  async function login() {
    if (!engine) return;
    if (!who.trim()) {
      setErr('請輸入你的名字');
      whoRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await engine.call<JoinResult>('oh_login', { p_name: who.trim() });
      if (!r.ok) {
        setErr(errorText(new ApiError(r.error ?? 'NAME_UNKNOWN')));
        whoRef.current?.focus();
        return;
      }
      signedIn(r);
      go(r.session?.role === 'admin' ? 'admin' : '', { replace: true });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    engine
      ?.call<{ settings: Settings }>('oh_public')
      .then((r) => setSettings(r.settings))
      .catch(() => {});
  }, [engine]);

  useEffect(() => {
    if (initialCode && engine) check(formatCode(initialCode));
  }, [engine]);

  useEffect(() => {
    if (peek?.ok && peek.role === 'student') nameRef.current?.focus();
  }, [peek]);

  async function check(c = code) {
    if (!engine) return;
    const raw = c.replace(/-/g, '');
    if (raw.length < 8) {
      setErr('代碼是 8–12 個英數字');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await engine.call<PeekResult>('oh_peek', { p_code: raw });
      if (!r.ok) {
        setErr(errorText(new ApiError(r.error ?? 'CODE_INVALID')));
        codeRef.current?.focus();
      }
      setPeek(r.ok ? r : null);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!engine || !peek?.ok) return;
    if (peek.role === 'student' && !name.trim()) {
      setErr('請輸入你的名字');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await engine.call<JoinResult>('oh_join', { p_code: code.replace(/-/g, ''), p_name: name.trim() || null });
      if (!r.ok) {
        setErr(errorText(new ApiError(r.error ?? 'CODE_INVALID')));
        if (r.error === 'CODE_INVALID') setPeek(null);
        return;
      }
      signedIn(r);
      go(r.session?.role === 'admin' ? 'admin' : '', { replace: true });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const host = settings?.host_label || 'PM';

  const offline = (
    <div class="notice info">
      <Icon name="info" />
      <span>這個網站還沒有連接雲端資料庫。你可以先用示範模式看看完整功能</span>
    </div>
  );
  const deadline = settings ? closeRuleText(settings) : '截止時間';
  const slot = settings?.slot_minutes ?? 60;
  // how booking works, then a student-only demo to try it
  const demo = (
    <>
      <div class="divider" />
      <section class="stack tight" aria-labelledby="howto">
        <h2 id="howto" class="title-s">
          學生怎麼預約
        </h2>
        <ol class="howto">
          <li>輸入自己的名字登入，會自動進到你的組</li>
          <li>每組有固定的業師和時段，首頁會寫你們是星期幾、幾點</li>
          <li>在{deadline} 前決定那週要不要約。要約就按「預約這週」，寫好題目、想問 PM 的問題、目前進度和雲端連結，送出就排定</li>
          <li>不約就按「這週不約」，讓業師知道。時間到了，點首頁的 Google Meet 連結進去就好</li>
        </ol>
        <p class="tiny muted">
          每組每週一次，每次 {minutesText(slot)}。{RECORDING_NOTE}
        </p>
      </section>
      <div class="stack tight">
        <p class="small muted">{mode === 'name' ? '想先看看怎麼用？' : '還沒拿到代碼，或想先看看怎麼用？'}</p>
        <Btn icon="play" loading={demoLoading} onClick={() => startDemo('student', { studentOnly: true })}>
          試玩預約流程
        </Btn>
      </div>
    </>
  );

  return (
    <main class="welcome">
      <section class="welcome-art">
        <BrandMark />
        <ClockArt />
        <div class="stack loose" style={{ maxWidth: '520px' }}>
          {settings?.course_code && (
            <p class="eyebrow">
              {settings.course_code} · {settings.course_title}
            </p>
          )}
          <h1 class="title-xl">
            {APP_SHORT_NAME}
            <br />
            {APP_NAME.slice(APP_SHORT_NAME.length + 1)}
          </h1>
          <p class="lede">每組和業師有固定的一小時，每週決定要不要約。送出就排定，全組和業師的畫面同時更新，不用來回傳訊息</p>
        </div>
      </section>

      <section class="welcome-main">
        <div class="welcome-card enter">
          {!peek?.ok && mode === 'name' ? (
            <form
              class="stack loose"
              onSubmit={(e) => {
                e.preventDefault();
                login();
              }}
            >
              <div class="stack tight">
                <h2 class="title-l">輸入你的名字</h2>
                <p class="muted">學生、老師和助教輸入名字就能登入</p>
              </div>
              {HAS_CLOUD ? (
                <>
                  <Field label="名字" error={err}>
                    <input
                      ref={whoRef}
                      class="input"
                      value={who}
                      maxLength={40}
                      autoComplete="name"
                      placeholder="例：林小晴"
                      onInput={(e) => {
                        setWho((e.target as HTMLInputElement).value);
                        setErr(null);
                      }}
                    />
                  </Field>
                  <Btn type="submit" variant="primary" size="lg" block loading={busy}>
                    登入
                  </Btn>
                  <button type="button" class="link-btn small" style={{ justifySelf: 'start' }} onClick={() => switchMode('code')}>
                    我有邀請代碼
                  </button>
                </>
              ) : (
                offline
              )}
              {demo}
            </form>
          ) : !peek?.ok ? (
            <form
              class="stack loose"
              onSubmit={(e) => {
                e.preventDefault();
                check();
              }}
            >
              <div class="stack tight">
                <h2 class="title-l">輸入邀請代碼</h2>
                <p class="muted">代碼由助教提供，點邀請連結會自動帶入</p>
              </div>
              {HAS_CLOUD ? (
                <>
                  <Field label="邀請代碼" error={err}>
                    <input
                      ref={codeRef}
                      class="input code"
                      value={code}
                      inputMode="text"
                      autoComplete="one-time-code"
                      autoCapitalize="characters"
                      spellcheck={false}
                      placeholder="XXXX-XXXX"
                      maxLength={14}
                      onInput={(e) => {
                        setCode(formatCode((e.target as HTMLInputElement).value));
                        setErr(null);
                      }}
                    />
                  </Field>
                  <Btn type="submit" variant="primary" size="lg" block loading={busy}>
                    繼續
                  </Btn>
                  <button type="button" class="link-btn small" style={{ justifySelf: 'start' }} onClick={() => switchMode('name')}>
                    改用名字登入
                  </button>
                </>
              ) : (
                offline
              )}
              {demo}
            </form>
          ) : (
            <form
              class="stack loose"
              onSubmit={(e) => {
                e.preventDefault();
                join();
              }}
            >
              {peek.role === 'student' ? (
                <>
                  <div class="stack">
                    <span class="gno lg">{peek.group?.no}</span>
                    <div class="stack tight">
                      <p class="eyebrow">你要加入</p>
                      <h2 class="title-l">
                        第 {peek.group?.no} 組{peek.group?.name ? `「${peek.group.name}」` : ''}
                      </h2>
                    </div>
                  </div>
                  <Field label="你的名字" help="讓組員和助教知道需求是誰填的" error={err}>
                    <input
                      ref={nameRef}
                      class="input"
                      value={name}
                      maxLength={20}
                      autoComplete="name"
                      placeholder="例：林小晴"
                      onInput={(e) => {
                        setName((e.target as HTMLInputElement).value);
                        setErr(null);
                      }}
                    />
                  </Field>
                  <Btn type="submit" variant="primary" size="lg" block loading={busy}>
                    加入小組
                  </Btn>
                </>
              ) : (
                <>
                  <div class="stack tight">
                    <p class="eyebrow">{peek.role === 'teacher' ? host : '助教'}</p>
                    <h2 class="title-l">歡迎，{peek.name}</h2>
                    <p class="muted">{ROLE_TEXT[peek.role as 'teacher' | 'admin']}</p>
                  </div>
                  {err && <p class="small" style={{ color: 'var(--danger)' }}>{err}</p>}
                  <Btn type="submit" variant="primary" size="lg" block loading={busy}>
                    進入
                  </Btn>
                </>
              )}
              <button
                type="button"
                class="link-btn small"
                style={{ justifySelf: 'start' }}
                onClick={() => {
                  setPeek(null);
                  setErr(null);
                  setTimeout(() => codeRef.current?.focus(), 0);
                }}
              >
                換一個代碼
              </button>
            </form>
          )}
          <p class="tiny faint">
            我們只記錄你的名字與組別，用來顯示誰填寫了需求。登入資訊只存在這台裝置上
          </p>
          <div class="divider" />
          <p class="small muted">
            找 TD 專班的課？<a href="#/td">查看 TD 專班課表</a>，不用登入
          </p>
        </div>
      </section>
    </main>
  );
}
