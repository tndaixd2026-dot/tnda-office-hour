-- =====================================================================
-- Office Hour · two groups sharing one fixed hour
--
-- Groups 6 and 7 now share Joseph's Tuesday 18:00-19:00. A group that
-- books such a shared hour alone has the whole hour; when both book it,
-- each has half, in the order they booked (the first at 18:00). So a
-- session now has its own length (app.appointments.minutes; empty means
-- the course's slot) and every place that shows or exports a session's
-- end uses it: the student, teacher and admin pages, the calendar feeds,
-- the weekly email and the Discord messages.
--
-- The hour is split again each time a group books or skips it, until the
-- week closes; a cancellation after that leaves the other group's time
-- as it is (the admins can still move it). Moving a session to another
-- time on the board makes it a whole session again.
-- =====================================================================

alter table app.appointments
  add column minutes int check (minutes between 10 and 240);

-- How long a session lasts: its own length, else the course's slot.
create or replace function app.appt_minutes(p_minutes int) returns int
language sql stable set search_path = '' as $$
  select coalesce(p_minutes, (select s.slot_minutes from app.settings s where s.id = 1))
$$;

-- "10/21（三）18:00–18:30" for a session of its own length
create or replace function app.slot_text(p_d date, p_t time, p_minutes int) returns text
language sql stable set search_path = '' as $$
  select to_char(p_d, 'FMMM/FMDD') || '（' || app.wday(p_d) || '）' || app.hm(p_t) || '–'
         || app.hm(p_t + make_interval(mins => app.appt_minutes(p_minutes)))
$$;

-- The groups whose fixed slot is the same PM, weekday and time as this
-- group's, this group included, in group order.
create or replace function app.slot_sharers(p_group int) returns int[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(x.id order by x.no), '{}')
    from app.groups g
    join app.groups x on x.active and x.teacher_id = g.teacher_id and x.slot_dow = g.slot_dow and x.slot_time = g.slot_time
   where g.id = p_group and g.slot_dow is not null
$$;

-- The sessions that week in a group's shared hour, in the order they were booked.
create or replace function app.shared_sessions(p_group int, p_week int) returns bigint[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(a.id order by a.created_at, a.id), '{}')
    from app.groups g
    join app.weeks w on w.id = p_week
    join app.appointments a on a.week_id = p_week and a.status = 'confirmed' and a.teacher_id = g.teacher_id
                           and a.d = w.start_date + g.slot_dow - 1
                           and a.t >= g.slot_time
                           and a.t < g.slot_time + make_interval(mins => (select s.slot_minutes from app.settings s where s.id = 1))
   where g.id = p_group and g.slot_dow is not null
     and a.group_id = any (app.slot_sharers(p_group))
$$;

-- Where a group's new session starts: after those already booked in its
-- hour, at its share once the hour is split one way more.
create or replace function app.share_next(p_group int, p_week int) returns time
language sql stable set search_path = '' as $$
  select g.slot_time + make_interval(mins => m * (s.slot_minutes / (m + 1)))
    from app.groups g, app.settings s,
         (select cardinality(app.shared_sessions(p_group, p_week)) as m) x
   where g.id = p_group and s.id = 1
$$;

-- Splits a shared hour among the sessions booked in it: each an equal
-- part, in the order they were booked; one session has the whole hour.
create or replace function app.share_slot(p_group int, p_week int) returns void
language plpgsql set search_path = '' as $$
declare
  g app.groups;
  v_hour int := (select s.slot_minutes from app.settings s where s.id = 1);
  v_ids bigint[] := app.shared_sessions(p_group, p_week);
  n int := cardinality(v_ids);
begin
  select * into g from app.groups x where x.id = p_group;
  if n = 0 then
    return;
  end if;
  update app.appointments a
     set t = g.slot_time + make_interval(mins => (array_position(v_ids, a.id) - 1) * (v_hour / n)),
         minutes = case when n = 1 then null else v_hour / n end
   where a.id = any (v_ids)
     and (a.t, a.minutes) is distinct from
         (g.slot_time + make_interval(mins => (array_position(v_ids, a.id) - 1) * (v_hour / n)),
          case when n = 1 then null else v_hour / n end);
end $$;


-- Sessions say how long they are.
create or replace function app.appt_json(a app.appointments) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'week_id', a.week_id, 'group_id', a.group_id, 'teacher_id', a.teacher_id,
    'd', a.d, 't', app.hm(a.t), 'minutes', a.minutes, 'status', a.status,
    'created_by', a.created_by, 'created_at', app.iso(a.created_at),
    'published_at', app.iso(a.published_at), 'cancelled_at', app.iso(a.cancelled_at),
    'cancelled_by', a.cancelled_by, 'cancel_reason', a.cancel_reason)
