-- =====================================================================
-- Office Hour · the questions a group wants to ask
--
-- Requests get a third text: the questions for the PM, so the PM can
-- prepare. They show wherever the topic and progress do: the student's
-- and admins' pages, the PMs' view and calendar, the export and the
-- weekly email. oh_request_save takes them as a new last parameter; a
-- page loaded before this change leaves them as they are.
-- =====================================================================

alter table app.requests add column questions text not null default '' check (length(questions) <= 1000);

create or replace function app.request_json(p_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'week_id', r.week_id, 'group_id', r.group_id,
    'topic', r.topic, 'progress', r.progress, 'questions', r.questions, 'link', r.link, 'want', r.want,
    'author', r.author, 'status', r.status, 'version', r.version,
    'created_at', app.iso(r.created_at), 'updated_at', app.iso(r.updated_at),
    'slots', coalesce((select jsonb_agg(jsonb_build_object('d', rs.d, 't', app.hm(rs.t)) order by rs.d, rs.t)
                         from app.request_slots rs where rs.request_id = r.id), '[]'::jsonb))
  from app.requests r where r.id = p_id
$$;

drop function public.oh_request_save(text, int, text, text, text, int, jsonb, int);
create or replace function public.oh_request_save(
  p_token text, p_week int, p_topic text, p_progress text, p_link text,
  p_want int, p_slots jsonb, p_version int default null, p_questions text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['student']);
  cfg app.settings := app.cfg();
  w app.weeks;
  r app.requests;
  v_topic text := app.clean(p_topic);
  v_progress text := app.clean_multiline(p_progress);
  v_questions text := app.clean_multiline(p_questions);
  v_link text := app.clean(p_link);
  v_slots timestamp[];
  v_valid timestamp[];
  v_new boolean := false;
begin
  select * into w from app.weeks x where x.id = p_week;
  if not found then
    perform app.err('NOT_FOUND', 'week');
  end if;
  if not w.open then
    perform app.err('WEEK_CLOSED');
  end if;
  if app.local_now() >= app.week_deadline(w.start_date) then
    perform app.err('WEEK_LATE', app.deadline_text(app.week_deadline(w.start_date)));
  end if;
  if v_topic is null or length(v_topic) > 80 then
    perform app.err('VALIDATION', 'topic');
  end if;
  if v_progress is null or length(v_progress) > 1000 then
    perform app.err('VALIDATION', 'progress');
  end if;
  if length(v_questions) > 1000 then
    perform app.err('VALIDATION', 'questions');
  end if;
  if v_link is not null and (length(v_link) > 500 or v_link !~* '^https?://[^\s/?#]+\.[^\s]*$') then
    perform app.err('VALIDATION', 'link');
  end if;
  if p_want is null or p_want < 1 or p_want > cfg.week_cap then
    perform app.err('VALIDATION', 'want');
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) = 0 or jsonb_array_length(p_slots) > 200 then
    perform app.err('VALIDATION', 'slots');
  end if;
  begin
    select array_agg(distinct ((e ->> 'd')::date + (e ->> 't')::time)) into v_slots
      from jsonb_array_elements(p_slots) e;
  exception when others then
    perform app.err('VALIDATION', 'slots');
  end;
  if array_position(v_slots, null) is not null then
    perform app.err('VALIDATION', 'slots');
  end if;

  v_valid := array(select distinct ws.d + ws.t from app.week_slots(p_week) ws);
  if exists (select 1 from unnest(v_slots) x where not (x = any (v_valid))) then
    perform app.err('SLOT_INVALID');
  end if;

  select * into r from app.requests x
   where x.week_id = p_week and x.group_id = s.group_id
   for update;
  if found then
    if p_version is distinct from r.version then
      perform app.err('CONFLICT');
    end if;
  end if;

  if r.id is null then
    insert into app.requests (week_id, group_id, topic, progress, questions, link, want, author, status, version, created_at, updated_at)
    values (p_week, s.group_id, v_topic, v_progress, coalesce(v_questions, ''), v_link, p_want, s.name, 'open', 1, app.now(), app.now())
    on conflict (week_id, group_id) do nothing
    returning * into r;
    if r.id is null then
      perform app.err('CONFLICT');
    end if;
    v_new := true;
  else
    update app.requests x
       set topic = v_topic, progress = v_progress, link = v_link, want = p_want,
           -- a page loaded before the field existed sends none: keep what is there
           questions = case when p_questions is null then x.questions else coalesce(v_questions, '') end,
           author = s.name, status = 'open', version = x.version + 1, updated_at = app.now()
     where x.id = r.id
    returning * into r;
  end if;

  delete from app.request_slots rs where rs.request_id = r.id;
  insert into app.request_slots (request_id, d, t)
  select r.id, x::date, x::time from unnest(v_slots) x;

  perform app.log(s, case when v_new then 'request.created' else 'request.updated' end, s.group_id, p_week,
                  jsonb_build_object('topic', v_topic, 'slots', cardinality(v_slots), 'want', p_want));
  return app.request_json(r.id);
end $$;

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
                   'request', (select jsonb_build_object('topic', r.topic, 'progress', r.progress, 'questions', r.questions, 'link', r.link,
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
           rq.topic, rq.progress, rq.questions, rq.link, rq.author
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
        case when t.id is not null and nullif(r.questions, '') is not null then '想問的問題：' || E'\n' || r.questions end,
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

create or replace function public.oh_admin_export(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  return jsonb_build_object(
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                   'week', w.label, 'week_start', w.start_date, 'group_no', g.no, 'group_name', g.name,
                   'status', r.status, 'want', r.want, 'topic', r.topic, 'progress', r.progress, 'questions', r.questions,
                   'link', r.link, 'author', r.author,
                   'created_at', app.iso(r.created_at), 'updated_at', app.iso(r.updated_at),
                   'slots', (select coalesce(string_agg(to_char(rs.d, 'MM/DD') || ' ' || app.hm(rs.t), '; ' order by rs.d, rs.t), '')
                               from app.request_slots rs where rs.request_id = r.id)
                 ) order by w.start_date, g.no), '[]'::jsonb)
                 from app.requests r join app.weeks w on w.id = r.week_id join app.groups g on g.id = r.group_id),
    'appointments', (select coalesce(jsonb_agg(jsonb_build_object(
                       'week', w.label, 'date', a.d, 'time', app.hm(a.t), 'group_no', g.no, 'group_name', g.name,
                       'teacher', te.name, 'status', a.status, 'created_by', a.created_by,
                       'published_at', app.iso(a.published_at), 'cancelled_at', app.iso(a.cancelled_at),
                       'cancelled_by', a.cancelled_by, 'cancel_reason', a.cancel_reason,
                       'topic', (select r.topic from app.requests r where r.week_id = a.week_id and r.group_id = a.group_id)
                     ) order by a.d, a.t, g.no), '[]'::jsonb)
                     from app.appointments a
                     join app.weeks w on w.id = a.week_id
                     join app.groups g on g.id = a.group_id
                     join app.teachers te on te.id = a.teacher_id
                    where a.status <> 'draft')
  );
end $$;

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
          format('<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="margin:10px 0 0;background:#f5f4f0;border-radius:10px;">'
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
        case when v_url then app.mail_btn(cfg.location, '加入會議', 'join') else '' end,
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

revoke execute on all functions in schema app from public;
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('oh_request_save', 'oh_teacher_state', 'oh_calendar', 'oh_admin_export')
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
