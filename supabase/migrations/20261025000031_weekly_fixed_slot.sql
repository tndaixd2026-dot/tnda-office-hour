-- =====================================================================
-- Office Hour · one fixed hour a week per group
--
-- Each group now has a fixed weekly slot with one PM (teacher, weekday,
-- start; sessions last an hour). Every week the group decides, by
-- Saturday 20:00 of the week before, whether to use next week's slot:
-- booking it (topic, questions, progress and a folder link, all
-- required) confirms the session at once; "這週不約" says they skip it.
-- Only the next week is open, and a whole-day holiday on the fixed day
-- means no session that week. Each PM meets in their own Google Meet
-- room. The admins handle a PM's absence on the board: another PM
-- (代班), another time (改期) or cancelling.
--
-- The slot-picking requests, the auto-scheduler and the two-teacher
-- pairing give way: groups now pick nothing, and app.group_teachers goes.
-- =====================================================================

-- one hour, once a week, closing on the Saturday before at 20:00
update app.settings
   set slot_minutes = 60, week_cap = 1, day_cap = 1, close_dow = 6, close_time = '20:00',
       show_teacher_names = true
 where id = 1;
-- nothing is left to schedule on Sunday noon, so the TAs' reminder stops
update app.mail_settings set remind = false where true;

-- each PM's own room
alter table app.teachers
  add column room text check (room is null or (length(room) <= 200 and room ~* '^https://'));
update app.teachers t set room = v.room
  from (values ('Prolong', 'https://meet.google.com/gtj-tcpu-wmu'),
               ('Joseph',  'https://meet.google.com/wgj-uxbz-bcv'),
               ('Tim',     'https://meet.google.com/umx-ikqj-ghi')) as v (name, room)
 where t.name = v.name and not t.team;

-- each group's fixed slot (a teacher removed later leaves the group without one)
alter table app.groups
  add column teacher_id int references app.teachers (id) on delete set null,
  add column slot_dow   int check (slot_dow between 1 and 7),
  add column slot_time  time,
  add constraint groups_slot_check check ((slot_dow is null) = (slot_time is null));

drop trigger if exists not_team on app.groups;
create trigger not_team before insert or update of teacher_id on app.groups
  for each row execute function app.not_team();

update app.groups g set teacher_id = t.id, slot_dow = v.dow, slot_time = v.tm::time
  from (values (1, 'Joseph', 2, '17:00'), (2, 'Prolong', 3, '10:00'), (3, 'Prolong', 3, '11:00'),
               (4, 'Prolong', 4, '10:00'), (5, 'Tim', 4, '17:00'), (6, 'Joseph', 1, '17:00'),
               (7, 'Joseph', 2, '18:00')) as v (no, name, dow, tm)
  join app.teachers t on t.name = v.name and not t.team
 where g.no = v.no;
update app.groups set name = '媒日媒夜' where no = 7 and name = '';

-- a group can say it skips a week; a skipped week needs no topic
alter table app.requests
  drop constraint requests_status_check,
  drop constraint requests_topic_check,
  drop constraint requests_progress_check;
alter table app.requests
  add constraint requests_status_check check (status in ('open', 'withdrawn', 'skipped')),
  add constraint requests_topic_check check (length(topic) <= 80 and (status = 'skipped' or length(topic) >= 1)),
  add constraint requests_progress_check check (length(progress) <= 1000 and (status = 'skipped' or length(progress) >= 1));

-- Where a PM meets: their room, else the course's location.
create or replace function app.room_of(p_teacher int) returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif((select t.room from app.teachers t where t.id = p_teacher), ''),
                  nullif((select s.location from app.settings s where s.id = 1), ''))
$$;

-- The one week students can book: the first open week still before its deadline.
create or replace function app.booking_week() returns int
language sql stable set search_path = '' as $$
  select w.id from app.weeks w
   where w.open and app.local_now() < app.week_deadline(w.start_date)
   order by w.start_date limit 1
$$;

-- The reason a group's fixed day is a holiday in that week, if it is one.
create or replace function app.fixed_holiday(p_group int, p_week int) returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(c.reason, ''), '放假')
    from app.groups g
    join app.weeks w on w.id = p_week
    join app.closures c on c.teacher_id is null and c.on_date = w.start_date + g.slot_dow - 1
   where g.id = p_group and g.slot_dow is not null
   limit 1
$$;

-- A week this group can book now: the booking week, with a fixed slot that is not a holiday.
create or replace function app.week_bookable(p_week int, p_group int) returns boolean
language sql stable set search_path = '' as $$
  select p_week is not distinct from app.booking_week()
     and exists (select 1 from app.groups g
                  where g.id = p_group and g.teacher_id is not null and g.slot_dow is not null)
     and app.fixed_holiday(p_group, p_week) is null
$$;

-- Slots no longer depend on a group's teachers (the slot grid is gone).
create or replace function app.group_slots(p_week int, p_group int)
returns table (d date, t time, teacher_id int)
language sql stable set search_path = '' as $$
  select ws.d, ws.t, ws.teacher_id from app.week_slots(p_week) ws
$$;

