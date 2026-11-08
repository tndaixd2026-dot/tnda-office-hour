-- =====================================================================
-- Office Hour · ask each group in Discord
--
-- Every Friday a bot posts in each group's own Discord channel: next
-- week's fixed slot with buttons. 「預約這週」 opens a Discord form for
-- the topic, questions, progress and folder link and books the slot;
-- 「這週不約」 skips the week. Both go through app.booking_save and
-- app.booking_skip, the site's own rules, so Saturday 20:00 closes them;
-- the message is then rewritten with the outcome and loses its buttons.
--
-- scripts/discord-ask.mjs (GitHub Actions) posts and rewrites the
-- messages with the bot's token. It also does the setup: it reads the
-- bot's public key from Discord, points the bot's interactions at
-- supabase/functions/discord, and learns each group's channel from the
-- group's webhook. The function checks Discord's signature on every
-- button press and hands it to app.discord_interaction, which writes the
-- answer. Neither keeps any logic of its own.
-- =====================================================================

-- Each group's channel (from its webhook), and whether the bot can see it.
alter table app.groups
  add column discord_channel text check (discord_channel ~ '^[0-9]{15,25}$'),
  add column discord_ready boolean not null default false;

-- The bot, as the sender last found it: the public key Discord signs its
-- button presses with, its name, where its interactions go, and the site
-- the messages link to.
create table app.discord_bot (
  id         int primary key default 1 check (id = 1),
  public_key text check (public_key ~ '^[0-9a-f]{64}$'),
  name       text check (length(name) <= 100),
  endpoint   text check (length(endpoint) <= 300),
  site       text check (site ~ '^https?://\S+$' and length(site) <= 200),
  checked_at timestamptz
);
insert into app.discord_bot (id) values (1);

-- The message each group got about a week, to rewrite once it closes.
create table app.discord_posts (
  id         int generated always as identity primary key,
  group_id   int  not null references app.groups (id) on delete cascade,
  week_id    int  not null references app.weeks (id) on delete cascade,
  channel_id text not null,
  message_id text not null unique,
  posted_at  timestamptz not null,
  closed_at  timestamptz,
  unique (group_id, week_id)
);

-- What someone typed in the Discord form when it was turned down (say, a
-- link that is not a link), so the form comes back filled in.
create table app.discord_drafts (
  group_id  int not null references app.groups (id) on delete cascade,
  week_id   int not null references app.weeks (id) on delete cascade,
  topic     text,
  questions text,
  progress  text,
  link      text,
  saved_at  timestamptz not null,
  primary key (group_id, week_id)
);

alter table app.discord_bot    enable row level security;
alter table app.discord_posts  enable row level security;
alter table app.discord_drafts enable row level security;
revoke all on app.discord_bot, app.discord_posts, app.discord_drafts from public;

do $$
declare
  t text;
begin
  foreach t in array array['discord_bot', 'discord_posts'] loop
    execute format('drop trigger if exists ping on app.%I', t);
    execute format('create trigger ping after insert or update or delete on app.%I
                    for each statement execute function app.ping()', t);
  end loop;
end $$;

-- "W9 11/2–11/6"
create or replace function app.discord_week(p_week int) returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(w.label, '') || ' ', '') || to_char(w.start_date, 'FMMM/FMDD') || '–' || to_char(w.start_date + 4, 'FMMM/FMDD')
    from app.weeks w where w.id = p_week
$$;

-- "11/4（三）10:00–11:00 · Prolong": the session if there is one (the
-- admins may have moved it or handed it to another PM), else the fixed slot.
create or replace function app.discord_slot(p_group int, p_week int) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select app.slot_text(a.d, a.t) || case when s.show_teacher_names then ' · ' || t.name else '' end
       from app.appointments a join app.teachers t on t.id = a.teacher_id
      where a.group_id = p_group and a.week_id = p_week and a.status = 'confirmed'
      order by a.d, a.t limit 1),
    (select app.slot_text(w.start_date + g.slot_dow - 1, g.slot_time) || case when s.show_teacher_names then ' · ' || t.name else '' end
       from app.groups g join app.weeks w on w.id = p_week join app.teachers t on t.id = g.teacher_id
      where g.id = p_group and g.slot_dow is not null))
    from app.settings s where s.id = 1
