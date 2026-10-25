-- Demo data for the in-browser sandbox: fixed codes and a semester that
-- is always "in progress", whatever today's date is. Every group has its
-- fixed weekly hour (from the seed); each week a group books it or skips.

update app.groups   set code = 'DEMOG' || lpad(no::text, 3, '0');
update app.teachers set code = 'DEMOT' || lpad(sort::text, 5, '0');
update app.admins   set code = 'DEMOADMIN001';

-- a group books its fixed hour of a week: the request and the session it confirms
create function app._demo_book(p_week int, p_group_no int, p_author text, p_topic text, p_questions text,
                               p_progress text, p_ago interval)
returns void language plpgsql as $$
declare
  g app.groups;
  v_d date;
  v_id bigint;
begin
  select * into g from app.groups x where x.no = p_group_no;
  select w.start_date + g.slot_dow - 1 into v_d from app.weeks w where w.id = p_week;
  insert into app.requests (week_id, group_id, topic, progress, questions, link, want, author, status, created_at, updated_at)
  values (p_week, g.id, p_topic, p_progress, p_questions, 'https://drive.google.com/drive/folders/demo-group-' || p_group_no,
          1, p_author, 'open', app.now() - p_ago, app.now() - p_ago)
  returning id into v_id;
  insert into app.request_slots (request_id, d, t) values (v_id, v_d, g.slot_time);
  insert into app.appointments (week_id, group_id, teacher_id, d, t, status, created_by, created_at, published_at)
  values (p_week, g.id, g.teacher_id, v_d, g.slot_time, 'confirmed', p_author, app.now() - p_ago, app.now() - p_ago);
  insert into app.events (at, actor_role, actor_name, kind, group_id, week_id, data)
  values (app.now() - p_ago, 'student', p_author, 'request.created', g.id, p_week, jsonb_build_object('topic', p_topic));
end $$;

-- a group says it skips a week
create function app._demo_skip(p_week int, p_group_no int, p_author text, p_ago interval)
returns void language plpgsql as $$
declare
  v_group int := (select id from app.groups where no = p_group_no);
begin
  insert into app.requests (week_id, group_id, topic, progress, questions, want, author, status, created_at, updated_at)
  values (p_week, v_group, '', '', '', 1, p_author, 'skipped', app.now() - p_ago, app.now() - p_ago);
  insert into app.events (at, actor_role, actor_name, kind, group_id, week_id)
  values (app.now() - p_ago, 'student', p_author, 'request.skipped', v_group, p_week);
end $$;

