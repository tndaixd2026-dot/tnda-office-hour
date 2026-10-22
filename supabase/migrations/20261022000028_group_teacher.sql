-- =====================================================================
-- Office Hour · each group can be paired with one PM
--
-- An admin can pair a group with one of the teachers (never the shared
-- account) and change it at any time on the groups page. A paired group
-- only sees, requests and is auto-scheduled into that teacher's open
-- slots; placing it with another teacher by hand is a soft issue
-- (OTHER_TEACHER) the admin confirms. Unpaired groups work as before.
-- =====================================================================

alter table app.groups add column teacher_id int references app.teachers (id) on delete set null;

drop trigger if exists not_team on app.groups;
create trigger not_team before insert or update of teacher_id on app.groups
  for each row execute function app.not_team();

-- The open slots of a week that a group can use: its teacher's, or everyone's.
create or replace function app.group_slots(p_week int, p_group int)
returns table (d date, t time, teacher_id int)
language sql stable set search_path = '' as $$
  select ws.d, ws.t, ws.teacher_id
    from app.week_slots(p_week) ws
   where ws.teacher_id = coalesce((select g.teacher_id from app.groups g where g.id = p_group), ws.teacher_id)
$$;

-- A week this group can still act on: open, before its deadline, with slots for it.
create or replace function app.week_bookable(p_week int, p_group int) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from app.weeks w
     where w.id = p_week and w.open
       and app.local_now() < app.week_deadline(w.start_date)
       and exists (select 1 from app.group_slots(w.id, p_group)))
$$;

-- Placing a paired group with another teacher needs the admin to confirm.
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
  -- a paired group meets its own teacher
  if exists (select 1 from app.groups g
              where g.id = p_group and g.teacher_id is not null and g.teacher_id <> p_teacher) then
    v_issues := array_append(v_issues, 'OTHER_TEACHER');
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
  if not exists (select 1 from app.requests r
                   join app.request_slots rs on rs.request_id = r.id
                  where r.week_id = p_week and r.group_id = p_group and r.status = 'open'
                    and rs.d = p_d and rs.t = p_t) then
    v_issues := array_append(v_issues, 'NOT_REQUESTED');
  end if;
  if p_d + p_t < app.local_now() then
    v_issues := array_append(v_issues, 'PAST');
  end if;
  -- one meeting room: one group per time slot, whatever the teacher
  if exists (select 1 from app.appointments a
              where a.d = p_d and a.t = p_t and a.group_id <> p_group
                and a.status <> 'cancelled' and a.id is distinct from p_appt) then
    v_issues := array_append(v_issues, 'SLOT_TAKEN');
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

-- Students see only the slots their group can use, and their teacher when names are shown.
create or replace function public.oh_student_state(p_token text, p_week int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  cfg app.settings := app.cfg();
  v_today date := app.today();
  v_week int := p_week;
  v_late boolean;
begin
  if v_week is null or not exists (select 1 from app.weeks w where w.id = v_week) then
    select w.id into v_week from app.weeks w
     where app.week_bookable(w.id, s.group_id) order by w.start_date limit 1;
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
    'pair', (select te.name from app.groups g join app.teachers te on te.id = g.teacher_id
              where g.id = s.group_id and cfg.show_teacher_names),
    'members', (select coalesce(jsonb_agg(m.name order by m.first), '[]'::jsonb)
                  from (select x.name, min(x.created_at) as first from app.sessions x
                         where x.group_id = s.group_id and x.revoked_at is null group by x.name) m),
    'week_id', v_week,
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', w.id, 'start', w.start_date, 'label', w.label, 'open', w.open, 'note', w.note,
                'bookable', app.week_bookable(w.id, s.group_id),
                'deadline', to_char(app.week_deadline(w.start_date), 'YYYY-MM-DD HH24:MI'),
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
                       'cancel_reason', a.cancel_reason, 'cancelled_by', a.cancelled_by,
                       'can_cancel', a.status = 'confirmed'
                                     and a.d + a.t > app.local_now() + make_interval(hours => cfg.cancel_hours),
                       'topic', (select r.topic from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
                     ) order by a.d, a.t), '[]'::jsonb)
                     from app.appointments a join app.teachers te on te.id = a.teacher_id
                    where a.group_id = s.group_id
                      and (a.status = 'confirmed' or (a.status = 'cancelled' and a.published_at is not null)))
  );
end $$;

