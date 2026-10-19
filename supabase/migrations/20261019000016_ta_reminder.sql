-- =====================================================================
-- Office Hour · the Sunday-noon reminder to the admins
--
-- When next week's requests close (Sunday 12:00), the admins' mailbox
-- gets a summary of them, so they can schedule and publish before the
-- 18:00 preview. A switch in mail_settings turns it off; mail_log keeps
-- it to once a week.
-- =====================================================================

alter table app.mail_settings add column remind boolean not null default true; -- Sunday 12:00 to the admins' mailbox
alter table app.mail_log drop constraint mail_log_kind_check,
  add constraint mail_log_kind_check check (kind in ('weekly', 'preview', 'remind'));

-- The Sunday-noon reminder to the admins' mailbox: which groups asked
-- for the week starting p_week, which did not, and a button to the board.
create or replace function app.mail_remind(p_week date, p_site text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_range text := to_char(p_week, 'FMMM/FMDD') || '–' || to_char(p_week + 6, 'FMMM/FMDD');
  v_deadline text := app.deadline_text(app.week_deadline(p_week));
  v_closed boolean := app.local_now() >= app.week_deadline(p_week);
  v_open boolean := exists (select 1 from app.weeks w where w.start_date = p_week and w.open);
  v_count int;
  v_want int;
  v_missing text;
  v_rows text := '';
  v_lines text := '';
  v_subject text;
  v_lead text;
  r record;
begin
  select count(*), coalesce(sum(rq.want), 0) into v_count, v_want
    from app.requests rq
    join app.weeks w on w.id = rq.week_id
    join app.groups g on g.id = rq.group_id
   where w.start_date = p_week and rq.status = 'open' and g.active;

  select string_agg('第 ' || g.no || ' 組', '、' order by g.no) into v_missing
    from app.groups g
   where g.active
     and not exists (select 1 from app.requests rq join app.weeks w on w.id = rq.week_id
                      where w.start_date = p_week and rq.group_id = g.id and rq.status = 'open');

  for r in
    select rq.group_id, rq.want, rq.topic,
           (select count(*) from app.request_slots x where x.request_id = rq.id) as slots
      from app.requests rq
      join app.weeks w on w.id = rq.week_id
      join app.groups g on g.id = rq.group_id
     where w.start_date = p_week and rq.status = 'open' and g.active
     order by g.no
  loop
    v_rows := v_rows || format(
      '<tr><td style="padding:12px 0;border-top:1px solid #e4e1da;">'
      || '<p style="margin:0;font-size:15px;font-weight:700;">%s</p>'
      || '<p style="margin:2px 0 0;font-size:14px;">%s</p>'
      || '<p style="margin:2px 0 0;font-size:13px;color:#5f5d57;">想要 %s 次 · 勾了 %s 個時段</p>'
      || '</td></tr>',
      app.html(app.group_title(r.group_id)), app.html(r.topic), r.want, r.slots);
    v_lines := v_lines || format(E'%s｜%s｜想要 %s 次，勾了 %s 個時段\n', app.group_title(r.group_id), r.topic, r.want, r.slots);
  end loop;

  v_subject := '【Office Hour】'
               || case when not v_open then '下週沒有開放預約'
                       when v_count = 0 then '下週沒有組別送出需求'
                       else '請審核下週需求：' || v_count || ' 組送出' end
               || '（' || v_range || '）';
  v_lead := case
    when not v_open then '下週沒有開放預約，不用排程'
    when v_closed then format('需求已在 %s 截止，%s 組送出，共想要 %s 次。請在週日 18:00 前排好並發布：18:00 會先寄預覽到助教信箱，週一 09:00 寄給老師',
                              v_deadline, v_count, v_want)
    else format('需求會在 %s 截止，目前 %s 組送出，共想要 %s 次。截止後請在週日 18:00 前排好並發布', v_deadline, v_count, v_want)
  end;

  return jsonb_build_object(
    'subject', v_subject,
    'count', v_count,
    'text', concat_ws(E'\n',
              v_lead,
              case when v_open and v_missing is not null then (case when v_closed then '沒有送出：' else '還沒送出：' end) || v_missing end,
              '',
              nullif(v_lines, ''),
              '打開排程：' || coalesce(p_site, '') || '#/admin'),
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
      || '<p style="margin:0;font-size:12px;letter-spacing:.08em;color:#5f5d57;">叁式 30 分鐘 一週三次 · 給助教</p>'
      || format('<h1 style="margin:6px 0 0;font-size:22px;line-height:1.35;">%s</h1>',
                case when v_open then '請審核下週的 Office Hour 需求' else '下週（' || v_range || '）沒有開放預約' end)
      || format('<p style="margin:8px 0 0;font-size:14px;color:#5f5d57;">%s</p>', v_range)
      || format('<p style="margin:12px 0 0;font-size:15px;">%s</p>', app.html(v_lead))
      || case when v_open and v_missing is not null then
           format('<p style="margin:8px 0 0;font-size:14px;"><b>%s</b>%s</p>',
                  case when v_closed then '沒有送出：' else '還沒送出：' end, app.html(v_missing))
         else '' end
      || '<p style="margin:18px 0 0;">' || app.mail_button(coalesce(p_site, '') || '#/admin', '打開排程', true) || '</p>'
      || '</td></tr>'
      || case when v_rows <> '' then
           '<tr><td style="padding:18px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
           || v_rows || '</table></td></tr>'
         else '' end
      || '<tr><td style="padding:22px 28px 26px;font-size:12px;color:#5f5d57;">'
      || '這封信由 Office Hour 平台在每週日 12:00 自動寄到助教信箱，可以在後台「寄信通知」關掉'
      || '</td></tr></table></td></tr></table></body></html>'
  );
end $$;

-- 'remind' joins 'weekly' and 'preview'.
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
                || '<div style="margin-top:8px;">要調整場次，請在週一 09:00 前發布；收件人和內容可以在後台「寄信通知」修改</div></div></td></tr>\1')));
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

