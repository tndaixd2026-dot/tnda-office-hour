-- The TD calendar feed can be narrowed to one teacher:
--   GET /rest/v1/rpc/oh_lessons_calendar?apikey=…&p_teacher=浡崴
-- (a new argument, so the old one-argument version goes first; PostgREST
-- would not know which of two overloads to call)

drop function if exists public.oh_lessons_calendar(text);

create or replace function public.oh_lessons_calendar(apikey text default null, p_teacher text default null) returns "*/*"
language plpgsql stable security definer set search_path = '' as $$
declare
  i app.lesson_info := (select x from app.lesson_info x where x.id = 1);
  v_teacher text := app.clean(p_teacher);
  v_lines text[];
  l app.lessons;
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
     where n.nspname = 'public' and p.proname = 'oh_lessons_calendar'
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