-- Requests only take slots the group can use.
create or replace function public.oh_request_save(
  p_token text, p_week int, p_topic text, p_progress text, p_link text,
  p_want int, p_slots jsonb, p_version int default null, p_questions text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  cfg app.settings := app.cfg();
  w app.weeks;
  r app.requests;
  v_topic text := app.clean(p_topic);
  v_progress text := app.clean_multiline(p_progress);
  v_questions text := app.clean_multiline(p_questions);
  v_link text := app.clean(p_link);
  v_slots timestamp[];
  v_valid timestamp[];
  v_new boolean := false;
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
  if v_topic is null or length(v_topic) > 80 then
    perform app.err('VALIDATION', 'topic');
  end if;
  if v_progress is null or length(v_progress) > 1000 then
    perform app.err('VALIDATION', 'progress');
  end if;
  if length(v_questions) > 1000 then
    perform app.err('VALIDATION', 'questions');
  end if;
  if v_link is not null and (length(v_link) > 500 or v_link !~* '^https?://[^\s/?#]+\.[^\s]*$') then
    perform app.err('VALIDATION', 'link');
  end if;
  if p_want is null or p_want < 1 or p_want > cfg.week_cap then
    perform app.err('VALIDATION', 'want');
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) = 0 or jsonb_array_length(p_slots) > 200 then
    perform app.err('VALIDATION', 'slots');
  end if;
  begin
    select array_agg(distinct ((e ->> 'd')::date + (e ->> 't')::time)) into v_slots
      from jsonb_array_elements(p_slots) e;
  exception when others then
    perform app.err('VALIDATION', 'slots');
  end;
  if array_position(v_slots, null) is not null then
    perform app.err('VALIDATION', 'slots');
  end if;

  v_valid := array(select distinct ws.d + ws.t from app.group_slots(p_week, s.group_id) ws);
  if exists (select 1 from unnest(v_slots) x where not (x = any (v_valid))) then
    perform app.err('SLOT_INVALID');
  end if;

  select * into r from app.requests x
   where x.week_id = p_week and x.group_id = s.group_id
   for update;
  if found then
    if p_version is distinct from r.version then
      perform app.err('CONFLICT');
    end if;
  end if;

  if r.id is null then
    insert into app.requests (week_id, group_id, topic, progress, questions, link, want, author, status, version, created_at, updated_at)
    values (p_week, s.group_id, v_topic, v_progress, coalesce(v_questions, ''), v_link, p_want, s.name, 'open', 1, app.now(), app.now())
    on conflict (week_id, group_id) do nothing
    returning * into r;
    if r.id is null then
      perform app.err('CONFLICT');
    end if;
    v_new := true;
  else
    update app.requests x
       set topic = v_topic, progress = v_progress, link = v_link, want = p_want,
           -- a page loaded before the field existed sends none: keep what is there
           questions = case when p_questions is null then x.questions else coalesce(v_questions, '') end,
           author = s.name, status = 'open', version = x.version + 1, updated_at = app.now()
     where x.id = r.id
    returning * into r;
  end if;

  delete from app.request_slots rs where rs.request_id = r.id;
  insert into app.request_slots (request_id, d, t)
  select r.id, x::date, x::time from unnest(v_slots) x;

  perform app.log(s, case when v_new then 'request.created' else 'request.updated' end, s.group_id, p_week,
                  jsonb_build_object('topic', v_topic, 'slots', cardinality(v_slots), 'want', p_want));
  return app.request_json(r.id);
end $$;

-- The groups page shows and sets each group's teacher.
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
                 'webhook', g.webhook, 'teacher_id', g.teacher_id,
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
                   'id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'sort', x.sort, 'team', x.team,
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

-- The board and the auto-scheduler know each group's teacher.
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
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'active', x.active)
                   order by x.sort, x.id), '[]'::jsonb) from app.teachers x where not x.team),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'no', g.no, 'name', g.name, 'active', g.active, 'teacher_id', g.teacher_id,
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

-- Saving a group takes its teacher (null to unpair).
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
      insert into app.groups (no, name, code, active, webhook, teacher_id)
      values (coalesce((p ->> 'no')::int, (select coalesce(max(x.no), 0) + 1 from app.groups x)),
              coalesce(app.clean(p ->> 'name'), ''), app.new_code(8),
              coalesce((p ->> 'active')::boolean, true), app.clean(p ->> 'webhook'),
              nullif(p ->> 'teacher_id', '')::int)
      returning id into v_id;
    else
      update app.groups x set
        no      = case when p ? 'no'      then (p ->> 'no')::int else x.no end,
        name    = case when p ? 'name'    then coalesce(app.clean(p ->> 'name'), '') else x.name end,
        active  = case when p ? 'active'  then (p ->> 'active')::boolean else x.active end,
        webhook = case when p ? 'webhook' then app.clean(p ->> 'webhook') else x.webhook end,
        teacher_id = case when p ? 'teacher_id' then nullif(p ->> 'teacher_id', '')::int else x.teacher_id end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'group'); end if;
    end if;
    perform app.log(s, 'config.group', v_id, null);
    return (select jsonb_build_object('id', g.id, 'no', g.no, 'name', g.name, 'code', g.code,
                                      'active', g.active, 'webhook', g.webhook, 'teacher_id', g.teacher_id)
              from app.groups g where g.id = v_id);

  when 'teacher' then
    if v_id is null then
      insert into app.teachers (name, code, active, sort)
      values (app.clean(p ->> 'name'), app.new_code(10), coalesce((p ->> 'active')::boolean, true),
              coalesce((p ->> 'sort')::int, (select coalesce(max(x.sort), 0) + 1 from app.teachers x)))
      returning id into v_id;
    else
      update app.teachers x set
        name   = case when p ? 'name'   then app.clean(p ->> 'name') else x.name end,
        active = case when p ? 'active' then (p ->> 'active')::boolean else x.active end,
        sort   = case when p ? 'sort'   then (p ->> 'sort')::int else x.sort end
      where x.id = v_id;
      if not found then perform app.err('NOT_FOUND', 'teacher'); end if;
    end if;
    perform app.log(s, 'config.teacher', null, null, jsonb_build_object('teacher_id', v_id));
    return (select jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'active', x.active, 'sort', x.sort)
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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('oh_student_state', 'oh_request_save', 'oh_admin_config', 'oh_admin_state', 'oh_admin_save')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
