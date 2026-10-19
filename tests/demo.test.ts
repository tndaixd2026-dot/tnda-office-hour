import { describe, expect, it } from 'vitest';
import demoSeed from '../src/db/demo.sql?raw';
import { autoSchedule } from '../src/lib/scheduler';
import { makeDb } from './helpers';

describe('demo data', () => {
  it('loads on any date and gives every role something to look at', async () => {
    for (const now of ['2026-10-14T09:00:00+08:00', '2027-03-07T22:00:00+08:00', '2028-02-29T08:00:00+08:00']) {
      const db = await makeDb();
      await db.setNow(now);
      await db.pg.exec(demoSeed);
      const admin = await db.call('oh_join', { p_code: 'DEMOADMIN001' });
      const st = await db.call('oh_admin_state', { p_token: admin.token });
      expect(st.requests.length).toBeGreaterThanOrEqual(5);
      const student = await db.call('oh_join', { p_code: 'DEMOG002', p_name: '林小晴' });
      const ss = await db.call('oh_student_state', { p_token: student.token });
      expect(ss.appointments.length).toBeGreaterThan(0);
      expect(ss.members).toContain('林小晴');
      const byName = await db.call('oh_login', { p_name: '林小晴' });
      expect(byName.session).toMatchObject({ role: 'student', group: { no: 2 } });
      const teacher = await db.call('oh_join', { p_code: 'DEMOT00001' });
      const ts = await db.call('oh_teacher_state', { p_token: teacher.token });
      expect(ts.me.name).toBe('Joseph');
      expect(ts.sessions.some((x: any) => x.mine)).toBe(true);
      expect(ts.sessions.some((x: any) => !x.mine)).toBe(true);

      // the auto-scheduler's proposal is accepted by the server as-is
      const proposal = autoSchedule({
        slots: st.slots, appointments: st.appointments, requests: st.requests, groups: st.groups,
        weekCap: st.settings.week_cap, dayCap: st.settings.day_cap,
      });
      expect(proposal.length).toBeGreaterThan(0);
      const r = await db.call('oh_admin_apply', { p_token: admin.token, p_week: st.week_id, p_items: proposal });
      expect(r.count).toBe(proposal.length);
    }
  });
});
