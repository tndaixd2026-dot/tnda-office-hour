import type { ComponentChildren } from 'preact';
import { useEffect, useErrorBoundary } from 'preact/hooks';
import type { Role } from './api/types';
import { go, route } from './app/router';
import { exitDemo, resetDemo, signOut, startDemo, switchDemoRole, useApp, verifySession } from './app/session';
import { confirm, Dialogs } from './ui/dialog';
import { Icon } from './ui/icons';
import { Btn, Seg } from './ui/kit';
import { Toasts } from './ui/toast';
import { AdminApp } from './views/admin/AdminApp';
import { LessonsPage } from './views/lessons/LessonsPage';
import { StudentApp } from './views/student/StudentApp';
import { TeacherApp } from './views/teacher/TeacherApp';
import { Welcome } from './views/Welcome';

function DemoBar() {
  const { demo } = useApp();
  if (!demo) return null;
  return (
    <div class="demobar" role="region" aria-label="示範模式">
      <span class="row" style={{ gap: '6px' }}>
        <Icon name="play" size={14} />
        示範模式
      </span>
      {demo.studentOnly ? (
        <span class="tiny" style={{ opacity: 0.85 }}>
          以學生身份試玩
        </span>
      ) : (
        <Seg<Role>
          label="切換身份"
          value={demo.role}
          onChange={(r) => switchDemoRole(r)}
          options={[
            { value: 'student', label: '學生' },
            { value: 'admin', label: '助教' },
            { value: 'teacher', label: '老師' },
          ]}
        />
      )}
      <span class="grow" />
      <span class="tiny" style={{ opacity: 0.85 }}>
        資料只存在這個分頁
      </span>
      <Btn size="sm" icon="rotate" onClick={resetDemo}>
        重設
      </Btn>
      <Btn size="sm" icon="door" onClick={exitDemo}>
        離開
      </Btn>
    </div>
  );
}

/** A bug in one screen should never leave a blank page. */
function Guard({ children, reset }: { children: ComponentChildren; reset: string }) {
  const [error, retry] = useErrorBoundary((e) => console.error(e));
  useEffect(() => {
    if (error) retry();
  }, [reset]);
  if (!error) return <>{children}</>;
  return (
    <div class="center-screen">
      <div class="stack" style={{ justifyItems: 'center', maxWidth: '380px' }}>
        <span class="brand-mark" aria-hidden="true">
          OH
        </span>
        <p class="title-m">這個畫面出了點問題</p>
        <p class="small muted">資料都還在。重新整理通常就能解決；如果一直發生，請截圖給助教</p>
        <div class="row">
          <Btn variant="primary" icon="rotate" onClick={() => location.reload()}>
            重新整理
          </Btn>
          <Btn onClick={() => retry()}>再試一次</Btn>
        </div>
      </div>
    </div>
  );
}

function DemoLoading({ progress }: { progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div class="center-screen">
      <div class="stack" style={{ justifyItems: 'center', width: 'min(320px, 100%)' }}>
        <span class="brand-mark" aria-hidden="true">
          OH
        </span>
        <p class="title-s">正在啟動示範模式</p>
        <p class="small muted">
          {progress < 1 ? `下載資料庫引擎 ${pct}%` : '建立示範資料…'}
        </p>
        <div class="meter" style={{ width: '100%' }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="示範模式載入進度">
          <i style={{ width: `${Math.max(4, pct)}%`, background: 'var(--accent)', transition: 'width .2s' }} />
        </div>
        <p class="tiny faint" style={{ textAlign: 'center' }}>
          一個完整的 Postgres 資料庫會在你的瀏覽器裡執行，第一次約需下載 5 MB
        </p>
      </div>
    </div>
  );
}

export function App() {
  const { auth, demo, demoLoading, demoProgress } = useApp();
  const r = route.use();

  useEffect(() => {
    verifySession();
  }, []);

  // #/demo opens the sandbox directly (handy for judges and screenshots)
  useEffect(() => {
    if (r[0] === 'demo' && !demo && !demoLoading) {
      const role = (['student', 'admin', 'teacher'] as Role[]).includes(r[1] as Role) ? (r[1] as Role) : 'student';
      startDemo(role);
    }
  }, [r[0], r[1]]);

  // a join link while already signed in
  useEffect(() => {
    if (r[0] !== 'join' || !auth || demo) return;
    confirm({
      title: '要切換身份嗎？',
      body: `這台裝置目前以「${auth.session.name}」登入。要登出並使用新的邀請連結嗎？`,
      ok: '登出並切換',
    }).then(async (ok) => {
      const code = r[1];
      if (ok) {
        await signOut();
        go(`join/${code}`, { replace: true });
      } else {
        go('', { replace: true });
      }
    });
  }, [r[0], auth?.token]);

  let body;
  if (demoLoading || (r[0] === 'demo' && !demo)) {
    body = <DemoLoading progress={demoProgress} />;
  } else if (r[0] === 'td') {
    // the TD 專班 timetable is public: no sign-in needed
    body = <LessonsPage who={r[1]} />;
  } else if (!auth) {
    body = <Welcome key={r[1] ?? ''} initialCode={r[0] === 'join' ? r[1] : undefined} />;
  } else if (auth.session.role === 'admin') {
    body = <AdminApp route={r[0] === 'admin' ? r : ['admin']} />;
  } else if (auth.session.role === 'teacher') {
    body = <TeacherApp />;
  } else {
    body = <StudentApp route={r} />;
  }

  return (
    <>
      <DemoBar />
      <Guard reset={r.join('/') + (auth?.token ?? '')}>{body}</Guard>
      <Toasts />
      <Dialogs />
    </>
  );
}
