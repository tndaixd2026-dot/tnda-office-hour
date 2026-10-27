-- =====================================================================
-- Office Hour · Discord reminders
--
-- Besides Friday's question (now at 08:00) and Saturday's close, the bot
-- posts two more messages in each group's channel:
--   Sunday 08:00  next week's outcome, whatever it is: the session (time,
--                 PM, room, topic), or that the group skipped, did not
--                 answer, has a holiday or a paused week
--   08:00 on the day of a session  today's session, as the admins left it
-- app.discord_notes keeps what went out, so a rerun never posts twice.
-- =====================================================================

create table app.discord_notes (
  id         int generated always as identity primary key,
  kind       text not null check (kind in ('summary', 'today')),
  group_id   int  not null references app.groups (id) on delete cascade,
  -- the week's Monday for a summary, the session's day for a reminder
  on_date    date not null,
  channel_id text not null,
  message_id text not null,
  posted_at  timestamptz not null,
  unique (kind, group_id, on_date)
);
alter table app.discord_notes enable row level security;
revoke all on app.discord_notes from public;
drop trigger if exists ping on app.discord_notes;
create trigger ping after insert or update or delete on app.discord_notes
  for each statement execute function app.ping();

-- "第 1 組「…」 · Joseph · 🔗 [進入討論室](<…>)"
create or replace function app.discord_who(p_group int, p_teacher int) returns text
language sql stable set search_path = '' as $$
  select app.discord_escape(app.group_title(p_group))
         || case when s.show_teacher_names
                 then coalesce(' · ' || app.discord_escape((select t.name from app.teachers t where t.id = p_teacher)), '')
                 else '' end
         || coalesce(' · ' || case when r.room ~ '^https?://\S+$' then '🔗 [進入討論室](<' || r.room || '>)'
                                   else app.discord_escape(r.room) end, '')
    from app.settings s, (select app.room_of(p_teacher) as room) r
   where s.id = 1
$$;

-- The "打開網站" button, alone in its row (none until the site is known).
create or replace function app.discord_site_button() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce((select jsonb_build_array(jsonb_build_object('type', 1, 'components', jsonb_build_array(
                     jsonb_build_object('type', 2, 'style', 5, 'label', '打開網站', 'url', b.site))))
                     from app.discord_bot b where b.id = 1 and b.site is not null), '[]'::jsonb)
$$;

