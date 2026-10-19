// The SQL that defines the backend. The same files are pushed to Supabase,
// run by the test suite, and executed in the browser for the demo.
import schema from '../../supabase/migrations/20261013000001_schema.sql?raw';
import api from '../../supabase/migrations/20261013000002_api.sql?raw';
import discord from '../../supabase/migrations/20261014000003_discord.sql?raw';
import expiry from '../../supabase/migrations/20261014000004_session_expiry.sql?raw';
import privateRealtime from '../../supabase/migrations/20261014000005_private_realtime.sql?raw';
import calendarFeeds from '../../supabase/migrations/20261014000006_calendar_feeds.sql?raw';
import nameLogin from '../../supabase/migrations/20261016000007_name_login.sql?raw';
import adminNameLogin from '../../supabase/migrations/20261016000008_admin_name_login.sql?raw';
import oneGroupPerSlot from '../../supabase/migrations/20261016000009_one_group_per_slot.sql?raw';
import tdLessons from '../../supabase/migrations/20261019000010_td_lessons.sql?raw';
import tdCalendarByTeacher from '../../supabase/migrations/20261019000011_td_calendar_by_teacher.sql?raw';
import teamView from '../../supabase/migrations/20261019000012_team_view.sql?raw';
import weekDeadline from '../../supabase/migrations/20261019000013_week_deadline.sql?raw';
import weeklyMail from '../../supabase/migrations/20261019000014_weekly_mail.sql?raw';
import mailPreviewNote from '../../supabase/migrations/20261019000015_mail_preview_note.sql?raw';
import taReminder from '../../supabase/migrations/20261019000016_ta_reminder.sql?raw';
import seed from '../../supabase/seed.sql?raw';

// Supabase provides these roles and the realtime schema; a bare Postgres
// (PGlite) needs stand-ins. realtime.send becomes a NOTIFY so the demo
// engine can still push changes to the UI.
export const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create schema realtime;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql as $$ select pg_notify('oh_sync', payload::text) $$;
`;

export const MIGRATIONS = [schema, api, discord, expiry, privateRealtime, calendarFeeds, nameLogin, adminNameLogin, oneGroupPerSlot, tdLessons, tdCalendarByTeacher, teamView, weekDeadline, weeklyMail, mailPreviewNote, taReminder];
export const SEED = seed;
