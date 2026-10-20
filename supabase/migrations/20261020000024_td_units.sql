-- =====================================================================
-- TD timetable: units
--
-- Each lesson type is split into numbered units, 基礎教學（一）,
-- 基礎教學（二）…, each with a topic and a description students can
-- read. A lesson belongs to at most one unit of its own type; the admin
-- ticks which lessons teach a unit. Units are numbered within their type
-- by `sort`, which is always 1, 2, 3 … (app.lesson_units_renumber).
-- =====================================================================

create table app.lesson_units (
  id         int generated always as identity primary key,
  kind       text not null check (kind in ('基礎教學', '案例分享', '駐村創作')),
  sort       int not null default 1,
  title      text not null check (length(title) between 1 and 80),
  topic      text not null default '' check (length(topic) <= 1000),
  updated_at timestamptz not null default now(),
  unique (id, kind)
);

alter table app.lesson_units enable row level security;
revoke all on app.lesson_units from public;

drop trigger if exists ping on app.lesson_units;
create trigger ping after insert or update or delete on app.lesson_units
  for each statement execute function app.ping();

-- A lesson's unit is always of the lesson's own type. Deleting a unit
-- leaves its lessons without one; renaming a type carries both along.
alter table app.lessons add column unit_id int;
alter table app.lessons add constraint lessons_unit_fkey foreign key (unit_id, kind)
  references app.lesson_units (id, kind) on update cascade on delete set null (unit_id);
create index lessons_unit_idx on app.lessons (unit_id);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- 1 → 一, 10 → 十, 12 → 十二, 21 → 二十一
create or replace function app.cn_num(n int) returns text
language sql immutable set search_path = '' as $$
  select case
           when n between 1 and 9 then d[n]
           when n = 10 then '十'
           when n between 11 and 19 then '十' || d[n - 10]
           when n between 20 and 99 then d[n / 10] || '十' || coalesce(d[nullif(n % 10, 0)], '')
           else n::text
         end
    from (select array['一', '二', '三', '四', '五', '六', '七', '八', '九'] as d) x
$$;

-- "基礎教學（一）"
create or replace function app.lesson_unit_label(u app.lesson_units) returns text
language sql immutable set search_path = '' as $$
  select u.kind || '（' || app.cn_num(u.sort) || '）'
$$;

create or replace function app.lesson_unit_json(u app.lesson_units) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', u.id, 'type', u.kind, 'no', u.sort, 'title', u.title, 'topic', u.topic)
$$;

-- Numbers each type's units 1, 2, 3 … in their current order.
create or replace function app.lesson_units_renumber() returns void
language sql set search_path = '' as $$
  update app.lesson_units u set sort = r.n
    from (select x.id, row_number() over (partition by x.kind order by x.sort, x.id)::int as n
            from app.lesson_units x) r
   where u.id = r.id and u.sort <> r.n
$$;

create or replace function app.lesson_json(l app.lessons) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', l.id, 'date', l.d, 'start', app.hm(l.start_time), 'end', app.hm(l.end_time),
                            'teacher', l.teacher, 'type', l.kind, 'unit', l.unit_id, 'title', l.title, 'topic', l.topic)
$$;

-- What a calendar calls a lesson: "TD 基礎教學（一）介面與節點 · 浡崴｜補課"
create or replace function app.lesson_summary(l app.lessons, u app.lesson_units) returns text
language sql immutable set search_path = '' as $$
  select 'TD ' || coalesce(app.lesson_unit_label(u) || u.title, l.kind) || ' · ' || l.teacher
         || coalesce('｜' || nullif(l.title, ''), '')
$$;

create or replace function app.lesson_details(l app.lessons, u app.lesson_units) returns text
language sql immutable set search_path = '' as $$
  select concat_ws(E'\n\n', app.lesson_unit_label(u) || u.title, nullif(u.topic, ''), nullif(l.title, ''), nullif(l.topic, ''),
                   '講師：' || l.teacher || '　類型：' || l.kind)
$$;

-- =====================================================================
-- Public API
-- =====================================================================

create or replace function public.oh_lessons() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'info', app.lesson_info_json(),
    'types', to_jsonb(app.lesson_kinds()),
    'units', (select coalesce(jsonb_agg(app.lesson_unit_json(u) order by array_position(app.lesson_kinds(), u.kind), u.sort, u.id), '[]'::jsonb)
                from app.lesson_units u),
    'lessons', (select coalesce(jsonb_agg(app.lesson_json(l) order by l.d, l.start_time, l.id), '[]'::jsonb)
                  from app.lessons l));