do $$
declare
  v_today  date := app.today();
  v_monday date := v_today - (extract(isodow from v_today)::int - 1);
  w_prev2 int; w_prev int; w_cur int; w_next int; w_book int;
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
  -- next week, or the one after once Saturday 20:00 has passed
  w_book := app.booking_week();

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
  perform app._demo_book(w_prev2, 1, '吳思妤', '題目發想怎麼收斂', '十個方向要怎麼挑出兩個', '列了十個方向，想選兩個深入。', interval '19 days');
  perform app._demo_book(w_prev2, 2, '陳柏宇', '目標觀眾是誰', '觀眾設定要多窄才好', '訪談了五位同學，整理成兩種觀眾。', interval '19 days');
  perform app._demo_book(w_prev2, 3, '李承恩', '分工與時程', '五個人怎麼分工比較順', '有初步分工表，還沒排時程。', interval '18 days');
  perform app._demo_book(w_prev2, 4, '蔡宗翰', '互動形式的選擇', E'體感和觸控哪一種適合展場\n預算夠買哪些感測器', '在體感和觸控之間猶豫。', interval '18 days');
  perform app._demo_book(w_prev2, 5, '周子芸', '預算怎麼抓', '設備要租還是買', '列了第一版預算表。', interval '18 days');
  perform app._demo_book(w_prev2, 6, '楊詠晴', '影像風格參考', '寫實和插畫哪一種比較好做互動', '收集了二十張參考圖。', interval '17 days');
  perform app._demo_skip(w_prev2, 7, '簡郁庭', interval '16 days');

  -- last week
  perform app._demo_book(w_prev, 1, '張家豪', '投影機要租還是買', '租和買的差價值得嗎', '比較了三家租賃報價。', interval '12 days');
  perform app._demo_book(w_prev, 2, '黃以恩', '展場平面圖初稿', '入口到主裝置的動線會不會太長', '畫好第一版平面圖。', interval '12 days');
  perform app._demo_book(w_prev, 3, '王語彤', '使用者測試要問什麼', E'要找幾個人測才夠\n要錄影，還是做筆記就好', '寫好測試腳本草稿。', interval '11 days');
  perform app._demo_book(w_prev, 4, '鄭宇辰', '感測器選型', '超音波和 ToF 哪個比較穩', '試了超音波和 ToF 兩種。', interval '11 days');
  perform app._demo_skip(w_prev, 5, '劉冠廷', interval '10 days');
  perform app._demo_book(w_prev, 6, '謝昀哲', '風格定案前的最後確認', '兩版 moodboard 哪一版比較適合展場燈光', '收斂到兩版 moodboard。', interval '10 days');
  perform app._demo_book(w_prev, 7, '簡郁庭', '媒體素材授權', '網路上的音樂可以拿來用嗎', '列了想用的素材清單。', interval '10 days');

  -- this week (closed last Saturday)
  perform app._demo_book(w_cur, 1, '張家豪', '投影融合的測試方法', E'兩台投影機重疊的地方亮度不均，要怎麼調\n融合用 Resolume 就夠嗎', '借到兩台投影機，週末會先測。', interval '6 days');
  perform app._demo_book(w_cur, 2, '林小晴', '展場平面圖回饋', E'入口到主裝置的動線會不會太長\n排隊區放在哪裡比較不擋路', '畫好第一版平面圖，想請 PM 看動線。', interval '6 days');
  perform app._demo_book(w_cur, 3, '王語彤', '互動流程測試要找誰來試', E'找同學測會不會太有偏見\n測之前要先說明玩法嗎', '流程圖完成，準備第一次使用者測試。', interval '6 days');
  perform app._demo_book(w_cur, 4, '許芷瑄', '感測器延遲太大，要換方案嗎', E'0.3 秒的延遲觀眾感覺得到嗎\n換成 ToF 值得多花預算嗎', '第一版原型可以動，但反應慢了 1 秒。', interval '5 days');
  perform app._demo_book(w_cur, 5, '周子芸', '預算超支怎麼辦', E'哪些項目可以先砍\n租和買要怎麼取捨', '估價比預算多兩成。', interval '5 days');
  perform app._demo_book(w_cur, 6, '謝昀哲', '影像內容的風格方向', '寫實和插畫哪一種比較好做互動', '做了三版 moodboard，組內還沒有共識。', interval '5 days');
  perform app._demo_skip(w_cur, 7, '簡郁庭', interval '4 days');
  -- the admins adjusted two sessions: another PM took one, one moved to a backup hour
  update app.appointments a set teacher_id = (select id from app.teachers where name = 'Joseph')
   where a.week_id = w_cur and a.group_id = (select id from app.groups where no = 3);
  update app.appointments a set d = v_monday + 4, t = '10:00'
   where a.week_id = w_cur and a.group_id = (select id from app.groups where no = 4);

  -- next week, when it has already closed (Saturday night or Sunday)
  if w_book is distinct from w_next then
    perform app._demo_book(w_next, 1, '吳思妤', '投影融合的接縫怎麼處理', E'接縫要用軟邊還是硬切\n需要另外買融合器嗎', '兩台投影機已架好，邊緣融合還有一條亮帶。', interval '2 days');
    perform app._demo_book(w_next, 2, '黃以恩', '展場動線要怎麼配合互動裝置', E'每個人體驗多久比較好\n動線要單向，還是可以回頭', '正在畫展場平面圖，想討論排隊的位置。', interval '2 days');
    perform app._demo_book(w_next, 3, '李承恩', '測試回饋怎麼整理', '十份回饋要怎麼排優先順序', '第一次測試完成，收到十份回饋。', interval '30 hours');
    perform app._demo_book(w_next, 5, '劉冠廷', '估價單的人力怎麼抓', '工時要用小時還是天來估', '估價草稿寫到一半。', interval '28 hours');
    perform app._demo_skip(w_next, 6, '楊詠晴', interval '26 hours');
  end if;

  -- the week open for booking: some groups have booked, some have not decided yet
  if w_book is not null then
    perform app._demo_book(w_book, 1, '吳思妤', '展覽當天的動線演練', '演練要找多少人來走一次', '平面圖定案，準備做一次完整演練。', interval '20 hours');
    perform app._demo_book(w_book, 3, '王語彤', '第二輪測試的題目', '第二輪要不要換一批人測', '整理完第一輪回饋，改了兩個流程。', interval '9 hours');
    perform app._demo_book(w_book, 5, '周子芸', '工程師工時怎麼估', '外包工程師要怎麼報價比較合理', '估價單寫好了，人力的部分還不確定。', interval '5 hours');
    perform app._demo_skip(w_book, 6, '謝昀哲', interval '40 minutes');
  end if;
end $$;

drop function app._demo_book(int, int, text, text, text, text, interval);
drop function app._demo_skip(int, int, text, interval);