create or replace function public.oh_admin_mail(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
begin
  return jsonb_build_object(
    'clock', app.clock(),
    'settings', (select jsonb_build_object('weekly', m.weekly, 'preview', m.preview, 'remind', m.remind, 'ta_email', m.ta_email)
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

-- p_kind 'settings' (weekly, preview, remind, ta_email) or 'recipient'
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
      remind   = case when p ? 'remind'   then (p ->> 'remind')::boolean else x.remind end,
      ta_email = case when p ? 'ta_email' then coalesce(app.clean(p ->> 'ta_email'), '') else x.ta_email end,
      updated_at = app.now()
    where x.id = 1;
    perform app.log(s, 'config.mail', null, null);
    return (select jsonb_build_object('weekly', m.weekly, 'preview', m.preview, 'remind', m.remind, 'ta_email', m.ta_email)
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

-- The reminder comes first: it is the first to go out.
create or replace function public.oh_admin_mail_preview(p_token text, p_week date default null, p_site text default null,
                                                        p_api text default null, p_key text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s app.sessions := app.session(p_token, array['admin']);
  v_week date := coalesce(p_week, app.mail_week(app.today()));
  v_week_list jsonb;
  v_preview jsonb;
  v_remind jsonb;
begin
  v_week := v_week - (extract(isodow from v_week)::int - 1);
  v_week_list := app.mail_outbox('weekly', v_week, p_site, p_api, p_key, null, true);
  v_preview := app.mail_outbox('preview', v_week, p_site, p_api, p_key, '（寄件的 Gmail）', true);
  v_remind := app.mail_outbox('remind', v_week, p_site, p_api, p_key, '（寄件的 Gmail）', true);
  return jsonb_build_object(
    'week', v_week,
    'messages', (select coalesce(jsonb_agg(m || jsonb_build_object('sent_at',
                   (select app.iso(l.sent_at) from app.mail_log l
                     where l.kind = m ->> 'kind' and l.week_start = v_week and lower(l.email) = lower(m ->> 'to')))
                 order by i), '[]'::jsonb)
                 from jsonb_array_elements(v_remind || v_preview || v_week_list) with ordinality as x (m, i)));
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
