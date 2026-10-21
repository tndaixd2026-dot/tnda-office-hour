-- Demo data for the in-browser sandbox: fixed codes and a semester that
-- is always "in progress", whatever today's date is.

update app.groups   set code = 'DEMOG' || lpad(no::text, 3, '0');
update app.teachers set code = 'DEMOT' || lpad(sort::text, 5, '0');
update app.admins   set code = 'DEMOADMIN001';

create function app._demo_request(p_week int, p_group_no int, p_author text, p_topic text, p_progress text,
                                  p_link text, p_want int, p_slots text[], p_ago interval)
returns void language plpgsql as $$
declare
  v_id bigint;
  v_start date := (select start_date from app.weeks where id = p_week);
  s text;
begin
  insert into app.requests (week_id, group_id, topic, progress, link, want, author, created_at, updated_at)
  values (p_week, (select id from app.groups where no = p_group_no), p_topic, p_progress, p_link, p_want, p_author,
          app.now() - p_ago, app.now() - p_ago)
  returning id into v_id;
  -- slots are written as 'dow HH:MM', e.g. '3 10:00' = Wednesday 10:00
  foreach s in array p_slots loop
    insert into app.request_slots (request_id, d, t)
    values (v_id, v_start + split_part(s, ' ', 1)::int - 1, split_part(s, ' ', 2)::time);
  end loop;
  insert into app.events (at, actor_role, actor_name, kind, group_id, week_id, data)
  values (app.now() - p_ago, 'student', p_author, 'request.created', (select id from app.groups where no = p_group_no),
          p_week, jsonb_build_object('topic', p_topic, 'slots', cardinality(p_slots), 'want', p_want));
end $$;

create function app._demo_appt(p_week int, p_group_no int, p_teacher text, p_dow int, p_t text, p_status text default 'confirmed')
returns void language sql as $$
  insert into app.appointments (week_id, group_id, teacher_id, d, t, status, created_by, created_at, published_at)
  select p_week, (select id from app.groups where no = p_group_no), (select id from app.teachers where name = p_teacher),
         w.start_date + p_dow - 1, p_t::time, p_status, '助教', app.now() - interval '3 days',
         case when p_status = 'confirmed' then app.now() - interval '3 days' end
    from app.weeks w where w.id = p_week;
$$;

do $$
declare
  v_today  date := app.today();
  v_monday date := v_today - (extract(isodow from v_today)::int - 1);
  w_prev2 int; w_prev int; w_cur int; w_next int;
  m record;