-- Book next week's fixed slot, or update the booking. The session is
-- confirmed at once, unless the admins already placed or cancelled one.
create or replace function public.oh_booking_save(
  p_token text, p_week int, p_topic text, p_questions text, p_progress text, p_link text,
  p_version int default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  g app.groups;
  w app.weeks;
  r app.requests;
  v_topic text := app.clean(p_topic);
  v_questions text := app.clean_multiline(p_questions);
  v_progress text := app.clean_multiline(p_progress);
  v_link text := app.clean(p_link);
  v_holiday text;
  v_d date;
  v_new boolean := false;
begin
  select * into g from app.groups x where x.id = s.group_id;
  if g.teacher_id is null or g.slot_dow is null then
    perform app.err('NO_FIXED_SLOT');
  end if;
  select * into w from app.weeks x where x.id = p_week;
  if not found then
    perform app.err('NOT_FOUND', 'week');
  end if;
  if not w.open then
    perform app.err('WEEK_CLOSED');
  end if;
  if app.local_now() >= app.week_deadline(w.start_date) then
    perform app.err('WEEK_LATE', app.deadline_text(app.week_deadline(w.start_date)));
  end if;
  if p_week is distinct from app.booking_week() then
    perform app.err('WEEK_NOT_YET');
  end if;
  v_holiday := app.fixed_holiday(g.id, w.id);
  if v_holiday is not null then
    perform app.err('WEEK_HOLIDAY', v_holiday);
  end if;
  if v_topic is null or length(v_topic) > 80 then
    perform app.err('VALIDATION', 'topic');
  end if;
  if v_questions is null or length(v_questions) > 1000 then
    perform app.err('VALIDATION', 'questions');
  end if;
  if v_progress is null or length(v_progress) > 1000 then
    perform app.err('VALIDATION', 'progress');
  end if;
  if v_link is null or length(v_link) > 500 or v_link !~* '^https?://[^\s/?#]+\.[^\s]*$' then
    perform app.err('VALIDATION', 'link');
  end if;
  v_d := w.start_date + g.slot_dow - 1;

  select * into r from app.requests x
   where x.week_id = p_week and x.group_id = s.group_id
   for update;
  if found and p_version is distinct from r.version then
    perform app.err('CONFLICT');
  end if;

  if r.id is null then
    insert into app.requests (week_id, group_id, topic, progress, questions, link, want, author, status, version, created_at, updated_at)
    values (p_week, s.group_id, v_topic, v_progress, v_questions, v_link, 1, s.name, 'open', 1, app.now(), app.now())
    on conflict (week_id, group_id) do nothing
    returning * into r;
    if r.id is null then
      perform app.err('CONFLICT');
    end if;
    v_new := true;
  else
    update app.requests x
       set topic = v_topic, progress = v_progress, questions = v_questions, link = v_link, want = 1,
           author = s.name, status = 'open', version = x.version + 1, updated_at = app.now()
     where x.id = r.id
    returning * into r;
  end if;

  delete from app.request_slots rs where rs.request_id = r.id;
  insert into app.request_slots (request_id, d, t) values (r.id, v_d, g.slot_time);

  if not exists (select 1 from app.appointments a where a.week_id = p_week and a.group_id = s.group_id) then
    begin
      insert into app.appointments (week_id, group_id, teacher_id, d, t, status, created_by, created_at, published_at)
      values (p_week, s.group_id, g.teacher_id, v_d, g.slot_time, 'confirmed', s.name, app.now(), app.now());
    exception when unique_violation then
      perform app.err('SLOT_TAKEN');
    end;
  end if;

  perform app.log(s, case when v_new then 'request.created' else 'request.updated' end, s.group_id, p_week,
                  jsonb_build_object('topic', v_topic));
  return app.request_json(r.id);
end $$;

-- Say the group skips next week; a booked session that week goes away.
create or replace function public.oh_booking_skip(p_token text, p_week int, p_version int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  w app.weeks;
  r app.requests;
begin
  select * into w from app.weeks x where x.id = p_week;
  if not found then
    perform app.err('NOT_FOUND', 'week');
  end if;
  if not w.open then
    perform app.err('WEEK_CLOSED');
  end if;
  if app.local_now() >= app.week_deadline(w.start_date) then
    perform app.err('WEEK_LATE', app.deadline_text(app.week_deadline(w.start_date)));
  end if;
  if p_week is distinct from app.booking_week() then
    perform app.err('WEEK_NOT_YET');
  end if;

  select * into r from app.requests x
   where x.week_id = p_week and x.group_id = s.group_id
   for update;
  if found and p_version is distinct from r.version then
    perform app.err('CONFLICT');
  end if;

  if r.id is null then
    insert into app.requests (week_id, group_id, topic, progress, questions, link, want, author, status, version, created_at, updated_at)
    values (p_week, s.group_id, '', '', '', null, 1, s.name, 'skipped', 1, app.now(), app.now())
    on conflict (week_id, group_id) do nothing
    returning * into r;
    if r.id is null then
      perform app.err('CONFLICT');
    end if;
  else
    update app.requests x
       set status = 'skipped', author = s.name, version = x.version + 1, updated_at = app.now()
     where x.id = r.id
    returning * into r;
  end if;

  delete from app.appointments a
   where a.week_id = p_week and a.group_id = s.group_id and a.status <> 'cancelled';
  perform app.log(s, 'request.skipped', s.group_id, p_week);
  return app.request_json(r.id);
end $$;

-- Students see their fixed slot, what they decided each week and each
-- session's room; a confirmed session can be cancelled only once its
-- week has closed (before that, the group simply skips the week).
create or replace function public.oh_student_state(p_token text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  cfg app.settings := app.cfg();
  g app.groups;
  v_today date := app.today();
  v_week int := p_week;
  v_late boolean;
begin
  select * into g from app.groups x where x.id = s.group_id;
  if v_week is null or not exists (select 1 from app.weeks w where w.id = v_week) then
    v_week := app.booking_week();
    if v_week is null then
      select w.id into v_week from app.weeks w
       where w.start_date + 6 >= v_today order by w.start_date limit 1;
    end if;
    if v_week is null then
      select w.id into v_week from app.weeks w order by w.start_date desc limit 1;
    end if;
  end if;
  v_late := app.local_now() >= app.week_deadline((select w.start_date from app.weeks w where w.id = v_week));

  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'pair', (select te.name from app.teachers te where te.id = g.teacher_id and cfg.show_teacher_names),
    'fixed', case when g.teacher_id is not null and g.slot_dow is not null then jsonb_build_object(
               'dow', g.slot_dow, 't', app.hm(g.slot_time),
               'teacher', (select te.name from app.teachers te where te.id = g.teacher_id and cfg.show_teacher_names),
               'room', app.room_of(g.teacher_id)) end,
    'members', (select coalesce(jsonb_agg(m.name order by m.first), '[]'::jsonb)
                  from (select x.name, min(x.created_at) as first from app.sessions x
                         where x.group_id = s.group_id and x.revoked_at is null group by x.name) m),
    'week_id', v_week,
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'bookable', app.week_bookable(w.id, s.group_id),
                'deadline', to_char(app.week_deadline(w.start_date), 'YYYY-MM-DD HH24:MI'),
                'holiday', app.fixed_holiday(s.group_id, w.id),
                'status', (select r.status from app.requests r where r.week_id = w.id and r.group_id = s.group_id),
                'requested', exists (select 1 from app.requests r
                                      where r.week_id = w.id and r.group_id = s.group_id and r.status = 'open'),
                'booked', (select count(*) from app.appointments a
                            where a.week_id = w.id and a.group_id = s.group_id and a.status = 'confirmed')
              ) order by w.start_date), '[]'::jsonb) from app.weeks w),
    'slots', (select coalesce(jsonb_agg(jsonb_build_object(
                'd', x.d, 't', app.hm(x.t), 'cap', x.cap,
                'late', coalesce(v_late, true) or x.d + x.t < app.local_now(),
                'full', x.full,
                'demand', x.demand) order by x.d, x.t), '[]'::jsonb)
              from (select ws.d, ws.t, least(count(distinct ws.teacher_id), 1) as cap,
                           exists (select 1 from app.appointments a
                                    where a.d = ws.d and a.t = ws.t and a.status = 'confirmed'
                                      and a.group_id <> s.group_id) as full,
                           (select count(distinct r.group_id) from app.requests r
                              join app.request_slots rs on rs.request_id = r.id
                             where r.week_id = v_week and r.status = 'open' and r.group_id <> s.group_id
                               and rs.d = ws.d and rs.t = ws.t) as demand
                      from app.group_slots(v_week, s.group_id) ws group by ws.d, ws.t) x),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object('d', c.on_date, 'reason', c.reason) order by c.on_date), '[]'::jsonb)
                   from app.closures c join app.weeks w on w.id = v_week
                  where c.teacher_id is null and c.on_date between w.start_date and w.start_date + 6),
    'request', (select app.request_json(r.id) from app.requests r
                 where r.week_id = v_week and r.group_id = s.group_id),
    'scheduling', exists (select 1 from app.appointments a
                           where a.week_id = v_week and a.group_id = s.group_id and a.status = 'draft'),
    'appointments', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', a.id, 'week_id', a.week_id, 'd', a.d, 't', app.hm(a.t), 'status', a.status,
                       'teacher', case when cfg.show_teacher_names then te.name end,
                       'room', app.room_of(a.teacher_id),
                       'cancel_reason', a.cancel_reason, 'cancelled_by', a.cancelled_by,
                       'can_cancel', a.status = 'confirmed'
                                     and a.d + a.t > app.local_now() + make_interval(hours => cfg.cancel_hours)
                                     and app.local_now() >= app.week_deadline(w.start_date),
                       'topic', (select r.topic from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
                     ) order by a.d, a.t), '[]'::jsonb)
                     from app.appointments a
                     join app.teachers te on te.id = a.teacher_id
                     join app.weeks w on w.id = a.week_id
                    where a.group_id = s.group_id
                      and (a.status = 'confirmed' or (a.status = 'cancelled' and a.published_at is not null)))
  );
end $$;

