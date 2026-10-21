-- Importing a schedule.json failed on the live site with "21000 DELETE
-- requires a WHERE clause": Supabase loads pg-safeupdate for API
-- requests, and the import emptied the timetable with a bare DELETE.
-- `where true` says every row on purpose. Nothing else changes.

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
  delete from app.lessons where true;

  if v_units is not null then
    delete from app.lesson_units where true;
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
     where n.nspname = 'public' and p.proname = 'oh_admin_lessons_import'
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