$$;

-- The board can hand a shared half-hour to another PM (its start is not on
-- the hour), and moving a session to another time makes it whole again.
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
     or ((extract(epoch from p_t)::int % (cfg.slot_minutes * 60)) <> 0
         and p_t is distinct from (select x.t from app.appointments x where x.id = p_appt)) then
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
       set teacher_id = p_teacher, d = p_d, t = p_t,
           -- another PM keeps a session's length; another time makes it whole
           minutes = case when (a.d, a.t) is distinct from (p_d, p_t) then null else a.minutes end
     where a.id = p_appt
    returning * into v;
  end if;
  return v;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform app.err(case when v_constraint = 'appointments_group_slot' then 'GROUP_BUSY' else 'TEACHER_BUSY' end);
end $$;

-- Discord notices give each session its own length; a shared hour that is
-- split or whole again is a change of time too.
create or replace function app.appointments_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  -- drafts that were just published: one message per group
  for r in
    select n.group_id, n.week_id,
           string_agg('• ' || app.slot_text(n.d, n.t, n.minutes) || coalesce(' ' || app.room_of(n.teacher_id), ''), E'\n' order by n.d, n.t) as lines
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
      '**Office Hour 已取消**' || E'\n' || app.group_title(r.group_id) || E'\n• ' || app.slot_text(r.d, r.t, r.minutes)
      || coalesce(E'\n' || r.cancelled_by || ' 取消' || coalesce('：' || r.cancel_reason, ''), ''));
  end loop;

  -- confirmed sessions that moved
  for r in
    select n.*, o.d as old_d, o.t as old_t, o.minutes as old_minutes from new_rows n join old_rows o on o.id = n.id
     where n.status = 'confirmed' and o.status = 'confirmed' and (n.d, n.t, n.minutes) is distinct from (o.d, o.t, o.minutes)
  loop
    perform app.discord(r.group_id,
      '**Office Hour 時間異動**' || E'\n' || app.group_title(r.group_id)
      || E'\n• ' || app.slot_text(r.old_d, r.old_t, r.old_minutes) || ' → ' || app.slot_text(r.d, r.t, r.minutes)
      || case when r.minutes is not null then E'\n這週和同一時段的另一組各討論 ' || r.minutes || ' 分鐘' else '' end
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
      || E'\n• ' || app.slot_text(r.d, r.t, r.minutes) || '：'
      || (select t.name from app.teachers t where t.id = r.old_teacher) || ' → ' || (select t.name from app.teachers t where t.id = r.teacher_id)
      || coalesce(E'\n地點：' || app.room_of(r.teacher_id), ''));
  end loop;
  return null;
end $$;

-- Calendar feeds end each session when it ends.
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
    select a.id, a.d, a.t, a.minutes, a.teacher_id, gr.id as gid, te.name as tname,
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
      'DTEND:' || app.ics_stamp(r.d, r.t + make_interval(mins => app.appt_minutes(r.minutes))),
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

-- Students see a session's length and who shares their hour.
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
               'room', app.room_of(g.teacher_id),
               -- the other groups sharing this hour
               'shared', (select coalesce(jsonb_agg(x.no order by x.no), '[]'::jsonb) from app.groups x
                           where x.id = any (app.slot_sharers(g.id)) and x.id <> g.id)) end,
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
                       'id', a.id, 'week_id', a.week_id, 'd', a.d, 't', app.hm(a.t), 'minutes', a.minutes, 'status', a.status,
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

-- The PMs see each session's length.
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
                   'id', a.id, 'd', a.d, 't', app.hm(a.t), 'minutes', a.minutes, 'status', a.status,
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

