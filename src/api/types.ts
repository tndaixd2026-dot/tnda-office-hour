// Shapes returned by the oh_* functions (see supabase/migrations).

export type Role = 'student' | 'teacher' | 'admin';

export interface ClockInfo {
  now: string;
  today: string;
  tz: string;
}

export interface Settings {
  course_code: string;
  course_title: string;
  host_label: string;
  location: string;
  notice: string;
  /** requests for a week close on this weekday (1 = Monday) of the week before, at close_time */
  close_dow: number;
  close_time: string;
  week_cap: number;
  day_cap: number;
  cancel_hours: number;
  slot_minutes: number;
  show_teacher_names: boolean;
  timezone: string;
}

export interface SessionInfo {
  id: number;
  role: Role;
  name: string;
  group: { id: number; no: number; name: string } | null;
  teacher: { id: number; name: string } | null;
  admin: { id: number; name: string } | null;
}

export interface JoinResult {
  ok: boolean;
  error?: 'CODE_INVALID' | 'NAME_REQUIRED' | 'NAME_UNKNOWN' | 'NAME_AMBIGUOUS';
  token?: string;
  session?: SessionInfo;
}

export interface PeekResult {
  ok: boolean;
  error?: string;
  role?: Role;
  name?: string;
  group?: { no: number; name: string };
}

export interface SlotRef {
  d: string;
  t: string;
}

export interface Request {
  id: number;
  week_id: number;
  group_id: number;
  topic: string;
  progress: string;
  link: string | null;
  want: number;
  author: string;
  status: 'open' | 'withdrawn';
  version: number;
  created_at: string;
  updated_at: string;
  slots: SlotRef[];
}

export interface StudentWeek {
  id: number;
  start: string;
  label: string;
  open: boolean;
  note: string;
  bookable: boolean;
  requested: boolean;
  booked: number;
  /** 'YYYY-MM-DD HH:MM', course time: requests close then */
  deadline: string;
}

export interface StudentSlot extends SlotRef {
  cap: number;
  late: boolean;
  /** already confirmed for another group */
  full: boolean;
  demand: number;
}

export interface StudentAppointment {
  id: number;
  week_id: number;
  d: string;
  t: string;
  status: 'confirmed' | 'cancelled';
  teacher: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  can_cancel: boolean;
  topic: string | null;
}

export interface StudentState {
  clock: ClockInfo;
  settings: Settings;
  me: SessionInfo;
  members: string[];
  week_id: number | null;
  weeks: StudentWeek[];
  slots: StudentSlot[];
  closures: Array<{ d: string; reason: string }>;
  request: Request | null;
  scheduling: boolean;
  appointments: StudentAppointment[];
}

export interface TeacherSession {
  id: number;
  d: string;
  t: string;
  status: 'confirmed' | 'cancelled';
  teacher_id: number;
  teacher: string;
  /** the signed-in teacher's own session */
  mine: boolean;
  cancel_reason: string | null;
  group: { no: number; name: string };
  request: {
    topic: string;
    progress: string;
    link: string | null;
    want: number;
    author: string;
    updated_at: string;
  } | null;
}

/** One screen for every PM (and the shared account): everyone's sessions. */
export interface TeacherState {
  clock: ClockInfo;
  settings: Settings;
  me: SessionInfo & { team: boolean };
  teachers: Array<{ id: number; name: string }>;
  sessions: TeacherSession[];
  blocks: Array<{
    teacher_id: number;
    dow: number | null;
    on_date: string | null;
    start: string;
    end: string;
    valid_from: string | null;
    valid_to: string | null;
  }>;
  closures: Array<{ d: string; reason: string; teacher_id: number | null }>;
}

