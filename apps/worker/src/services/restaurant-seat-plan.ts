import type { RestaurantSeatAvailability } from '@line-crm/shared';

export interface SeatPlanTable { id: string; label: string; seatType: string; minCapacity: number; maxCapacity: number; joinGroup: string | null; active: number }
export interface SeatPlanBooking { id: string; startsAt: string; endsAt: string; guestCount: number; tableIds: string[] }
export interface SeatPlanClosure { tableIds: string[]; periods: { startsAt: string; endsAt: string }[] }
export interface SeatPlanState { tables: SeatPlanTable[]; reservations: SeatPlanBooking[]; waiting: SeatPlanBooking[]; closures: SeatPlanClosure[]; policy: string | null }
export interface SeatPlanInput { startsAt: string; endsAt: string; guestCount: number; tableId?: string | null }
type Candidate = RestaurantSeatAvailability['tables'][number];
const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) => Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(a.endsAt) > Date.parse(b.startsAt);

/** 未配席の組も仮の配置で検査する。保存する卓は決めず、店全体の受入可能性だけを調べる。 */
export function planRestaurantSeats(state: SeatPlanState, input: SeatPlanInput): Candidate | null {
  const active = state.tables.filter(t => t.active === 1);
  const fixed = [...state.reservations, ...state.waiting].filter(r => r.tableIds.length);
  const incoming = '$incoming';
  const jobs = [...[...state.reservations, ...state.waiting].filter(r => !r.tableIds.length), { ...input, id: incoming, tableIds: [] }];
  if (jobs.length > 128) return null;
  const choices = (job: SeatPlanBooking): Candidate[] => {
    const free = active.filter(t => !fixed.some(r => r.tableIds.includes(t.id) && overlaps(r, job))
      && !state.closures.some(c => (!c.tableIds.length || c.tableIds.includes(t.id)) && c.periods.some(p => overlaps(p, job))));
    const candidates: Candidate[] = free.filter(t => t.minCapacity <= job.guestCount && job.guestCount <= t.maxCapacity);
    for (const group of new Set(free.map(t => t.joinGroup).filter(Boolean))) {
      const members = free.filter(t => t.joinGroup === group);
      if (members.length < 2 || state.tables.filter(t => t.joinGroup === group).some(t => !members.some(m => m.id === t.id))) continue;
      const minCapacity = members.reduce((n, t) => n + t.minCapacity, 0), maxCapacity = members.reduce((n, t) => n + t.maxCapacity, 0);
      if (minCapacity <= job.guestCount && job.guestCount <= maxCapacity && members.every(t => t.maxCapacity < job.guestCount)) candidates.push({ ...members[0], tableIds: members.map(t => t.id), minCapacity, maxCapacity });
    }
    return candidates.filter(t => job.id !== incoming || !input.tableId || (t.tableIds ?? [t.id]).includes(input.tableId))
      .sort((a, b) => a.maxCapacity - b.maxCapacity || a.id.localeCompare(b.id));
  };
  const ranked = jobs.map(job => ({ job, choices: choices(job) })).sort((a, b) => a.choices.length - b.choices.length || b.job.guestCount - a.job.guestCount || a.job.id.localeCompare(b.job.id));
  const placed: { job: SeatPlanBooking; candidate: Candidate }[] = [];
  let attempts = 0, selected: Candidate | null = null;
  const visit = (index: number): boolean => {
    if (index === ranked.length) { selected = placed.find(p => p.job.id === incoming)!.candidate; return true; }
    if (++attempts > 10000) return false;
    const { job, choices: candidates } = ranked[index];
    for (const candidate of candidates) {
      const ids = candidate.tableIds ?? [candidate.id];
      if (placed.some(p => overlaps(p.job, job) && (p.candidate.tableIds ?? [p.candidate.id]).some(id => ids.includes(id)))) continue;
      placed.push({ job, candidate });
      if (visit(index + 1)) return true;
      placed.pop();
    }
    return false;
  };
  return visit(0) ? selected : null;
}