-- Booking a shared hour splits it with the groups that booked it first.
create or replace function app.booking_save(
  s app.sessions, p_week int, p_topic text, p_questions text, p_progress text, p_link text,
  p_version int default null
) returns jsonb
language plpgsql set search_path = '' as $$
declare
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
      -- after the sessions already booked in a shared hour
      insert into app.appointments (week_id, group_id, teacher_id, d, t, status, created_by, created_at, published_at)
      values (p_week, s.group_id, g.teacher_id, v_d, app.share_next(g.id, p_week), 'confirmed', s.name, app.now(), app.now());
    exception when unique_violation then
      perform app.err('SLOT_TAKEN');
    end;
    perform app.share_slot(g.id, p_week);
  end if;

  perform app.log(s, case when v_new then 'request.created' else 'request.updated' end, s.group_id, p_week,
                  jsonb_build_object('topic', v_topic));
  return app.request_json(r.id);
end $$;

-- Skipping a shared hour gives it back to the others.
create or replace function app.booking_skip(s app.sessions, p_week int, p_version int default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
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
  -- the groups still in a shared hour have it to themselves
  perform app.share_slot(s.group_id, p_week);
  perform app.log(s, 'request.skipped', s.group_id, p_week);
  return app.request_json(r.id);
end $$;

-- The weekly email ends each session when it ends.
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
  -- sent the day before the week starts it is next week's; on its Monday, this week's
  v_ahead boolean := p_week > app.today();
  v_when text := case when v_ahead then '下週' else '這週' end;
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
               || case when v_ahead then '下週' else '本週' end
               || case when v_count = 0 then '沒有場次' else ' ' || v_count || ' 場' end
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
      select a.t, a.minutes, a.teacher_id, te.name as teacher, rq.topic, rq.progress, nullif(rq.questions, '') as questions, rq.link, a.group_id
        from app.appointments a
        join app.teachers te on te.id = a.teacher_id
        left join app.requests rq on rq.week_id = a.week_id and rq.group_id = a.group_id
       where a.status = 'confirmed' and a.d = d.d and (v_all or a.teacher_id = any (p_teachers))
       order by a.t, te.sort
    loop
      v_end := r.t + make_interval(mins => app.appt_minutes(r.minutes));
      v_href := app.gcal_link(
        'Office Hour · ' || r.teacher || ' · ' || app.group_title(r.group_id) || coalesce('｜' || r.topic, ''),
        d.d, r.t, app.appt_minutes(r.minutes),
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
              case when v_count = 0 then v_when || '（' || v_range || '）沒有排到 Office Hour'
                   else v_when || '（' || v_range || '）' || coalesce(v_who || ' ', '') || '有 ' || v_count || ' 場 Office Hour，每場 '
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
                case when v_count = 0 then v_when || '沒有排到 Office Hour'
                     else app.html(coalesce(v_who || ' ', '')) || v_when || '有 <span style="color:#ff8f5c;">' || v_count || ' 場</span> Office Hour' end)
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
           '<tr><td style="padding:20px 24px 0;font-size:15px;text-align:left;">' || v_when || '沒有安排場次，不用預留時間</td></tr>'
         end
      || v_days
      || '<tr><td style="padding:24px 24px 26px;font-size:12px;color:#5f5d57;text-align:left;">'
      || format('場次和題目以平台為準：<a href="%s" style="color:#161514;">%s</a><br>', app.html(p_site), app.html(p_site))
      || '這封信由 Office Hour 平台在每週日 08:00 自動寄出，有問題可在 Discord 聯絡 TNDA 助教'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

-- "👥 和第 7 組共用這一小時…": for a group in a shared hour, how it is split
-- (p_minutes: the session's length, when split), else null.
create or replace function app.discord_share_note(p_group int, p_minutes int) returns text
language sql stable set search_path = '' as $$
  select case when p_minutes is not null
              then '👥 這週和' || o.names || '共用這一小時，各 ' || p_minutes || ' 分鐘'
              else '👥 和' || o.names || '共用這一小時：只有一組預約就討論 ' || s.slot_minutes || ' 分鐘，都預約就各 '
                   || s.slot_minutes / (o.n + 1) || ' 分鐘，先約的先開始' end
    from app.settings s,
         (select string_agg('第 ' || x.no || ' 組', '、' order by x.no) as names, count(*) as n
            from app.groups x where x.id = any (app.slot_sharers(p_group)) and x.id <> p_group) o
   where s.id = 1 and o.n > 0
$$;


create or replace function app.discord_slot(p_group int, p_week int) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select app.slot_text(a.d, a.t, a.minutes) || case when s.show_teacher_names then ' · ' || t.name else '' end
       from app.appointments a join app.teachers t on t.id = a.teacher_id
      where a.group_id = p_group and a.week_id = p_week and a.status = 'confirmed'
      order by a.d, a.t limit 1),
    (select app.slot_text(w.start_date + g.slot_dow - 1, g.slot_time) || case when s.show_teacher_names then ' · ' || t.name else '' end
       from app.groups g join app.weeks w on w.id = p_week join app.teachers t on t.id = g.teacher_id
      where g.id = p_group and g.slot_dow is not null))
    from app.settings s where s.id = 1
