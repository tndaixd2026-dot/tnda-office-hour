-- The PMs' Office Hours move to their own Google Meet room. The old one
-- stays the TD timetable's (app.lesson_info.place). Only a location that
-- is still the old room changes, so a new one set in the admin page is
-- kept.
update app.settings
   set location = 'https://meet.google.com/szq-wemd-ksx'
 where id = 1 and location = 'https://meet.google.com/cpr-haya-zqw';
