-- =====================================================================
-- TD timetable: the mix of lesson types
--
-- The TAs set a ratio for 基礎教學 : 案例分享 : 駐村創作, and the lessons
-- still to come are re-typed to match it. A lesson that has started, or
-- that a TA has marked as confirmed (已確定), keeps its type. The page
-- works out which lessons change (as few as it can, spread out over the
-- weeks) and shows them first; oh_admin_lessons_retype checks each one
-- and makes the change in one go.
-- =====================================================================

alter table app.lessons add column confirmed boolean not null default false;
alter table app.lesson_info add column ratio int[]
  check (ratio is null or (cardinality(ratio) = 3 and 0 <= all (ratio) and 20 >= all (ratio)
                           and ratio[1] + ratio[2] + ratio[3] > 0));

-- When a lesson starts, in the timetable's time zone.
create or replace function app.lesson_starts(l app.lessons) returns timestamptz
language sql stable set search_path = '' as $$
  select (l.d + l.start_time) at time zone (select s.timezone from app.settings s where s.id = 1)
$$;

-- A ratio from client JSON: three whole numbers 0–20, in the order of
-- app.lesson_kinds(), not all zero (VALIDATION 'ratio').
create or replace function app.ratio_from(p jsonb) returns int[]
language plpgsql stable set search_path = '' as $$
declare
  v int[];
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 3
     or exists (select 1 from jsonb_array_elements(p) e
                 where jsonb_typeof(e) <> 'number' or e::text::numeric <> trunc(e::text::numeric)
                    or e::text::numeric not between 0 and 20) then
    perform app.err('VALIDATION', 'ratio');
  end if;
  select array_agg(e::text::int order by o) into v from jsonb_array_elements(p) with ordinality as x (e, o);
  if v[1] + v[2] + v[3] = 0 then
    perform app.err('VALIDATION', 'ratio');
  end if;
  return v;
end $$;

create or replace function app.lesson_json(l app.lessons) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', l.id, 'date', l.d, 'start', app.hm(l.start_time), 'end', app.hm(l.end_time),
                            'teacher', l.teacher, 'type', l.kind, 'unit', l.unit_id, 'confirmed', l.confirmed,
                            'title', l.title, 'topic', l.topic)
$$;

create or replace function app.lesson_info_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('title', i.title, 'subtitle', i.subtitle, 'place', i.place, 'note', i.note,
                            'ratio', to_jsonb(i.ratio))
    from app.lesson_info i where i.id = 1
$$;

-- Add (no id) or change one lesson. `unit` is a unit id of the lesson's
-- type, or null for none; left out, an edit keeps the lesson's unit
-- unless its type changed. `confirmed` likewise: left out, an edit keeps it.
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
  if p ? 'confirmed' and jsonb_typeof(p -> 'confirmed') <> 'null' then
    if jsonb_typeof(p -> 'confirmed') <> 'boolean' then
      perform app.err('VALIDATION', 'lesson');
    end if;
    v.confirmed := (p ->> 'confirmed')::boolean;
  elsif v_id is not null then
    select x.confirmed into v.confirmed from app.lessons x where x.id = v_id;
  end if;
  v.confirmed := coalesce(v.confirmed, false);
  c := app.lesson_clash(v, v_id);
  if c.id is not null then
    perform app.err('LESSON_CLASH', app.lesson_label(c));
  end if;
  if v_id is null then
    insert into app.lessons (d, start_time, end_time, teacher, kind, unit_id, confirmed, title, topic, updated_at)
    values (v.d, v.start_time, v.end_time, v.teacher, v.kind, v.unit_id, v.confirmed, v.title, v.topic, app.now())
    returning * into v;
  else
    update app.lessons x set
      d = v.d, start_time = v.start_time, end_time = v.end_time, teacher = v.teacher,
      kind = v.kind, unit_id = v.unit_id, confirmed = v.confirmed, title = v.title, topic = v.topic, updated_at = app.now()
    where x.id = v_id
    returning * into v;
    if not found then
      perform app.err('NOT_FOUND', 'lesson');
    end if;
  end if;
  perform app.log(s, 'config.lesson', null, null, jsonb_build_object('id', v.id, 'label', app.lesson_label(v)));
  return app.lesson_json(v);
end $$;

