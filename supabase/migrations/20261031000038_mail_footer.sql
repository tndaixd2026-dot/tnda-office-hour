-- The PMs' email points questions to the TNDA TAs on Discord instead of
-- asking for a reply.

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
  -- sent the day before the week starts it is next week's; on its Monday, this week's
  v_ahead boolean := p_week > app.today();
  v_when text := case when v_ahead then '下週' else '這週' end;
  v_count int;
  v_subject text;
  v_chips text := '';
  v_days text := '';
  v_text text := '';
  v_rooms text := '';
  v_rooms_text text := '';
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
               || case when v_ahead then '下週' else '本週' end
               || case when v_count = 0 then '沒有場次' else ' ' || v_count || ' 場' end
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

  -- each PM meets in their own room
  select coalesce(string_agg(format('<p style="margin:4px 0 0;font-size:15px;"><b>%s</b>&nbsp;&nbsp;%s</p>',
                    app.html(x.name),
                    case when x.room ~* '^https?://'
                         then format('<a href="%s" style="color:#161514;font-weight:700;">%s</a>', app.html(x.room), app.html(regexp_replace(x.room, '^https?://', '')))
                         else app.html(coalesce(x.room, '線上')) end), '' order by x.sort, x.id), ''),
         coalesce(string_agg('  ' || x.name || '：' || coalesce(x.room, '線上'), E'\n' order by x.sort, x.id), '')
    into v_rooms, v_rooms_text
    from (select distinct t.id, t.name, t.sort, app.room_of(t.id) as room
            from app.appointments a join app.teachers t on t.id = a.teacher_id
           where a.status = 'confirmed' and a.d between p_week and p_week + 6
             and (v_all or a.teacher_id = any (p_teachers))) x;

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
      select a.t, a.teacher_id, te.name as teacher, rq.topic, rq.progress, nullif(rq.questions, '') as questions, rq.link, a.group_id
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
        concat_ws(E'\n', app.group_title(r.group_id), '老師：' || r.teacher, '題目：' || r.topic,
                  '想問的問題：' || E'\n' || r.questions, '進度：' || r.progress, '檔案：' || r.link),
        app.room_of(r.teacher_id));
      v_days := v_days || format(
        '<tr><td style="padding:0 24px 10px;">'
        || '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e1da;border-radius:14px;">'
        || '<tr><td width="84" valign="top" style="width:84px;padding:16px 0 14px 16px;">'
        || '<p style="margin:0;font-size:24px;font-weight:800;line-height:1.1;color:#161514;">%s</p>'
        || '<p style="margin:4px 0 0;font-size:13px;color:#5f5d57;">–%s</p>'
        || '</td><td valign="top" style="padding:14px 16px 8px 12px;">'
        || '%s'
        || '<p style="margin:0;font-size:16px;font-weight:700;line-height:1.4;">%s</p>'
        || '%s%s%s%s'
        || '<p style="margin:12px 0 0;">%s%s</p>'
        || '</td></tr></table></td></tr>',
        app.hm(r.t), app.hm(v_end),
        case when v_many then '<p style="margin:0 0 4px;">' || app.mail_chip(r.teacher_id, r.teacher) || '</p>' else '' end,
        app.html(app.group_title(r.group_id)),
        case when r.topic is not null then
          format('<p style="margin:6px 0 0;font-size:15px;line-height:1.5;"><span style="color:#5f5d57;">題目</span>&nbsp;&nbsp;<b>%s</b></p>', app.html(r.topic))
        else '' end,
        -- what they want to ask: the part a PM most needs before the call
        case when r.questions is not null then
          format('<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" bgcolor="#f5f4f0" style="margin:10px 0 0;background-color:#f5f4f0;border-radius:10px;">'
                 || '<tr><td style="padding:10px 12px;"><p style="margin:0;font-size:12px;font-weight:700;color:#5f5d57;">想問的問題</p>'
                 || '<p style="margin:2px 0 0;font-size:14px;line-height:1.6;color:#161514;white-space:pre-line;">%s</p></td></tr></table>',
                 app.html(r.questions))
        else '' end,
        case when r.progress is not null then
          format('<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#5f5d57;white-space:pre-line;">'
                 || '<span style="font-weight:700;">進度</span>&nbsp;&nbsp;%s</p>', app.html(r.progress))
        else '' end,
        case when r.link ~* '^https?://' then
          format('<p style="margin:8px 0 0;font-size:13px;line-height:1.5;"><span style="font-weight:700;color:#5f5d57;">檔案</span>&nbsp;&nbsp;'
                 || '<a href="%s" style="color:#2f5bd3;word-break:break-all;">%s</a></p>',
                 app.html(r.link), app.html(regexp_replace(r.link, '^https?://', '')))
        else '' end,
        case when app.room_of(r.teacher_id) ~* '^https?://' then app.mail_btn(app.room_of(r.teacher_id), '加入會議', 'join') else '' end,
        app.mail_btn(v_href, '＋ 加到 Google 日曆', 'add'));
      v_text := v_text || format(E'  %s–%s %s %s%s\n%s%s  加到 Google 日曆：%s\n',
                                 app.hm(r.t), app.hm(v_end), r.teacher,
                                 app.group_title(r.group_id), coalesce('｜' || r.topic, ''),
                                 coalesce('  想問的問題：' || replace(r.questions, E'\n', E'\n    ') || E'\n', ''),
                                 coalesce('  檔案：' || r.link || E'\n', ''), v_href);
    end loop;
  end loop;

  return jsonb_build_object(
    'subject', v_subject,
    'count', v_count,
    'text', concat_ws(E'\n',
              case when coalesce(p_name, '') <> '' then p_name || ' 您好' end,
              case when v_count = 0 then v_when || '（' || v_range || '）沒有排到 Office Hour'
                   else v_when || '（' || v_range || '）' || coalesce(v_who || ' ', '') || '有 ' || v_count || ' 場 Office Hour，每場 '
                        || cfg.slot_minutes || ' 分鐘' end,
              case when v_rooms_text <> '' then '會議室：' || E'\n' || v_rooms_text end,
              v_text,
              case when v_subscribe is not null then '一次訂閱全部場次（之後的異動會自動更新）：' || v_subscribe end,
              '平台：' || coalesce(p_site, '')),
    'html',
      '<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      || '<title>' || app.html(v_subject) || '</title></head>'
      || '<body style="margin:0;padding:0;background-color:#f5f4f0;">'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f4f0" style="background-color:#f5f4f0;padding:24px 12px;'
      || 'font-family:''Noto Sans TC'',''PingFang TC'',''Microsoft JhengHei'',Arial,sans-serif;color:#161514;line-height:1.6;">'
      || '<tr><td align="center"><!--banner-->'
      || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;'
      || 'border:1px solid #e4e1da;border-radius:16px;">'
      -- what the week holds, at a glance
      || '<tr><td bgcolor="#161514" style="padding:26px 24px 24px;background-color:#161514;border-radius:15px 15px 0 0;color:#ffffff;text-align:left;">'
      || '<p style="margin:0;font-size:12px;letter-spacing:.08em;color:#c9c5bb;">叁式 ULTRACOMBOS One Hour a Week · Office Hour</p>'
      || case when coalesce(p_name, '') <> '' then format('<p style="margin:16px 0 0;font-size:15px;color:#ffffff;">%s 您好</p>', app.html(p_name)) else '' end
      || format('<h1 style="margin:6px 0 0;font-size:26px;line-height:1.3;color:#ffffff;">%s</h1>',
                case when v_count = 0 then v_when || '沒有排到 Office Hour'
                     else app.html(coalesce(v_who || ' ', '')) || v_when || '有 <span style="color:#ff8f5c;">' || v_count || ' 場</span> Office Hour' end)
      || format('<p style="margin:8px 0 0;font-size:14px;color:#c9c5bb;">%s · 每場 %s 分鐘</p>', v_span, cfg.slot_minutes)
      || case when v_chips <> '' then '<p style="margin:14px 0 0;">' || v_chips || '</p>' else '' end
      || '</td></tr>'
      -- where, and the one-step calendar subscription
      || case when v_count > 0 then
           '<tr><td style="padding:20px 24px 0;text-align:left;">'
           || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fdeee4" style="background-color:#fdeee4;border-radius:12px;">'
           || '<tr><td style="padding:14px 16px;">'
           || format('<p style="margin:0;font-size:13px;font-weight:700;color:#b23a0b;">%s</p>',
                     case when v_many then '會議室 · 每位業師各自一間' else '會議室 · 每一場都在這裡' end)
           || v_rooms
           || '</td></tr></table>'
           || case when v_subscribe is not null then
                '<p style="margin:16px 0 0;">' || app.mail_btn(v_subscribe, '一鍵把全部場次加到 Google 日曆', 'dark') || '</p>'
                || '<p style="margin:0;font-size:12px;color:#5f5d57;">這是訂閱：之後新增、改時間或取消，日曆都會自動更新。也可以用每一場的按鈕只加一場</p>'
              else '' end
           || '</td></tr>'
         else
           '<tr><td style="padding:20px 24px 0;font-size:15px;text-align:left;">' || v_when || '沒有安排場次，不用預留時間</td></tr>'
         end
      || v_days
      || '<tr><td style="padding:24px 24px 26px;font-size:12px;color:#5f5d57;text-align:left;">'
      || format('場次和題目以平台為準：<a href="%s" style="color:#161514;">%s</a><br>', app.html(p_site), app.html(p_site))
      || '這封信由 Office Hour 平台在每週日 08:00 自動寄出，有問題可在 Discord 聯絡 TNDA 助教'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

revoke execute on all functions in schema app from public;
