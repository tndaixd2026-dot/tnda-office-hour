-- =====================================================================
-- Office Hour · the weekly email to the teachers
--
-- Every Monday 09:00 a GitHub Actions job (scripts/send-mail.mjs) sends
-- each recipient the week's sessions of the teachers they follow, and
-- on Sunday 18:00 it first sends a preview of all of it to the admins'
-- own mailbox. The messages are written here, so the admin page can
-- show exactly what will go out; mail_log makes sure nobody gets the
-- same week twice.
-- =====================================================================

create or replace function app.is_email(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and length(p) <= 120 and p ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$'
$$;

create table app.mail_settings (
  id         int primary key default 1 check (id = 1),
  weekly     boolean not null default true,   -- Monday 09:00 to the recipients
  preview    boolean not null default true,   -- Sunday 18:00 to the admins' mailbox
  ta_email   text not null default '' check (ta_email = '' or app.is_email(ta_email)),
  updated_at timestamptz not null default now()
);
insert into app.mail_settings (id) values (1);

-- Who gets the Monday email, and whose sessions (no teachers = all of them).
create table app.mail_recipients (
  id         int generated always as identity primary key,
  email      text not null check (app.is_email(email)),
  name       text not null default '' check (length(name) <= 40),
  teachers   int[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index mail_recipients_email on app.mail_recipients (lower(email));

create table app.mail_log (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('weekly', 'preview')),
  week_start date not null,
  email      text not null,
  subject    text not null,
  sessions   int not null default 0,
  sent_at    timestamptz not null default now()
);
create unique index mail_log_once on app.mail_log (kind, week_start, lower(email));

alter table app.mail_settings enable row level security;
alter table app.mail_recipients enable row level security;
alter table app.mail_log enable row level security;
revoke all on app.mail_settings, app.mail_recipients, app.mail_log from public;

do $$
declare
  t text;
begin
  foreach t in array array['mail_settings', 'mail_recipients', 'mail_log'] loop
    execute format('drop trigger if exists ping on app.%I', t);
    execute format('create trigger ping after insert or update or delete on app.%I
                    for each statement execute function app.ping()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Writing the messages
-- ---------------------------------------------------------------------
create or replace function app.html(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

create or replace function app.url_encode(p text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(
           case when ch ~ '^[A-Za-z0-9._~-]$' then ch
                else upper(regexp_replace(encode(convert_to(ch, 'UTF8'), 'hex'), '(..)', '%\1', 'g')) end,
           '' order by i), '')
    from regexp_split_to_table(coalesce(p, ''), '') with ordinality as x (ch, i)
$$;

-- The Monday the email is about: today when it is Monday, else the next one.
create or replace function app.mail_week(p_today date) returns date
language sql immutable set search_path = '' as $$
  select p_today + ((8 - extract(isodow from p_today)::int) % 7)
$$;

-- A Google Calendar link that adds one event.
create or replace function app.gcal_link(p_title text, p_d date, p_t time, p_minutes int, p_details text, p_location text)
returns text
language sql stable set search_path = '' as $$
  select 'https://calendar.google.com/calendar/render?action=TEMPLATE'
         || '&text=' || app.url_encode(p_title)
         || '&dates=' || app.ics_stamp(p_d, p_t) || '/' || app.ics_stamp(p_d, p_t + make_interval(mins => p_minutes))
         || '&details=' || app.url_encode(p_details)
         || case when coalesce(p_location, '') <> '' then '&location=' || app.url_encode(p_location) else '' end
$$;

-- "第 2 組「看到太陽就知道完蛋了」" without the 「」 when there is no name
create or replace function app.mail_button(p_href text, p_label text, p_big boolean default false) returns text
language sql immutable set search_path = '' as $$
  select format('<a href="%s" style="display:inline-block;padding:%s;border-radius:10px;background:%s;color:%s;'
                || 'border:1px solid #161514;font-size:%s;font-weight:700;text-decoration:none;">%s</a>',
                app.html(p_href), case when p_big then '12px 20px' else '7px 12px' end,
                case when p_big then '#161514' else '#ffffff' end, case when p_big then '#ffffff' else '#161514' end,
                case when p_big then '15px' else '13px' end, app.html(p_label))
$$;

-- One message: the week starting p_week, for p_teachers (empty = all).
-- p_site is the platform's address; p_api / p_key build calendar links.
create or replace function app.mail_message(p_week date, p_teachers int[], p_name text,
                                            p_site text, p_api text, p_key text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  cfg app.settings := app.cfg();
  v_all boolean := coalesce(cardinality(p_teachers), 0) = 0
                   or not exists (select 1 from app.teachers t where not t.team and t.active and not (t.id = any (p_teachers)));
  v_who text;
  v_feed text;
  v_range text := to_char(p_week, 'FMMM/FMDD') || '–' || to_char(p_week + 6, 'FMMM/FMDD');
  v_count int;
  v_subject text;
  v_days text := '';
  v_text text := '';
  v_place text;
  d record;
  r record;
  v_href text;
begin
  if not v_all then
    select string_agg(t.name, '、' order by t.sort, t.id) into v_who
      from app.teachers t where t.id = any (p_teachers);
  end if;

  select count(*) into v_count
    from app.appointments a
   where a.status = 'confirmed' and a.d between p_week and p_week + 6
     and (v_all or a.teacher_id = any (p_teachers));

  v_subject := '【Office Hour】' || coalesce(v_who || ' ', '')
               || case when v_count = 0 then '本週沒有場次' else '本週 ' || v_count || ' 場' end
               || '（' || v_range || '）';

  -- one teacher: their own feed; otherwise the shared account's
  select t.feed into v_feed from app.teachers t
   where t.active and ((not v_all and cardinality(p_teachers) = 1 and t.id = p_teachers[1]) or ((v_all or cardinality(p_teachers) > 1) and t.team))
   order by t.team limit 1;

  v_place := case when cfg.location ~* '^https?://' then format('<a href="%s" style="color:#161514;">%s</a>', app.html(cfg.location),
                                                              case when cfg.location ~* 'meet\.google\.com' then 'Google Meet 會議室' else app.html(cfg.location) end)
                  else app.html(coalesce(nullif(cfg.location, ''), '線上')) end;

  for d in
    select distinct a.d from app.appointments a
     where a.status = 'confirmed' and a.d between p_week and p_week + 6
       and (v_all or a.teacher_id = any (p_teachers))
     order by a.d
  loop
    v_days := v_days || format('<tr><td style="padding:18px 28px 6px;font-size:15px;font-weight:700;">%s</td></tr>',
                               '週' || app.wday(d.d) || ' ' || to_char(d.d, 'FMMM/FMDD'));
    v_text := v_text || E'\n' || '週' || app.wday(d.d) || ' ' || to_char(d.d, 'FMMM/FMDD') || E'\n';
    for r in
      select a.t, te.name as teacher, g.no, g.name as gname, rq.topic, rq.progress, rq.link, a.group_id
        from app.appointments a
        join app.teachers te on te.id = a.teacher_id
        join app.groups g on g.id = a.group_id
        left join app.requests rq on rq.week_id = a.week_id and rq.group_id = a.group_id
       where a.status = 'confirmed' and a.d = d.d and (v_all or a.teacher_id = any (p_teachers))
       order by a.t, te.sort
    loop
      v_href := app.gcal_link(
        'Office Hour · ' || r.teacher || ' · ' || app.group_title(r.group_id) || coalesce('｜' || r.topic, ''),
        d.d, r.t, cfg.slot_minutes,
        concat_ws(E'\n', app.group_title(r.group_id), '老師：' || r.teacher, '題目：' || r.topic, '進度：' || r.progress,
                  '資料：' || r.link),
        cfg.location);
      v_days := v_days || format(
        '<tr><td style="padding:4px 28px;"><table role="presentation" width="100%%" cellpadding="0" cellspacing="0" '
        || 'style="border:1px solid #e4e1da;border-radius:12px;"><tr><td style="padding:14px 16px;">'
        || '<p style="margin:0;font-size:15px;"><b style="font-family:Menlo,Consolas,monospace;">%s–%s</b>&nbsp;&nbsp;%s</p>'
        || '<p style="margin:6px 0 0;font-size:15px;font-weight:700;">%s</p>'
        || '%s%s%s'
        || '<p style="margin:12px 0 0;">%s</p>'
        || '</td></tr></table></td></tr>',
        app.hm(r.t), app.hm(r.t + make_interval(mins => cfg.slot_minutes)), app.html(r.teacher),
        app.html(app.group_title(r.group_id)),
        case when r.topic is not null then format('<p style="margin:6px 0 0;font-size:14px;">題目：%s</p>', app.html(r.topic)) else '' end,
        case when r.progress is not null then format('<p style="margin:4px 0 0;font-size:13px;color:#5f5d57;white-space:pre-line;">%s</p>', app.html(r.progress)) else '' end,
        case when r.link ~* '^https?://' then format('<p style="margin:6px 0 0;font-size:13px;"><a href="%s" style="color:#161514;">雲端資料夾</a></p>', app.html(r.link)) else '' end,
        app.mail_button(v_href, '＋ 加到 Google 日曆'));
      v_text := v_text || format(E'  %s–%s %s %s%s\n  加到 Google 日曆：%s\n',
                                 app.hm(r.t), app.hm(r.t + make_interval(mins => cfg.slot_minutes)), r.teacher,
                                 app.group_title(r.group_id), coalesce('｜' || r.topic, ''), v_href);
    end loop;
  end loop;

  return jsonb_build_object(
    'subject', v_subject,
    'count', v_count,
    'text', concat_ws(E'\n',
              case when coalesce(p_name, '') <> '' then p_name || ' 您好' end,
              case when v_count = 0 then '這週（' || v_range || '）沒有排到 Office Hour'
                   else '這週（' || v_range || '）' || coalesce(v_who || ' ', '') || '有 ' || v_count || ' 場 Office Hour，每場 '
                        || cfg.slot_minutes || ' 分鐘' end,
              '地點：' || coalesce(nullif(cfg.location, ''), '線上'),
              v_text,
              case when v_feed is not null and coalesce(p_api, '') <> '' then
                '一次訂閱全部場次（之後的異動會自動更新）：https://calendar.google.com/calendar/render?cid='
                || app.url_encode('webcal://' || regexp_replace(p_api, '^https?://', '') || '/rest/v1/rpc/oh_calendar?p_feed=' || v_feed
                                  || '&apikey=' || coalesce(p_key, '')) end,
              '平台：' || coalesce(p_site, '')),
    'html',
      '<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      || '<title>' || app.html(v_subject) || '</title></head>'
      || '<body style="margin:0;padding:0;background:#f5f4f0;">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f0;padding:24px 12px;'
      || 'font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',Arial,sans-serif;color:#161514;line-height:1.6;">'
      || '<tr><td align="center">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;'
      || 'border:1px solid #e4e1da;border-radius:16px;">'
      || '<tr><td style="padding:28px 28px 4px;">'
      || '<p style="margin:0;font-size:12px;letter-spacing:.08em;color:#5f5d57;">叁式 30 分鐘 一週三次 · Office Hour</p>'
      || case when coalesce(p_name, '') <> '' then format('<p style="margin:14px 0 0;font-size:15px;">%s 您好</p>', app.html(p_name)) else '' end
      || format('<h1 style="margin:6px 0 0;font-size:22px;line-height:1.35;">%s</h1>',
                case when v_count = 0 then '這週沒有排到 Office Hour'
                     else app.html(coalesce(v_who || ' ', '')) || '這週有 ' || v_count || ' 場 Office Hour' end)
      || format('<p style="margin:8px 0 0;font-size:14px;color:#5f5d57;">%s · 每場 %s 分鐘 · 地點 %s</p>',
                v_range, cfg.slot_minutes, v_place)
      || '</td></tr>'
      || case when v_feed is not null and coalesce(p_api, '') <> '' and v_count > 0 then
           '<tr><td style="padding:16px 28px 4px;">'
           || app.mail_button('https://calendar.google.com/calendar/render?cid='
                              || app.url_encode('webcal://' || regexp_replace(p_api, '^https?://', '') || '/rest/v1/rpc/oh_calendar?p_feed='
                                                || v_feed || '&apikey=' || coalesce(p_key, '')),
                              '一鍵把全部場次加到 Google 日曆', true)
           || '<p style="margin:8px 0 0;font-size:12px;color:#5f5d57;">這是訂閱：之後新增、改時間或取消，日曆都會自動更新。也可以用下面每一場的按鈕只加一場</p>'
           || '</td></tr>'
         else '' end
      || v_days
      || '<tr><td style="padding:22px 28px 26px;font-size:12px;color:#5f5d57;">'
      || format('完整內容和之後的異動都在平台上：<a href="%s" style="color:#161514;">%s</a><br>', app.html(p_site), app.html(p_site))
      || '這封信由 Office Hour 平台在每週一 09:00 自動寄出，有問題直接回覆這封信即可'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

-- Everything due to go out: kind 'weekly' (to each recipient) or
-- 'preview' (one message to the admins' mailbox, or p_fallback when it
-- is empty). Already-sent messages are left out unless p_force.
create or replace function app.mail_outbox(p_kind text, p_week date, p_site text, p_api text, p_key text,
                                           p_fallback text default null, p_force boolean default false)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  ms app.mail_settings := (select x from app.mail_settings x where x.id = 1);
  v_week date := coalesce(p_week, app.mail_week(app.today()));
  v_out jsonb := '[]';
  v_to text;
  v_list text := '';
  rc record;
  m jsonb;
  v_all jsonb;
begin
  if p_kind = 'weekly' then
    if not ms.weekly and not p_force then
      return v_out;
    end if;
    for rc in select * from app.mail_recipients r where r.active order by r.id loop
      continue when not p_force and exists (select 1 from app.mail_log l
                                             where l.kind = 'weekly' and l.week_start = v_week and lower(l.email) = lower(rc.email));
      m := app.mail_message(v_week, rc.teachers, rc.name, p_site, p_api, p_key);
      v_out := v_out || jsonb_build_array(m || jsonb_build_object(
                 'kind', 'weekly', 'week', v_week, 'to', rc.email, 'name', rc.name, 'recipient_id', rc.id));
    end loop;
  elsif p_kind = 'preview' then
    v_to := coalesce(nullif(ms.ta_email, ''), nullif(p_fallback, ''));
    if v_to is null or (not ms.preview and not p_force)
       or (not p_force and exists (select 1 from app.mail_log l
                                    where l.kind = 'preview' and l.week_start = v_week and lower(l.email) = lower(v_to))) then
      return v_out;
    end if;
    for rc in select * from app.mail_recipients r where r.active order by r.id loop
      m := app.mail_message(v_week, rc.teachers, rc.name, p_site, p_api, p_key);
      v_list := v_list || format('<li>%s%s：%s</li>', app.html(rc.email), coalesce('（' || app.html(nullif(rc.name, '')) || '）', ''),
                                 app.html(m ->> 'subject'));
    end loop;
    v_all := app.mail_message(v_week, '{}', null, p_site, p_api, p_key);
    v_out := jsonb_build_array(jsonb_build_object(
      'kind', 'preview', 'week', v_week, 'to', v_to, 'name', '',
      'count', v_all -> 'count',
      'subject', '【預覽】週一 09:00 要寄出的 Office Hour 通知（' || to_char(v_week, 'FMMM/FMDD') || '–' || to_char(v_week + 6, 'FMMM/FMDD') || '）',
      'text', '週一 09:00 會寄給：' || E'\n' || coalesce(nullif(regexp_replace(v_list, '<[^>]+>', E'\n', 'g'), ''), '（還沒有收件人）')
              || E'\n\n' || (v_all ->> 'text'),
      'html', regexp_replace(v_all ->> 'html', '(<tr><td style="padding:28px 28px 4px;">)',
                '<tr><td style="padding:20px 28px 0;"><div style="padding:14px 16px;border-radius:12px;background:#fbf0dc;font-size:14px;">'
                || '<b>這是預覽。</b>' || case when ms.weekly then '週一 09:00 會寄給：' else '週一寄信目前關閉，不會寄給：' end
                || case when v_list = '' then '（還沒有收件人，請到後台「寄信通知」新增）' else '<ul style="margin:6px 0 0;padding-left:20px;">' || v_list || '</ul>' end
                || '要調整場次，請在週一 09:00 前發布；收件人和內容可以在後台「寄信通知」修改</div></td></tr>\1')));
  end if;
  return v_out;
end $$;

create or replace function app.mail_sent(p_kind text, p_week date, p_email text, p_subject text, p_count int)
returns void
language sql set search_path = '' as $$
  insert into app.mail_log (kind, week_start, email, subject, sessions, sent_at)
  values (p_kind, p_week, p_email, p_subject, coalesce(p_count, 0), app.now())
  on conflict (kind, week_start, lower(email)) do update set subject = excluded.subject, sessions = excluded.sessions, sent_at = excluded.sent_at
$$;

-- =====================================================================
-- Admin API
-- =====================================================================
create or replace function public.oh_admin_mail(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'settings', (select jsonb_build_object('weekly', m.weekly, 'preview', m.preview, 'ta_email', m.ta_email)
                   from app.mail_settings m where m.id = 1),
    'week', app.mail_week(app.today()),
    'teachers', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.sort, t.id), '[]'::jsonb)
                   from app.teachers t where not t.team and t.active),
    'recipients', (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', r.id, 'email', r.email, 'name', r.name, 'teachers', to_jsonb(r.teachers), 'active', r.active
                   ) order by r.id), '[]'::jsonb) from app.mail_recipients r),
    'log', (select coalesce(jsonb_agg(jsonb_build_object(
              'kind', l.kind, 'week', l.week_start, 'email', l.email, 'subject', l.subject,
              'sessions', l.sessions, 'at', app.iso(l.sent_at)) order by l.sent_at desc, l.id desc), '[]'::jsonb)
            from (select * from app.mail_log x order by x.sent_at desc, x.id desc limit 30) l)
  );