end $$;

-- Add (no id) or change one lesson. `unit` is a unit id of the lesson's
-- type, or null for none; left out, an edit keeps the lesson's unit
-- unless its type changed.
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
  -- units before lessons, the same order as every other writer
  lock table app.lesson_units in exclusive mode;
  -- one writer at a time, so two admins cannot book the same hour at once
  lock table app.lessons in exclusive mode;
  if p ? 'unit' and jsonb_typeof(p -> 'unit') <> 'null' then
    if jsonb_typeof(p -> 'unit') <> 'number' then
      perform app.err('VALIDATION', 'lesson');
    end if;
    select u.id into v.unit_id from app.lesson_units u where u.id = (p ->> 'unit')::int and u.kind = v.kind;
    if v.unit_id is null then
      perform app.err('VALIDATION', 'unit');
    end if;
  elsif not p ? 'unit' and v_id is not null then
    select x.unit_id into v.unit_id from app.lessons x where x.id = v_id and x.kind = v.kind;
  end if;
  c := app.lesson_clash(v, v_id);
  if c.id is not null then
    perform app.err('LESSON_CLASH', app.lesson_label(c));
  end if;
  if v_id is null then
    insert into app.lessons (d, start_time, end_time, teacher, kind, unit_id, title, topic, updated_at)
    values (v.d, v.start_time, v.end_time, v.teacher, v.kind, v.unit_id, v.title, v.topic, app.now())
    returning * into v;
  else
    update app.lessons x set
      d = v.d, start_time = v.start_time, end_time = v.end_time, teacher = v.teacher,
      kind = v.kind, unit_id = v.unit_id, title = v.title, topic = v.topic, updated_at = app.now()
    where x.id = v_id
    returning * into v;
    if not found then
      perform app.err('NOT_FOUND', 'lesson');
    end if;
  end if;
  perform app.log(s, 'config.lesson', null, null, jsonb_build_object('id', v.id, 'label', app.lesson_label(v)));
  return app.lesson_json(v);
end $$;

