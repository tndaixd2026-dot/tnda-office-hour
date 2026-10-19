-- =====================================================================
-- Office Hour · one view for the three PMs
--
-- Every teacher now sees everyone's sessions in one screen, and a shared
-- account (team = true, "叁式" to begin with) signs in to that screen
-- without being one of the PMs. The shared account has no availability
-- and can never be given a session; its calendar feed holds every
-- teacher's sessions.
-- =====================================================================

alter table app.teachers add column team boolean not null default false;

insert into app.teachers (name, code, sort, team)
select '叁式', app.new_code(10), 0, true
 where not exists (select 1 from app.teachers t where t.team)
   and not exists (select 1 from app.teachers t where app.name_key(t.name) = app.name_key('叁式'))
   and not exists (select 1 from app.roster r where app.name_key(r.name) = app.name_key('叁式'))
   and not exists (select 1 from app.admins a where app.name_key(a.name) = app.name_key('叁式'));

-- The shared account is never scheduled and has no open hours.
create or replace function app.not_team() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from app.teachers t where t.id = new.teacher_id and t.team) then
    perform app.err('NOT_FOUND', 'teacher');
  end if;
  return new;
end $$;

drop trigger if exists not_team on app.appointments;
create trigger not_team before insert or update of teacher_id on app.appointments
  for each row execute function app.not_team();
drop trigger if exists not_team on app.blocks;
create trigger not_team before insert or update of teacher_id on app.blocks
  for each row execute function app.not_team();

-- One screen for every teacher: all sessions of all PMs.
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
                   'id', a.id, 'd', a.d, 't', app.hm(a.t), 'status', a.status,
                   'teacher_id', a.teacher_id, 'teacher', te.name, 'mine', a.teacher_id = s.teacher_id,
                   'cancel_reason', a.cancel_reason,
                   'group', jsonb_build_object('no', g.no, 'name', g.name),
                   'request', (select jsonb_build_object('topic', r.topic, 'progress', r.progress, 'link', r.link,
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

-- The shared account's feed holds every teacher's sessions.
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
    select a.id, a.d, a.t, gr.id as gid, te.name as tname,
           rq.topic, rq.progress, rq.link, rq.author
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
      'DTEND:' || app.ics_stamp(r.d, r.t + v_end),
      'SUMMARY:' || app.ics_text(case
        when t.team then 'Office Hour · ' || r.tname || ' · ' || app.group_title(r.gid) || coalesce('｜' || r.topic, '')
        when t.id is not null then 'Office Hour · ' || app.group_title(r.gid) || coalesce('｜' || r.topic, '')
        else 'Office Hour · ' || cfg.host_label || case when cfg.show_teacher_names then ' ' || r.tname else '' end
             || coalesce('｜' || r.topic, '')
      end),
      'LOCATION:' || app.ics_text(cfg.location),
      'DESCRIPTION:' || app.ics_text(concat_ws(E'\n',
        app.group_title(r.gid),
        case when t.team then '老師：' || r.tname end,
        case when r.topic is not null then '題目：' || r.topic end,
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

-- Admin configuration says which teacher row is the shared account.
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
                 'webhook', g.webhook,
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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('oh_teacher_state', 'oh_calendar', 'oh_admin_config')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