-- Today's session: on the day, at 08:00.
create or replace function app.discord_today_message(p_group int, p_d date, p_t time, p_teacher int, p_topic text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'content', left(
      '## ⏰ 今天 ' || to_char(p_d, 'FMMM/FMDD') || '（' || app.wday(p_d) || '）有 Office Hour'
      || E'\n### ' || app.hm(p_t) || '–' || app.hm(p_t + make_interval(mins => s.slot_minutes))
      || E'\n' || app.discord_who(p_group, p_teacher)
      || coalesce(E'\n> 💬 **' || app.discord_escape(p_topic) || '**', '')
      || E'\n-# 時間到了點上面的連結進入討論室。討論時 Google Meet 會錄影，僅作為紀錄使用', 1900),
    'components', app.discord_site_button(),
    'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb))
    from app.settings s where s.id = 1
$$;

-- Next week's outcome, on Sunday: what the group will have, or why not.
create or replace function app.discord_summary(p_group int, p_week int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  g app.groups;
  w app.weeks;
  r app.requests;
  a app.appointments;
  cfg app.settings := app.cfg();
  v_holiday text := app.fixed_holiday(p_group, p_week);
  v_wk text;
  v_d date;
  v_text text;
begin
  select * into g from app.groups x where x.id = p_group;
  select * into w from app.weeks x where x.id = p_week;
  select * into r from app.requests x where x.group_id = p_group and x.week_id = p_week;
  select * into a from app.appointments x where x.group_id = p_group and x.week_id = p_week
   order by x.status = 'confirmed' desc, x.id desc limit 1;
  v_wk := '下週（' || coalesce(nullif(w.label, ''), to_char(w.start_date, 'FMMM/FMDD') || ' 那週') || '）';
  v_d := w.start_date + g.slot_dow - 1;

  if not w.open then
    v_text := '## 📌 ' || v_wk || '暫停'
              || E'\n-# 這週不排 Office Hour，有問題可以問助教';
  elsif v_holiday is not null then
    v_text := '## 📌 ' || v_wk || '停一次'
              || E'\n' || to_char(v_d, 'FMMM/FMDD') || '（' || app.wday(v_d) || '）遇到' || app.discord_escape(v_holiday) || '，這週不排討論';
  elsif a.status = 'confirmed' then
    v_text := '## 📌 ' || v_wk || '的 Office Hour'
              || E'\n### ' || app.slot_text(a.d, a.t)
              || E'\n' || app.discord_who(p_group, a.teacher_id)
              || coalesce(E'\n> 💬 **' || app.discord_escape(nullif(r.topic, '')) || '**', '')
              || E'\n-# 當天 08:00 會再提醒一次。不能來的話，開始前 ' || cfg.cancel_hours || ' 小時以上可以在網站上取消，來不及就告訴助教';
  elsif a.status = 'cancelled' then
    v_text := '## 📌 ' || v_wk || '的 Office Hour 已取消'
              || E'\n### ~~' || app.slot_text(a.d, a.t) || '~~'
              || coalesce(E'\n-# ' || app.discord_escape(a.cancelled_by) || ' 取消'
                          || coalesce('：' || app.discord_escape(a.cancel_reason), ''), '');
  elsif r.status = 'skipped' then
    v_text := '## 📌 ' || v_wk || '不排 Office Hour'
              || E'\n-# 你們選了這週不約（' || app.discord_escape(r.author) || ' 決定的）';
  else
    v_text := '## 📌 ' || v_wk || '沒有 Office Hour'
              || E'\n-# ' || app.deadline_text(app.week_deadline(w.start_date)) || ' 前沒有預約，這週不排討論';
  end if;

  return jsonb_build_object(
    'content', left(v_text, 1900),
    'components', app.discord_site_button(),
    'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb));
end $$;

-- Sunday's messages: each group's outcome for the week starting next Monday.
create or replace function app.discord_summary_outbox(p_force boolean default false, p_only int default null)
returns table (group_id int, group_no int, on_date date, channel_id text, payload jsonb)
language sql stable set search_path = '' as $$
  select g.id, g.no, w.start_date, g.discord_channel, app.discord_summary(g.id, w.id)
    from app.weeks w
    join app.groups g on g.active and g.discord_channel is not null and g.discord_ready
                     and g.teacher_id is not null and g.slot_dow is not null
   where w.start_date = app.today() + (8 - extract(isodow from app.today())::int)
     and (p_only is null or g.no = p_only)
     and (p_force or not exists (select 1 from app.discord_notes n
                                  where n.kind = 'summary' and n.group_id = g.id and n.on_date = w.start_date))
   order by g.no
$$;

-- The day's messages: each confirmed session today that has not started yet.
create or replace function app.discord_today_outbox(p_force boolean default false, p_only int default null)
returns table (group_id int, group_no int, on_date date, channel_id text, payload jsonb)
language sql stable set search_path = '' as $$
  select distinct on (g.no) g.id, g.no, a.d, g.discord_channel,
         app.discord_today_message(g.id, a.d, a.t, a.teacher_id,
                                   (select nullif(r.topic, '') from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id))
    from app.appointments a
    join app.groups g on g.id = a.group_id and g.active and g.discord_channel is not null and g.discord_ready
   where a.status = 'confirmed' and a.d = app.today() and a.d + a.t > app.local_now()
     and (p_only is null or g.no = p_only)
     and (p_force or not exists (select 1 from app.discord_notes n
                                  where n.kind = 'today' and n.group_id = g.id and n.on_date = a.d))
   order by g.no, a.t
$$;

create or replace function app.discord_noted(p_kind text, p_group int, p_date date, p_channel text, p_message text) returns void
language sql set search_path = '' as $$
  insert into app.discord_notes (kind, group_id, on_date, channel_id, message_id, posted_at)
  values (p_kind, p_group, p_date, p_channel, p_message, app.now())
  on conflict (kind, group_id, on_date) do update
    set channel_id = excluded.channel_id, message_id = excluded.message_id, posted_at = excluded.posted_at;
$$;

-- The admins also see the reminders: previews of all three messages, and
-- the reminders among what was sent.
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