begin
  delete from app.closures;
  delete from app.weeks;
  insert into app.weeks (start_date, label)
  select v_monday + 7 * (i - 2), 'W' || (5 + i) from generate_series(0, 11) as i;
  select id into w_prev2 from app.weeks where start_date = v_monday - 14;
  select id into w_prev  from app.weeks where start_date = v_monday - 7;
  select id into w_cur   from app.weeks where start_date = v_monday;
  select id into w_next  from app.weeks where start_date = v_monday + 7;
  insert into app.closures (on_date, reason) values (v_monday + 7 * 4 + 4, '校慶補假');
  update app.weeks set note = '期中週' where start_date = v_monday + 7 * 5;

  -- group members (their tokens are random and unusable)
  for m in select * from (values
      (1, '吳思妤'), (1, '張家豪'),
      (2, '陳柏宇'), (2, '黃以恩'),
      (3, '李承恩'), (3, '王語彤'),
      (4, '蔡宗翰'), (4, '許芷瑄'), (4, '鄭宇辰'),
      (5, '周子芸'), (5, '劉冠廷'),
      (6, '楊詠晴'), (6, '謝昀哲'),
      (7, '簡郁庭')) as x (no, name) loop
    insert into app.sessions (token_hash, role, group_id, name, created_at, seen_at)
    values (app.hash_token(app.new_token()), 'student', (select id from app.groups where no = m.no), m.name,
            app.now() - interval '20 days', app.now() - interval '1 day');
    insert into app.roster (group_id, name) values ((select id from app.groups where no = m.no), m.name);
  end loop;
  -- on the roster, but not signed in yet
  insert into app.roster (group_id, name)
  select (select id from app.groups where no = x.no), x.name
    from (values (2, '林小晴'), (5, '林冠宇'), (7, '張書維')) as x (no, name);

  -- two weeks ago
  perform app._demo_request(w_prev2, 2, '陳柏宇', '題目發想怎麼收斂', '列了十個方向，想選兩個深入。', null, 1, array['3 10:00'], interval '18 days');
  perform app._demo_request(w_prev2, 3, '李承恩', '分工與時程', '有初步分工表，還沒排時程。', null, 1, array['3 10:30'], interval '18 days');
  perform app._demo_appt(w_prev2, 2, 'Joseph', 3, '10:00');
  perform app._demo_appt(w_prev2, 3, 'Prolong', 3, '10:30');

  -- last week
  perform app._demo_request(w_prev, 1, '吳思妤', '投影機要租還是買', '比較了三家租賃報價。', null, 1, array['1 17:00'], interval '11 days');
  perform app._demo_request(w_prev, 2, '黃以恩', '互動形式的選擇', '在體感和觸控之間猶豫。', null, 1, array['3 11:00'], interval '11 days');
  perform app._demo_request(w_prev, 4, '蔡宗翰', '感測器選型', '試了超音波和 ToF 兩種。', null, 1, array['4 16:00'], interval '11 days');
  perform app._demo_request(w_prev, 6, '楊詠晴', '影像風格參考', '收集了二十張參考圖。', null, 1, array['1 18:00'], interval '11 days');
  perform app._demo_appt(w_prev, 1, 'Joseph', 1, '17:00');
  perform app._demo_appt(w_prev, 2, 'Prolong', 3, '11:00');
  perform app._demo_appt(w_prev, 4, 'Tim', 4, '16:00');
  perform app._demo_appt(w_prev, 6, 'Joseph', 1, '18:00');

  -- this week
  perform app._demo_request(w_cur, 1, '張家豪', '投影融合的測試方法', '借到兩台投影機，週末會先測。', null, 1, array['1 17:30'], interval '6 days');
  perform app._demo_request(w_cur, 2, '林小晴', '展場平面圖回饋', '畫好第一版平面圖，想請 PM 看動線。', 'https://drive.google.com/drive/folders/demo-group-2', 1, array['3 10:00', '3 10:30'], interval '6 days');
  perform app._demo_request(w_cur, 3, '王語彤', '使用者測試要問什麼', '寫好測試腳本草稿。', null, 1, array['4 16:30'], interval '6 days');
  perform app._demo_request(w_cur, 5, '周子芸', '預算超支怎麼辦', '估價比預算多兩成。', null, 1, array['3 10:00'], interval '6 days');
  perform app._demo_request(w_cur, 6, '謝昀哲', '風格定案前的最後確認', '收斂到兩版 moodboard。', null, 1, array['5 11:00'], interval '6 days');
  perform app._demo_appt(w_cur, 1, 'Joseph', 1, '17:30');
  perform app._demo_appt(w_cur, 2, 'Prolong', 3, '10:30');
  perform app._demo_appt(w_cur, 5, 'Joseph', 3, '10:00');
  perform app._demo_appt(w_cur, 3, 'Tim', 4, '16:30');
  perform app._demo_appt(w_cur, 6, 'Prolong', 5, '11:00');

  -- next week: requests waiting to be scheduled
  perform app._demo_request(w_next, 1, '吳思妤', '投影融合的接縫怎麼處理',
    E'兩台投影機已架好，邊緣融合還有一條亮帶。\n想確認是軟體設定還是硬體擺位的問題。',
    'https://drive.google.com/drive/folders/demo-group-1', 1, array['3 10:00', '3 10:30', '4 10:00'], interval '2 days');
  perform app._demo_request(w_next, 2, '林小晴', '展場動線要怎麼配合互動裝置',
    E'企劃書完成，正在畫展場平面圖。\n想討論觀眾從入口走到裝置的動線，以及排隊的位置。',
    'https://drive.google.com/drive/folders/demo-group-2', 2,
    array['1 17:00', '1 17:30', '3 10:00', '3 10:30', '3 11:00', '5 10:00'], interval '1 day');
  perform app._demo_request(w_next, 3, '李承恩', '互動流程測試要找誰來試',
    '流程圖完成，準備第一次使用者測試，還不確定要找多少人、找誰。', null, 1, array['2 17:00', '2 17:30', '4 16:00'], interval '20 hours');
  perform app._demo_request(w_next, 4, '蔡宗翰', '感測器延遲太大，要換方案嗎',
    '第一版原型可以動，但從揮手到畫面反應大約慢 1 秒。', 'https://drive.google.com/drive/folders/demo-group-4', 1,
    array['3 10:00', '4 10:00', '4 10:30', '5 11:00'], interval '9 hours');
  perform app._demo_request(w_next, 5, '劉冠廷', '估價單的人力怎麼抓',
    '估價草稿寫到一半，不確定工程師的工時怎麼估比較合理。', null, 1, array['3 10:00', '3 10:30'], interval '5 hours');
  perform app._demo_request(w_next, 6, '楊詠晴', '影像內容的風格方向',
    '做了三版 moodboard，組內還沒有共識，想聽聽 PM 的看法。', 'https://drive.google.com/drive/folders/demo-group-6', 2,
    array['1 18:00', '2 18:00', '4 16:30', '5 10:30'], interval '40 minutes');
  perform app._demo_appt(w_next, 4, 'Prolong', 4, '10:00');
  -- group 2 (the demo student) always has something coming up, whatever the weekday
  perform app._demo_appt(w_next, 2, 'Joseph', 1, '17:00');