export interface Appointment {
  id: number;
  week_id: number;
  group_id: number;
  teacher_id: number;
  d: string;
  t: string;
  status: 'draft' | 'confirmed' | 'cancelled';
  created_by: string;
  created_at: string;
  published_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

export interface AdminWeek {
  id: number;
  start: string;
  label: string;
  open: boolean;
  note: string;
  /** 'YYYY-MM-DD HH:MM', course time */
  deadline: string;
  requests: number;
  scheduled: number;
  drafts: number;
}

export interface AdminGroup {
  id: number;
  no: number;
  name: string;
  active: boolean;
  members: number;
  done: number;
  total: number;
  recent_teachers: number[];
}

export interface Teacher {
  id: number;
  name: string;
  active: boolean;
}

export interface ActivityEvent {
  id: number;
  at: string;
  role: string | null;
  name: string | null;
  kind: string;
  group_id: number | null;
  week_id: number | null;
  data: Record<string, any>;
}

export interface AdminState {
  clock: ClockInfo;
  settings: Settings;
  me: SessionInfo;
  week_id: number | null;
  weeks: AdminWeek[];
  slots: Array<SlotRef & { teachers: number[]; late: boolean }>;
  closures: Array<{ id: number; d: string; teacher_id: number | null; reason: string }>;
  teachers: Teacher[];
  groups: AdminGroup[];
  requests: Request[];
  appointments: Appointment[];
  events: ActivityEvent[];
}

export interface ConfigGroup {
  id: number;
  no: number;
  name: string;
  code: string;
  active: boolean;
  webhook: string | null;
  members: Array<{ id: number; name: string; created_at: string; seen_at: string }>;
  roster: string[];
  used: boolean;
}

export interface ConfigTeacher {
  id: number;
  name: string;
  code: string;
  active: boolean;
  sort: number;
  devices: number;
  used: boolean;
  /** the shared account that sees every PM's sessions */
  team: boolean;
}

export interface ConfigAdmin {
  id: number;
  name: string;
  code: string;
  active: boolean;
  name_login: boolean;
  me: boolean;
  devices: number;
}

export interface Block {
  id: number;
  teacher_id: number;
  dow: number | null;
  on_date: string | null;
  start: string;
  end: string;
  valid_from: string | null;
  valid_to: string | null;
}

export interface Closure {
  id: number;
  d: string;
  teacher_id: number | null;
  reason: string;
}

export interface ConfigWeek {
  id: number;
  start: string;
  label: string;
  open: boolean;
  note: string;
  used: boolean;
}

export interface AdminConfig {
  clock: ClockInfo;
  settings: Settings;
  me: SessionInfo;
  groups: ConfigGroup[];
  teachers: ConfigTeacher[];
  admins: ConfigAdmin[];
  weeks: ConfigWeek[];
  blocks: Block[];
  closures: Closure[];
}

// TD 專班課表 (oh_lessons): public, same keys as schedule.json
export interface Lesson {
  id: number;
  date: string;
  start: string;
  end: string;
  teacher: string;
  type: string;
  title: string;
  topic: string;
}

export interface LessonInfo {
  title: string;
  subtitle: string;
  place: string;
  note: string;
}

export interface LessonsState {
  clock: ClockInfo;
  info: LessonInfo;
  types: string[];
  lessons: Lesson[];
}

// Weekly email (oh_admin_mail)
export interface MailRecipient {
  id: number;
  email: string;
  name: string;
  /** empty: every teacher */
  teachers: number[];
  active: boolean;
}

export interface MailState {
  clock: ClockInfo;
  settings: { weekly: boolean; preview: boolean; remind: boolean; ta_email: string };
  /** the Monday the next email is about */
  week: string;
  teachers: Array<{ id: number; name: string }>;
  recipients: MailRecipient[];
  log: Array<{ kind: MailMessage['kind']; week: string; email: string; subject: string; sessions: number; at: string }>;
}

export interface MailMessage {
  kind: 'weekly' | 'preview' | 'remind';
  week: string;
  to: string;
  name: string;
  subject: string;
  html: string;
  text: string;
  count: number;
  sent_at: string | null;
}
