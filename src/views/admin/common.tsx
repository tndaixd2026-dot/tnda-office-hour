import type { ActivityEvent } from '../../api/types';
import { md } from '../../lib/time';

export function groupName(groups: Array<{ id: number; no: number; name: string }>, id: number | null): string {
  const g = groups.find((x) => x.id === id);
  if (!g) return '某組';
  return g.name ? `第 ${g.no} 組「${g.name}」` : `第 ${g.no} 組`;
}

export function eventText(e: ActivityEvent, groups: Array<{ id: number; no: number; name: string }>): string {
  const who = e.name ?? '有人';
  const g = groupName(groups, e.group_id);
  const d = e.data ?? {};
  const at = d.d && d.t ? ` ${md(d.d)} ${d.t}` : '';
  switch (e.kind) {
    case 'member.joined':
      return e.role === 'student' ? `${who} 加入了${g}` : `${who} 登入了`;
    case 'request.created':
      return `${who} 幫${g}預約了「${d.topic ?? ''}」`;
    case 'request.updated':
      return `${who} 更新了${g}的預約`;
    case 'request.skipped':
      return `${who} 決定${g}這週不約`;
    case 'request.withdrawn':
      return `${who} 撤回了${g}的需求`;
    case 'appt.drafted':
      return `${who} 為${g}排了${at}（草稿）`;
    case 'appt.undrafted':
      return `${who} 移除了${g}${at} 的草稿`;
    case 'appt.moved':
      return `${who} 把${g}改到${at}`;
    case 'appt.autofilled':
      return `${who} 用閃身步排程法建立了 ${d.count} 筆草稿`;
    case 'appt.published':
      return `${who} 發布了 ${d.count} 筆排程`;
    case 'appt.discarded':
      return `${who} 清除了 ${d.count} 筆草稿`;
    case 'appt.cancelled':
      return `${who} 取消了${g}${at}${d.reason ? `（${d.reason}）` : ''}`;
    case 'config.settings':
      return `${who} 修改了課程設定`;
    case 'config.group':
      return `${who} 修改了${g}`;
    case 'config.group.rotated':
      return `${who} 更換了${g}的邀請代碼`;
    case 'config.group.roster':
      return `${who} 更新了${g}的學生名單`;
    case 'config.lesson':
      return `${who} 修改了 TD 課表 ${d.label ?? ''}`;
    case 'config.lesson.deleted':
      return `${who} 刪除了 TD 課表 ${d.label ?? ''}`;
    case 'config.lessons.info':
      return `${who} 修改了 TD 課表的頁面資訊`;
    case 'config.lessons.imported':
      return `${who} 匯入了 TD 課表（${d.count} 堂）`;
    default:
      if (e.kind.startsWith('config.')) return `${who} 修改了${e.kind.includes('teacher') ? '老師' : e.kind.includes('block') ? '開放時段' : e.kind.includes('closure') ? '休息日' : e.kind.includes('week') ? '週次' : e.kind.includes('admin') ? '助教' : '設定'}`;
      return `${who} ${e.kind}`;
  }
}

export function eventClass(kind: string): string {
  if (kind === 'appt.cancelled' || kind === 'request.withdrawn' || kind === 'request.skipped') return 'k-cancel';
  if (kind.startsWith('request.')) return 'k-request';
  if (kind.startsWith('appt.')) return 'k-appt';
  return '';
}

export const siteUrl = () => `${location.origin}${location.pathname}`;
