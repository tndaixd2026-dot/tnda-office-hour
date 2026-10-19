-- TD timetable: the lesson type 解惑時間 is now 駐村創作. Lessons
-- already of that type move over, and a schedule.json exported before
-- the change still imports, its old name read as the new one.

alter table app.lessons drop constraint lessons_kind_check;
update app.lessons set kind = '駐村創作' where kind = '解惑時間';
alter table app.lessons add constraint lessons_kind_check check (kind in ('基礎教學', '案例分享', '駐村創作'));

create or replace function app.lesson_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['基礎教學', '案例分享', '駐村創作']
$$;

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
  if v.kind = '解惑時間' then
    v.kind := '駐村創作'; -- the old name, in files exported before it changed
  end if;
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

revoke execute on all functions in schema app from public;
