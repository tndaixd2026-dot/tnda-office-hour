import { describe, expect, it } from 'vitest';
import demoSeed from '../src/db/demo.sql?raw';
import { makeDb } from './helpers';

describe('demo data', () => {
  it('loads on any date and gives every role something to look at', async () => {
    // a weekday, a Saturday after the deadline, a Sunday, a leap day
    for (const now of ['2026-10-14T09:00:00+08:00', '2026-10-24T21:00:00+08:00', '2027-03-07T22:00:00+08:00', '2028-02-29T08:00:00+08:00']) {
      const db = await makeDb();
      await db.setNow(now);
      await db.pg.exec(demoSeed);
      const admin = await db.call('oh_join', { p_code: 'DEMOADMIN001' });
      const st = await db.call('oh_admin_state', { p_token: admin.token });
      expect(st.groups.every((g: any) => g.teacher_id && g.slot_dow && g.slot_time)).toBe(true);
      const student = await db.call('oh_join', { p_code: 'DEMOG002', p_name: '林小晴' });
      const ss = await db.call('oh_student_state', { p_token: student.token });
      expect(ss.fixed).toMatchObject({ dow: 3, t: '10:00', teacher: 'Prolong' });
      expect(ss.appointments.length).toBeGreaterThan(0);
      expect(ss.members).toContain('林小晴');
      // the demo student can always book the open week
      const open = ss.weeks.find((w: any) => w.bookable);
      expect(open).toMatchObject({ status: null });
      const booked = await db.call('oh_student_state', { p_token: student.token, p_week: open.id });
      expect(booked.request).toBeNull();
      const byName = await db.call('oh_login', { p_name: '林小晴' });
      expect(byName.session).toMatchObject({ role: 'student', group: { no: 2 } });
      const teacher = await db.call('oh_join', { p_code: 'DEMOT00001' });
      const ts = await db.call('oh_teacher_state', { p_token: teacher.token });
      expect(ts.me.name).toBe('Joseph');
      expect(ts.sessions.some((x: any) => x.mine)).toBe(true);
      expect(ts.sessions.some((x: any) => !x.mine)).toBe(true);
      // the open week already has bookings and a skip to show on the board
      const bw = await db.call('oh_admin_state', { p_token: admin.token, p_week: open.id });
      expect(bw.requests.filter((r: any) => r.status === 'open').length).toBeGreaterThanOrEqual(3);
      expect(bw.requests.some((r: any) => r.status === 'skipped')).toBe(true);
    }
  });
});
