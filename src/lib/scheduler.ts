// Auto-scheduling as a max-flow problem.
//
//   source ──(sessions still wanted)──▶ group ──(day cap)──▶ group·day
//          ──(1 per picked slot)──▶ slot ──(free teachers)──▶ sink
//
// Phase 1 gives every group at most one session, augmenting groups in
// priority order (fewest sessions so far, then earliest request). Because
// served groups' source edges never lose flow, this yields the largest
// possible set of served groups, preferring higher priority ones.
// Phase 2 then tops up groups that asked for more, round-robin.
// Finally each chosen slot gets concrete teachers, favouring a teacher
// the group has met before, then the least busy one.
//
// A group paired with one or two teachers only reaches the slots where one
// of them is free: it enters a slot through its own  group·slot  node and
// one  slot·teacher  node per teacher of its (capacity 1 each), so groups
// paired with the same teacher never share that teacher in a slot, and it
// always gets one of its teachers.

export interface SchedSlot {
  d: string;
  t: string;
  teachers: number[];
}

export interface SchedAppointment {
  group_id: number;
  teacher_id: number;
  d: string;
  t: string;
  status: string;
}

export interface SchedRequest {
  group_id: number;
  want: number;
  status: string;
  created_at: string;
  slots: Array<{ d: string; t: string }>;
}

export interface SchedGroup {
  id: number;
  no: number;
  active: boolean;
  total: number;
  recent_teachers: number[];
  /** the teachers this group meets (at most two); empty or missing = anyone */
  teacher_ids?: number[];
}

export interface SchedInput {
  slots: SchedSlot[];
  appointments: SchedAppointment[];
  requests: SchedRequest[];
  groups: SchedGroup[];
  weekCap: number;
  dayCap: number;
  /** slots starting before this (local 'YYYY-MM-DD HH:MM') are skipped */
  notBefore?: string;
  /** groups per time slot, whatever the number of free teachers (one meeting room: 1) */
  perSlot?: number;
}

export interface Proposal {
  group_id: number;
  teacher_id: number;
  d: string;
  t: string;
}

const key = (d: string, t: string) => `${d} ${t}`;

class Flow {
  private cap = new Map<string, Map<string, number>>();
  private order = new Map<string, string[]>();

  add(u: string, v: string, c: number) {
    if (c <= 0) return;
    this.edge(u, v, c);
    this.edge(v, u, 0);
  }

  private edge(u: string, v: string, c: number) {
    let m = this.cap.get(u);
    if (!m) {
      m = new Map();
      this.cap.set(u, m);
      this.order.set(u, []);
    }
    if (!m.has(v)) this.order.get(u)!.push(v);
    m.set(v, (m.get(v) ?? 0) + c);
  }

  residual(u: string, v: string): number {
    return this.cap.get(u)?.get(v) ?? 0;
  }

  /** Overwrite the residual capacity of an existing edge. */
  setCap(u: string, v: string, c: number) {
    this.cap.get(u)!.set(v, Math.max(0, c));
  }

  /** Push one unit along an augmenting path that starts with `first`. */
  augment(source: string, first: string, sink: string): boolean {
    if (this.residual(source, first) < 1) return false;
    const seen = new Set<string>([source, first]);
    const path: string[] = [source, first];
    const dfs = (u: string): boolean => {
      if (u === sink) return true;
      for (const v of this.order.get(u) ?? []) {
        if (seen.has(v) || this.residual(u, v) < 1) continue;
        seen.add(v);
        path.push(v);
        if (dfs(v)) return true;
        path.pop();
      }
      return false;
    };
    if (!dfs(first)) return false;
    for (let i = 0; i < path.length - 1; i++) {
      const u = path[i];
      const v = path[i + 1];
      this.cap.get(u)!.set(v, this.residual(u, v) - 1);
      this.cap.get(v)!.set(u, this.residual(v, u) + 1);
    }
    return true;
  }
}

