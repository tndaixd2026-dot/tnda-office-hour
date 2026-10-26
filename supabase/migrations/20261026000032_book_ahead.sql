-- =====================================================================
-- Office Hour · book any week ahead
--
-- A group may book (or skip) any future week, not only the next one: the
-- one limit is each week's deadline, Saturday 20:00 of the week before.
-- Booking and skipping move into app.booking_save / app.booking_skip,
-- which take the acting session, so that the Discord buttons (next
-- migration) book through exactly the same rules as the site.
-- =====================================================================

-- The next week to decide: the first open week still before its deadline.
create or replace function app.booking_week() returns int
language sql stable set search_path = '' as $$
  select w.id from app.weeks w
   where w.open and app.local_now() < app.week_deadline(w.start_date)
   order by w.start_date limit 1
$$;

-- A week this group can book now: open, before its deadline, with a fixed
-- slot that is not a holiday.
create or replace function app.week_bookable(p_week int, p_group int) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from app.weeks w
                  where w.id = p_week and w.open and app.local_now() < app.week_deadline(w.start_date))
     and exists (select 1 from app.groups g
                  where g.id = p_group and g.teacher_id is not null and g.slot_dow is not null)
     and app.fixed_holiday(p_group, p_week) is null
$$;

-- Book a week's fixed slot, or update the booking. The session is
-- confirmed at once, unless the admins already placed or cancelled one.
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

-- Say the group skips a week; a booked session that week goes away.
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
  perform app.log(s, 'request.skipped', s.group_id, p_week);
  return app.request_json(r.id);
end $$;

create or replace function public.oh_booking_save(
  p_token text, p_week int, p_topic text, p_questions text, p_progress text, p_link text,
  p_version int default null
) returns jsonb
language sql security definer set search_path = '' as $$
  select app.booking_save(app.session(p_token, array['student']), p_week, p_topic, p_questions, p_progress, p_link, p_version)
$$;

create or replace function public.oh_booking_skip(p_token text, p_week int, p_version int default null) returns jsonb
language sql security definer set search_path = '' as $$
  select app.booking_skip(app.session(p_token, array['student']), p_week, p_version)
$$;

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_booking_save', 'oh_booking_skip')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
