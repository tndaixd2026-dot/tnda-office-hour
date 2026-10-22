import { describe, expect, it } from 'vitest';
import { autoSchedule, type SchedInput } from '../src/lib/scheduler';

const D = { mon: '2026-10-19', tue: '2026-10-20', wed: '2026-10-21', thu: '2026-10-22' };

function base(over: Partial<SchedInput> = {}): SchedInput {
  return {
    slots: [],
    appointments: [],
    requests: [],
    groups: [1, 2, 3, 4, 5].map((id) => ({ id, no: id, active: true, total: 0, recent_teachers: [] })),
    weekCap: 2,
    dayCap: 1,
    ...over,
  };
}

const req = (group_id: number, slots: Array<[string, string]>, want = 1, created_at = `2026-10-1${group_id}T00:00:00Z`) => ({
  group_id,
  want,
  status: 'open',
  created_at,
  slots: slots.map(([d, t]) => ({ d, t })),
});

describe('autoSchedule', () => {
  it("keeps a paired group to its own teacher's slots", () => {
    const groups = base().groups.map((g) => (g.id === 1 ? { ...g, teacher_id: 2 } : g));
    const out = autoSchedule(base({
      groups,
      slots: [
        { d: D.mon, t: '17:00', teachers: [1] },
        { d: D.wed, t: '10:00', teachers: [1, 2] },
      ],
      requests: [req(1, [[D.mon, '17:00'], [D.wed, '10:00']])],
    }));
    expect(out).toEqual([{ group_id: 1, teacher_id: 2, d: D.wed, t: '10:00' }]);
  });

  it('gives a paired group its teacher even when another group met that teacher before', () => {
    const groups = base().groups.map((g) => (g.id === 1 ? { ...g, teacher_id: 1 } : g.id === 2 ? { ...g, recent_teachers: [1] } : g));
    const out = autoSchedule(base({
      perSlot: 2,
      groups,
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2] }],
      requests: [req(2, [[D.wed, '10:00']]), req(1, [[D.wed, '10:00']])],
    }));
    expect(out).toEqual([
      { group_id: 1, teacher_id: 1, d: D.wed, t: '10:00' },
      { group_id: 2, teacher_id: 2, d: D.wed, t: '10:00' },
    ]);
  });

  it('never puts two groups paired with one teacher in the same slot', () => {
    const groups = base().groups.map((g) => (g.id <= 2 ? { ...g, teacher_id: 1 } : g));
    const out = autoSchedule(base({
      perSlot: 2,
      groups,
      slots: [
        { d: D.wed, t: '10:00', teachers: [1, 2] },
        { d: D.thu, t: '10:00', teachers: [1] },
      ],
      requests: [req(1, [[D.wed, '10:00']]), req(2, [[D.wed, '10:00'], [D.thu, '10:00']])],
    }));
    expect(out).toEqual([
      { group_id: 1, teacher_id: 1, d: D.wed, t: '10:00' },
      { group_id: 2, teacher_id: 1, d: D.thu, t: '10:00' },
    ]);
  });

  it("leaves a paired group out when its teacher is busy, rather than give it another one", () => {
    const groups = base().groups.map((g) => (g.id === 1 ? { ...g, teacher_id: 1 } : g));
    const out = autoSchedule(base({
      perSlot: 2,
      groups,
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2] }],
      appointments: [{ group_id: 3, teacher_id: 1, d: D.wed, t: '10:00', status: 'confirmed' }],
      requests: [req(1, [[D.wed, '10:00']])],
    }));
    expect(out).toEqual([]);
  });

  it('puts one group in a slot by default, however many teachers are free (one meeting room)', () => {
    const out = autoSchedule(base({
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2] }],
      requests: [req(1, [[D.wed, '10:00']]), req(2, [[D.wed, '10:00']])],
    }));
    expect(out).toEqual([{ group_id: 1, teacher_id: 1, d: D.wed, t: '10:00' }]);
  });

  it('does not add a group to a slot another group already has', () => {
    const out = autoSchedule(base({
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2] }],
      appointments: [{ group_id: 1, teacher_id: 1, d: D.wed, t: '10:00', status: 'draft' }],
      requests: [req(2, [[D.wed, '10:00']])],
    }));
    expect(out).toEqual([]);
  });

  it('fills a two-teacher slot with two groups when there are rooms for both', () => {
    const out = autoSchedule(base({
      perSlot: 2,
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2] }],
      requests: [req(1, [[D.wed, '10:00']]), req(2, [[D.wed, '10:00']])],
    }));
    expect(out).toHaveLength(2);
    expect(new Set(out.map((o) => o.teacher_id))).toEqual(new Set([1, 2]));
  });

  it('reroutes to serve everyone when possible', () => {
    // group 1 can use A or B, group 2 only A, group 3 only B
    const out = autoSchedule(base({
      slots: [
        { d: D.mon, t: '17:00', teachers: [1] },
        { d: D.tue, t: '17:00', teachers: [1] },
      ],
      requests: [
        req(1, [[D.mon, '17:00'], [D.tue, '17:00']]),
        req(2, [[D.mon, '17:00']]),
        req(3, [[D.tue, '17:00']]),
      ],
    }));
    // only two slots exist, so two groups are served; group 1 asked first,
    // and the flow still serves one of 2 / 3 alongside it
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.group_id)).toContain(1);
  });

  it('prefers groups that have met PMs less often', () => {
    const out = autoSchedule(base({
      slots: [{ d: D.wed, t: '10:00', teachers: [1] }],
      groups: [
        { id: 1, no: 1, active: true, total: 3, recent_teachers: [] },
        { id: 2, no: 2, active: true, total: 0, recent_teachers: [] },
      ],
      requests: [req(1, [[D.wed, '10:00']]), req(2, [[D.wed, '10:00']])],
    }));
    expect(out).toEqual([{ group_id: 2, teacher_id: 1, d: D.wed, t: '10:00' }]);
  });

  it('gives a second session on another day when asked', () => {
    const out = autoSchedule(base({
      slots: [
        { d: D.wed, t: '10:00', teachers: [1] },
        { d: D.wed, t: '10:30', teachers: [1] },
        { d: D.thu, t: '10:00', teachers: [2] },
      ],
      requests: [req(1, [[D.wed, '10:00'], [D.wed, '10:30'], [D.thu, '10:00']], 2)],
    }));
    expect(out).toHaveLength(2);
    expect(new Set(out.map((o) => o.d))).toEqual(new Set([D.wed, D.thu]));
  });

  it('serves everyone once before anyone twice', () => {
    const out = autoSchedule(base({
      slots: [
        { d: D.wed, t: '10:00', teachers: [1] },
        { d: D.thu, t: '10:00', teachers: [1] },
      ],
      requests: [req(1, [[D.wed, '10:00'], [D.thu, '10:00']], 2), req(2, [[D.thu, '10:00']])],
    }));
    expect(out.map((o) => [o.group_id, o.d])).toEqual([
      [1, D.wed],
      [2, D.thu],
    ]);
  });

  it('respects what is already booked', () => {
    const out = autoSchedule(base({
      perSlot: 2,
      slots: [
        { d: D.wed, t: '10:00', teachers: [1, 2] },
        { d: D.wed, t: '10:30', teachers: [1] },
        { d: D.thu, t: '10:00', teachers: [1] },
      ],
      appointments: [
        { group_id: 1, teacher_id: 1, d: D.wed, t: '10:00', status: 'confirmed' },
        { group_id: 3, teacher_id: 1, d: D.thu, t: '10:00', status: 'draft' },
        { group_id: 4, teacher_id: 2, d: D.wed, t: '10:00', status: 'cancelled' },
      ],
      requests: [
        req(1, [[D.wed, '10:30'], [D.thu, '10:00']], 2), // Wednesday used up, Thursday taken by group 3
        req(2, [[D.wed, '10:00']]),
      ],
    }));
    expect(out).toEqual([{ group_id: 2, teacher_id: 2, d: D.wed, t: '10:00' }]);
  });

  it('skips groups at their weekly cap, withdrawn requests and inactive groups', () => {
    const out = autoSchedule(base({
      weekCap: 1,
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2, 3] }, { d: D.thu, t: '10:00', teachers: [1] }],
      appointments: [{ group_id: 1, teacher_id: 1, d: D.thu, t: '10:00', status: 'confirmed' }],
      groups: [
        { id: 1, no: 1, active: true, total: 0, recent_teachers: [] },
        { id: 2, no: 2, active: true, total: 0, recent_teachers: [] },
        { id: 3, no: 3, active: false, total: 0, recent_teachers: [] },
      ],
      requests: [
        req(1, [[D.wed, '10:00']], 2),
        { ...req(2, [[D.wed, '10:00']]), status: 'withdrawn' },
        req(3, [[D.wed, '10:00']]),
      ],
    }));
    expect(out).toEqual([]);
  });

  it('skips slots that already started', () => {
    const out = autoSchedule(base({
      notBefore: `${D.wed} 10:30`,
      slots: [{ d: D.wed, t: '10:00', teachers: [1] }, { d: D.wed, t: '11:00', teachers: [1] }],
      requests: [req(1, [[D.wed, '10:00'], [D.wed, '11:00']])],
    }));
    expect(out).toEqual([{ group_id: 1, teacher_id: 1, d: D.wed, t: '11:00' }]);
  });

  it('keeps a group with the PM it met before', () => {
    const out = autoSchedule(base({
      slots: [{ d: D.wed, t: '10:00', teachers: [1, 2] }],
      groups: [{ id: 1, no: 1, active: true, total: 1, recent_teachers: [2] }],
      requests: [req(1, [[D.wed, '10:00']])],
    }));
    expect(out[0].teacher_id).toBe(2);
  });

  it('serves the maximum on a crowded week', () => {
    // 6 slots x 1 teacher, 8 groups each picking 2 random-ish slots
    const days = [D.mon, D.tue, D.wed];
    const slots = days.flatMap((d) => ['10:00', '10:30'].map((t) => ({ d, t, teachers: [1] })));
    const picks: Array<Array<[string, string]>> = [
      [[D.mon, '10:00'], [D.tue, '10:00']],
      [[D.mon, '10:00'], [D.mon, '10:30']],
      [[D.mon, '10:30'], [D.wed, '10:00']],
      [[D.tue, '10:00'], [D.tue, '10:30']],
      [[D.tue, '10:30'], [D.wed, '10:30']],
      [[D.wed, '10:00'], [D.wed, '10:30']],
      [[D.mon, '10:00']],
      [[D.mon, '10:00']],
    ];
    const out = autoSchedule(base({
      slots,
      groups: picks.map((_, i) => ({ id: i + 1, no: i + 1, active: true, total: 0, recent_teachers: [] })),
      requests: picks.map((p, i) => req(i + 1, p, 1, `2026-10-10T00:0${i}:00Z`)),
    }));
    expect(out).toHaveLength(6);
    expect(new Set(out.map((o) => `${o.d} ${o.t}`)).size).toBe(6);
    // groups 1–6 all fit; the two late single-slot groups lose out
    expect(out.map((o) => o.group_id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