end $$;

-- what each group wants to ask the PM
update app.requests r set questions = v.q
  from (values
    ('投影融合的測試方法', E'兩台投影機重疊的地方亮度不均，要怎麼調\n融合用 Resolume 就夠嗎'),
    ('展場平面圖回饋', E'入口到主裝置的動線會不會太長\n排隊區放在哪裡比較不擋路'),
    ('使用者測試要問什麼', E'要找幾個人測才夠\n要錄影，還是做筆記就好'),
    ('預算超支怎麼辦', E'哪些項目可以先砍\n租和買要怎麼取捨'),
    ('風格定案前的最後確認', '兩版 moodboard 哪一版比較適合展場燈光'),
    ('投影融合的接縫怎麼處理', E'接縫要用軟邊還是硬切\n需要另外買融合器嗎'),
    ('展場動線要怎麼配合互動裝置', E'每個人體驗多久比較好\n動線要單向，還是可以回頭'),
    ('互動流程測試要找誰來試', E'找同學測會不會太有偏見\n測之前要先說明玩法嗎'),
    ('感測器延遲太大，要換方案嗎', E'0.3 秒的延遲觀眾感覺得到嗎\n換成 ToF 值得多花預算嗎'),
    ('估價單的人力怎麼抓', '工時要用小時還是天來估'),
    ('影像內容的風格方向', '寫實和插畫哪一種比較好做互動')
  ) as v (t, q)
 where r.topic = v.t;

drop function app._demo_request(int, int, text, text, text, text, int, text[], interval);
drop function app._demo_appt(int, int, text, int, text, text);

-- TD units: the outline starts empty; give the first few a topic and tick them on some of the planned lessons
update app.lesson_units u set title = v.title, topic = v.topic
  from (values
    ('基礎教學', 1, '介面與節點', E'認識 TouchDesigner 的介面、OP 的種類和怎麼接線\n請先裝好免費版並註冊帳號'),
    ('基礎教學', 2, 'TOP 與影像合成', '用 TOP 做出第一個會動的畫面'),
    ('基礎教學', 3, 'CHOP 與聲音互動', ''),
    ('案例分享', 1, '展場互動裝置', '拆解兩個展場案子的系統架構'),
    ('駐村創作', 1, '題目發想', '帶著想做的題目來，一起討論可行性')
  ) as v (kind, sort, title, topic)
 where u.kind = v.kind and u.sort = v.sort;
update app.lessons l set unit_id = u.id
  from app.lesson_units u, (values
    ('2026-10-26', '基礎教學', 1), ('2026-10-27', '基礎教學', 1),
    ('2026-11-02', '基礎教學', 2), ('2026-11-03', '基礎教學', 2),
    ('2026-11-06', '案例分享', 1), ('2026-11-10', '案例分享', 1),
    ('2026-11-14', '駐村創作', 1), ('2026-11-15', '駐村創作', 1)
  ) as v (d, kind, sort)
 where l.d = v.d::date and l.kind = v.kind and u.kind = v.kind and u.sort = v.sort;