-- Sets the ratio and re-types lessons to match it:
--   { "ratio": [基礎教學, 案例分享, 駐村創作], "changes": [ { id, type }, ... ] }
-- A lesson that has started or is confirmed cannot change
-- (LESSON_FIXED); one that changes type leaves its unit. All or nothing.
create or replace function public.oh_admin_lessons_retype(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_ratio int[];
  v_list jsonb;
  v_kind text;
  l app.lessons;
  n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', 'ratio');
  end if;
  v_ratio := app.ratio_from(p -> 'ratio');
  v_list := coalesce(nullif(p -> 'changes', 'null'::jsonb), '[]'::jsonb);
  if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 500 then
    perform app.err('VALIDATION', 'ratio');
  end if;

  lock table app.lesson_units in exclusive mode;
  lock table app.lessons in exclusive mode;
  for i in 0 .. jsonb_array_length(v_list) - 1 loop
    if jsonb_typeof(v_list -> i) <> 'object' or jsonb_typeof(v_list -> i -> 'id') <> 'number' then
      perform app.err('VALIDATION', 'ratio');
    end if;
    v_kind := app.clean(v_list -> i ->> 'type');
    if v_kind is null or not (v_kind = any (app.lesson_kinds())) then
      perform app.err('VALIDATION', 'ratio');
    end if;
    select * into l from app.lessons x where x.id = (v_list -> i ->> 'id')::int;
    if not found then
      perform app.err('NOT_FOUND', 'lesson');
    end if;
    if l.confirmed or app.lesson_starts(l) <= app.now() then
      perform app.err('LESSON_FIXED', app.lesson_label(l));
    end if;
    if l.kind <> v_kind then
      update app.lessons x set kind = v_kind, unit_id = null, updated_at = app.now() where x.id = l.id;
      n := n + 1;
    end if;
  end loop;
  update app.lesson_info x set ratio = v_ratio, updated_at = app.now() where x.id = 1;

  perform app.log(s, 'config.lessons.ratio', null, null, jsonb_build_object('ratio', to_jsonb(v_ratio), 'count', n));
  return jsonb_build_object('count', n);
end $$;

-- Replace the whole timetable with a schedule.json document:
-- { "title"?, "subtitle"?, "place"?, "note"?, "ratio"?,
--   "units"?: [ { type, no?, title?, topic? }, ... ],
--   "sessions": [ { date, start, end, teacher, type, unit?, confirmed?, title?, topic? }, ... ] }.
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
  v_ratio int[];
begin
  v_list := case when jsonb_typeof(p) = 'object' then p -> 'sessions' else p end;
  if v_list is null or jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 500 then
    perform app.err('VALIDATION', 'lessons');
  end if;
  if jsonb_typeof(p) = 'object' and p ? 'ratio' and jsonb_typeof(p -> 'ratio') <> 'null' then
    v_ratio := app.ratio_from(p -> 'ratio');
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
      v_title := coalesce(app.clean(v_unit ->> 'title'), '');
      v_topic := coalesce(app.clean_multiline(v_unit ->> 'topic'), '');
      v_no := null;
      if jsonb_typeof(v_unit -> 'no') = 'number' then
        v_no := (v_unit ->> 'no')::int;
      elsif v_unit ? 'no' and jsonb_typeof(v_unit -> 'no') <> 'null' then
        perform app.err('IMPORT_UNIT', (i + 1)::text);
      end if;
      if v_kind is null or not (v_kind = any (app.lesson_kinds()))
         or length(v_title) > 80 or length(v_topic) > 1000 or v_no < 1 then
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
    v.confirmed := false;
    if jsonb_typeof(v_list -> i -> 'confirmed') = 'boolean' then
      v.confirmed := (v_list -> i ->> 'confirmed')::boolean;
    elsif (v_list -> i) ? 'confirmed' and jsonb_typeof(v_list -> i -> 'confirmed') <> 'null' then
      perform app.err('IMPORT_ROW', (i + 1)::text);
    end if;
    c := app.lesson_clash(v, null);
    if c.id is not null then
      perform app.err('LESSON_CLASH', app.lesson_label(c));
    end if;
    insert into app.lessons (d, start_time, end_time, teacher, kind, unit_id, confirmed, title, topic, updated_at)
    values (v.d, v.start_time, v.end_time, v.teacher, v.kind, v.unit_id, v.confirmed, v.title, v.topic, app.now());
  end loop;
  perform app.lesson_units_renumber();
  if v_ratio is not null then
    update app.lesson_info x set ratio = v_ratio, updated_at = app.now() where x.id = 1;
  end if;

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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_admin_lesson_save', 'oh_admin_lessons_retype', 'oh_admin_lessons_import')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