end $$;

-- p_kind 'settings' (weekly, preview, ta_email) or 'recipient'
-- (id?, email, name, teachers, active).
create or replace function public.oh_admin_mail_save(p_token text, p_kind text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_id int;
  v_teachers int[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform app.err('VALIDATION', 'mail');
  end if;
  if p_kind = 'settings' then
    update app.mail_settings x set
      weekly   = case when p ? 'weekly'   then (p ->> 'weekly')::boolean else x.weekly end,
      preview  = case when p ? 'preview'  then (p ->> 'preview')::boolean else x.preview end,
      ta_email = case when p ? 'ta_email' then coalesce(app.clean(p ->> 'ta_email'), '') else x.ta_email end,
      updated_at = app.now()
    where x.id = 1;
    perform app.log(s, 'config.mail', null, null);
    return (select jsonb_build_object('weekly', m.weekly, 'preview', m.preview, 'ta_email', m.ta_email)
              from app.mail_settings m where m.id = 1);
  elsif p_kind = 'recipient' then
    if p ? 'teachers' and jsonb_typeof(p -> 'teachers') <> 'array' then
      perform app.err('VALIDATION', 'mail');
    end if;
    v_teachers := array(select distinct x::int from jsonb_array_elements_text(coalesce(p -> 'teachers', '[]')) x
                         where exists (select 1 from app.teachers t where t.id = x::int and not t.team) order by 1);
    v_id := case when jsonb_typeof(p -> 'id') = 'number' then (p ->> 'id')::int end;
    if v_id is null then
      insert into app.mail_recipients (email, name, teachers, active, created_at)
      values (app.clean(p ->> 'email'), coalesce(app.clean(p ->> 'name'), ''), v_teachers,
              coalesce((p ->> 'active')::boolean, true), app.now())
      returning id into v_id;
    else
      update app.mail_recipients x set
        email    = case when p ? 'email'    then app.clean(p ->> 'email') else x.email end,
        name     = case when p ? 'name'     then coalesce(app.clean(p ->> 'name'), '') else x.name end,
        teachers = case when p ? 'teachers' then v_teachers else x.teachers end,
        active   = case when p ? 'active'   then (p ->> 'active')::boolean else x.active end
      where x.id = v_id;
      if not found then
        perform app.err('NOT_FOUND', 'recipient');
      end if;
    end if;
    perform app.log(s, 'config.mail', null, null);
    return (select jsonb_build_object('id', r.id, 'email', r.email, 'name', r.name, 'teachers', to_jsonb(r.teachers), 'active', r.active)
              from app.mail_recipients r where r.id = v_id);
  end if;
  perform app.err('VALIDATION', 'kind');
  return null;
exception
  when unique_violation then
    perform app.err('DUPLICATE', 'recipient');
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
    perform app.err('VALIDATION', 'mail');
end $$;

create or replace function public.oh_admin_mail_delete(p_token text, p_id int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  delete from app.mail_recipients x where x.id = p_id;
  if not found then
    perform app.err('NOT_FOUND', 'recipient');
  end if;
  perform app.log(s, 'config.mail', null, null);
  return jsonb_build_object('ok', true);
end $$;

-- What will go out for the week starting p_week (default: the next mail
-- week), already-sent messages included, with when each one was sent.
create or replace function public.oh_admin_mail_preview(p_token text, p_week date default null, p_site text default null,
                                                        p_api text default null, p_key text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_week date := coalesce(p_week, app.mail_week(app.today()));
  v_week_list jsonb;
  v_preview jsonb;
begin
  v_week := v_week - (extract(isodow from v_week)::int - 1);
  v_week_list := app.mail_outbox('weekly', v_week, p_site, p_api, p_key, null, true);
  v_preview := app.mail_outbox('preview', v_week, p_site, p_api, p_key, '（寄件的 Gmail）', true);
  return jsonb_build_object(
    'week', v_week,
    'messages', (select coalesce(jsonb_agg(m || jsonb_build_object('sent_at',
                   (select app.iso(l.sent_at) from app.mail_log l
                     where l.kind = m ->> 'kind' and l.week_start = v_week and lower(l.email) = lower(m ->> 'to')))
                 order by i), '[]'::jsonb)
                 from jsonb_array_elements(v_preview || v_week_list) with ordinality as x (m, i)));
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
       and p.proname in ('oh_admin_mail', 'oh_admin_mail_save', 'oh_admin_mail_delete', 'oh_admin_mail_preview')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
