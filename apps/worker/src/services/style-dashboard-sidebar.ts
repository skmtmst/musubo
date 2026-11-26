import type { IndustryStyle, StyleBooking } from '@line-crm/shared';
import { eligible, instant, civilDate } from './style-analytics-core.js';
import { personMetrics } from './style-person-metrics.js';

/** スタッフ・店舗・メニューの権限で絞り済みの、アカウント内の行だけを使う。 */
export async function styleDashboardSidebar(
  db: D1Database,
  account: string,
  style: IndustryStyle,
  rows: StyleBooking[],
  timeZone: string,
  now: number,
  settings: Record<string, number>,
  staffId?: string,
  storeId?: string,
) {
  const today = civilDate(now, timeZone);
  const todayRows = rows.filter(
    (r) =>
      eligible(r) &&
      r.status !== 'no_show' &&
      civilDate(instant(r.startsAt), timeZone) === today,
  );
  const attention = [];
  if (style === 'restaurant') {
    const bookings = todayRows.filter((r) => r.kind === 'restaurant');
    const allergyByReservation = new Map<string, string | null>();
    const fieldsByFriend = new Map<string, Array<{ fixed_key: string; value: string | null }>>();
    // D1 の束縛数の上限を守りつつ、対象を権限で絞り込んだ行に限定する。
    const batches = <T,>(values: T[]) => {
      const chunks: T[][] = [];
      for (let i = 0; i < values.length; i += 80) chunks.push(values.slice(i, i + 80));
      return chunks;
    };
    for (const ids of batches([...new Set(bookings.map((r) => r.id))])) {
      const details = await db.prepare(
        `SELECT id,allergy_note allergy FROM rt_reservations WHERE store_id IN(SELECT id FROM rt_stores WHERE line_account_id=?) AND id IN(${ids.map(() => '?').join(',')})`,
      ).bind(account, ...ids).all<{ id: string; allergy: string | null }>();
      for (const detail of details.results) allergyByReservation.set(detail.id, detail.allergy);
    }
    for (const ids of batches([...new Set(bookings.flatMap((r) => r.friendId ? [r.friendId] : []))])) {
      const fields = await db.prepare(
        `SELECT v.friend_id,k.fixed_key,COALESCE(v.value,v.value_text,v.value_date) value FROM friend_field_values v JOIN friend_fixed_fields k ON k.field_id=v.field_id JOIN friends f ON f.id=v.friend_id WHERE f.line_account_id=? AND f.id IN(${ids.map(() => '?').join(',')}) AND k.fixed_key IN('allergy','anniversary')`,
      ).bind(account, ...ids).all<{ friend_id: string; fixed_key: string; value: string | null }>();
      for (const field of fields.results) {
        const group = fieldsByFriend.get(field.friend_id) ?? [];
        group.push(field);
        fieldsByFriend.set(field.friend_id, group);
      }
    }
    const firstNoShow = new Map<string, number>();
    for (const row of rows) {
      if (row.status !== 'no_show') continue;
      const at = instant(row.startsAt);
      if (Number.isNaN(at)) continue;
      firstNoShow.set(row.personKey, Math.min(firstNoShow.get(row.personKey) ?? Infinity, at));
    }
    for (const r of bookings) {
      const fields = r.friendId ? fieldsByFriend.get(r.friendId) ?? [] : [];
      const allergy =
        allergyByReservation.get(r.id) ||
        fields.find((f) => f.fixed_key === 'allergy')?.value ||
        null;
      const anniversary = fields.find(
        (f) => f.fixed_key === 'anniversary',
      )?.value;
      const noShowAt = firstNoShow.get(r.personKey);
      const noShowHistory = noShowAt !== undefined && noShowAt < instant(r.startsAt);
      const isAnniversary =
        !!anniversary && anniversary.slice(5, 10) === today.slice(5);
      if (allergy || isAnniversary || noShowHistory)
        attention.push({
          id: r.id,
          name: r.name,
          friendId: r.friendId,
          startsAt: r.startsAt,
          allergy,
          anniversary: isAnniversary,
          noShowHistory,
        });
    }
  }
  // 待機者は担当未定なので、担当者で絞る場合は除き、他の担当の情報を漏らさない。
  const waitlist =
    style === 'restaurant' && !staffId
      ? (
          await db
            .prepare(
              `SELECT w.id,w.customer_name name,w.starts_at startsAt,w.guest_count partySize,w.status,w.store_id storeId FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE s.line_account_id=? AND (? IS NULL OR s.id=?) AND w.status IN('waiting','invited') ORDER BY w.starts_at,w.created_at,w.id`,
            )
            .bind(account, storeId ?? null, storeId ?? null)
            .all<{
              id: string;
              name: string;
              startsAt: string;
              partySize: number;
              status: string;
              storeId: string;
            }>()
        ).results.filter(
          (w) => civilDate(instant(w.startsAt), timeZone) === today,
        )
      : [];
  const noNextBooking =
    style === 'salon'
      ? personMetrics(
          rows,
          now - 30 * 86400000,
          now,
          now,
          settings,
        ).people.filter((p) => !p.nextBooking)
      : [];
  return { today, attention, waitlist, noNextBooking };
}
