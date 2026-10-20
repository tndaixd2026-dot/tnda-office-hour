-- =====================================================================
-- Office Hour · a clearer weekly email
--
-- The PMs' email puts what matters first: a dark header with the week's
-- count (and, for several PMs, a chip per PM in the platform's colours),
-- the meeting room, then each session with its time large on the left,
-- the PM, the group and the topic, and buttons to join the room or add
-- the session to Google Calendar. The admins' preview banner now sits
-- above the card instead of inside it.
-- =====================================================================

-- A button: 'dark' (filled, large), 'join' (accent, small) or 'add'
-- (outlined, small). Colours keep at least 4.5:1 against their fill.
create or replace function app.mail_btn(p_href text, p_label text, p_kind text default 'add') returns text
language sql immutable set search_path = '' as $$
  select format('<a href="%s" style="display:inline-block;margin:0 8px 8px 0;padding:%s;border-radius:10px;background:%s;'
                || 'color:%s;border:1px solid %s;font-size:%s;font-weight:700;line-height:1.3;text-decoration:none;">%s</a>',
                app.html(p_href),
                case when p_kind = 'dark' then '12px 18px' else '8px 12px' end,
                case p_kind when 'dark' then '#161514' when 'join' then '#b23a0b' else '#ffffff' end,
                case when p_kind in ('dark', 'join') then '#ffffff' else '#161514' end,
                case p_kind when 'dark' then '#161514' when 'join' then '#b23a0b' else '#c9c5bb' end,
                case when p_kind = 'dark' then '15px' else '13px' end,
                app.html(p_label))
$$;

-- A PM's name on their colour: the same order and colours as the
-- platform's teacher view (blue, orange, green, amber).
create or replace function app.mail_chip(p_teacher int, p_label text) returns text
language sql stable set search_path = '' as $$
  select format('<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border-radius:999px;'
                || 'background:%s;color:%s;font-size:13px;font-weight:700;line-height:1.5;">%s</span>',
                (array['#e7edfb', '#fdeee4', '#e4f2e8', '#fbf0dc'])[s.i % 4 + 1],
                (array['#2f5bd3', '#b23a0b', '#126b31', '#9a4508'])[s.i % 4 + 1],
                app.html(p_label))
    from (select coalesce((select x.n - 1 from (select t.id, row_number() over (order by t.sort, t.id) as n
                                                  from app.teachers t where not t.team) x
                            where x.id = p_teacher), 0)::int as i) s
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
  v_many boolean;
  v_who text;
  v_feed text;
  v_subscribe text;
  v_range text := to_char(p_week, 'FMMM/FMDD') || '–' || to_char(p_week + 6, 'FMMM/FMDD');
  v_span text := to_char(p_week, 'FMMM/FMDD') || '（一）– ' || to_char(p_week + 6, 'FMMM/FMDD') || '（日）';
  v_count int;
  v_subject text;
  v_chips text := '';
  v_days text := '';
  v_text text := '';
  v_url boolean := cfg.location ~* '^https?://';
  v_room text;
  v_end time;
  d record;
  r record;
  v_href text;
begin
  v_many := v_all or cardinality(p_teachers) > 1;
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
  if v_feed is not null and coalesce(p_api, '') <> '' then
    v_subscribe := 'https://calendar.google.com/calendar/render?cid='
                   || app.url_encode('webcal://' || regexp_replace(p_api, '^https?://', '') || '/rest/v1/rpc/oh_calendar?p_feed='
                                     || v_feed || '&apikey=' || coalesce(p_key, ''));
  end if;

  v_room := case when cfg.location ~* 'meet\.google\.com' then 'Google Meet 會議室'
                 when v_url then '線上會議室'
                 else coalesce(nullif(cfg.location, ''), '線上') end;

  if v_many then
    select coalesce(string_agg(app.mail_chip(x.id, x.name || ' ' || x.n || ' 場'), '' order by x.sort, x.id), '') into v_chips
      from (select t.id, t.name, t.sort, count(*) as n
              from app.appointments a join app.teachers t on t.id = a.teacher_id
             where a.status = 'confirmed' and a.d between p_week and p_week + 6
               and (v_all or a.teacher_id = any (p_teachers))
             group by t.id, t.name, t.sort) x;
  end if;

  for d in
    select distinct a.d from app.appointments a
     where a.status = 'confirmed' and a.d between p_week and p_week + 6
       and (v_all or a.teacher_id = any (p_teachers))
     order by a.d
  loop
    v_days := v_days || format(
      '<tr><td style="padding:24px 24px 10px;"><p style="margin:0;padding-left:10px;border-left:4px solid #b23a0b;'
      || 'font-size:17px;font-weight:700;line-height:1.3;">%s</p></td></tr>',
      '週' || app.wday(d.d) || ' ' || to_char(d.d, 'FMMM/FMDD'));
    v_text := v_text || E'\n' || '週' || app.wday(d.d) || ' ' || to_char(d.d, 'FMMM/FMDD') || E'\n';
    for r in
      select a.t, a.teacher_id, te.name as teacher, rq.topic, rq.progress, rq.link, a.group_id
        from app.appointments a
        join app.teachers te on te.id = a.teacher_id
        left join app.requests rq on rq.week_id = a.week_id and rq.group_id = a.group_id
       where a.status = 'confirmed' and a.d = d.d and (v_all or a.teacher_id = any (p_teachers))
       order by a.t, te.sort
    loop
      v_end := r.t + make_interval(mins => cfg.slot_minutes);
      v_href := app.gcal_link(
        'Office Hour · ' || r.teacher || ' · ' || app.group_title(r.group_id) || coalesce('｜' || r.topic, ''),
        d.d, r.t, cfg.slot_minutes,
        concat_ws(E'\n', app.group_title(r.group_id), '老師：' || r.teacher, '題目：' || r.topic, '進度：' || r.progress,
                  '資料：' || r.link),
        cfg.location);
      v_days := v_days || format(
        '<tr><td style="padding:0 24px 10px;">'
        || '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e1da;border-radius:14px;">'
        || '<tr><td width="84" valign="top" style="width:84px;padding:16px 0 14px 16px;">'
        || '<p style="margin:0;font-size:24px;font-weight:800;line-height:1.1;color:#161514;">%s</p>'
        || '<p style="margin:4px 0 0;font-size:13px;color:#5f5d57;">–%s</p>'
        || '</td><td valign="top" style="padding:14px 16px 8px 12px;">'
        || '%s'
        || '<p style="margin:0;font-size:16px;font-weight:700;line-height:1.4;">%s</p>'
        || '%s%s%s'
        || '<p style="margin:12px 0 0;">%s%s</p>'
        || '</td></tr></table></td></tr>',
        app.hm(r.t), app.hm(v_end),
        case when v_many then '<p style="margin:0 0 4px;">' || app.mail_chip(r.teacher_id, r.teacher) || '</p>' else '' end,
        app.html(app.group_title(r.group_id)),
        case when r.topic is not null then
          format('<p style="margin:6px 0 0;font-size:15px;line-height:1.5;"><span style="color:#5f5d57;">題目</span>&nbsp;&nbsp;<b>%s</b></p>', app.html(r.topic))
        else '' end,
        case when r.progress is not null then
          format('<p style="margin:4px 0 0;font-size:13px;line-height:1.6;color:#5f5d57;white-space:pre-line;">%s</p>', app.html(r.progress))
        else '' end,
        case when r.link ~* '^https?://' then
          format('<p style="margin:6px 0 0;font-size:13px;"><a href="%s" style="color:#161514;">打開雲端資料夾</a></p>', app.html(r.link))
        else '' end,
        case when v_url then app.mail_btn(cfg.location, '加入會議', 'join') else '' end,
        app.mail_btn(v_href, '＋ 加到 Google 日曆', 'add'));
      v_text := v_text || format(E'  %s–%s %s %s%s\n  加到 Google 日曆：%s\n',
                                 app.hm(r.t), app.hm(v_end), r.teacher,
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
              '會議室：' || coalesce(nullif(cfg.location, ''), '線上'),
              v_text,
              case when v_subscribe is not null then '一次訂閱全部場次（之後的異動會自動更新）：' || v_subscribe end,
              '平台：' || coalesce(p_site, '')),
    'html',
      '<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      || '<title>' || app.html(v_subject) || '</title></head>'
      || '<body style="margin:0;padding:0;background:#f5f4f0;">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f0;padding:24px 12px;'
      || 'font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',Arial,sans-serif;color:#161514;line-height:1.6;">'
      || '<tr><td align="center"><!--banner-->'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;'
      || 'border:1px solid #e4e1da;border-radius:16px;">'
      -- what the week holds, at a glance
      || '<tr><td style="padding:26px 24px 24px;background:#161514;border-radius:15px 15px 0 0;color:#ffffff;text-align:left;">'
      || '<p style="margin:0;font-size:12px;letter-spacing:.08em;color:#c9c5bb;">叁式 30 分鐘 一週三次 · Office Hour</p>'
      || case when coalesce(p_name, '') <> '' then format('<p style="margin:16px 0 0;font-size:15px;color:#ffffff;">%s 您好</p>', app.html(p_name)) else '' end
      || format('<h1 style="margin:6px 0 0;font-size:26px;line-height:1.3;color:#ffffff;">%s</h1>',
                case when v_count = 0 then '這週沒有排到 Office Hour'
                     else app.html(coalesce(v_who || ' ', '')) || '這週有 <span style="color:#ff8f5c;">' || v_count || ' 場</span> Office Hour' end)
      || format('<p style="margin:8px 0 0;font-size:14px;color:#c9c5bb;">%s · 每場 %s 分鐘</p>', v_span, cfg.slot_minutes)
      || case when v_chips <> '' then '<p style="margin:14px 0 0;">' || v_chips || '</p>' else '' end
      || '</td></tr>'
      -- where, and the one-step calendar subscription
      || case when v_count > 0 then
           '<tr><td style="padding:20px 24px 0;text-align:left;">'
           || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdeee4;border-radius:12px;">'
           || '<tr><td style="padding:14px 16px;">'
           || '<p style="margin:0;font-size:13px;font-weight:700;color:#b23a0b;">會議室 · 每一場都在這裡</p>'
           || case when v_url then
                format('<p style="margin:4px 0 0;font-size:16px;font-weight:700;"><a href="%s" style="color:#161514;">%s</a></p>'
                       || '<p style="margin:2px 0 0;font-size:13px;color:#5f5d57;word-break:break-all;">%s</p>',
                       app.html(cfg.location), app.html(v_room), app.html(regexp_replace(cfg.location, '^https?://', '')))
              else format('<p style="margin:4px 0 0;font-size:16px;font-weight:700;">%s</p>', app.html(v_room)) end
           || '</td></tr></table>'
           || case when v_subscribe is not null then
                '<p style="margin:16px 0 0;">' || app.mail_btn(v_subscribe, '一鍵把全部場次加到 Google 日曆', 'dark') || '</p>'
                || '<p style="margin:0;font-size:12px;color:#5f5d57;">這是訂閱：之後新增、改時間或取消，日曆都會自動更新。也可以用每一場的按鈕只加一場</p>'
              else '' end
           || '</td></tr>'
         else
           '<tr><td style="padding:20px 24px 0;font-size:15px;text-align:left;">這週沒有安排場次，不用預留時間</td></tr>'
         end
      || v_days
      || '<tr><td style="padding:24px 24px 26px;font-size:12px;color:#5f5d57;text-align:left;">'
      || format('場次和題目以平台為準：<a href="%s" style="color:#161514;">%s</a><br>', app.html(p_site), app.html(p_site))
      || '這封信由 Office Hour 平台在每週一 09:00 自動寄出，有問題直接回覆這封信即可'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

-- The admins' preview: the banner goes where the message marks it.
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
      'html', replace(v_all ->> 'html', '<!--banner-->',
                '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 0 12px;">'
                || '<tr><td style="padding:14px 16px;border:1px solid #e9d3ad;border-radius:12px;background:#fbf0dc;font-size:14px;text-align:left;">'
                || '<b>這是預覽。</b>' || case when ms.weekly then '週一 09:00 會寄給：' else '週一寄信目前關閉，不會寄給：' end
                || case when v_list = '' then '（還沒有收件人，請到後台「寄信通知」新增）' else '<ul style="margin:6px 0 0;padding-left:20px;">' || v_list || '</ul>' end
                || '<div style="margin-top:8px;">要調整場次，請在週一 09:00 前發布；收件人和內容可以在後台「寄信通知」修改</div></td></tr></table>')));
  elsif p_kind = 'remind' then
    v_to := coalesce(nullif(ms.ta_email, ''), nullif(p_fallback, ''));
    if v_to is null or (not ms.remind and not p_force)
       or (not p_force and exists (select 1 from app.mail_log l
                                    where l.kind = 'remind' and l.week_start = v_week and lower(l.email) = lower(v_to))) then
      return v_out;
    end if;
    v_out := jsonb_build_array(app.mail_remind(v_week, p_site)
                               || jsonb_build_object('kind', 'remind', 'week', v_week, 'to', v_to, 'name', ''));
  end if;
  return v_out;
end $$;

revoke execute on all functions in schema app from public;
