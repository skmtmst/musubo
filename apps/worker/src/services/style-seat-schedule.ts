import { addDays, type StyleSchedule, type StyleSnapshot, type RestaurantOpeningDay } from '@line-crm/shared';

import { civilDate, instant } from './style-analytics.js';
import { StyleError } from './style-setup.js';

import { closuresForRange, openSeatTablePeriods, type ClosurePeriod } from './restaurant-closures.js';
import { restaurantCivilTime } from './restaurant-booking.js';
import { connectedGoogleProfile, googleOpeningDay } from './restaurant-google-hours-source.js';

export async function seatSchedule(db:D1Database,account:string,query:Record<string,string|undefined>,style:StyleSnapshot['style'],from:string,to:string,asOf:string,timeZone:string,days:StyleSchedule['days'],closures:StyleSchedule['closures'],availability:StyleSchedule['availability']) {
  if (style === 'restaurant') {
    const duration = Number(query.duration_minutes ?? 120),
      guests = Number(query.guest_count ?? 1);
    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 1440 ||
      !Number.isInteger(guests) ||
      guests < 1 ||
      guests > 100
    )
      throw new StyleError('invalid_slot');
    const stores = (
      await db
        .prepare(
          'SELECT id,timezone FROM rt_stores WHERE line_account_id=? AND (? IS NULL OR id=?) ORDER BY id',
        )
        .bind(account, query.store_id ?? null, query.store_id ?? null)
        .all<{ id: string; timezone: string }>()
    ).results;
    if (!stores.length) {
      availability.status = 'unconfigured';
      availability.reason = 'store_required';
    }
    const closedByStore: string[][] = [];
    for (const store of stores) {
      const setting = await db
        .prepare(
          'SELECT hours_json FROM rt_opening_hours_settings WHERE store_id=?',
        )
        .bind(store.id)
        .first<{ hours_json: string }>();
      const googleConnection = await db.prepare('SELECT status FROM rt_google_connections WHERE store_id=?')
        .bind(store.id).first<{ status: string }>();
      const googleProfile = googleConnection ? await connectedGoogleProfile(db, store.id) : null;
      const hasHours = googleConnection ? Boolean(googleProfile) : Boolean(setting);
      if (!hasHours) {
        availability.status = 'unconfigured';
        availability.reason = 'business_hours_required';
      }
      const hours: RestaurantOpeningDay[] = setting && !googleConnection
        ? JSON.parse(setting.hours_json)
        : [];
      const closed = await closuresForRange(db, store.id, from, to);
      for (const c of closed)
        closures.push({
          id: c.id,
          target: JSON.parse(c.table_ids_json).length ? 'table' : 'store',
          targetIds: JSON.parse(c.table_ids_json).length
            ? JSON.parse(c.table_ids_json)
            : [store.id],
          dateFrom: c.start_date,
          dateTo: c.end_date,
          kind: c.kind,
          hours: c.all_day ? [] : [{ start: c.start_time!, end: c.end_time! }],
          reason: c.memo,
        });
      const closedDates: string[] = [];
      const candidates: ClosurePeriod[] = [];
      for (const day of days) {
        const previousDate = addDays(day.date, -1);
        const openingDays = [previousDate, day.date].map(openDate => ({
          openDate,
          periods: googleProfile ? googleOpeningDay(googleProfile, openDate) ?? []
            : hours.find(h => h.weekday === new Date(`${openDate}T00:00:00Z`).getUTCDay())?.periods ?? [],
        }));
        const minute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
        const hasDayHours = openingDays.some(({ openDate, periods }) => periods.some(period => {
          const opens = minute(period.opensAt);
          const closes = minute(period.closesAt) + (minute(period.closesAt) < opens ? 1440 : 0);
          return openDate === day.date || closes > 1440;
        }));
        if (
          hasHours &&
          (!hasDayHours ||
            closed.some(
              (c) =>
                c.all_day &&
                !JSON.parse(c.table_ids_json).length &&
                c.start_date <= day.date &&
                c.end_date >= day.date,
            ))
        )
          closedDates.push(day.date);
        // 営業時間だけで空きと扱わず、表示する各候補を既存の席数検査へ通す。
        const seen = new Set<number>();
        for (const { openDate, periods } of openingDays) for (const period of periods) {
          const opens = minute(period.opensAt);
          const closes = minute(period.closesAt) + (minute(period.closesAt) < opens ? 1440 : 0);
          for (
            let start = opens;
            start + duration <= closes;
            start += 30
          ) {
            const startsAt = restaurantCivilTime(
                openDate,
                start,
                store.timezone,
              ),
              endsAt = restaurantCivilTime(
                openDate,
                start + duration,
                store.timezone,
              );
            if (civilDate(instant(startsAt), store.timezone) !== day.date) continue;
            if (seen.has(instant(startsAt))) continue;
            seen.add(instant(startsAt));
            if (instant(startsAt) < instant(asOf)) continue;
            candidates.push({ startsAt, endsAt });
          }
        }
      }
      for (const period of await openSeatTablePeriods(
        db,
        store.id,
        candidates,
        guests,
      ))
        for (const table of period.tables)
          availability.slots.push({
            columnId: table.id,
            resourceIds: table.tableIds ?? [table.id],
            menuId: null,
            date: civilDate(instant(period.startsAt), timeZone),
            startsAt: period.startsAt,
            endsAt: period.endsAt,
            remaining: table.maxCapacity,
          });
      closedByStore.push(closedDates);
    }
    availability.closedDates = days
      .filter(
        (day) =>
          closedByStore.length &&
          closedByStore.every((dates) => dates.includes(day.date)),
      )
      .map((d) => d.date);
  }
}
