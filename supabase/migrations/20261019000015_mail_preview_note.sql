-- The preview's note about publishing ran on from the recipient list
-- when there were no recipients yet; it now starts a line of its own.

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

revoke execute on all functions in schema app from public;