-- The admins' preview no longer lists the Sunday-noon reminder.
create or replace function public.oh_admin_mail_preview(p_token text, p_week date default null, p_site text default null,
                                                        p_api text default null, p_key text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_week date := coalesce(p_week, app.mail_week(app.today()));
  v_week_list jsonb;
  v_preview jsonb;
begin
  v_week := v_week - (extract(isodow from v_week)::int - 1);
  v_week_list := app.mail_outbox('weekly', v_week, p_site, p_api, p_key, null, true);
  v_preview := app.mail_outbox('preview', v_week, p_site, p_api, p_key, '（寄件的 Gmail）', true);
  return jsonb_build_object(
    'week', v_week,
    'messages', (select coalesce(jsonb_agg(m || jsonb_build_object('sent_at',
                   (select app.iso(l.sent_at) from app.mail_log l
                     where l.kind = m ->> 'kind' and l.week_start = v_week and lower(l.email) = lower(m ->> 'to')))
                 order by i), '[]'::jsonb)
                 from jsonb_array_elements(v_preview || v_week_list) with ordinality as x (m, i)));
end $$;

-- The board opens on the week whose sessions are still ahead: this week
-- until Friday, next week at the weekend.
create or replace function app.admin_default_week() returns int
language sql stable set search_path = '' as $$
  select coalesce(
    (select w.id from app.weeks w where w.start_date + 4 >= app.today() order by w.start_date limit 1),
    (select w.id from app.weeks w order by w.start_date desc limit 1))
$$;

-- By hand the admins can still put a group anywhere; with fixed slots there is
-- no request list to match and every PM has a room, so only the teacher's
-- hours, the caps and the past are checked.
create or replace function app.assign(
  p_admin app.sessions, p_appt bigint, p_week int, p_group int, p_teacher int,
  p_d date, p_t time, p_force boolean
) returns app.appointments
language plpgsql set search_path = '' as $$
declare
  cfg app.settings := app.cfg();
  w app.weeks;
  v app.appointments;
  v_issues text[] := '{}';
  v_constraint text;
begin
  select * into w from app.weeks x where x.id = p_week;
  if not found then
    perform app.err('NOT_FOUND', 'week');
  end if;
  if p_d is null or p_t is null or p_d < w.start_date or p_d > w.start_date + 6
     or (extract(epoch from p_t)::int % (cfg.slot_minutes * 60)) <> 0 then
    perform app.err('SLOT_INVALID');
  end if;
  if not exists (select 1 from app.groups x where x.id = p_group and x.active) then
    perform app.err('NOT_FOUND', 'group');
  end if;
  if not exists (select 1 from app.teachers x where x.id = p_teacher and x.active) then
    perform app.err('NOT_FOUND', 'teacher');
  end if;

  if exists (select 1 from app.appointments a
              where a.teacher_id = p_teacher and a.d = p_d and a.t = p_t
                and a.status <> 'cancelled' and a.id is distinct from p_appt) then
    perform app.err('TEACHER_BUSY');
  end if;
  if exists (select 1 from app.appointments a
              where a.group_id = p_group and a.d = p_d and a.t = p_t
                and a.status <> 'cancelled' and a.id is distinct from p_appt) then
    perform app.err('GROUP_BUSY');
  end if;

  if not exists (select 1 from app.week_slots(p_week) ws
                  where ws.d = p_d and ws.t = p_t and ws.teacher_id = p_teacher) then
    v_issues := array_append(v_issues, 'OFF_HOURS');
  end if;
  if (select count(*) from app.appointments a
       where a.group_id = p_group and a.week_id = p_week
         and a.status <> 'cancelled' and a.id is distinct from p_appt) >= cfg.week_cap then
    v_issues := array_append(v_issues, 'CAP_WEEK');
  end if;
  if (select count(*) from app.appointments a
       where a.group_id = p_group and a.d = p_d
         and a.status <> 'cancelled' and a.id is distinct from p_appt) >= cfg.day_cap then
    v_issues := array_append(v_issues, 'CAP_DAY');
  end if;
  if p_d + p_t < app.local_now() then
    v_issues := array_append(v_issues, 'PAST');
  end if;
  if cardinality(v_issues) > 0 and not coalesce(p_force, false) then
    perform app.err('NEEDS_FORCE', array_to_string(v_issues, ','));
  end if;

  if p_appt is null then
    insert into app.appointments (week_id, group_id, teacher_id, d, t, status, created_by, created_at)
    values (p_week, p_group, p_teacher, p_d, p_t, 'draft', p_admin.name, app.now())
    returning * into v;
  else
    update app.appointments a
       set teacher_id = p_teacher, d = p_d, t = p_t
     where a.id = p_appt
    returning * into v;
  end if;
  return v;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform app.err(case when v_constraint = 'appointments_group_slot' then 'GROUP_BUSY' else 'TEACHER_BUSY' end);
end $$;

-- The groups page shows each group's fixed slot, the teachers page each room.
create or replace function public.oh_admin_config(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'no', g.no, 'name', g.name, 'code', g.code, 'active', g.active,
                 'webhook', g.webhook,
                 'teacher_id', g.teacher_id, 'slot_dow', g.slot_dow, 'slot_time', app.hm(g.slot_time),
                 'members', (select coalesce(jsonb_agg(jsonb_build_object(
                               'id', x.id, 'name', x.name, 'created_at', app.iso(x.created_at),
                               'seen_at', app.iso(x.seen_at)) order by x.created_at), '[]'::jsonb)
                               from app.sessions x where x.group_id = g.id and x.revoked_at is null),
                 'roster', (select coalesce(jsonb_agg(r.name order by r.id), '[]'::jsonb)
                              from app.roster r where r.group_id = g.id),
                 'used', exists (select 1 from app.requests r where r.group_id = g.id)
                         or exists (select 1 from app.appointments a where a.group_id = g.id)
               ) order by g.no), '[]'::jsonb) from app.groups g),
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'sort', x.sort, 'team', x.team, 'room', x.room,
                   'devices', (select count(*) from app.sessions se where se.teacher_id = x.id and se.revoked_at is null),
                   'used', exists (select 1 from app.appointments a where a.teacher_id = x.id)
                 ) order by x.team desc, x.sort, x.id), '[]'::jsonb) from app.teachers x),
    'admins', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'me', x.id = s.admin_id,
                 'name_login', x.name_login,
                 'devices', (select count(*) from app.sessions se where se.admin_id = x.id and se.revoked_at is null)
               ) order by x.id), '[]'::jsonb) from app.admins x),
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'used', exists (select 1 from app.requests r where r.week_id = w.id)
                        or exists (select 1 from app.appointments a where a.week_id = w.id)
              ) order by w.start_date), '[]'::jsonb) from app.weeks w),
    'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', b.id, 'teacher_id', b.teacher_id, 'dow', b.dow, 'on_date', b.on_date,
                 'start', app.hm(b.start_time), 'end', app.hm(b.end_time),
                 'valid_from', b.valid_from, 'valid_to', b.valid_to
               ) order by b.on_date nulls first, b.dow, b.start_time, b.teacher_id), '[]'::jsonb) from app.blocks b),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', c.id, 'd', c.on_date, 'teacher_id', c.teacher_id, 'reason', c.reason) order by c.on_date), '[]'::jsonb)
                 from app.closures c)
  );
end $$;