$$;

-- The message about one group's week, as it stands now: what they
-- decided, and while the week is open, the buttons to decide or change it.
create or replace function app.discord_message(p_group int, p_week int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  g app.groups;
  w app.weeks;
  r app.requests;
  a app.appointments;
  v_site text := (select b.site from app.discord_bot b where b.id = 1);
  v_open boolean := app.week_bookable(p_week, p_group);
  v_deadline text;
  v_wk text := app.discord_week(p_week);
  v_room text;
  v_holiday text := app.fixed_holiday(p_group, p_week);
  v_text text;
  v_buttons jsonb := '[]';
begin
  select * into g from app.groups x where x.id = p_group;
  select * into w from app.weeks x where x.id = p_week;
  select * into r from app.requests x where x.group_id = p_group and x.week_id = p_week;
  select * into a from app.appointments x where x.group_id = p_group and x.week_id = p_week
   order by x.status = 'confirmed' desc, x.id desc limit 1;
  v_deadline := app.deadline_text(app.week_deadline(w.start_date));
  v_room := app.room_of(coalesce(a.teacher_id, g.teacher_id));
  v_room := case when v_room ~ '^https?://' then '<' || v_room || '>' else v_room end;

  if not w.open then
    v_text := '**' || v_wk || ' 暫停**' || E'\n這週不排 Office Hour，有問題可以問助教';
  elsif v_holiday is not null then
    v_text := '**' || v_wk || ' 遇到' || v_holiday || '，停一次**' || E'\n固定時段那天放假，這週不用預約';
  elsif r.status = 'open' and a.status = 'cancelled' then
    v_text := '**' || v_wk || ' 的 Office Hour 已取消**' || E'\n' || app.slot_text(a.d, a.t)
              || coalesce(E'\n' || a.cancelled_by || ' 取消' || coalesce('：' || a.cancel_reason, ''), '');
  elsif r.status = 'open' then
    v_text := '**✅ ' || v_wk || ' 已預約 Office Hour**' || E'\n' || coalesce(app.discord_slot(p_group, p_week), '')
              || coalesce(E'\n討論室：' || v_room, '')
              || E'\n題目：' || r.topic
              || E'\n' || r.author || ' 填的'
              || case when v_open then '，' || v_deadline || ' 前都可以修改或改成這週不約' else '' end;
  elsif r.status = 'skipped' then
    v_text := '**' || v_wk || ' 這週不約**' || E'\n' || r.author || ' 決定的'
              || case when v_open then '，' || v_deadline || ' 前都可以改成預約' else '' end;
  elsif v_open then
    v_text := '**📅 ' || v_wk || ' 要約 Office Hour 嗎？**'
              || E'\n' || app.group_title(p_group) || '的固定時段：' || coalesce(app.discord_slot(p_group, p_week), '')
              || E'\n請在 ' || v_deadline || ' 前決定。要約就按「預約這週」，填好題目、想問的問題、目前進度和雲端資料夾連結';
  else
    v_text := '**' || v_wk || ' 沒有預約**' || E'\n已在 ' || v_deadline || ' 截止，這週不排討論';
  end if;

  -- 這週不約 carries the version it was drawn with: pressed on a message
  -- that no longer shows what the group decided, it only redraws it
  if v_open and r.status = 'open' and a.status is distinct from 'cancelled' then
    v_buttons := jsonb_build_array(
      jsonb_build_object('type', 2, 'style', 2, 'label', '修改內容', 'custom_id', 'oh:book:' || p_week),
      jsonb_build_object('type', 2, 'style', 4, 'label', '這週不約', 'custom_id', 'oh:skip:' || p_week || ':' || r.version));
  elsif v_open and r.status = 'skipped' then
    v_buttons := jsonb_build_array(
      jsonb_build_object('type', 2, 'style', 1, 'label', '改成預約', 'custom_id', 'oh:book:' || p_week));
  elsif v_open and r.status is distinct from 'open' then
    v_buttons := jsonb_build_array(
      jsonb_build_object('type', 2, 'style', 1, 'label', '預約這週', 'custom_id', 'oh:book:' || p_week),
      jsonb_build_object('type', 2, 'style', 2, 'label', '這週不約', 'custom_id', 'oh:skip:' || p_week || ':' || coalesce(r.version, 0)));
  end if;
  if v_site is not null then
    v_buttons := v_buttons || jsonb_build_array(jsonb_build_object('type', 2, 'style', 5, 'label', '打開網站', 'url', v_site));
  end if;

  return jsonb_build_object(
    'content', left(v_text, 1900),
    'components', case when jsonb_array_length(v_buttons) > 0
                       then jsonb_build_array(jsonb_build_object('type', 1, 'components', v_buttons))
                       else '[]'::jsonb end,
    -- never let student-typed text ping @everyone or roles
    'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb));
end $$;

-- A reply only the person who pressed the button sees.
create or replace function app.discord_reply(p_text text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('type', 4, 'data', jsonb_build_object('content', p_text, 'flags', 64))
$$;

-- Rewrites the message the button was on.
create or replace function app.discord_update(p_group int, p_week int) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('type', 7, 'data', app.discord_message(p_group, p_week))
$$;

-- The booking form, filled in with what the group wrote before (or what
-- was just turned down, if that is newer).
create or replace function app.discord_form(p_group int, p_week int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  g app.groups;
  w app.weeks;
  r app.requests;
  d app.discord_drafts;
  v_day date;
  v_topic text;
  v_questions text;
  v_progress text;
  v_link text;
  input jsonb;
begin
  select * into g from app.groups x where x.id = p_group;
  select * into w from app.weeks x where x.id = p_week;
  select * into r from app.requests x where x.group_id = p_group and x.week_id = p_week;
  select * into d from app.discord_drafts x where x.group_id = p_group and x.week_id = p_week;
  if d.saved_at is not null and (r.updated_at is null or d.saved_at > r.updated_at) then
    v_topic := d.topic; v_questions := d.questions; v_progress := d.progress; v_link := d.link;
  else
    v_topic := nullif(r.topic, ''); v_questions := nullif(r.questions, ''); v_progress := nullif(r.progress, ''); v_link := r.link;
  end if;
  v_day := w.start_date + g.slot_dow - 1;
  input := '{"type": 4, "required": true}';
  return jsonb_strip_nulls(jsonb_build_object('type', 9, 'data', jsonb_build_object(
    'custom_id', 'oh:save:' || p_week || ':' || coalesce(r.version, 0),
    'title', left(case when r.status = 'open' then '修改 ' else '預約 ' end
                  || coalesce(nullif(w.label, '') || ' ', '') || to_char(v_day, 'FMMM/FMDD') || '（' || app.wday(v_day) || '）'
                  || app.hm(g.slot_time), 45),
    'components', jsonb_build_array(
      jsonb_build_object('type', 1, 'components', jsonb_build_array(input || jsonb_build_object(
        'custom_id', 'topic', 'style', 1, 'label', '想討論的題目', 'min_length', 1, 'max_length', 80,
        'placeholder', '例：互動裝置的感測器要選哪一種', 'value', left(v_topic, 80)))),
      jsonb_build_object('type', 1, 'components', jsonb_build_array(input || jsonb_build_object(
        'custom_id', 'questions', 'style', 2, 'label', '想問 PM 的問題（一行一個）', 'min_length', 1, 'max_length', 1000,
        'placeholder', '例：感測器延遲 0.3 秒，觀眾感覺得到嗎', 'value', left(v_questions, 1000)))),
      jsonb_build_object('type', 1, 'components', jsonb_build_array(input || jsonb_build_object(
        'custom_id', 'progress', 'style', 2, 'label', '目前進度', 'min_length', 1, 'max_length', 1000,
        'placeholder', '做到哪裡、卡在哪裡', 'value', left(v_progress, 1000)))),
      jsonb_build_object('type', 1, 'components', jsonb_build_array(input || jsonb_build_object(
        'custom_id', 'link', 'style', 1, 'label', '雲端資料夾連結（請開放知道連結的人檢視）', 'min_length', 8, 'max_length', 500,
        'placeholder', 'https://drive.google.com/…', 'value', left(v_link, 500))))
    ))));
end $$;

-- What went wrong, for the person who pressed the button.
create or replace function app.discord_error(p_code text, p_detail text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_code = 'VALIDATION' and p_detail = 'link' then '雲端資料夾連結要貼完整網址（https:// 開頭）'
    when p_code = 'VALIDATION' and p_detail = 'topic' then '題目要 1–80 字'
    when p_code = 'VALIDATION' and p_detail = 'questions' then '想問 PM 的問題要 1–1000 字'
    when p_code = 'VALIDATION' and p_detail = 'progress' then '目前進度要 1–1000 字'
    when p_code = 'CONFLICT' then '組員剛剛也改了這週的預約，請再按一次按鈕看最新的內容'
    when p_code = 'NO_FIXED_SLOT' then '助教還沒設定你們的固定時段，請告訴助教'
    when p_code = 'SLOT_TAKEN' then '這個時段已經有別的場次，請告訴助教'
    else '出了點問題（' || p_code || '），請改用網站預約，或告訴助教'
  end
$$;

-- Answers a button press or a submitted form. Discord's signature has
-- already been checked; the group is the one the message was posted for
-- (or whose channel this is), and only in that channel.
create or replace function app.discord_interaction(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_type int := (p ->> 'type')::int;
  v_parts text[] := string_to_array(coalesce(p -> 'data' ->> 'custom_id', ''), ':');
  v_channel text := p ->> 'channel_id';
  v_week int;
  v_version int;
  g app.groups;
  r app.requests;
  s app.sessions;
  v jsonb;
  v_code text;
  v_detail text;
begin
  if v_type = 1 then
    return '{"type": 1}';
  end if;
  if v_type not in (3, 5) or v_parts[1] is distinct from 'oh' or coalesce(v_parts[3], '') !~ '^[0-9]{1,9}$' then
    return app.discord_reply('這個按鈕已經不能用了');
  end if;
  v_week := v_parts[3]::int;
  v_version := case when coalesce(v_parts[4], '') ~ '^[1-9][0-9]{0,8}$' then v_parts[4]::int end;

  select x.* into g from app.groups x
    join app.discord_posts dp on dp.group_id = x.id
   where dp.message_id = p -> 'message' ->> 'id' and dp.channel_id = v_channel;
  if g.id is null and (select count(*) from app.groups x where x.discord_channel = v_channel) = 1 then
    select x.* into g from app.groups x where x.discord_channel = v_channel;
  end if;
  if g.id is null or not g.active then
    return app.discord_reply('這個頻道沒有對應的小組，請告訴助教');
  end if;
  if not exists (select 1 from app.weeks w where w.id = v_week) then
    return app.discord_reply('這個按鈕已經不能用了');
  end if;

  -- who pressed it: their server nickname, else their Discord name
  s.role := 'student';
  s.group_id := g.id;
  s.name := left(coalesce(app.clean(p -> 'member' ->> 'nick'), app.clean(p -> 'member' -> 'user' ->> 'global_name'),
                          app.clean(p -> 'member' -> 'user' ->> 'username'), 'Discord'), 30);
  select * into r from app.requests x where x.group_id = g.id and x.week_id = v_week;

  if v_type = 3 and v_parts[2] = 'book' then
    -- once the week has closed (or stopped), the message says so itself
    if not app.week_bookable(v_week, g.id) then
      return app.discord_update(g.id, v_week);
    end if;
    return app.discord_form(g.id, v_week);
  end if;

  if v_type = 3 and v_parts[2] = 'skip' then
    begin
      perform app.booking_skip(s, v_week, v_version);
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_code = message_text, v_detail = pg_exception_detail;
      if v_code in ('WEEK_LATE', 'WEEK_CLOSED', 'CONFLICT') then
        return app.discord_update(g.id, v_week);
      end if;
      return app.discord_reply(app.discord_error(v_code, v_detail));
    end;
    return app.discord_update(g.id, v_week);
  end if;

  if v_type = 5 and v_parts[2] = 'save' then
    -- text inputs come in action rows (or, in newer forms, labels)
    select jsonb_object_agg(c ->> 'custom_id', c ->> 'value') into v
      from (select jsonb_path_query(p -> 'data' -> 'components', 'lax $[*].components[*]') as c
            union all
            select jsonb_path_query(p -> 'data' -> 'components', 'lax $[*].component')) x
     where jsonb_typeof(c) = 'object' and c ? 'custom_id';
    v := coalesce(v, '{}');
    begin
      perform app.booking_save(s, v_week, v ->> 'topic', v ->> 'questions', v ->> 'progress', v ->> 'link', v_version);
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_code = message_text, v_detail = pg_exception_detail;
      if v_code in ('WEEK_LATE', 'WEEK_CLOSED', 'WEEK_HOLIDAY') then
        return app.discord_update(g.id, v_week);
      end if;
      if v_code = 'VALIDATION' then
        insert into app.discord_drafts (group_id, week_id, topic, questions, progress, link, saved_at)
        values (g.id, v_week, left(v ->> 'topic', 80), left(v ->> 'questions', 1000), left(v ->> 'progress', 1000), left(v ->> 'link', 500), app.now())
        on conflict (group_id, week_id) do update
          set topic = excluded.topic, questions = excluded.questions, progress = excluded.progress,
              link = excluded.link, saved_at = excluded.saved_at;
        return app.discord_reply(app.discord_error(v_code, v_detail) || '。再按一次按鈕，剛剛填的內容都還在');
      end if;
      return app.discord_reply(app.discord_error(v_code, v_detail));
    end;
    delete from app.discord_drafts x where x.group_id = g.id and x.week_id = v_week;
    return app.discord_update(g.id, v_week);
  end if;

  return app.discord_reply('這個按鈕已經不能用了');
end $$;

-- ---------------------------------------------------------------------
-- For the sender (scripts/discord-ask.mjs)
-- ---------------------------------------------------------------------

-- Groups with a webhook, whose channel the sender looks up from it.
create or replace function app.discord_webhooks() returns table (group_id int, group_no int, webhook text)
language sql stable set search_path = '' as $$
  select g.id, g.no, g.webhook from app.groups g where g.active and g.webhook is not null order by g.no
$$;

create or replace function app.discord_set_channel(p_group int, p_channel text, p_ready boolean) returns void
language sql set search_path = '' as $$
  update app.groups g set discord_channel = p_channel, discord_ready = coalesce(p_ready, false)
   where g.id = p_group and (g.discord_channel, g.discord_ready) is distinct from (p_channel, coalesce(p_ready, false));
$$;

create or replace function app.discord_set_bot(p_key text, p_name text, p_endpoint text, p_site text) returns void
language sql set search_path = '' as $$
  update app.discord_bot b
     set public_key = lower(p_key), name = left(p_name, 100), endpoint = left(p_endpoint, 300), site = p_site, checked_at = app.now()
   where b.id = 1;
$$;

-- The week to ask about (the next one still open) and each group's
-- message about it; groups already asked are left out unless forced.
create or replace function app.discord_outbox(p_force boolean default false, p_only int default null)
returns table (group_id int, group_no int, week_id int, channel_id text, payload jsonb)
language sql stable set search_path = '' as $$
  select g.id, g.no, b.w, g.discord_channel, app.discord_message(g.id, b.w)
    from (select app.booking_week() as w) b
    join app.groups g on g.active and g.discord_channel is not null and g.discord_ready
                     and g.teacher_id is not null and g.slot_dow is not null
   where b.w is not null
     and (p_only is null or g.no = p_only)
     and (p_force or not exists (select 1 from app.discord_posts dp where dp.group_id = g.id and dp.week_id = b.w))
   order by g.no
$$;

create or replace function app.discord_posted(p_group int, p_week int, p_channel text, p_message text) returns void
language sql set search_path = '' as $$
  insert into app.discord_posts (group_id, week_id, channel_id, message_id, posted_at)
  values (p_group, p_week, p_channel, p_message, app.now())
  on conflict (group_id, week_id) do update
    set channel_id = excluded.channel_id, message_id = excluded.message_id,
        posted_at = excluded.posted_at, closed_at = null;
$$;

-- Messages whose week has closed but that still show their buttons.
create or replace function app.discord_closing()
returns table (post_id int, group_no int, channel_id text, message_id text, payload jsonb)
language sql stable set search_path = '' as $$
  select dp.id, g.no, dp.channel_id, dp.message_id, app.discord_message(dp.group_id, dp.week_id)
    from app.discord_posts dp
    join app.groups g on g.id = dp.group_id
    join app.weeks w on w.id = dp.week_id
   where dp.closed_at is null and app.local_now() >= app.week_deadline(w.start_date)
   order by g.no
$$;

create or replace function app.discord_closed(p_post int) returns void
language sql set search_path = '' as $$
  update app.discord_posts dp set closed_at = app.now() where dp.id = p_post;
$$;

-- ---------------------------------------------------------------------
-- For the admins
-- ---------------------------------------------------------------------

create or replace function public.oh_admin_discord(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  b app.discord_bot;
  v_week int := app.booking_week();
  v_sample int;
begin
  select * into b from app.discord_bot x where x.id = 1;
  -- the preview: preferably a group that has not decided yet, as on Friday
  select g.id into v_sample from app.groups g
   where g.active and g.teacher_id is not null and g.slot_dow is not null
   order by exists (select 1 from app.requests r where r.group_id = g.id and r.week_id = v_week), g.no limit 1;
  return jsonb_build_object(
    'clock', app.clock(),
    'ready', b.public_key is not null and b.endpoint is not null,
    'name', b.name,
    'endpoint', b.endpoint,
    'checked_at', b.checked_at,
    'week', (select jsonb_build_object('id', w.id, 'label', w.label, 'start', w.start_date,
                                       'deadline', to_char(app.week_deadline(w.start_date), 'YYYY-MM-DD HH24:MI'))
               from app.weeks w where w.id = v_week),
    'sample', case when v_week is not null and v_sample is not null then app.discord_message(v_sample, v_week) end,
    'sample_group', (select g.no from app.groups g where g.id = v_sample),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', g.id, 'no', g.no, 'name', g.name, 'webhook', g.webhook is not null,
                 'channel', g.discord_channel is not null, 'ready', g.discord_ready,
                 'fixed', g.teacher_id is not null and g.slot_dow is not null
               ) order by g.no), '[]'::jsonb) from app.groups g where g.active),
    'posts', (select coalesce(jsonb_agg(x.j order by x.posted_at desc), '[]'::jsonb) from (
                select dp.posted_at, jsonb_build_object(
                         'id', dp.id, 'group_no', g.no, 'week_id', dp.week_id, 'week', app.discord_week(dp.week_id),
                         'posted_at', dp.posted_at, 'closed_at', dp.closed_at,
                         'status', (select r.status from app.requests r where r.group_id = dp.group_id and r.week_id = dp.week_id)) as j
                  from app.discord_posts dp join app.groups g on g.id = dp.group_id
                 order by dp.posted_at desc limit 50) x)
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
