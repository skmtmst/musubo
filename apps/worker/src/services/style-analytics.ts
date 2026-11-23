import { withDisplayReadCache } from '@line-crm/db/src/display-read-cache.js';
import { restaurantCivilTime } from './restaurant-booking.js';
import { styleDashboardSidebar } from './style-dashboard-sidebar.js';
import { StyleError } from './style-setup.js';
import type { IndustryStyle, StyleSnapshot, StyleAnalyticsData } from '@line-crm/shared';

export * from './style-analytics-core.js';
export { styleRows } from './style-booking-rows.js';
export { personMetrics } from './style-person-metrics.js';
import {
  DAY,
  countMetric,
  instant,
  civilDate,
  addDate,
  eligible,
  cancelled,
  readWindow,
} from './style-analytics-core.js';
import { styleRows } from './style-booking-rows.js';
import { personMetrics } from './style-person-metrics.js';
import { lessonMetrics } from './style-lesson-metrics.js';
import { stylePeriodMetrics } from './style-period-metrics.js';
import { restaurantMetrics } from './style-restaurant-metrics.js';
import { staffMetrics } from './style-staff-metrics.js';
import { activityMetrics } from './style-activity-metrics.js';
export async function styleWindow(
  db: D1Database,
  account: string,
  query: Record<string, string | undefined>,
  now = Date.now(),
) {
  const setting = await db
    .prepare('SELECT timezone FROM booking_settings WHERE line_account_id=?')
    .bind(account)
    .first<{ timezone: string }>();
  const accountRow = await db
    .prepare('SELECT timezone FROM line_accounts WHERE id=?')
    .bind(account)
    .first<{ timezone: string }>();
  const timeZone = setting?.timezone ?? accountRow?.timezone ?? 'Asia/Tokyo';
  return {
    ...readWindow(query, timeZone, now),
    timeZone,
    asOf: new Date(now).toISOString(),
  };
}

export async function styleSnapshot(
  db: D1Database,
  account: string,
  style: IndustryStyle,
  query: Record<string, string | undefined>,
  staffId?: string,
  now = Date.now(),
  access: {
    kinds?: import('@line-crm/shared').StyleBooking['kind'][];
    ownMeetStaffId?: string;
  } = {},
): Promise<
  StyleSnapshot & {
    people: ReturnType<typeof personMetrics>['people'];
    analytics: StyleAnalyticsData;
  }