-- The board knows each group's fixed slot, each PM's room and who skipped.
create or replace function public.oh_admin_state(p_token text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  cfg app.settings := app.cfg();
  v_today date := app.today();
  v_week int := p_week;
  v_start date;
begin
  if v_week is null or not exists (select 1 from app.weeks w where w.id = v_week) then
    v_week := app.admin_default_week();
  end if;
  select w.start_date into v_start from app.weeks w where w.id = v_week;

  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s),
    'week_id', v_week,
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'deadline', to_char(app.week_deadline(w.start_date), 'YYYY-MM-DD HH24:MI'),
                'requests', (select count(*) from app.requests r where r.week_id = w.id and r.status = 'open'),
                'skipped', (select count(*) from app.requests r where r.week_id = w.id and r.status = 'skipped'),
                'scheduled', (select count(distinct a.group_id) from app.appointments a
                               where a.week_id = w.id and a.status = 'confirmed'),
                'drafts', (select count(*) from app.appointments a where a.week_id = w.id and a.status = 'draft')
              ) order by w.start_date), '[]'::jsonb) from app.weeks w),
    'slots', (select coalesce(jsonb_agg(jsonb_build_object(
                'd', x.d, 't', app.hm(x.t), 'teachers', x.teachers,
                'late', app.local_now() >= app.week_deadline(v_start)) order by x.d, x.t), '[]'::jsonb)
              from (select ws.d, ws.t, jsonb_agg(ws.teacher_id order by ws.teacher_id) as teachers
                      from app.week_slots(v_week) ws group by ws.d, ws.t) x),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', c.id, 'd', c.on_date, 'teacher_id', c.teacher_id, 'reason', c.reason) order by c.on_date), '[]'::jsonb)
                 from app.closures c where c.on_date between v_start and v_start + 6),
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'active', x.active, 'room', x.room)
                   order by x.sort, x.id), '[]'::jsonb) from app.teachers x where not x.team),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'no', g.no, 'name', g.name, 'active', g.active,
                 'teacher_id', g.teacher_id, 'slot_dow', g.slot_dow, 'slot_time', app.hm(g.slot_time),
                 'members', (select count(*) from app.sessions x where x.group_id = g.id and x.revoked_at is null),
                 'done', (select count(*) from app.appointments a
                           where a.group_id = g.id and a.status = 'confirmed' and a.d + a.t < app.local_now()),
                 'total', (select count(*) from app.appointments a where a.group_id = g.id and a.status = 'confirmed'),
                 'recent_teachers', (select coalesce(jsonb_agg(a.teacher_id order by a.d desc, a.t desc), '[]'::jsonb)
                                       from app.appointments a where a.group_id = g.id and a.status = 'confirmed')
               ) order by g.no), '[]'::jsonb) from app.groups g),
    'requests', (select coalesce(jsonb_agg(app.request_json(r.id) order by r.created_at), '[]'::jsonb)
                   from app.requests r where r.week_id = v_week),
    'appointments', (select coalesce(jsonb_agg(app.appt_json(a) order by a.d, a.t), '[]'::jsonb)
                       from app.appointments a where a.week_id = v_week),
    'events', (select coalesce(jsonb_agg(e.j order by e.at desc), '[]'::jsonb)
                 from (select ev.at, jsonb_build_object(
                         'id', ev.id, 'at', app.iso(ev.at), 'role', ev.actor_role, 'name', ev.actor_name,
                         'kind', ev.kind, 'group_id', ev.group_id, 'week_id', ev.week_id, 'data', ev.data) as j
                         from app.events ev order by ev.at desc, ev.id desc limit 50) e)
  );
end $$;

-- Saving a group takes its fixed slot; saving a teacher takes their room.
create or replace function public.oh_admin_save(p_token text, p_kind text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  cfg app.settings := app.cfg();
  v_id int;
  v_step int := cfg.slot_minutes * 60;
  v_start time;
  v_end time;
  v_constraint text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', p_kind);
  end if;
  v_id := nullif(p ->> 'id', '')::int;

  case p_kind
  when 'settings' then
    update app.settings x set
      course_code  = case when p ? 'course_code'  then coalesce(app.clean(p ->> 'course_code'), '')  else x.course_code end,
      course_title = case when p ? 'course_title' then coalesce(app.clean(p ->> 'course_title'), '') else x.course_title end,
      host_label   = case when p ? 'host_label'   then coalesce(app.clean(p ->> 'host_label'), 'PM') else x.host_label end,
      location     = case when p ? 'location'     then coalesce(app.clean(p ->> 'location'), '')     else x.location end,
      notice       = case when p ? 'notice'       then coalesce(app.clean_multiline(p ->> 'notice'), '') else x.notice end,
      close_dow    = case when p ? 'close_dow'    then (p ->> 'close_dow')::int    else x.close_dow end,
      close_time   = case when p ? 'close_time'   then (p ->> 'close_time')::time  else x.close_time end,
      week_cap     = case when p ? 'week_cap'     then (p ->> 'week_cap')::int     else x.week_cap end,
      day_cap      = case when p ? 'day_cap'      then (p ->> 'day_cap')::int      else x.day_cap end,
      cancel_hours = case when p ? 'cancel_hours' then (p ->> 'cancel_hours')::int else x.cancel_hours end,
      show_teacher_names = case when p ? 'show_teacher_names' then (p ->> 'show_teacher_names')::boolean
                                else x.show_teacher_names end,
      updated_at = app.now()
    where x.id = 1;
    perform app.log(s, 'config.settings', null, null);
    return app.settings_json();

  when 'group' then
    if v_id is null then
      insert into app.groups (no, name, code, active, webhook)
      values (coalesce((p ->> 'no')::int, (select coalesce(max(x.no), 0) + 1 from app.groups x)),
              coalesce(app.clean(p ->> 'name'), ''), app.new_code(8),
              coalesce((p ->> 'active')::boolean, true), app.clean(p ->> 'webhook'))
      returning id into v_id;
    else
      update app.groups x set
        no      = case when p ? 'no'      then (p ->> 'no')::int else x.no end,
        name    = case when p ? 'name'    then coalesce(app.clean(p ->> 'name'), '') else x.name end,
        active  = case when p ? 'active'  then (p ->> 'active')::boolean else x.active end,
        webhook = case when p ? 'webhook' then app.clean(p ->> 'webhook') else x.webhook end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'group'); end if;
    end if;
    -- the fixed weekly slot: teacher, weekday and start, all three or none
    if p ? 'teacher_id' or p ? 'slot_dow' or p ? 'slot_time' then
      update app.groups x set
        teacher_id = case when p ? 'teacher_id' then nullif(p ->> 'teacher_id', '')::int else x.teacher_id end,
        slot_dow   = case when p ? 'slot_dow'   then nullif(p ->> 'slot_dow', '')::int   else x.slot_dow end,
        slot_time  = case when p ? 'slot_time'  then nullif(p ->> 'slot_time', '')::time else x.slot_time end
      where x.id = v_id;
      if exists (select 1 from app.groups x
                  where x.id = v_id
                    and not ((x.teacher_id is null and x.slot_dow is null and x.slot_time is null)
                             or (x.teacher_id is not null and x.slot_dow is not null and x.slot_time is not null
                                 and extract(epoch from x.slot_time)::int % v_step = 0))) then
        perform app.err('VALIDATION', 'slot');
      end if;
    end if;
    perform app.log(s, 'config.group', v_id, null);
    return (select jsonb_build_object('id', g.id, 'no', g.no, 'name', g.name, 'code', g.code,
                                      'active', g.active, 'webhook', g.webhook,
                                      'teacher_id', g.teacher_id, 'slot_dow', g.slot_dow, 'slot_time', app.hm(g.slot_time))
              from app.groups g where g.id = v_id);

  when 'teacher' then
    if v_id is null then
      insert into app.teachers (name, code, active, sort, room)
      values (app.clean(p ->> 'name'), app.new_code(10), coalesce((p ->> 'active')::boolean, true),
              coalesce((p ->> 'sort')::int, (select coalesce(max(x.sort), 0) + 1 from app.teachers x)),
              nullif(app.clean(p ->> 'room'), ''))
      returning id into v_id;
    else
      update app.teachers x set
        name   = case when p ? 'name'   then app.clean(p ->> 'name') else x.name end,
        active = case when p ? 'active' then (p ->> 'active')::boolean else x.active end,
        sort   = case when p ? 'sort'   then (p ->> 'sort')::int else x.sort end,
        room   = case when p ? 'room'   then nullif(app.clean(p ->> 'room'), '') else x.room end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'teacher'); end if;
    end if;
    perform app.log(s, 'config.teacher', null, null, jsonb_build_object('teacher_id', v_id));
    return (select jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'sort', x.sort, 'room', x.room)
              from app.teachers x where x.id = v_id);

  when 'admin' then
    if v_id is null then
      insert into app.admins (name, code, active)
      values (app.clean(p ->> 'name'), app.new_code(12), true)
      returning id into v_id;
    else
      if v_id = s.admin_id and p ? 'active' and not (p ->> 'active')::boolean then
        perform app.err('SELF');
      end if;
      update app.admins x set
        name   = case when p ? 'name'   then app.clean(p ->> 'name') else x.name end,
        active = case when p ? 'active' then (p ->> 'active')::boolean else x.active end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'admin'); end if;
    end if;
    perform app.log(s, 'config.admin', null, null);
    return (select jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'active', x.active)
              from app.admins x where x.id = v_id);

  when 'week' then
    if v_id is null then
      insert into app.weeks (start_date, label, open, note)
      values ((p ->> 'start')::date, coalesce(app.clean(p ->> 'label'), ''),
              coalesce((p ->> 'open')::boolean, true), coalesce(app.clean(p ->> 'note'), ''))
      returning id into v_id;
    else
      update app.weeks x set
        label = case when p ? 'label' then coalesce(app.clean(p ->> 'label'), '') else x.label end,
        open  = case when p ? 'open'  then (p ->> 'open')::boolean else x.open end,
        note  = case when p ? 'note'  then coalesce(app.clean(p ->> 'note'), '') else x.note end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'week'); end if;
    end if;
    perform app.log(s, 'config.week', null, v_id);
    return (select jsonb_build_object('id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note)
              from app.weeks w where w.id = v_id);

  when 'block' then
    v_start := (p ->> 'start')::time;
    v_end := (p ->> 'end')::time;
    if v_start is null or v_end is null or v_end <= v_start
       or extract(epoch from v_start)::int % v_step <> 0
       or extract(epoch from v_end)::int % v_step <> 0 then
      perform app.err('VALIDATION', 'block');
    end if;
    if not exists (select 1 from app.teachers x where x.id = (p ->> 'teacher_id')::int) then
      perform app.err('NOT_FOUND', 'teacher');
    end if;
    if v_id is null then
      insert into app.blocks (teacher_id, dow, on_date, start_time, end_time, valid_from, valid_to)
      values ((p ->> 'teacher_id')::int, (p ->> 'dow')::int, (p ->> 'on_date')::date, v_start, v_end,
              (p ->> 'valid_from')::date, (p ->> 'valid_to')::date)
      returning id into v_id;
    else
      update app.blocks x set
        teacher_id = (p ->> 'teacher_id')::int, dow = (p ->> 'dow')::int, on_date = (p ->> 'on_date')::date,
        start_time = v_start, end_time = v_end,
        valid_from = (p ->> 'valid_from')::date, valid_to = (p ->> 'valid_to')::date
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'block'); end if;
    end if;
    perform app.log(s, 'config.block', null, null);
    return jsonb_build_object('id', v_id);

  when 'closure' then
    if v_id is null then
      insert into app.closures (on_date, teacher_id, reason)
      values ((p ->> 'd')::date, (p ->> 'teacher_id')::int, coalesce(app.clean(p ->> 'reason'), ''))
      returning id into v_id;
    else
      update app.closures x set
        on_date = (p ->> 'd')::date, teacher_id = (p ->> 'teacher_id')::int,
        reason = coalesce(app.clean(p ->> 'reason'), '')
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'closure'); end if;
    end if;
    perform app.log(s, 'config.closure', null, null);
    return jsonb_build_object('id', v_id);

  else
    perform app.err('VALIDATION', 'kind');
  end case;
  return null;
