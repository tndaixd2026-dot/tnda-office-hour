-- =====================================================================
-- Office Hour · the 08:00 messages at 08:00
--
-- GitHub starts scheduled workflows late at busy times; in the first week
-- the 08:00 run started at about 10:40 every day, so the day's reminder
-- for a 10:00 session came after it had begun and was dropped. The
-- database now sends the messages that cannot wait itself, on the minute,
-- with pg_cron: at 08:00 every day the reminders for that day's sessions,
-- and on Sunday next week's outcome. They go through each group's webhook
-- (they carry no buttons, so they need no bot) and are recorded like any
-- other, so the GitHub run that comes later only sends what is still
-- missing. A message a webhook turned down has its record dropped at
-- 08:05, so that run sends it with the bot after all. Friday's question
-- and Saturday's close still need the bot and stay with GitHub.
-- Where pg_cron or pg_net is missing (tests, the demo) nothing changes.
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension pg_cron with schema pg_catalog;
    exception when others then
      raise notice 'pg_cron could not be enabled: %', sqlerrm;
    end;
  end if;
end $$;

-- The 08:00 messages: the day's reminders, and on Sunday next week's outcome.
create or replace function app.discord_morning_hooks() returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_id bigint;
  n int := 0;
begin
  if not app.has_pg_net() then
    return 0;
  end if;
  for r in
    select 'summary' as kind, o.* from app.discord_summary_outbox(false, null) o
     where extract(isodow from app.today()) = 7
    union all
    select 'today', o.* from app.discord_today_outbox(false, null) o
  loop
    v_id := app.discord(r.group_id, r.payload ->> 'content');
    if v_id is not null then
      perform app.discord_noted(r.kind, r.group_id, r.on_date, r.channel_id, 'hook:' || v_id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Drops the record of a message a webhook turned down in the last hour,
-- so the GitHub run sends it with the bot.
create or replace function app.discord_hook_check() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not app.has_pg_net() then
    return 0;
  end if;
  delete from app.discord_notes x
   where x.message_id like 'hook:%' and x.posted_at > app.now() - interval '1 hour'
     and not exists (select 1 from net._http_response h
                      where h.id = substr(x.message_id, 6)::bigint and h.status_code between 200 and 299);
  get diagnostics n = row_count;
  return n;
end $$;

-- Whether pg_cron sends the 08:00 messages.
create or replace function app.discord_cron_on() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean := false;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1 and active)' into v using 'oh-discord-morning';
  end if;
  return v;
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    -- pg_cron counts in UTC: 00:00 is 08:00 in Taipei
    execute $c$select cron.schedule('oh-discord-morning', '0 0 * * *', 'select app.discord_morning_hooks()')$c$;
    execute $c$select cron.schedule('oh-discord-check', '5 0 * * *', 'select app.discord_hook_check()')$c$;
  end if;
end $$;

-- The admin page says whether the 08:00 messages go out on the minute.
create or replace function public.oh_admin_discord(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  b app.discord_bot;
  v_week int := app.booking_week();
  v_sample int;
  g app.groups;
  w app.weeks;
begin
  select * into b from app.discord_bot x where x.id = 1;
  -- the preview: preferably a group that has not decided yet and meets that week, as on Friday
  select x.id into v_sample from app.groups x
   where x.active and x.teacher_id is not null and x.slot_dow is not null
   order by exists (select 1 from app.requests r where r.group_id = x.id and r.week_id = v_week),
            app.fixed_holiday(x.id, v_week) is not null, x.no limit 1;
  select * into g from app.groups x where x.id = v_sample;
  select * into w from app.weeks x where x.id = v_week;
  return jsonb_build_object(
    'clock', app.clock(),
    'ready', b.public_key is not null and b.endpoint is not null,
    'name', b.name,
    'endpoint', b.endpoint,
    'checked_at', b.checked_at,
    'cron', app.discord_cron_on(),
    'week', (select jsonb_build_object('id', w.id, 'label', w.label, 'start', w.start_date,
                                       'deadline', to_char(app.week_deadline(w.start_date), 'YYYY-MM-DD HH24:MI'))
              where w.id is not null),
    'sample', case when w.id is not null and g.id is not null then app.discord_message(g.id, w.id) end,
    'sample_summary', case when w.id is not null and g.id is not null then app.discord_summary(g.id, w.id) end,
    'sample_today', case when w.id is not null and g.id is not null then
                      app.discord_today_message(g.id, w.start_date + g.slot_dow - 1, g.slot_time, g.teacher_id,
                        coalesce((select nullif(r.topic, '') from app.requests r where r.group_id = g.id and r.week_id = w.id), '組員填的題目')) end,
    'sample_group', g.no,
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', x.id, 'no', x.no, 'name', x.name, 'webhook', x.webhook is not null,
                 'channel', x.discord_channel is not null, 'ready', x.discord_ready,
                 'fixed', x.teacher_id is not null and x.slot_dow is not null
               ) order by x.no), '[]'::jsonb) from app.groups x where x.active),
    'posts', (select coalesce(jsonb_agg(y.j order by y.at desc), '[]'::jsonb) from (
                select * from (
                  select dp.posted_at as at, jsonb_build_object(
                           'id', 'a' || dp.id, 'kind', 'ask', 'group_no', x.no, 'week', app.discord_week(dp.week_id),
                           'posted_at', dp.posted_at, 'closed_at', dp.closed_at,
                           'status', (select r.status from app.requests r where r.group_id = dp.group_id and r.week_id = dp.week_id)) as j
                    from app.discord_posts dp join app.groups x on x.id = dp.group_id
                  union all
                  select n.posted_at, jsonb_build_object(
                           'id', 'n' || n.id, 'kind', n.kind, 'group_no', x.no,
                           'week', case when n.kind = 'summary'
                                        then coalesce((select app.discord_week(wk.id) from app.weeks wk where wk.start_date = n.on_date),
                                                      to_char(n.on_date, 'FMMM/FMDD'))
                                        else to_char(n.on_date, 'FMMM/FMDD') || '（' || app.wday(n.on_date) || '）' end,
                           'posted_at', n.posted_at, 'closed_at', null, 'status', null)
                    from app.discord_notes n join app.groups x on x.id = n.group_id
                ) z order by z.at desc limit 60) y)
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
     where n.nspname = 'public' and p.proname = 'oh_admin_discord'
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
