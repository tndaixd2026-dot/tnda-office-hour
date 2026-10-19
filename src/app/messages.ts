import { ApiError } from '../api/engine';
import type { Settings } from '../api/types';

const FIELD: Record<string, string> = {
  topic: '題目需為 1–80 字',
  progress: '進度說明需為 1–1000 字',
  link: '連結格式不對，請貼完整網址（https:// 開頭）',
  want: '想約的時間超出每週上限',
  slots: '請至少勾選一個時段',
  name: '請輸入名字',
  block: '時段需以 30 分鐘為單位，且結束要晚於開始',
  settings: '有設定值超出允許範圍',
  group: '小組資料不正確（編號 1–999、Discord Webhook 需為官方網址）',
  teacher: '請輸入老師名字',
  admin: '請輸入助教名字',
  week: '週次的開始日必須是星期一',
  weeks: '週數需在 1–52 之間',
  closure: '請選擇日期',
  roster: '名單最多 200 人，每個名字最多 20 字',
  items: '排程資料不正確，請重新整理後再試',
  lesson: '請確認日期、時間、講師和類型（結束要晚於開始，講師最多 20 字）',
  lesson_info: '標題需為 1–40 字，副標題最多 80 字，地點最多 200 字，公告最多 500 字',
  lessons: '檔案格式不對：需要有 sessions 清單，最多 500 堂',
  kind: '不支援的操作',
};

const MESSAGES: Record<string, string> = {
  AUTH: '登入已失效，請重新登入',
  FORBIDDEN: '這個身份沒有權限做這件事',
  RATE_LIMIT: '嘗試次數太多，請 10 分鐘後再試',
  CODE_INVALID: '找不到這個代碼，請確認後再試一次',
  NAME_REQUIRED: '請輸入你的名字',
  NAME_UNKNOWN: '找不到這個名字。請確認寫法和助教的名單一樣，或改用邀請連結',
  NAME_AMBIGUOUS: '有人和你同名，請改用邀請連結登入',
  SLOT_INVALID: '有時段已經不開放，請重新選擇',
  WEEK_CLOSED: '這週已暫停預約',
  CONFLICT: '組員剛剛更新了需求',
  HAS_APPOINTMENTS: '這週已經有排定的時段，請先取消時段再撤回需求',
  TEACHER_BUSY: '這位老師在這個時段已經有安排了',
  GROUP_BUSY: '這組在這個時段已經有安排了',
  IN_USE: '已有預約紀錄，不能刪除；可以改成停用',
  SELF: '不能停用或刪除自己的帳號',
  DUPLICATE: '資料重複了（例如組別編號、日期已經存在）',
  NETWORK: '連線中斷了，請檢查網路後再試一次',
  SERVER: '伺服器出了點問題，請稍後再試',
  CLIENT: '發生錯誤，請重新整理頁面',
};

export const ISSUE: Record<string, string> = {
  OFF_HOURS: '不在這位老師的開放時段',
  CAP_WEEK: '超過這組的每週上限',
  CAP_DAY: '超過這組的每日上限',
  NOT_REQUESTED: '這組沒有勾選這個時段',
  PAST: '這個時間已經過了',
  SLOT_TAKEN: '這個時段已經排了別組（只有一個會議室）',
};

export function errorText(e: unknown, s?: Pick<Settings, 'lead_days' | 'cancel_hours'>): string {
  if (!(e instanceof ApiError)) return MESSAGES.CLIENT;
  switch (e.code) {
    case 'VALIDATION':
      return FIELD[e.detail] ?? '輸入的資料不正確';
    case 'NAME_TAKEN':
      return e.detail ? `「${e.detail}」已經在其他組的名單，或是老師、助教的名字，名字不能重複` : '有名字和其他人重複了，請重新整理後再試';
    case 'LESSON_CLASH':
      return `和 ${e.detail} 的課時間重疊，同一時間只能排一堂課`;
    case 'IMPORT_ROW':
      return `第 ${e.detail} 堂的資料不正確，請確認日期、時間、講師和類型`;
    case 'NOT_FOUND':
      return '找不到這筆資料，可能已經被刪除或修改了';
    case 'SLOT_LATE':
      return `有時段已過預約截止（需在 ${s?.lead_days ?? 4} 天前預約）`;
    case 'CANCEL_LATE':
      return `距離開始不到 ${s?.cancel_hours ?? 24} 小時，請直接在 Discord 告訴助教`;
    case 'NEEDS_FORCE':
      return e.detail
        .split(',')
        .map((x) => ISSUE[x] ?? x)
        .join('、');
    default:
      return MESSAGES[e.code] ?? MESSAGES.SERVER;
  }
}