exception
  when unique_violation then
    perform app.err('DUPLICATE', p_kind);
  when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
       or datetime_field_overflow or numeric_value_out_of_range or string_data_right_truncation
       or invalid_parameter_value or foreign_key_violation then
    perform app.err('VALIDATION', p_kind);
end $$;

-- Teachers see each session's room.
create or replace function public.oh_teacher_state(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['teacher']);
  t app.teachers;
  v_today date := app.today();
  v_monday date := v_today - (extract(isodow from v_today)::int - 1);
begin
  select * into t from app.teachers x where x.id = s.teacher_id;
  return jsonb_build_object(
    'clock', app.clock(),
    'settings', app.settings_json(),
    'me', app.session_json(s) || jsonb_build_object('team', t.team),
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.sort, x.id), '[]'::jsonb)
                   from app.teachers x
                  where not x.team
                    and (x.active or exists (select 1 from app.appointments a
                                              where a.teacher_id = x.id and a.d >= v_monday - 28))),
    'sessions', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', a.id, 'd', a.d, 't', app.hm(a.t), 'status', a.status,
                   'teacher_id', a.teacher_id, 'teacher', te.name, 'mine', a.teacher_id = s.teacher_id,
                   'room', app.room_of(a.teacher_id),
                   'cancel_reason', a.cancel_reason,
                   'group', jsonb_build_object('no', g.no, 'name', g.name),
                   'request', (select jsonb_build_object('topic', r.topic, 'progress', r.progress, 'questions', r.questions, 'link', r.link,
                                                         'want', r.want, 'author', r.author,
                                                         'updated_at', app.iso(r.updated_at))
                                 from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
                 ) order by a.d, a.t, te.sort), '[]'::jsonb)
                 from app.appointments a
                 join app.groups g on g.id = a.group_id
                 join app.teachers te on te.id = a.teacher_id
                where a.d >= v_monday - 28
                  and (a.status = 'confirmed'
                       or (a.status = 'cancelled' and a.published_at is not null and a.d >= v_today))),
    'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                 'teacher_id', b.teacher_id, 'dow', b.dow, 'on_date', b.on_date,
                 'start', app.hm(b.start_time), 'end', app.hm(b.end_time),
                 'valid_from', b.valid_from, 'valid_to', b.valid_to
               ) order by b.on_date nulls first, b.dow, b.start_time), '[]'::jsonb)
               from app.blocks b join app.teachers x on x.id = b.teacher_id and x.active
              where (b.on_date is null or b.on_date >= v_today)
                and (b.valid_to is null or b.valid_to >= v_today)),
    'closures', (select coalesce(jsonb_agg(jsonb_build_object('d', c.on_date, 'reason', c.reason, 'teacher_id', c.teacher_id)
                   order by c.on_date), '[]'::jsonb)
                 from app.closures c
                where c.on_date between v_today and v_today + 90)
  );
end $$;