export function autoSchedule(input: SchedInput): Proposal[] {
  const live = input.appointments.filter((a) => a.status !== 'cancelled');
  const groups = new Map(input.groups.map((g) => [g.id, g]));

  // free teachers per slot, and how many more groups each slot can take
  const perSlot = input.perSlot ?? 1;
  const free = new Map<string, number[]>();
  const room = new Map<string, number>();
  for (const s of input.slots) {
    if (input.notBefore && key(s.d, s.t) < input.notBefore) continue;
    const here = live.filter((a) => a.d === s.d && a.t === s.t);
    const busy = new Set(here.map((a) => a.teacher_id));
    const ts = s.teachers.filter((t) => !busy.has(t));
    const left = Math.min(ts.length, perSlot - here.length);
    if (left > 0) {
      free.set(key(s.d, s.t), ts);
      room.set(key(s.d, s.t), left);
    }
  }

  // how contested each slot is, so quieter slots are tried first
  const demand = new Map<string, number>();
  for (const r of input.requests)
    if (r.status === 'open') for (const s of r.slots) demand.set(key(s.d, s.t), (demand.get(key(s.d, s.t)) ?? 0) + 1);

  interface Need {
    group: number;
    remaining: number;
    created: string;
    total: number;
    no: number;
    pairs: number[] | null;
  }
  const needs: Need[] = [];
  const f = new Flow();
  // where a group enters a slot: the slot itself, or (paired) its own node
  // that leads to the lanes of its teachers who are free then
  const entryOf = (k: string, group: number, pairs: number[] | null) => (pairs ? `gk:${group}:${k}` : `s:${k}`);
  const lanes = new Set<string>();
  const entry = (k: string, group: number, pairs: number[] | null) => {
    const node = entryOf(k, group, pairs);
    if (pairs) {
      for (const t of free.get(k)!.filter((x) => pairs.includes(x))) {
        const lane = `st:${k}:${t}`;
        if (!lanes.has(lane)) {
          lanes.add(lane);
          f.add(lane, `s:${k}`, 1);
        }
        f.add(node, lane, 1);
      }
    }
    return node;
  };

  for (const r of input.requests) {
    const g = groups.get(r.group_id);
    if (r.status !== 'open' || !g || !g.active) continue;
    const mine = live.filter((a) => a.group_id === r.group_id);
    const remaining = Math.min(r.want, input.weekCap) - mine.length;
    if (remaining <= 0) continue;
    const usedSlots = new Set(mine.map((a) => key(a.d, a.t)));
    const perDay = new Map<string, number>();
    for (const a of mine) perDay.set(a.d, (perDay.get(a.d) ?? 0) + 1);
    const pairs = g.teacher_ids?.length ? g.teacher_ids : null;

    const picks = r.slots
      .filter((s) => free.has(key(s.d, s.t)) && !usedSlots.has(key(s.d, s.t)) && (!pairs || free.get(key(s.d, s.t))!.some((t) => pairs.includes(t))))
      .sort((a, b) => (demand.get(key(a.d, a.t)) ?? 0) - (demand.get(key(b.d, b.t)) ?? 0) || key(a.d, a.t).localeCompare(key(b.d, b.t)));
    if (!picks.length) continue;

    const gNode = `g:${r.group_id}`;
    for (const s of picks) {
      const dayRoom = input.dayCap - (perDay.get(s.d) ?? 0);
      if (dayRoom <= 0) continue;
      const dayNode = `gd:${r.group_id}:${s.d}`;
      if (f.residual(gNode, dayNode) === 0) f.add(gNode, dayNode, dayRoom);
      f.add(dayNode, entry(key(s.d, s.t), r.group_id, pairs), 1);
    }
    needs.push({ group: r.group_id, remaining, created: r.created_at, total: g.total, no: g.no, pairs });
  }
  for (const [k] of free) f.add(`s:${k}`, 'T', room.get(k)!);

  needs.sort((a, b) => a.total - b.total || a.created.localeCompare(b.created) || a.no - b.no);

  // phase 1: one each
  for (const n of needs) {
    f.add('S', `g:${n.group}`, 1);
    f.augment('S', `g:${n.group}`, 'T');
  }
  // phase 2: top up, round-robin
  for (const n of needs) {
    const served = 1 - f.residual('S', `g:${n.group}`);
    f.setCap('S', `g:${n.group}`, n.remaining - served);
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of needs) if (f.augment('S', `g:${n.group}`, 'T')) progress = true;
  }

  // read back group → slot
  const bySlot = new Map<string, number[]>();
  for (const n of needs) {
    for (const [k] of free) {
      const d = k.slice(0, 10);
      const used = f.residual(entryOf(k, n.group, n.pairs), `gd:${n.group}:${d}`); // reverse edge = flow
      if (used >= 1) {
        const list = bySlot.get(k) ?? [];
        list.push(n.group);
        bySlot.set(k, list);
      }
    }
  }

  // teachers within each slot: groups with the fewest choices pick first,
  // each preferring a teacher it met before, then the least busy one; the
  // flow guarantees an assignment exists, a short search finds it
  const load = new Map<number, number>();
  for (const a of live) load.set(a.teacher_id, (load.get(a.teacher_id) ?? 0) + 1);
  const rank = new Map(needs.map((n, i) => [n.group, i]));
  const pairsOf = new Map(needs.map((n) => [n.group, n.pairs]));
  const out: Proposal[] = [];
  for (const [k, gs] of [...bySlot].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [d, t] = k.split(' ');
    const choices = new Map(
      gs.map((gid) => {
        const pairs = pairsOf.get(gid);
        const recent = groups.get(gid)?.recent_teachers ?? [];
        const pref = (x: number) => (recent.indexOf(x) < 0 ? 99 : recent.indexOf(x));
        const ok = free.get(k)!.filter((x) => !pairs || pairs.includes(x));
        return [gid, ok.sort((a, b) => pref(a) - pref(b) || (load.get(a) ?? 0) - (load.get(b) ?? 0) || a - b)];
      }),
    );
    const order = gs.slice().sort((a, b) => choices.get(a)!.length - choices.get(b)!.length || rank.get(a)! - rank.get(b)!);
    const taken = new Map<number, number>();
    const place = (i: number): boolean => {
      if (i === order.length) return true;
      for (const x of choices.get(order[i])!) {
        if ([...taken.values()].includes(x)) continue;
        taken.set(order[i], x);
        if (place(i + 1)) return true;
        taken.delete(order[i]);
      }
      return false;
    };
    place(0);
    for (const gid of order) {
      const teacher = taken.get(gid);
      if (teacher === undefined) continue;
      load.set(teacher, (load.get(teacher) ?? 0) + 1);
      out.push({ group_id: gid, teacher_id: teacher, d, t });
    }
  }
  return out.sort((a, b) => key(a.d, a.t).localeCompare(key(b.d, b.t)) || a.group_id - b.group_id);
}