$$;

create or replace function app.discord_message(p_group int, p_week int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  g app.groups;
  w app.weeks;
  r app.requests;
  a app.appointments;
  cfg app.settings := app.cfg();
  v_site text := (select b.site from app.discord_bot b where b.id = 1);
  v_open boolean := app.week_bookable(p_week, p_group);
  v_holiday text := app.fixed_holiday(p_group, p_week);
  v_deadline timestamp;
  v_wk text;
  v_d date;
  v_t time;
  v_teacher int;
  v_when text;
  v_who text;
  v_room text;
  v_text text;
  v_buttons jsonb := '[]';
begin
  select * into g from app.groups x where x.id = p_group;
  select * into w from app.weeks x where x.id = p_week;
  select * into r from app.requests x where x.group_id = p_group and x.week_id = p_week;
  select * into a from app.appointments x where x.group_id = p_group and x.week_id = p_week
   order by x.status = 'confirmed' desc, x.id desc limit 1;
  v_deadline := app.week_deadline(w.start_date);
  v_wk := coalesce(nullif(w.label, ''), to_char(w.start_date, 'FMMM/FMDD') || ' 那週');
  -- the session as the admins left it (moved, another PM), else the fixed slot
  if a.status = 'confirmed' then
    v_d := a.d; v_t := a.t; v_teacher := a.teacher_id;
  else
    v_d := w.start_date + g.slot_dow - 1; v_t := g.slot_time; v_teacher := g.teacher_id;
  end if;
  v_when := coalesce(app.slot_text(v_d, v_t, case when a.status = 'confirmed' then a.minutes end), '');
  v_who := app.discord_escape(app.group_title(p_group))
           || case when cfg.show_teacher_names
                   then coalesce(' · ' || app.discord_escape((select t.name from app.teachers t where t.id = v_teacher)), '')
                   else '' end;
  v_room := app.room_of(v_teacher);
  v_room := case when v_room ~ '^https?://\S+$' then '🔗 [進入討論室](<' || v_room || '>)' else app.discord_escape(v_room) end;

  if not w.open then
    v_text := '## ' || v_wk || ' 暫停'
              || E'\n-# 這週不排 Office Hour，有問題可以問助教';
  elsif v_holiday is not null then
    v_text := '## ' || v_wk || ' 停一次'
              || E'\n' || to_char(v_d, 'FMMM/FMDD') || '（' || app.wday(v_d) || '）遇到' || app.discord_escape(v_holiday) || '，這週不用預約';
  elsif r.status = 'open' and a.status = 'cancelled' then
    v_text := '## ' || v_wk || ' 的 Office Hour 已取消'
              || E'\n### ~~' || app.slot_text(a.d, a.t, a.minutes) || '~~'
              || coalesce(E'\n-# ' || app.discord_escape(a.cancelled_by) || ' 取消'
                          || coalesce('：' || app.discord_escape(a.cancel_reason), ''), '');
  elsif r.status = 'open' then
    v_text := '## ✅ ' || v_wk || ' 已預約 Office Hour'
              || E'\n### ' || v_when
              || E'\n' || v_who || coalesce(' · ' || v_room, '')
              || coalesce(E'\n' || app.discord_share_note(p_group, case when a.status = 'confirmed' then a.minutes end), '')
              || E'\n> 💬 **' || app.discord_escape(r.topic) || '**'
              || E'\n-# ' || app.discord_escape(r.author) || ' 填的'
              || case when v_open then ' · ' || app.deadline_text(v_deadline) || ' 前都可以修改或改成不預約' else '' end;
  elsif r.status = 'skipped' then
    v_text := '## ' || v_wk || ' 這週不約'
              || E'\n' || v_when || ' 不排討論'
              || E'\n-# ' || app.discord_escape(r.author) || ' 決定的'
              || case when v_open then ' · ' || app.deadline_text(v_deadline) || ' 前都可以改成要預約' else '' end;
  elsif v_open then
    v_text := '## 📅 ' || v_wk || ' 要約 Office Hour 嗎？'
              || E'\n### ' || v_when
              || E'\n' || v_who
              || coalesce(E'\n' || app.discord_share_note(p_group, null), '')
              -- Discord shows <t:…:R> as a countdown in each reader's language ("4 天後")
              || E'\n⏰ 請在 **' || app.deadline_text(v_deadline) || '** 前決定（<t:'
              || extract(epoch from (v_deadline at time zone cfg.timezone))::bigint || ':R>）'
              || E'\n-# 按「要預約」填好題目、想問的問題、目前進度和雲端資料夾連結，送出就排定';
  else
    v_text := '## ' || v_wk || ' 沒有預約'
              || E'\n-# 已在 ' || app.deadline_text(v_deadline) || ' 截止，這週不排討論';
  end if;

  -- 不預約 carries the version it was drawn with: pressed on a message
  -- that no longer shows what the group decided, it only redraws it
  if v_open and r.status = 'open' and a.status is distinct from 'cancelled' then
    v_buttons := jsonb_build_array(
      jsonb_build_object('type', 2, 'style', 2, 'label', '修改內容', 'custom_id', 'oh:book:' || p_week),
      jsonb_build_object('type', 2, 'style', 4, 'label', '不預約', 'custom_id', 'oh:skip:' || p_week || ':' || r.version));
  elsif v_open and r.status = 'skipped' then
    v_buttons := jsonb_build_array(
      jsonb_build_object('type', 2, 'style', 1, 'label', '要預約', 'custom_id', 'oh:book:' || p_week));
  elsif v_open and r.status is distinct from 'open' then
    v_buttons := jsonb_build_array(
      jsonb_build_object('type', 2, 'style', 1, 'label', '要預約', 'custom_id', 'oh:book:' || p_week),
      jsonb_build_object('type', 2, 'style', 2, 'label', '不預約', 'custom_id', 'oh:skip:' || p_week || ':' || coalesce(r.version, 0)));
  end if;
  if v_site is not null then
    v_buttons := v_buttons || jsonb_build_array(jsonb_build_object('type', 2, 'style', 5, 'label', '打開網站', 'url', v_site));
  end if;

  return jsonb_build_object(
    'content', left(v_text, 1900),
    'components', case when jsonb_array_length(v_buttons) > 0
                       then jsonb_build_array(jsonb_build_object('type', 1, 'components', v_buttons))
                       else '[]'::jsonb end,
    -- never let student-typed text ping @everyone or roles
    'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb));
end $$;

create or replace function app.discord_summary(p_group int, p_week int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  g app.groups;
  w app.weeks;
  r app.requests;
  a app.appointments;
  cfg app.settings := app.cfg();
  v_holiday text := app.fixed_holiday(p_group, p_week);
  v_wk text;
  v_d date;
  v_text text;
begin
  select * into g from app.groups x where x.id = p_group;
  select * into w from app.weeks x where x.id = p_week;
  select * into r from app.requests x where x.group_id = p_group and x.week_id = p_week;
  select * into a from app.appointments x where x.group_id = p_group and x.week_id = p_week
   order by x.status = 'confirmed' desc, x.id desc limit 1;
  v_wk := '下週（' || coalesce(nullif(w.label, ''), to_char(w.start_date, 'FMMM/FMDD') || ' 那週') || '）';
  v_d := w.start_date + g.slot_dow - 1;

  if not w.open then
    v_text := '## 📌 ' || v_wk || '暫停'
              || E'\n-# 這週不排 Office Hour，有問題可以問助教';
  elsif v_holiday is not null then
    v_text := '## 📌 ' || v_wk || '停一次'
              || E'\n' || to_char(v_d, 'FMMM/FMDD') || '（' || app.wday(v_d) || '）遇到' || app.discord_escape(v_holiday) || '，這週不排討論';
  elsif a.status = 'confirmed' then
    v_text := '## 📌 ' || v_wk || '的 Office Hour'
              || E'\n### ' || app.slot_text(a.d, a.t, a.minutes)
              || E'\n' || app.discord_who(p_group, a.teacher_id)
              || coalesce(E'\n' || app.discord_share_note(p_group, a.minutes), '')
              || coalesce(E'\n> 💬 **' || app.discord_escape(nullif(r.topic, '')) || '**', '')
              || E'\n-# 當天 08:00 會再提醒一次。不能來的話，開始前 ' || cfg.cancel_hours || ' 小時以上可以在網站上取消，來不及就告訴助教';
  elsif a.status = 'cancelled' then
    v_text := '## 📌 ' || v_wk || '的 Office Hour 已取消'
              || E'\n### ~~' || app.slot_text(a.d, a.t, a.minutes) || '~~'
              || coalesce(E'\n-# ' || app.discord_escape(a.cancelled_by) || ' 取消'
                          || coalesce('：' || app.discord_escape(a.cancel_reason), ''), '');
  elsif r.status = 'skipped' then
    v_text := '## 📌 ' || v_wk || '不排 Office Hour'
              || E'\n-# 你們選了這週不約（' || app.discord_escape(r.author) || ' 決定的）';
  else
    v_text := '## 📌 ' || v_wk || '沒有 Office Hour'
              || E'\n-# ' || app.deadline_text(app.week_deadline(w.start_date)) || ' 前沒有預約，這週不排討論';
  end if;

  return jsonb_build_object(
    'content', left(v_text, 1900),
    'components', app.discord_site_button(),
    'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb));
end $$;

-- The day's reminder, for a session of its own length.
create or replace function app.discord_today_message(p_group int, p_d date, p_t time, p_teacher int, p_topic text, p_minutes int) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'content', left(
      '## ⏰ 今天 ' || to_char(p_d, 'FMMM/FMDD') || '（' || app.wday(p_d) || '）有 Office Hour'
      || E'\n### ' || app.hm(p_t) || '–' || app.hm(p_t + make_interval(mins => app.appt_minutes(p_minutes)))
      || E'\n' || app.discord_who(p_group, p_teacher)
      || coalesce(E'\n> 💬 **' || app.discord_escape(p_topic) || '**', '')
      || E'\n-# 時間到了點上面的連結進入討論室。討論時 Google Meet 會錄影，僅作為紀錄使用', 1900),
    'components', app.discord_site_button(),
    'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb))
    from app.settings s where s.id = 1
$$;

create or replace function app.discord_today_message(p_group int, p_d date, p_t time, p_teacher int, p_topic text) returns jsonb
language sql stable set search_path = '' as $$
  select app.discord_today_message(p_group, p_d, p_t, p_teacher, p_topic, null)
$$;


create or replace function app.discord_today_outbox(p_force boolean default false, p_only int default null)
returns table (group_id int, group_no int, on_date date, channel_id text, payload jsonb)
language sql stable set search_path = '' as $$
  select distinct on (g.no) g.id, g.no, a.d, g.discord_channel,
         app.discord_today_message(g.id, a.d, a.t, a.teacher_id,
                                   (select nullif(r.topic, '') from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id),
                                   a.minutes)
    from app.appointments a
    join app.groups g on g.id = a.group_id and g.active and g.discord_channel is not null and g.discord_ready
   where a.status = 'confirmed' and a.d = app.today() and a.d + a.t > app.local_now()
     and (p_only is null or g.no = p_only)
     and (p_force or not exists (select 1 from app.discord_notes n
                                  where n.kind = 'today' and n.group_id = g.id and n.on_date = a.d))
   order by g.no, a.t
$$;

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_calendar', 'oh_student_state', 'oh_teacher_state')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
