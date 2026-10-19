import { useEffect, useState } from 'preact/hooks';
import { href } from '../../app/router';
import { signOut, useApp } from '../../app/session';
import { confirm } from '../../ui/dialog';
import { Icon, type IconName } from '../../ui/icons';
import { BrandMark, Btn, LiveBadge } from '../../ui/kit';
import { Board } from './Board';
import { CalendarPage } from './CalendarPage';
import { LessonsAdmin } from './LessonsAdmin';
import { GroupsPage, TeachersPage } from './People';
import { Overview } from './Overview';
import { SettingsPage } from './SettingsPage';

const NAV: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'board', label: '排程', icon: 'board' },
  { id: 'overview', label: '總覽與紀錄', icon: 'chart' },
  { id: 'groups', label: '小組與邀請', icon: 'users' },
  { id: 'teachers', label: '老師', icon: 'user' },
  { id: 'calendar', label: '時段與週次', icon: 'calendar' },
  { id: 'td', label: 'TD 課表', icon: 'layers' },
  { id: 'settings', label: '設定', icon: 'settings' },
];

export function AdminApp({ route }: { route: string[] }) {
  const { auth } = useApp();
  const section = NAV.some((n) => n.id === route[1]) ? route[1] : 'board';
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route.join('/')]);

  let body;
  switch (section) {
    case 'overview':
      body = <Overview />;
      break;
    case 'groups':
      body = <GroupsPage />;
      break;
    case 'teachers':
      body = <TeachersPage />;
      break;
    case 'calendar':
      body = <CalendarPage />;
      break;
    case 'settings':
      body = <SettingsPage />;
      break;
    case 'td':
      body = <LessonsAdmin />;
      break;
    default:
      body = <Board weekParam={route[1] === 'board' && route[2] ? Number(route[2]) || null : null} />;
  }

  return (
    <div class="admin">
      <aside class={`side ${open ? 'open' : ''}`} aria-label="管理選單">
        <BrandMark sub="助教後台" />
        <nav>
          {NAV.map((n) => (
            <a key={n.id} class="nav-a" href={href(n.id === 'board' ? 'admin' : `admin/${n.id}`)} aria-current={section === n.id ? 'page' : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </a>
          ))}
        </nav>
        <div class="foot">
          <LiveBadge />
          <div class="row between">
            <span class="row" style={{ gap: '6px' }}>
              <Icon name="user" size={16} />
              {auth?.session.name}
            </span>
            <Btn
              size="sm"
              variant="ghost"
              icon="logout"
              aria-label="登出"
              onClick={async () => {
                if (await confirm({ title: '登出這台裝置？', body: '之後需要重新輸入名字或代碼才能回來', ok: '登出', danger: true })) signOut();
              }}
            />
          </div>
        </div>
      </aside>
      {open && <div class="side-scrim" onClick={() => setOpen(false)} />}
      <div class="admin-main">
        <header class="topbar admin-top">
          <div class="topbar-inner">
            <Btn variant="ghost" icon="menu" aria-label="打開選單" onClick={() => setOpen(true)} />
            <BrandMark sub="助教後台" />
            <span class="grow" />
            <LiveBadge />
          </div>
        </header>
        {body}
      </div>
    </div>
  );
}