> {
  // 対象者の写しは毎回実データを読む。表示用の計算だけにキャッシュ DB を渡し、新しい結果の対象へ古い値を再利用しない。
  const liveDb = db;
  return withDisplayReadCache(db, async db => {
  if (
    query.compare &&
    !['previous', 'last_week', 'last_year'].includes(query.compare)
  )
    throw new StyleError('invalid_comparison');
  const window = await styleWindow(liveDb, account, query, now),
    timeZone = window.timeZone,
    from = instant(window.from),
    to = instant(window.to);
  const raw = await styleRows(liveDb, account, style, access.kinds);
  if (query.holidays && !['all', 'exclude', 'only'].includes(query.holidays))
    throw new StyleError('invalid_holiday_filter');
  const holidays = (
    await liveDb
      .prepare('SELECT date,name FROM style_holidays WHERE line_account_id=?')
      .bind(account)
      .all<{ date: string; name: string }>()
  ).results;
  const rows = raw.filter(
    (r) =>
      (!staffId || r.staffId === staffId) &&
      (r.kind !== 'meet' ||
        !access.ownMeetStaffId ||
        r.staffId === access.ownMeetStaffId) &&
      (!query.store_id || r.storeId === query.store_id) &&
      (!query.menu_id || r.menuId === query.menu_id) &&
      (!query.holidays ||
        query.holidays === 'all' ||
        (query.holidays === 'only') ===
          holidays.some(
            (h) => h.date === civilDate(instant(r.startsAt), timeZone),
          )),
  );
  const config = await liveDb
    .prepare(
      'SELECT settings_json,answers_json FROM account_styles WHERE line_account_id=?',
    )
    .bind(account)
    .first<{ settings_json: string; answers_json: string }>();
  const settings: Record<string, number> = JSON.parse(
    config?.settings_json ?? '{}',
  );
  const {
    period,
    metricsFor,
    metrics,
    previous,
    previousFrom,
    previousTo,
    past,
    weekFrom,
    weekTo,
  } = stylePeriodMetrics(
    rows,
    style,
    from,
    to,
    query,
    now,
    settings,
    timeZone,
    config,
  );
  const daily = (start: number, end: number) => {
    const result = [];
    for (
      let date = civilDate(start, timeZone);
      date <= civilDate(end - 1, timeZone);
      date = addDate(date, 1)
    ) {
      const fromDay = instant(restaurantCivilTime(date, 0, timeZone)),
        toDay = instant(restaurantCivilTime(addDate(date, 1), 0, timeZone));
      result.push({
        date,
        metrics: metricsFor(Math.max(start, fromDay), Math.min(end, toDay)),
      });
    }
    return result;
  };
  metrics.newBookings = countMetric(
    rows.filter(
      (r) => !cancelled(r) && instant(r.requestedAt) >= from && instant(r.requestedAt) < to,
    ).length,
    '予約が入った日が期間内の予約',
  );
  const analytics: StyleAnalyticsData = {
    dailyComparison: {
      current: daily(from, to),
      previous: daily(previousFrom, previousTo),
    },
    periodMetrics: metricsFor(from, to),
  };
  const context = {
    db,
    account,
    query,
    now,
    window,
    from,
    to,
    timeZone,
    rows,
    raw,
    style,
    staffId,
    settings,
    metrics,
    analytics,
    period,
  };
  await restaurantMetrics(context);
  await staffMetrics(context);
  const selected = await activityMetrics(context);
  if (style === 'lesson')
    await lessonMetrics(
      liveDb,
      account,
      rows,
      from,
      to,
      weekFrom,
      weekTo,
      now,
      metrics,
      analytics,
      staffId,
      settings,
    );
  analytics.sidebar = await styleDashboardSidebar(
    db,
    account,
    style,
    rows,
    timeZone,
    now,
    settings,
    staffId,
    query.store_id,
  );
  analytics.resultPending = past.filter(
    (r) => r.status !== 'no_show' && (!r.visited || !r.outcome),
  );
  const people = personMetrics(rows, from, to, now, settings).people;
  const selection = query.selection ?? 'bookings';
  if (
    ![
      'bookings',
      'visits',
      'no_show',
      'recall',
      'result_pending',
      'inactive_members',
    ].includes(selection)
  )
    throw new StyleError('invalid_selection');
  const selectionRows =
    selection === 'visits'
      ? selected.filter((r) => r.visited && eligible(r))
      : selection === 'no_show'
        ? selected.filter((r) => r.status === 'no_show' && eligible(r))
        : selection === 'recall'
          ? rows.filter((r) =>
              people.some((p) => p.personKey === r.personKey && p.recall),
            )
          : selection === 'result_pending'
            ? past.filter(
                (r) => r.status !== 'no_show' && (!r.visited || !r.outcome),
              )
            : selected.filter(
                (r) =>
                  eligible(r) &&
                  r.status !== 'no_show' &&
                  (style === 'restaurant' ||
                    style === 'lesson' ||
                    r.status !== 'requested'),
              );
  const selectedPeople =
    selection === 'inactive_members'
      ? (
          (analytics.members as Array<{
            id: string;
            lastAttendance: string | null;
            assigned_at: string;
            nextBooking: string | null;
          }>) ?? []
        )
          .filter(
            (p) =>
              !p.nextBooking &&
              now - instant(p.lastAttendance ?? p.assigned_at) >=
                (settings.inactiveDays ?? 14) * DAY,
          )
          .map((p) => ({
            id: p.id,
            kind: 'event',
            friendId: p.id,
            personKey: p.id,
          }))
      : selectionRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          friendId: r.friendId,
          personKey: r.personKey,
        }));
  const minimumSample = settings.minimumSample ?? 1;
  const suppress = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    if (
      typeof record.denominator === 'number' &&
      record.status === 'available' &&
      record.denominator < minimumSample
    ) {
      record.value = null;
      record.status = 'insufficient_sample';
    } else for (const value of Object.values(record)) suppress(value);
  };
  suppress(metrics);
  suppress(previous);
  suppress(analytics);
  analytics.holidays = holidays;
  analytics.targets = (
    await db
      .prepare(
        'SELECT metric,period,value FROM style_targets WHERE line_account_id=?',
      )
      .bind(account)
      .all()
  ).results;
  await db
    .prepare(
      `DELETE FROM style_analytics_results WHERE id IN(SELECT r.id FROM style_analytics_results r WHERE r.expires_at<=? AND NOT EXISTS(SELECT 1 FROM analytics_result_audiences a WHERE a.source_result_id=r.id AND a.expires_at>?) LIMIT 100)`,
    )
    .bind(new Date(now).toISOString(), new Date(now).toISOString())
    .run();
  const resultId = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO style_analytics_results(id,line_account_id,style,selection_json,created_at,expires_at) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      resultId,
      account,
      style,
      JSON.stringify({
        ids: selectedPeople,
        selection,
        staffId: staffId ?? null,
      }),
      new Date(now).toISOString(),
      new Date(now + DAY).toISOString(),
    )
    .run();
  let newBookings = rows.filter(
    (r) => !cancelled(r) && instant(r.requestedAt) >= from && instant(r.requestedAt) < to,
  );
  let unconfirmedNewBookingsCount: number | undefined;
  if (style === 'restaurant') {
    const stores = (await liveDb.prepare('SELECT id,timezone FROM rt_stores WHERE line_account_id=?')
      .bind(account).all<{id:string;timezone:string}>()).results;
    const timeZones = new Map(stores.map(store=>[store.id,store.timezone]));
    // 新着欄は担当者やメニューの絞り込みに左右されない店舗共有の一覧。
    newBookings = raw.filter(r=>{
      const zone = r.storeId ? timeZones.get(r.storeId) : undefined;
      const received = instant(r.requestedAt);
      return r.kind === 'restaurant' && (!query.store_id || r.storeId === query.store_id) && !!zone && !cancelled(r) && Number.isFinite(received)
        && civilDate(received,zone) === civilDate(now,zone);
    });
    const confirmed = newBookings.length ? (await liveDb.prepare(`SELECT a.store_id,a.booking_id FROM restaurant_booking_acknowledgements a
      JOIN rt_reservations r ON r.id=a.booking_id AND r.store_id=a.store_id
      WHERE a.line_account_id=? AND a.booking_kind='restaurant'
      AND julianday(r.created_at)>=julianday(?,'-2 days') AND julianday(r.created_at)<julianday(?,'+2 days')`)
      .bind(account,new Date(now).toISOString(),new Date(now).toISOString())
      .all<{store_id:string;booking_id:string}>()).results : [];
    const keys = new Set(confirmed.map(r=>JSON.stringify([r.store_id,r.booking_id])));
    newBookings = newBookings.filter(r=>r.kind!=='restaurant' || !keys.has(JSON.stringify([r.storeId,r.id])));
    unconfirmedNewBookingsCount = newBookings.length;
    newBookings = newBookings.slice(0,1000);
  }
  return {
    style,
    asOf: new Date(now).toISOString(),
    timeZone,
    from: window.from,
    to: window.to,
    sidebar:
      analytics.sidebar as import('@line-crm/shared').StyleDashboardSidebar,
    dateBasis: 'visit',
    range: window.range,
    metrics,
    previous,
    items: selected,
    newBookings,
    ...(unconfirmedNewBookingsCount === undefined ? {} : {unconfirmedNewBookingsCount}),
    resultId,
    people: personMetrics(rows, from, to, now, settings).people,
    analytics,
  };
  });
}
