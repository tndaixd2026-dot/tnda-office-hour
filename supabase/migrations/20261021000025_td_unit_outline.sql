-- TD units as an outline: each type starts with units （一） to （十）
-- listed, their topics left for the TAs to write. A unit may have no
-- topic yet (the pages say 主題待定), so saving and importing one no
-- longer needs a title. How many units a type has stays up to the TAs:
-- they add and delete them as before.

alter table app.lesson_units drop constraint lesson_units_title_check;
alter table app.lesson_units add constraint lesson_units_title_check check (length(title) <= 80);

-- ten per type, after any a type already has
insert into app.lesson_units (kind, sort, title)
select k.kind, n.n, ''
  from unnest(app.lesson_kinds()) as k (kind)
 cross join generate_series(1, 10) as n (n)
 where n.n > (select count(*) from app.lesson_units u where u.kind = k.kind)
 order by array_position(app.lesson_kinds(), k.kind), n.n;
select app.lesson_units_renumber();

-- Add (no id) or change one unit:
--   { id?, type, title?, topic?, no?, lessons? }
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
  v_title := coalesce(app.clean(p ->> 'title'), '');
  v_topic := coalesce(app.clean_multiline(p ->> 'topic'), '');
  if length(v_title) > 80 or length(v_topic) > 1000 then
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

-- Replace the whole timetable with a schedule.json document:
-- { "title"?, "subtitle"?, "place"?, "note"?,
--   "units"?: [ { type, no?, title?, topic? }, ... ],
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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_admin_lesson_unit_save', 'oh_admin_lessons_import')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