-- Calendar events point at the session's room.
create or replace function public.oh_calendar(p_feed text, apikey text default null) returns "*/*"
language plpgsql stable security definer set search_path = '' as $$
declare
  cfg app.settings := app.cfg();
  t app.teachers;
  g app.groups;
  v_name text;
  v_lines text[] := '{}';
  r record;
  v_end interval := make_interval(mins => cfg.slot_minutes);
  v_now text := to_char(app.now() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
begin
  if p_feed is not null and length(p_feed) = 32 then
    select * into t from app.teachers x where x.feed = p_feed and x.active;
    if t.id is null then
      select * into g from app.groups x where x.feed = p_feed and x.active;
    end if;
  end if;
  v_name := case
    when t.id is not null then 'Office Hour · ' || t.name
    when g.id is not null then 'Office Hour · ' || app.group_title(g.id)
    else 'Office Hour（訂閱連結已失效）'
  end;

  v_lines := array['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tnda-office-hour//calendar//ZH-TW', 'CALSCALE:GREGORIAN',
                   'METHOD:PUBLISH', 'X-WR-CALNAME:' || app.ics_text(v_name), 'X-WR-TIMEZONE:' || cfg.timezone,
                   'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];

  for r in
    select a.id, a.d, a.t, a.teacher_id, gr.id as gid, te.name as tname,
           rq.topic, rq.progress, rq.questions, rq.link, rq.author
      from app.appointments a
      join app.groups gr on gr.id = a.group_id
      join app.teachers te on te.id = a.teacher_id
      left join app.requests rq on rq.week_id = a.week_id and rq.group_id = a.group_id
     where a.status = 'confirmed'
       and a.d >= app.today() - 90
       and ((t.id is not null and (t.team or a.teacher_id = t.id)) or (g.id is not null and a.group_id = g.id))
     order by a.d, a.t
  loop
    v_lines := v_lines || array[
      'BEGIN:VEVENT',
      'UID:oh-' || r.id || '@tnda-office-hour',
      'DTSTAMP:' || v_now,
      'DTSTART:' || app.ics_stamp(r.d, r.t),
      'DTEND:' || app.ics_stamp(r.d, r.t + v_end),
      'SUMMARY:' || app.ics_text(case
        when t.team then 'Office Hour · ' || r.tname || ' · ' || app.group_title(r.gid) || coalesce('｜' || r.topic, '')
        when t.id is not null then 'Office Hour · ' || app.group_title(r.gid) || coalesce('｜' || r.topic, '')
        else 'Office Hour · ' || cfg.host_label || case when cfg.show_teacher_names then ' ' || r.tname else '' end
             || coalesce('｜' || r.topic, '')
      end),
      'LOCATION:' || app.ics_text(coalesce(app.room_of(r.teacher_id), '')),
      'DESCRIPTION:' || app.ics_text(concat_ws(E'\n',
        app.group_title(r.gid),
        case when t.team then '老師：' || r.tname end,
        case when r.topic is not null then '題目：' || r.topic end,
        case when t.id is not null and nullif(r.questions, '') is not null then '想問的問題：' || E'\n' || r.questions end,
        case when t.id is not null and r.progress is not null then '進度：' || r.progress end,
        case when r.link is not null then '資料：' || r.link end)),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Office Hour', 'END:VALARM',
      'END:VEVENT'];
  end loop;
  v_lines := v_lines || 'END:VCALENDAR'::text;

  perform set_config('response.headers',
    jsonb_build_array(
      jsonb_build_object('Content-Type', 'text/calendar; charset=utf-8'),
      jsonb_build_object('Cache-Control', 'max-age=300'),
      jsonb_build_object('Content-Disposition', 'inline; filename="office-hour.ics"'))::text,
    true);
  return convert_to((select string_agg(app.ics_fold(l), E'\r\n') from unnest(v_lines) as l) || E'\r\n', 'UTF8');
end $$;

-- Discord messages name the room, and say when another PM takes over.
create or replace function app.appointments_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  -- drafts that were just published: one message per group
  for r in
    select n.group_id, n.week_id,
           string_agg('• ' || app.slot_text(n.d, n.t) || coalesce(' ' || app.room_of(n.teacher_id), ''), E'\n' order by n.d, n.t) as lines
      from new_rows n join old_rows o on o.id = n.id
     where n.status = 'confirmed' and o.status = 'draft'
     group by n.group_id, n.week_id
  loop
    perform app.discord(r.group_id,
      '**📅 Office Hour 時間確定**' || E'\n' || app.group_title(r.group_id) || E'\n' || r.lines
      || coalesce(E'\n題目：' || (select x.topic from app.requests x where x.week_id = r.week_id and x.group_id = r.group_id), ''));
  end loop;

  -- confirmed sessions that were cancelled
  for r in
    select n.* from new_rows n join old_rows o on o.id = n.id
     where n.status = 'cancelled' and o.status = 'confirmed'
  loop
    perform app.discord(r.group_id,
      '**Office Hour 已取消**' || E'\n' || app.group_title(r.group_id) || E'\n• ' || app.slot_text(r.d, r.t)
      || coalesce(E'\n' || r.cancelled_by || ' 取消' || coalesce('：' || r.cancel_reason, ''), ''));
  end loop;

  -- confirmed sessions that moved
  for r in
    select n.*, o.d as old_d, o.t as old_t from new_rows n join old_rows o on o.id = n.id
     where n.status = 'confirmed' and o.status = 'confirmed' and (n.d, n.t) is distinct from (o.d, o.t)
  loop
    perform app.discord(r.group_id,
      '**Office Hour 時間異動**' || E'\n' || app.group_title(r.group_id)
      || E'\n• ' || app.slot_text(r.old_d, r.old_t) || ' → ' || app.slot_text(r.d, r.t)
      || coalesce(E'\n地點：' || app.room_of(r.teacher_id), ''));
  end loop;

  -- another PM takes a confirmed session at the same time
  for r in
    select n.*, o.teacher_id as old_teacher from new_rows n join old_rows o on o.id = n.id
     where n.status = 'confirmed' and o.status = 'confirmed'
       and n.teacher_id <> o.teacher_id and (n.d, n.t) is not distinct from (o.d, o.t)
  loop
    perform app.discord(r.group_id,
      '**Office Hour 換老師**' || E'\n' || app.group_title(r.group_id)
      || E'\n• ' || app.slot_text(r.d, r.t) || '：'
      || (select t.name from app.teachers t where t.id = r.old_teacher) || ' → ' || (select t.name from app.teachers t where t.id = r.teacher_id)
      || coalesce(E'\n地點：' || app.room_of(r.teacher_id), ''));
  end loop;
  return null;
end $$;

-- The PMs' email lists each PM's room; the header carries the new name.
create or replace function app.mail_message(p_week date, p_teachers int[], p_name text,
                                            p_site text, p_api text, p_key text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  cfg app.settings := app.cfg();
  v_all boolean := coalesce(cardinality(p_teachers), 0) = 0
                   or not exists (select 1 from app.teachers t where not t.team and t.active and not (t.id = any (p_teachers)));
  v_many boolean;
  v_who text;
  v_feed text;
  v_subscribe text;
  v_range text := to_char(p_week, 'FMMM/FMDD') || '–' || to_char(p_week + 6, 'FMMM/FMDD');
  v_span text := to_char(p_week, 'FMMM/FMDD') || '（一）– ' || to_char(p_week + 6, 'FMMM/FMDD') || '（日）';
  v_count int;
  v_subject text;
  v_chips text := '';
  v_days text := '';
  v_text text := '';
  v_rooms text := '';
  v_rooms_text text := '';
  v_end time;
  d record;
  r record;
  v_href text;
begin
  v_many := v_all or cardinality(p_teachers) > 1;
  if not v_all then
    select string_agg(t.name, '、' order by t.sort, t.id) into v_who
      from app.teachers t where t.id = any (p_teachers);
  end if;

  select count(*) into v_count
    from app.appointments a
   where a.status = 'confirmed' and a.d between p_week and p_week + 6
     and (v_all or a.teacher_id = any (p_teachers));

  v_subject := '【Office Hour】' || coalesce(v_who || ' ', '')
               || case when v_count = 0 then '本週沒有場次' else '本週 ' || v_count || ' 場' end
               || '（' || v_range || '）';

  -- one teacher: their own feed; otherwise the shared account's
  select t.feed into v_feed from app.teachers t
   where t.active and ((not v_all and cardinality(p_teachers) = 1 and t.id = p_teachers[1]) or ((v_all or cardinality(p_teachers) > 1) and t.team))
   order by t.team limit 1;
  if v_feed is not null and coalesce(p_api, '') <> '' then
    v_subscribe := 'https://calendar.google.com/calendar/render?cid='
                   || app.url_encode('webcal://' || regexp_replace(p_api, '^https?://', '') || '/rest/v1/rpc/oh_calendar?p_feed='
                                     || v_feed || '&apikey=' || coalesce(p_key, ''));
  end if;

  -- each PM meets in their own room
  select coalesce(string_agg(format('<p style="margin:4px 0 0;font-size:15px;"><b>%s</b>&nbsp;&nbsp;%s</p>',
                    app.html(x.name),
                    case when x.room ~* '^https?://'
                         then format('<a href="%s" style="color:#161514;font-weight:700;">%s</a>', app.html(x.room), app.html(regexp_replace(x.room, '^https?://', '')))
                         else app.html(coalesce(x.room, '線上')) end), '' order by x.sort, x.id), ''),
         coalesce(string_agg('  ' || x.name || '：' || coalesce(x.room, '線上'), E'\n' order by x.sort, x.id), '')
    into v_rooms, v_rooms_text
    from (select distinct t.id, t.name, t.sort, app.room_of(t.id) as room
            from app.appointments a join app.teachers t on t.id = a.teacher_id
           where a.status = 'confirmed' and a.d between p_week and p_week + 6
             and (v_all or a.teacher_id = any (p_teachers))) x;

  if v_many then
    select coalesce(string_agg(app.mail_chip(x.id, x.name || ' ' || x.n || ' 場'), '' order by x.sort, x.id), '') into v_chips
      from (select t.id, t.name, t.sort, count(*) as n
              from app.appointments a join app.teachers t on t.id = a.teacher_id
             where a.status = 'confirmed' and a.d between p_week and p_week + 6
               and (v_all or a.teacher_id = any (p_teachers))
             group by t.id, t.name, t.sort) x;
  end if;

  for d in
    select distinct a.d from app.appointments a
     where a.status = 'confirmed' and a.d between p_week and p_week + 6
       and (v_all or a.teacher_id = any (p_teachers))
     order by a.d
  loop
    v_days := v_days || format(
      '<tr><td style="padding:24px 24px 10px;"><p style="margin:0;padding-left:10px;border-left:4px solid #b23a0b;'
      || 'font-size:17px;font-weight:700;line-height:1.3;">%s</p></td></tr>',
      '週' || app.wday(d.d) || ' ' || to_char(d.d, 'FMMM/FMDD'));
    v_text := v_text || E'\n' || '週' || app.wday(d.d) || ' ' || to_char(d.d, 'FMMM/FMDD') || E'\n';
    for r in
      select a.t, a.teacher_id, te.name as teacher, rq.topic, rq.progress, nullif(rq.questions, '') as questions, rq.link, a.group_id
        from app.appointments a
        join app.teachers te on te.id = a.teacher_id
        left join app.requests rq on rq.week_id = a.week_id and rq.group_id = a.group_id
       where a.status = 'confirmed' and a.d = d.d and (v_all or a.teacher_id = any (p_teachers))
       order by a.t, te.sort
    loop
      v_end := r.t + make_interval(mins => cfg.slot_minutes);
      v_href := app.gcal_link(
        'Office Hour · ' || r.teacher || ' · ' || app.group_title(r.group_id) || coalesce('｜' || r.topic, ''),
        d.d, r.t, cfg.slot_minutes,
        concat_ws(E'\n', app.group_title(r.group_id), '老師：' || r.teacher, '題目：' || r.topic,
                  '想問的問題：' || E'\n' || r.questions, '進度：' || r.progress, '檔案：' || r.link),
        app.room_of(r.teacher_id));
      v_days := v_days || format(
        '<tr><td style="padding:0 24px 10px;">'
        || '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e1da;border-radius:14px;">'
        || '<tr><td width="84" valign="top" style="width:84px;padding:16px 0 14px 16px;">'
        || '<p style="margin:0;font-size:24px;font-weight:800;line-height:1.1;color:#161514;">%s</p>'
        || '<p style="margin:4px 0 0;font-size:13px;color:#5f5d57;">–%s</p>'
        || '</td><td valign="top" style="padding:14px 16px 8px 12px;">'
        || '%s'
        || '<p style="margin:0;font-size:16px;font-weight:700;line-height:1.4;">%s</p>'
        || '%s%s%s%s'
        || '<p style="margin:12px 0 0;">%s%s</p>'
        || '</td></tr></table></td></tr>',
        app.hm(r.t), app.hm(v_end),
        case when v_many then '<p style="margin:0 0 4px;">' || app.mail_chip(r.teacher_id, r.teacher) || '</p>' else '' end,
        app.html(app.group_title(r.group_id)),
        case when r.topic is not null then
          format('<p style="margin:6px 0 0;font-size:15px;line-height:1.5;"><span style="color:#5f5d57;">題目</span>&nbsp;&nbsp;<b>%s</b></p>', app.html(r.topic))
        else '' end,
        -- what they want to ask: the part a PM most needs before the call
        case when r.questions is not null then
          format('<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" bgcolor="#f5f4f0" style="margin:10px 0 0;background-color:#f5f4f0;border-radius:10px;">'
                 || '<tr><td style="padding:10px 12px;"><p style="margin:0;font-size:12px;font-weight:700;color:#5f5d57;">想問的問題</p>'
                 || '<p style="margin:2px 0 0;font-size:14px;line-height:1.6;color:#161514;white-space:pre-line;">%s</p></td></tr></table>',
                 app.html(r.questions))
        else '' end,
        case when r.progress is not null then
          format('<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#5f5d57;white-space:pre-line;">'
                 || '<span style="font-weight:700;">進度</span>&nbsp;&nbsp;%s</p>', app.html(r.progress))
        else '' end,
        case when r.link ~* '^https?://' then
          format('<p style="margin:8px 0 0;font-size:13px;line-height:1.5;"><span style="font-weight:700;color:#5f5d57;">檔案</span>&nbsp;&nbsp;'
                 || '<a href="%s" style="color:#2f5bd3;word-break:break-all;">%s</a></p>',
                 app.html(r.link), app.html(regexp_replace(r.link, '^https?://', '')))
        else '' end,
        case when app.room_of(r.teacher_id) ~* '^https?://' then app.mail_btn(app.room_of(r.teacher_id), '加入會議', 'join') else '' end,
        app.mail_btn(v_href, '＋ 加到 Google 日曆', 'add'));
      v_text := v_text || format(E'  %s–%s %s %s%s\n%s%s  加到 Google 日曆：%s\n',
                                 app.hm(r.t), app.hm(v_end), r.teacher,
                                 app.group_title(r.group_id), coalesce('｜' || r.topic, ''),
                                 coalesce('  想問的問題：' || replace(r.questions, E'\n', E'\n    ') || E'\n', ''),
                                 coalesce('  檔案：' || r.link || E'\n', ''), v_href);
    end loop;
  end loop;

  return jsonb_build_object(
    'subject', v_subject,
    'count', v_count,
    'text', concat_ws(E'\n',
              case when coalesce(p_name, '') <> '' then p_name || ' 您好' end,
              case when v_count = 0 then '這週（' || v_range || '）沒有排到 Office Hour'
                   else '這週（' || v_range || '）' || coalesce(v_who || ' ', '') || '有 ' || v_count || ' 場 Office Hour，每場 '
                        || cfg.slot_minutes || ' 分鐘' end,
              case when v_rooms_text <> '' then '會議室：' || E'\n' || v_rooms_text end,
              v_text,
              case when v_subscribe is not null then '一次訂閱全部場次（之後的異動會自動更新）：' || v_subscribe end,
              '平台：' || coalesce(p_site, '')),
    'html',
      '<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      || '<title>' || app.html(v_subject) || '</title></head>'
      || '<body style="margin:0;padding:0;background-color:#f5f4f0;">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f4f0" style="background-color:#f5f4f0;padding:24px 12px;'
      || 'font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',Arial,sans-serif;color:#161514;line-height:1.6;">'
      || '<tr><td align="center"><!--banner-->'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;'
      || 'border:1px solid #e4e1da;border-radius:16px;">'
      -- what the week holds, at a glance
      || '<tr><td bgcolor="#161514" style="padding:26px 24px 24px;background-color:#161514;border-radius:15px 15px 0 0;color:#ffffff;text-align:left;">'
      || '<p style="margin:0;font-size:12px;letter-spacing:.08em;color:#c9c5bb;">叁式 ULTRACOMBOS One Hour a Week · Office Hour</p>'
      || case when coalesce(p_name, '') <> '' then format('<p style="margin:16px 0 0;font-size:15px;color:#ffffff;">%s 您好</p>', app.html(p_name)) else '' end
      || format('<h1 style="margin:6px 0 0;font-size:26px;line-height:1.3;color:#ffffff;">%s</h1>',
                case when v_count = 0 then '這週沒有排到 Office Hour'
                     else app.html(coalesce(v_who || ' ', '')) || '這週有 <span style="color:#ff8f5c;">' || v_count || ' 場</span> Office Hour' end)
      || format('<p style="margin:8px 0 0;font-size:14px;color:#c9c5bb;">%s · 每場 %s 分鐘</p>', v_span, cfg.slot_minutes)
      || case when v_chips <> '' then '<p style="margin:14px 0 0;">' || v_chips || '</p>' else '' end
      || '</td></tr>'
      -- where, and the one-step calendar subscription
      || case when v_count > 0 then
           '<tr><td style="padding:20px 24px 0;text-align:left;">'
           || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fdeee4" style="background-color:#fdeee4;border-radius:12px;">'
           || '<tr><td style="padding:14px 16px;">'
           || format('<p style="margin:0;font-size:13px;font-weight:700;color:#b23a0b;">%s</p>',
                     case when v_many then '會議室 · 每位業師各自一間' else '會議室 · 每一場都在這裡' end)
           || v_rooms
           || '</td></tr></table>'
           || case when v_subscribe is not null then
                '<p style="margin:16px 0 0;">' || app.mail_btn(v_subscribe, '一鍵把全部場次加到 Google 日曆', 'dark') || '</p>'
                || '<p style="margin:0;font-size:12px;color:#5f5d57;">這是訂閱：之後新增、改時間或取消，日曆都會自動更新。也可以用每一場的按鈕只加一場</p>'
              else '' end
           || '</td></tr>'
         else
           '<tr><td style="padding:20px 24px 0;font-size:15px;text-align:left;">這週沒有安排場次，不用預留時間</td></tr>'
         end
      || v_days
      || '<tr><td style="padding:24px 24px 26px;font-size:12px;color:#5f5d57;text-align:left;">'
      || format('場次和題目以平台為準：<a href="%s" style="color:#161514;">%s</a><br>', app.html(p_site), app.html(p_site))
      || '這封信由 Office Hour 平台在每週一 08:00 自動寄出，有問題直接回覆這封信即可'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

-- The TAs' reminder carries the new name.
create or replace function app.mail_remind(p_week date, p_site text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_range text := to_char(p_week, 'FMMM/FMDD') || '–' || to_char(p_week + 6, 'FMMM/FMDD');
  v_deadline text := app.deadline_text(app.week_deadline(p_week));
  v_closed boolean := app.local_now() >= app.week_deadline(p_week);
  v_open boolean := exists (select 1 from app.weeks w where w.start_date = p_week and w.open);
  v_count int;
  v_want int;
  v_missing text;
  v_rows text := '';
  v_lines text := '';
  v_subject text;
  v_lead text;
  r record;
begin
  select count(*), coalesce(sum(rq.want), 0) into v_count, v_want
    from app.requests rq
    join app.weeks w on w.id = rq.week_id
    join app.groups g on g.id = rq.group_id
   where w.start_date = p_week and rq.status = 'open' and g.active;

  select string_agg('第 ' || g.no || ' 組', '、' order by g.no) into v_missing
    from app.groups g
   where g.active
     and not exists (select 1 from app.requests rq join app.weeks w on w.id = rq.week_id
                      where w.start_date = p_week and rq.group_id = g.id and rq.status = 'open');

  for r in
    select rq.group_id, rq.want, rq.topic,
           (select count(*) from app.request_slots x where x.request_id = rq.id) as slots
      from app.requests rq
      join app.weeks w on w.id = rq.week_id
      join app.groups g on g.id = rq.group_id
     where w.start_date = p_week and rq.status = 'open' and g.active
     order by g.no
  loop
    v_rows := v_rows || format(
      '<tr><td style="padding:12px 0;border-top:1px solid #e4e1da;">'
      || '<p style="margin:0;font-size:15px;font-weight:700;">%s</p>'
      || '<p style="margin:2px 0 0;font-size:14px;">%s</p>'
      || '<p style="margin:2px 0 0;font-size:13px;color:#5f5d57;">想要 %s 次 · 勾了 %s 個時段</p>'
      || '</td></tr>',
      app.html(app.group_title(r.group_id)), app.html(r.topic), r.want, r.slots);
    v_lines := v_lines || format(E'%s｜%s｜想要 %s 次，勾了 %s 個時段\n', app.group_title(r.group_id), r.topic, r.want, r.slots);
  end loop;

  v_subject := '【Office Hour】'
               || case when not v_open then '下週沒有開放預約'
                       when v_count = 0 then '下週沒有組別送出需求'
                       else '請審核下週需求：' || v_count || ' 組送出' end
               || '（' || v_range || '）';
  v_lead := case
    when not v_open then '下週沒有開放預約，不用排程'
    when v_closed then format('需求已在 %s 截止，%s 組送出，共想要 %s 次。請在週日 18:00 前排好並發布：18:00 會先寄預覽到助教信箱，週一 08:00 寄給老師',
                              v_deadline, v_count, v_want)
    else format('需求會在 %s 截止，目前 %s 組送出，共想要 %s 次。截止後請在週日 18:00 前排好並發布', v_deadline, v_count, v_want)
  end;

  return jsonb_build_object(
    'subject', v_subject,
    'count', v_count,
    'text', concat_ws(E'\n',
              v_lead,
              case when v_open and v_missing is not null then (case when v_closed then '沒有送出：' else '還沒送出：' end) || v_missing end,
              '',
              nullif(v_lines, ''),
              '打開排程：' || coalesce(p_site, '') || '#/admin'),
    'html',
      '<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      || '<title>' || app.html(v_subject) || '</title></head>'
      || '<body style="margin:0;padding:0;background-color:#f5f4f0;">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f4f0" style="background-color:#f5f4f0;padding:24px 12px;'
      || 'font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',Arial,sans-serif;color:#161514;line-height:1.6;">'
      || '<tr><td align="center">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;'
      || 'border:1px solid #e4e1da;border-radius:16px;">'
      || '<tr><td style="padding:28px 28px 4px;">'
      || '<p style="margin:0;font-size:12px;letter-spacing:.08em;color:#5f5d57;">叁式 ULTRACOMBOS One Hour a Week · 給助教</p>'
      || format('<h1 style="margin:6px 0 0;font-size:22px;line-height:1.35;">%s</h1>',
                case when v_open then '請審核下週的 Office Hour 需求' else '下週（' || v_range || '）沒有開放預約' end)
      || format('<p style="margin:8px 0 0;font-size:14px;color:#5f5d57;">%s</p>', v_range)
      || format('<p style="margin:12px 0 0;font-size:15px;">%s</p>', app.html(v_lead))
      || case when v_open and v_missing is not null then
           format('<p style="margin:8px 0 0;font-size:14px;"><b>%s</b>%s</p>',
                  case when v_closed then '沒有送出：' else '還沒送出：' end, app.html(v_missing))
         else '' end
      || '<p style="margin:18px 0 0;">' || app.mail_button(coalesce(p_site, '') || '#/admin', '打開排程', true) || '</p>'
      || '</td></tr>'
      || case when v_rows <> '' then
           '<tr><td style="padding:18px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
           || v_rows || '</table></td></tr>'
         else '' end
      || '<tr><td style="padding:22px 28px 26px;font-size:12px;color:#5f5d57;">'
      || '這封信由 Office Hour 平台在每週日 12:00 自動寄到助教信箱，可以在後台「寄信通知」關掉'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

drop table app.group_teachers;
drop function app.group_teachers_cap();

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('oh_booking_save', 'oh_booking_skip', 'oh_student_state', 'oh_admin_config', 'oh_admin_state', 'oh_admin_mail_preview',
                         'oh_admin_save', 'oh_teacher_state', 'oh_calendar')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
