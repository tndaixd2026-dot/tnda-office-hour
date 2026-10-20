-- The TD classes move to their own Google Meet room (the old one is now
-- the PMs'). Only a place still set to the old room changes.
update app.lesson_info
   set place = 'https://meet.google.com/qjq-osdm-moo', updated_at = now()
 where id = 1 and place = 'https://meet.google.com/cpr-haya-zqw';
