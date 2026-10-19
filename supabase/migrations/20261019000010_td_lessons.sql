-- =====================================================================
-- Office Hour · TD 專班課表
--
-- The timetable of the TD classes the TAs teach for the Wednesday VSAI
-- course. Anyone may read it without signing in (oh_lessons, and a
-- calendar feed); only admins change it. Every lesson is in the same
-- online room, so two lessons may never overlap.
-- =====================================================================

-- The page header: one row.
create table app.lesson_info (
  id         int primary key default 1 check (id = 1),
  title      text not null default 'TD 專班課表' check (length(title) between 1 and 40),
  subtitle   text not null default '' check (length(subtitle) <= 80),
  place      text not null default '' check (length(place) <= 200),
  note       text not null default '' check (length(note) <= 500),
  updated_at timestamptz not null default now()
);
insert into app.lesson_info (id, subtitle) values (1, 'TNDA 115-1 ・ 連我阿公都會之 TD 專班');

create table app.lessons (
  id         int generated always as identity primary key,
  d          date not null,
  start_time time not null,
  end_time   time not null,
  teacher    text not null check (length(teacher) between 1 and 20),
  kind       text not null check (kind in ('基礎教學', '案例分享', '解惑時間')),
  title      text not null default '' check (length(title) <= 80),
  topic      text not null default '' check (length(topic) <= 1000),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index lessons_d_idx on app.lessons (d, start_time);

alter table app.lesson_info enable row level security;
alter table app.lessons enable row level security;
revoke all on app.lesson_info, app.lessons from public;

drop trigger if exists ping on app.lesson_info;
create trigger ping after insert or update or delete on app.lesson_info
  for each statement execute function app.ping();
drop trigger if exists ping on app.lessons;
create trigger ping after insert or update or delete on app.lessons
  for each statement execute function app.ping();

-- The semester as first planned.
insert into app.lessons (d, start_time, end_time, teacher, kind)
select v.d::date, v.s::time, v.e::time, v.teacher, v.kind
  from (values
  ('2026-10-26', '21:00', '22:00', '浡崴', '基礎教學'),
  ('2026-10-27', '21:00', '22:00', '哲瑜', '基礎教學'),
  ('2026-11-02', '21:00', '22:00', '浡崴', '基礎教學'),
  ('2026-11-03', '21:00', '22:00', '哲瑜', '基礎教學'),
  ('2026-11-06', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-11-07', '17:00', '18:00', '浡崴', '基礎教學'),
  ('2026-11-07', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-11-08', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2026-11-08', '11:00', '12:00', '哲瑜', '基礎教學'),
  ('2026-11-08', '17:00', '18:00', '浡崴', '案例分享'),
  ('2026-11-08', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-11-09', '21:00', '22:00', '浡崴', '基礎教學'),
  ('2026-11-10', '21:00', '22:00', '浡崴', '案例分享'),
  ('2026-11-13', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-11-14', '10:00', '11:00', '哲瑜', '解惑時間'),
  ('2026-11-14', '11:00', '12:00', '哲瑜', '基礎教學'),
  ('2026-11-14', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-11-15', '10:00', '11:00', '哲瑜', '解惑時間'),
  ('2026-11-15', '11:00', '12:00', '哲瑜', '基礎教學'),
  ('2026-11-16', '21:00', '22:00', '浡崴', '解惑時間'),
  ('2026-11-17', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-11-20', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2026-11-21', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2026-11-21', '11:00', '12:00', '哲瑜', '案例分享'),
  ('2026-11-21', '17:00', '18:00', '浡崴', '基礎教學'),
  ('2026-11-21', '20:00', '21:00', '浡崴', '案例分享'),
  ('2026-11-21', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2026-11-22', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2026-11-22', '17:00', '18:00', '浡崴', '解惑時間'),
  ('2026-11-22', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-11-23', '21:00', '22:00', '浡崴', '案例分享'),
  ('2026-11-24', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-11-27', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2026-11-28', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2026-11-28', '11:00', '12:00', '哲瑜', '案例分享'),
  ('2026-11-28', '17:00', '18:00', '浡崴', '解惑時間'),
  ('2026-11-28', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-11-28', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2026-11-29', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2026-11-29', '17:00', '18:00', '浡崴', '案例分享'),
  ('2026-11-29', '20:00', '21:00', '浡崴', '解惑時間'),
  ('2026-11-30', '21:00', '22:00', '浡崴', '基礎教學'),
  ('2026-12-01', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-12-04', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2026-12-05', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2026-12-05', '17:00', '18:00', '浡崴', '案例分享'),
  ('2026-12-05', '20:00', '21:00', '浡崴', '解惑時間'),
  ('2026-12-05', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-12-06', '10:00', '11:00', '哲瑜', '解惑時間'),
  ('2026-12-06', '17:00', '18:00', '浡崴', '基礎教學'),
  ('2026-12-06', '20:00', '21:00', '浡崴', '案例分享'),
  ('2026-12-07', '21:00', '22:00', '浡崴', '解惑時間'),
  ('2026-12-08', '21:00', '22:00', '哲瑜', '基礎教學'),
  ('2026-12-11', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-12-12', '10:00', '11:00', '哲瑜', '解惑時間'),
  ('2026-12-12', '17:00', '18:00', '浡崴', '基礎教學'),
  ('2026-12-12', '20:00', '21:00', '浡崴', '案例分享'),
  ('2026-12-12', '21:00', '22:00', '哲瑜', '基礎教學'),
  ('2026-12-13', '10:00', '11:00', '哲瑜', '案例分享'),
  ('2026-12-13', '17:00', '18:00', '浡崴', '解惑時間'),
  ('2026-12-13', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-12-14', '21:00', '22:00', '浡崴', '案例分享'),
  ('2026-12-15', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2026-12-18', '21:00', '22:00', '浡崴', '解惑時間'),
  ('2026-12-19', '17:00', '18:00', '浡崴', '基礎教學'),
  ('2026-12-19', '20:00', '21:00', '浡崴', '案例分享'),
  ('2026-12-20', '17:00', '18:00', '浡崴', '解惑時間'),
  ('2026-12-20', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-12-21', '21:00', '22:00', '浡崴', '案例分享'),
  ('2026-12-22', '21:00', '22:00', '哲瑜', '基礎教學'),
  ('2026-12-25', '21:00', '22:00', '哲瑜', '案例分享'),
  ('2026-12-26', '10:00', '11:00', '哲瑜', '解惑時間'),
  ('2026-12-26', '17:00', '18:00', '浡崴', '解惑時間'),
  ('2026-12-26', '20:00', '21:00', '浡崴', '基礎教學'),
  ('2026-12-26', '21:00', '22:00', '哲瑜', '基礎教學'),
  ('2026-12-27', '10:00', '11:00', '哲瑜', '案例分享'),
  ('2026-12-27', '17:00', '18:00', '浡崴', '案例分享'),
  ('2026-12-27', '20:00', '21:00', '浡崴', '解惑時間'),
  ('2026-12-28', '21:00', '22:00', '浡崴', '基礎教學'),
  ('2026-12-29', '21:00', '22:00', '哲瑜', '解惑時間'),
  ('2027-01-02', '10:00', '11:00', '哲瑜', '基礎教學'),
  ('2027-01-02', '11:00', '12:00', '哲瑜', '案例分享'),
  ('2027-01-02', '17:00', '18:00', '浡崴', '案例分享'),
  ('2027-01-02', '20:00', '21:00', '浡崴', '解惑時間')
  ) as v (d, s, e, teacher, kind)
 where not exists (select 1 from app.lessons);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function app.lesson_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['基礎教學', '案例分享', '解惑時間']
$$;

-- Same keys as the schedule.json the timetable started from, so a file
-- exported here can be imported again.
create or replace function app.lesson_json(l app.lessons) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', l.id, 'date', l.d, 'start', app.hm(l.start_time), 'end', app.hm(l.end_time),
                            'teacher', l.teacher, 'type', l.kind, 'title', l.title, 'topic', l.topic)
$$;

create or replace function app.lesson_info_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('title', i.title, 'subtitle', i.subtitle, 'place', i.place, 'note', i.note)
    from app.lesson_info i where i.id = 1
$$;

-- One lesson from client JSON, cleaned and checked (VALIDATION 'lesson').
create or replace function app.lesson_from(p jsonb) returns app.lessons
language plpgsql stable set search_path = '' as $$
declare
  v app.lessons;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', 'lesson');
  end if;
  begin
    v.d := (p ->> 'date')::date;
    v.start_time := (p ->> 'start')::time;
    v.end_time := (p ->> 'end')::time;
  exception when others then
    v.d := null;
  end;
  v.teacher := app.clean(p ->> 'teacher');
  v.kind := app.clean(p ->> 'type');
  v.title := coalesce(app.clean(p ->> 'title'), '');
  v.topic := coalesce(app.clean_multiline(p ->> 'topic'), '');
  if v.d is null or v.start_time is null or v.end_time is null or v.end_time <= v.start_time
     or v.teacher is null or length(v.teacher) > 20
     or v.kind is null or not (v.kind = any (app.lesson_kinds()))
     or length(v.title) > 80 or length(v.topic) > 1000 then
    perform app.err('VALIDATION', 'lesson');
  end if;
  return v;
end $$;

-- The first other lesson that overlaps v; one room, one class at a time.
create or replace function app.lesson_clash(v app.lessons, p_except int) returns app.lessons
language sql stable set search_path = '' as $$
  select l.* from app.lessons l
   where l.d = v.d and l.start_time < v.end_time and v.start_time < l.end_time
     and l.id is distinct from p_except
   order by l.start_time, l.id
   limit 1
$$;

-- "11/7 17:00 浡崴"
create or replace function app.lesson_label(l app.lessons) returns text
language sql immutable set search_path = '' as $$
  select to_char(l.d, 'FMMM/FMDD') || ' ' || app.hm(l.start_time) || ' ' || l.teacher
$$;

-- =====================================================================
-- Public API
-- =====================================================================

-- The whole timetable. Public: no token.
create or replace function public.oh_lessons() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'info', app.lesson_info_json(),
    'types', to_jsonb(app.lesson_kinds()),
    'lessons', (select coalesce(jsonb_agg(app.lesson_json(l) order by l.d, l.start_time, l.id), '[]'::jsonb)
                  from app.lessons l));
end $$;

-- Add (no id) or change one lesson.
create or replace function public.oh_admin_lesson_save(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_id int;
  v app.lessons;
  c app.lessons;
begin
  v := app.lesson_from(p);
  if p ? 'id' and jsonb_typeof(p -> 'id') <> 'null' then
    if jsonb_typeof(p -> 'id') <> 'number' then
      perform app.err('VALIDATION', 'lesson');
    end if;
    v_id := (p ->> 'id')::int;
  end if;
  -- one writer at a time, so two admins cannot book the same hour at once
  lock table app.lessons in exclusive mode;
  c := app.lesson_clash(v, v_id);
  if c.id is not null then
    perform app.err('LESSON_CLASH', app.lesson_label(c));
  end if;
  if v_id is null then
    insert into app.lessons (d, start_time, end_time, teacher, kind, title, topic, updated_at)
    values (v.d, v.start_time, v.end_time, v.teacher, v.kind, v.title, v.topic, app.now())
    returning * into v;
  else
    update app.lessons x set
      d = v.d, start_time = v.start_time, end_time = v.end_time, teacher = v.teacher,
      kind = v.kind, title = v.title, topic = v.topic, updated_at = app.now()
    where x.id = v_id
    returning * into v;
    if not found then
      perform app.err('NOT_FOUND', 'lesson');
    end if;
  end if;
  perform app.log(s, 'config.lesson', null, null, jsonb_build_object('id', v.id, 'label', app.lesson_label(v)));
  return app.lesson_json(v);
end $$;

create or replace function public.oh_admin_lesson_delete(p_token text, p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v app.lessons;
begin
  delete from app.lessons x where x.id = p_id returning * into v;
  if not found then
    perform app.err('NOT_FOUND', 'lesson');
  end if;
  perform app.log(s, 'config.lesson.deleted', null, null, jsonb_build_object('id', v.id, 'label', app.lesson_label(v)));
  return jsonb_build_object('ok', true);
end $$;

-- The page header. Only the keys present are changed.
create or replace function public.oh_admin_lessons_info(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', 'lesson_info');
  end if;
  update app.lesson_info x set
    title      = case when p ? 'title'    then coalesce(app.clean(p ->> 'title'), '') else x.title end,
    subtitle   = case when p ? 'subtitle' then coalesce(app.clean(p ->> 'subtitle'), '') else x.subtitle end,
    place      = case when p ? 'place'    then coalesce(app.clean(p ->> 'place'), '') else x.place end,
    note       = case when p ? 'note'     then coalesce(app.clean_multiline(p ->> 'note'), '') else x.note end,
    updated_at = app.now()
  where x.id = 1;
  perform app.log(s, 'config.lessons.info', null, null);
  return app.lesson_info_json();
exception
  when check_violation then
    perform app.err('VALIDATION', 'lesson_info');
end $$;

-- Replace the whole timetable with a schedule.json document:
-- { "title"?, "subtitle"?, "place"?, "note"?, "sessions": [ { date, start,
-- end, teacher, type, title?, topic? }, ... ] }. All or nothing.
create or replace function public.oh_admin_lessons_import(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_list jsonb;
  v app.lessons;
  c app.lessons;
  v_info jsonb;
begin
  v_list := case when jsonb_typeof(p) = 'object' then p -> 'sessions' else p end;
  if v_list is null or jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 500 then
    perform app.err('VALIDATION', 'lessons');
  end if;

  lock table app.lessons in exclusive mode;
  delete from app.lessons;
  for i in 0 .. jsonb_array_length(v_list) - 1 loop
    begin
      v := app.lesson_from(v_list -> i);
    exception when sqlstate 'P0001' then
      perform app.err('IMPORT_ROW', (i + 1)::text);
    end;
    c := app.lesson_clash(v, null);
    if c.id is not null then
      perform app.err('LESSON_CLASH', app.lesson_label(c));
    end if;
    insert into app.lessons (d, start_time, end_time, teacher, kind, title, topic, updated_at)
    values (v.d, v.start_time, v.end_time, v.teacher, v.kind, v.title, v.topic, app.now());
  end loop;

  -- the header comes along when the file has one; an empty title keeps the old one
  if jsonb_typeof(p) = 'object' then
    v_info := jsonb_strip_nulls(jsonb_build_object(
      'title', p -> 'title', 'subtitle', p -> 'subtitle', 'place', p -> 'place', 'note', p -> 'note'));
    if v_info <> '{}'::jsonb then
      begin
        update app.lesson_info x set
          title    = coalesce(app.clean(v_info ->> 'title'), x.title),
          subtitle = case when v_info ? 'subtitle' then coalesce(app.clean(v_info ->> 'subtitle'), '') else x.subtitle end,
          place    = case when v_info ? 'place'    then coalesce(app.clean(v_info ->> 'place'), '') else x.place end,
          note     = case when v_info ? 'note'     then coalesce(app.clean_multiline(v_info ->> 'note'), '') else x.note end,
          updated_at = app.now()
        where x.id = 1;
      exception when check_violation then
        perform app.err('VALIDATION', 'lesson_info');
      end;
    end if;
  end if;

  perform app.log(s, 'config.lessons.imported', null, null, jsonb_build_object('count', jsonb_array_length(v_list)));
  return jsonb_build_object('count', jsonb_array_length(v_list));
end $$;

-- The timetable as a calendar anyone can subscribe to:
--   GET /rest/v1/rpc/oh_lessons_calendar?apikey=…
-- (PostgREST passes the apikey query parameter in as an argument.)
create or replace function public.oh_lessons_calendar(apikey text default null) returns "*/*"
language plpgsql stable security definer set search_path = '' as $$
declare
  i app.lesson_info := (select x from app.lesson_info x where x.id = 1);
  v_lines text[];
  l app.lessons;
  v_now text := to_char(app.now() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
begin
  v_lines := array['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tnda-office-hour//lessons//ZH-TW', 'CALSCALE:GREGORIAN',
                   'METHOD:PUBLISH', 'X-WR-CALNAME:' || app.ics_text(i.title),
                   'X-WR-TIMEZONE:' || (select x.timezone from app.settings x where x.id = 1),
                   'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for l in select * from app.lessons x where x.d >= app.today() - 180 order by x.d, x.start_time loop
    v_lines := v_lines || array[
      'BEGIN:VEVENT',
      'UID:td-' || l.id || '@tnda-office-hour',
      'DTSTAMP:' || v_now,
      'DTSTART:' || app.ics_stamp(l.d, l.start_time),
      'DTEND:' || app.ics_stamp(l.d, l.end_time),
      'SUMMARY:' || app.ics_text('TD ' || l.kind || ' · ' || l.teacher || coalesce('｜' || nullif(l.title, ''), '')),
      'LOCATION:' || app.ics_text(i.place),
      'DESCRIPTION:' || app.ics_text(concat_ws(E'\n\n', nullif(l.title, ''), nullif(l.topic, ''),
                                               '講師：' || l.teacher || '　類型：' || l.kind)),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:' || app.ics_text(i.title), 'END:VALARM',
      'END:VEVENT'];
  end loop;
  v_lines := v_lines || 'END:VCALENDAR'::text;

  perform set_config('response.headers',
    jsonb_build_array(
      jsonb_build_object('Content-Type', 'text/calendar; charset=utf-8'),
      jsonb_build_object('Cache-Control', 'max-age=300'),
      jsonb_build_object('Content-Disposition', 'inline; filename="td-lessons.ics"'))::text,
    true);
  return convert_to((select string_agg(app.ics_fold(x), E'\r\n') from unnest(v_lines) as x) || E'\r\n', 'UTF8');
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
       and p.proname in ('oh_lessons', 'oh_admin_lesson_save', 'oh_admin_lesson_delete', 'oh_admin_lessons_info',
                         'oh_admin_lessons_import', 'oh_lessons_calendar')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
