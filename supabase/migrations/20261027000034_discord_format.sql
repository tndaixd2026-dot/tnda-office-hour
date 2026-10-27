-- =====================================================================
-- Office Hour · the Discord message in Discord's own formatting
--
-- The weekly message becomes a heading for the week, a sub-heading for the
-- time (the thing to notice), the group and PM, the deadline in bold with
-- Discord's live countdown, and the fine print as Discord's small text.
-- Text the students or admins typed (topics, names, reasons) is escaped,
-- so it cannot turn into formatting. app.discord_refreshing lists the
-- messages still open, so the sender can redraw them (KIND=refresh).
-- =====================================================================

-- Backslash-escapes Discord's markdown characters, so typed text shows as typed.
create or replace function app.discord_escape(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(p, '([\\*_~`|<>#\[\]()-])', '\\\1', 'g')
$$;

create or replace function app.discord_message(p_group int, p_week int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  g app.groups;
  w app.weeks;
  r app.requests;
  a app.appointments;
  cfg app.settings := app.cfg();
  v_site text := (select b.site from app.discord_bot b where b.id = 1);
  v_open boolean := app.week_bookable(p_week, p_group);
  v_holiday text := app.fixed_holiday(p_group, p_week);
  v_deadline timestamp;
  v_wk text;
  v_d date;
  v_t time;
  v_teacher int;
  v_when text;
  v_who text;
  v_room text;
  v_text text;
  v_buttons jsonb := '[]';
begin
  select * into g from app.groups x where x.id = p_group;
  select * into w from app.weeks x where x.id = p_week;
  select * into r from app.requests x where x.group_id = p_group and x.week_id = p_week;
  select * into a from app.appointments x where x.group_id = p_group and x.week_id = p_week
   order by x.status = 'confirmed' desc, x.id desc limit 1;
  v_deadline := app.week_deadline(w.start_date);
  v_wk := coalesce(nullif(w.label, ''), to_char(w.start_date, 'FMMM/FMDD') || ' 那週');
  -- the session as the admins left it (moved, another PM), else the fixed slot
  if a.status = 'confirmed' then
    v_d := a.d; v_t := a.t; v_teacher := a.teacher_id;
  else
    v_d := w.start_date + g.slot_dow - 1; v_t := g.slot_time; v_teacher := g.teacher_id;
  end if;
  v_when := coalesce(app.slot_text(v_d, v_t), '');
  v_who := app.discord_escape(app.group_title(p_group))
           || case when cfg.show_teacher_names
                   then coalesce(' · ' || app.discord_escape((select t.name from app.teachers t where t.id = v_teacher)), '')
                   else '' end;
  v_room := app.room_of(v_teacher);
  v_room := case when v_room ~ '^https?://\S+$' then '🔗 [進入討論室](<' || v_room || '>)' else app.discord_escape(v_room) end;

  if not w.open then
    v_text := '## ' || v_wk || ' 暫停'
              || E'\n-# 這週不排 Office Hour，有問題可以問助教';
  elsif v_holiday is not null then
    v_text := '## ' || v_wk || ' 停一次'
              || E'\n' || to_char(v_d, 'FMMM/FMDD') || '（' || app.wday(v_d) || '）遇到' || app.discord_escape(v_holiday) || '，這週不用預約';
  elsif r.status = 'open' and a.status = 'cancelled' then
    v_text := '## ' || v_wk || ' 的 Office Hour 已取消'
              || E'\n### ~~' || app.slot_text(a.d, a.t) || '~~'
              || coalesce(E'\n-# ' || app.discord_escape(a.cancelled_by) || ' 取消'
                          || coalesce('：' || app.discord_escape(a.cancel_reason), ''), '');
  elsif r.status = 'open' then
    v_text := '## ✅ ' || v_wk || ' 已預約 Office Hour'
              || E'\n### ' || v_when
              || E'\n' || v_who || coalesce(' · ' || v_room, '')
              || E'\n> 💬 **' || app.discord_escape(r.topic) || '**'
              || E'\n-# ' || app.discord_escape(r.author) || ' 填的'
              || case when v_open then ' · ' || app.deadline_text(v_deadline) || ' 前都可以修改或改成這週不約' else '' end;
  elsif r.status = 'skipped' then
    v_text := '## ' || v_wk || ' 這週不約'
              || E'\n' || v_when || ' 不排討論'
              || E'\n-# ' || app.discord_escape(r.author) || ' 決定的'
              || case when v_open then ' · ' || app.deadline_text(v_deadline) || ' 前都可以改成預約' else '' end;
  elsif v_open then
    v_text := '## 📅 ' || v_wk || ' 要約 Office Hour 嗎？'
              || E'\n### ' || v_when
              || E'\n' || v_who
              -- Discord shows <t:…:R> as a countdown in each reader's language ("4 天後")
              || E'\n⏰ 請在 **' || app.deadline_text(v_deadline) || '** 前決定（<t:'
              || extract(epoch from (v_deadline at time zone cfg.timezone))::bigint || ':R>）'
              || E'\n-# 要約就按「預約這週」，填好題目、想問的問題、目前進度和雲端資料夾連結，送出就排定';
  else
    v_text := '## ' || v_wk || ' 沒有預約'
              || E'\n-# 已在 ' || app.deadline_text(v_deadline) || ' 截止，這週不排討論';
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

-- Messages whose week is still open, to redraw as they stand now.
create or replace function app.discord_refreshing()
returns table (post_id int, group_no int, channel_id text, message_id text, payload jsonb)
language sql stable set search_path = '' as $$
  select dp.id, g.no, dp.channel_id, dp.message_id, app.discord_message(dp.group_id, dp.week_id)
    from app.discord_posts dp
    join app.groups g on g.id = dp.group_id
    join app.weeks w on w.id = dp.week_id
   where dp.closed_at is null and app.local_now() < app.week_deadline(w.start_date)
   order by g.no
$$;

revoke execute on all functions in schema app from public;