-- Add (no id) or change one unit:
--   { id?, type, title, topic?, no?, lessons? }
-- `type` is fixed once the unit exists. `no` moves the unit to that place
-- in its type (a new one goes last). `lessons`, when present, is every
-- lesson the unit has: those listed move here from any other unit, and
-- the unit's lessons not listed are left without one.
create or replace function public.oh_admin_lesson_unit_save(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_id int;
  v_kind text;
  v_title text;
  v_topic text;
  v_no int;
  v_lessons int[];
  v_ids int[];
  u app.lesson_units;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', 'unit');
  end if;
  if p ? 'id' and jsonb_typeof(p -> 'id') <> 'null' then
    if jsonb_typeof(p -> 'id') <> 'number' then
      perform app.err('VALIDATION', 'unit');
    end if;
    v_id := (p ->> 'id')::int;
  end if;
  v_kind := app.clean(p ->> 'type');
  if v_kind = '解惑時間' then
    v_kind := '駐村創作';
  end if;
  v_title := app.clean(p ->> 'title');
  v_topic := coalesce(app.clean_multiline(p ->> 'topic'), '');
  if v_title is null or length(v_title) > 80 or length(v_topic) > 1000 then
    perform app.err('VALIDATION', 'unit');
  end if;
  if p ? 'no' and jsonb_typeof(p -> 'no') <> 'null' then
    if jsonb_typeof(p -> 'no') <> 'number' then
      perform app.err('VALIDATION', 'unit');
    end if;
    v_no := (p ->> 'no')::int;
  end if;
  if p ? 'lessons' and jsonb_typeof(p -> 'lessons') <> 'null' then
    if jsonb_typeof(p -> 'lessons') <> 'array' or jsonb_array_length(p -> 'lessons') > 500
       or exists (select 1 from jsonb_array_elements(p -> 'lessons') e where jsonb_typeof(e) <> 'number') then
      perform app.err('VALIDATION', 'unit');
    end if;
    select coalesce(array_agg(distinct e::numeric::int), '{}') into v_lessons from jsonb_array_elements_text(p -> 'lessons') e;
  end if;

  lock table app.lesson_units in exclusive mode;
  if v_id is null then
    if v_kind is null or not (v_kind = any (app.lesson_kinds())) then
      perform app.err('VALIDATION', 'unit');
    end if;
    insert into app.lesson_units (kind, sort, title, topic, updated_at)
    values (v_kind, (select coalesce(max(x.sort), 0) + 1 from app.lesson_units x where x.kind = v_kind), v_title, v_topic, app.now())
    returning * into u;
  else
    select * into u from app.lesson_units x where x.id = v_id;
    if not found then
      perform app.err('NOT_FOUND', 'unit');
    end if;
    if v_kind is not null and v_kind <> u.kind then
      perform app.err('VALIDATION', 'unit');
    end if;
    update app.lesson_units x set title = v_title, topic = v_topic, updated_at = app.now()
     where x.id = v_id
    returning * into u;
  end if;

  if v_no is not null then
    select array_agg(x.id order by x.sort, x.id) into v_ids from app.lesson_units x where x.kind = u.kind and x.id <> u.id;
    v_no := least(greatest(v_no, 1), coalesce(array_length(v_ids, 1), 0) + 1);
    v_ids := coalesce(v_ids[1:v_no - 1], '{}') || u.id || coalesce(v_ids[v_no:], '{}');
    update app.lesson_units x set sort = o.n
      from unnest(v_ids) with ordinality as o (id, n)
     where x.id = o.id and x.sort <> o.n;
  end if;
  perform app.lesson_units_renumber();

  if v_lessons is not null then
    if exists (select 1 from unnest(v_lessons) i
                where not exists (select 1 from app.lessons l where l.id = i and l.kind = u.kind)) then
      perform app.err('VALIDATION', 'unit_lessons');
    end if;
    update app.lessons l set unit_id = null, updated_at = app.now()
     where l.unit_id = u.id and not (l.id = any (v_lessons));
    update app.lessons l set unit_id = u.id, updated_at = app.now()
     where l.id = any (v_lessons) and l.unit_id is distinct from u.id;
  end if;

  select * into u from app.lesson_units x where x.id = u.id;
  perform app.log(s, 'config.lesson_unit', null, null, jsonb_build_object('id', u.id, 'label', app.lesson_unit_label(u)));
  return app.lesson_unit_json(u);
end $$;

-- Its lessons stay, without a unit; the units after it move up one.
create or replace function public.oh_admin_lesson_unit_delete(p_token text, p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  u app.lesson_units;
begin
  lock table app.lesson_units in exclusive mode;
  delete from app.lesson_units x where x.id = p_id returning * into u;
  if not found then
    perform app.err('NOT_FOUND', 'unit');
  end if;
  perform app.lesson_units_renumber();
  perform app.log(s, 'config.lesson_unit.deleted', null, null, jsonb_build_object('id', u.id, 'label', app.lesson_unit_label(u) || u.title));
  return jsonb_build_object('ok', true);
end $$;

-- Replace the whole timetable with a schedule.json document:
-- { "title"?, "subtitle"?, "place"?, "note"?,
--   "units"?: [ { type, no?, title, topic? }, ... ],
--   "sessions": [ { date, start, end, teacher, type, unit?, title?, topic? }, ... ] }.
-- With "units" the units are replaced too; a unit's `no` (else its place
-- among its type's units in the list) is what a session's `unit` names.
-- Without it the units stay, and `unit` names one of them by number.
-- All or nothing.
create or replace function public.oh_admin_lessons_import(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_list jsonb;
  v_units jsonb;
  v_unit jsonb;
  v_kind text;
  v_title text;
  v_topic text;
  v_no int;
  v app.lessons;
  c app.lessons;
  v_info jsonb;
begin
  v_list := case when jsonb_typeof(p) = 'object' then p -> 'sessions' else p end;
  if v_list is null or jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 500 then
    perform app.err('VALIDATION', 'lessons');
  end if;
  if jsonb_typeof(p) = 'object' and p ? 'units' and jsonb_typeof(p -> 'units') <> 'null' then
    v_units := p -> 'units';
    if jsonb_typeof(v_units) <> 'array' or jsonb_array_length(v_units) > 200 then
      perform app.err('VALIDATION', 'units');
    end if;
  end if;

  lock table app.lesson_units in exclusive mode;
  lock table app.lessons in exclusive mode;
  delete from app.lessons;

  if v_units is not null then
    delete from app.lesson_units;
    for i in 0 .. jsonb_array_length(v_units) - 1 loop
      v_unit := v_units -> i;
      if jsonb_typeof(v_unit) <> 'object' then
        perform app.err('IMPORT_UNIT', (i + 1)::text);
      end if;
      v_kind := app.clean(v_unit ->> 'type');
      if v_kind = '解惑時間' then
        v_kind := '駐村創作';
      end if;
      v_title := app.clean(v_unit ->> 'title');
      v_topic := coalesce(app.clean_multiline(v_unit ->> 'topic'), '');
      v_no := null;
      if jsonb_typeof(v_unit -> 'no') = 'number' then
        v_no := (v_unit ->> 'no')::int;
      elsif v_unit ? 'no' and jsonb_typeof(v_unit -> 'no') <> 'null' then
        perform app.err('IMPORT_UNIT', (i + 1)::text);
      end if;
      if v_kind is null or not (v_kind = any (app.lesson_kinds()))
         or v_title is null or length(v_title) > 80 or length(v_topic) > 1000 or v_no < 1 then
        perform app.err('IMPORT_UNIT', (i + 1)::text);
      end if;
      v_no := coalesce(v_no, (select count(*) + 1 from app.lesson_units x where x.kind = v_kind));
      if exists (select 1 from app.lesson_units x where x.kind = v_kind and x.sort = v_no) then
        perform app.err('IMPORT_UNIT', (i + 1)::text);
      end if;
      insert into app.lesson_units (kind, sort, title, topic, updated_at)
      values (v_kind, v_no, v_title, v_topic, app.now());
    end loop;
  end if;

  for i in 0 .. jsonb_array_length(v_list) - 1 loop
    begin
      v := app.lesson_from(v_list -> i);
    exception when sqlstate 'P0001' then
      perform app.err('IMPORT_ROW', (i + 1)::text);
    end;
    v.unit_id := null;
    if jsonb_typeof(v_list -> i -> 'unit') = 'number' then
      select x.id into v.unit_id from app.lesson_units x where x.kind = v.kind and x.sort = (v_list -> i ->> 'unit')::int;
      if v.unit_id is null then
        perform app.err('IMPORT_ROW', (i + 1)::text);
      end if;
    elsif (v_list -> i) ? 'unit' and jsonb_typeof(v_list -> i -> 'unit') <> 'null' then
      perform app.err('IMPORT_ROW', (i + 1)::text);
    end if;
    c := app.lesson_clash(v, null);
    if c.id is not null then
      perform app.err('LESSON_CLASH', app.lesson_label(c));
    end if;
    insert into app.lessons (d, start_time, end_time, teacher, kind, unit_id, title, topic, updated_at)
    values (v.d, v.start_time, v.end_time, v.teacher, v.kind, v.unit_id, v.title, v.topic, app.now());
  end loop;
  perform app.lesson_units_renumber();

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

  perform app.log(s, 'config.lessons.imported', null, null,
                  jsonb_build_object('count', jsonb_array_length(v_list), 'units', jsonb_array_length(v_units)));
  return jsonb_strip_nulls(jsonb_build_object('count', jsonb_array_length(v_list), 'units', jsonb_array_length(v_units)));
end $$;

-- The calendar feed names each lesson's unit.
create or replace function public.oh_lessons_calendar(apikey text default null, p_teacher text default null) returns "*/*"
language plpgsql stable security definer set search_path = '' as $$
declare
  i app.lesson_info := (select x from app.lesson_info x where x.id = 1);
  v_teacher text := app.clean(p_teacher);
  v_lines text[];
  l app.lessons;
  u app.lesson_units;
  v_now text := to_char(app.now() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
begin
  v_lines := array['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tnda-office-hour//lessons//ZH-TW', 'CALSCALE:GREGORIAN',
                   'METHOD:PUBLISH', 'X-WR-CALNAME:' || app.ics_text(i.title || coalesce(' · ' || v_teacher, '')),
                   'X-WR-TIMEZONE:' || (select x.timezone from app.settings x where x.id = 1),
                   'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for l in select * from app.lessons x
            where x.d >= app.today() - 180
              and (v_teacher is null or app.name_key(x.teacher) = app.name_key(v_teacher))
            order by x.d, x.start_time loop
    u := null;
    select * into u from app.lesson_units x where x.id = l.unit_id;
    v_lines := v_lines || array[
      'BEGIN:VEVENT',
      'UID:td-' || l.id || '@tnda-office-hour',
      'DTSTAMP:' || v_now,
      'DTSTART:' || app.ics_stamp(l.d, l.start_time),
      'DTEND:' || app.ics_stamp(l.d, l.end_time),
      'SUMMARY:' || app.ics_text(app.lesson_summary(l, u)),
      'LOCATION:' || app.ics_text(i.place),
      'DESCRIPTION:' || app.ics_text(app.lesson_details(l, u)),
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
       and p.proname in ('oh_lessons', 'oh_admin_lesson_save', 'oh_admin_lesson_unit_save', 'oh_admin_lesson_unit_delete',
                         'oh_admin_lessons_import', 'oh_lessons_calendar')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
