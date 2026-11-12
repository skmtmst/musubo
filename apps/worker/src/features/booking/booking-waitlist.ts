import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import { restaurantTestEnabled } from '../../lib/environment-features.js';
import { getAvailability, getAccountTimeZone, getStoreCapacitySnapshot, tzDateStr } from '../../services/availability.js';
import { sendAutomaticBookingLine } from './booking-automatic-line.js';
import { formatSlotHeadline, waitlistBookUrl, waitlistDeclineUrl } from './booking-waitlist-card.js';


export const DEFAULT_WAITLIST_HOLD_MINUTES = 30;
export function waitlistHoldMinutes(startsAt: string, now = new Date()): number {
  return Date.parse(startsAt) - now.getTime() < 2 * 60 * 60_000 ? 10 : 30;
}
/** 旧設定口との互換。承認済みの待ち仕様では30分に固定。 */
export async function readWaitlistHoldMinutes(_db: D1Database, _accountId: string): Promise<number> { return 30; }
export interface WaitlistSlot { lineAccountId: string; staffId: string; startsAt: string; }
export interface WaitlistEntry {
  id: string; line_account_id: string; staff_id: string; menu_id: string; starts_at: string; ends_at: string | null; block_ends_at: string | null;
  friend_id: string | null; booking_customer_id: string | null; identity_key: string; status: string; hold_minutes: number;
  invited_at: string | null; hold_expires_at: string | null; notified_at: string | null; created_at: string; notification_retry_key: string | null;
}
export type PromoteResult = { promoted: true; entry: WaitlistEntry ;} | { promoted: false; reason: 'empty' | 'hold_active' | 'race' | 'unavailable' ;};

/** 締切・期限切れは列へ戻さず終わりにする。受付を閉じても案内中の期限は守る。 */
export async function finishExpiredWaitlists(db: D1Database, accountId?: string, now = new Date()): Promise<void> {
  const iso = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE booking_waitlist SET status='finished',finish_reason=CASE WHEN status='invited' THEN 'offer_expired' ELSE 'registration_closed' END,updated_at=? WHERE status IN ('waiting','invited') AND ((status='waiting' AND julianday(starts_at)<=julianday(?,'+1 hour')) OR (status='invited' AND (julianday(hold_expires_at)<=julianday(?) OR julianday(starts_at)<=julianday(?)))) AND (? IS NULL OR line_account_id=?)`).bind(iso, iso, iso, iso, accountId ?? null, accountId ?? null),
    db.prepare(`UPDATE rt_seat_waitlist SET confirmation_revision=confirmation_revision+1, status='finished',finish_reason=CASE WHEN status='invited' THEN 'offer_expired' ELSE 'registration_closed' END,updated_at=? WHERE status IN ('waiting','invited') AND ((status='waiting' AND julianday(starts_at)<=julianday(?,'+1 hour')) OR (status='invited' AND (julianday(hold_expires_at)<=julianday(?) OR julianday(starts_at)<=julianday(?)))) AND (? IS NULL OR store_id IN (SELECT id FROM rt_stores WHERE line_account_id=?))`).bind(iso, iso, iso, iso, accountId ?? null, accountId ?? null),
  ]);
}
export async function promoteBookingWaitlist(db: D1Database, slot: WaitlistSlot, _sender?: unknown, liffBaseUrl = '', env?: Env['Bindings']): Promise<PromoteResult> {
  await finishExpiredWaitlists(db, slot.lineAccountId);
  const next = await db.prepare(`SELECT * FROM booking_waitlist WHERE line_account_id=? AND staff_id=? AND julianday(starts_at)=julianday(?) AND status='waiting' ORDER BY created_at,rowid LIMIT 1`).bind(slot.lineAccountId, slot.staffId, slot.startsAt).first<WaitlistEntry>();
  if (!next) return { promoted: false, reason: 'empty' };
  const tz = await getAccountTimeZone(db, slot.lineAccountId), date = tzDateStr(tz, new Date(next.starts_at));
  const available = await getAvailability(db, { lineAccountId: slot.lineAccountId, menuId: next.menu_id, staffId: slot.staffId, from: date, to: date, now: new Date(), minLeadTimeMinutes: 0, applyStoreRules: true, waitlistOffer: true, googleCredentials: env ? { email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY } : undefined });
  const start = Date.parse(next.starts_at);
  const found = available.by_staff.find(s => s.staff_id === slot.staffId)?.slots.some(s => Date.parse(s.startUtc) === start && s.remaining > 0);
  // 空き枠の開始instantと照合し、夏時間や店舗タイムゾーンの違いでずらさない。
  if (!found) return { promoted: false, reason: 'unavailable' };
  const menu = await db.prepare(`SELECT COALESCE(sm.override_duration_minutes,m.duration_minutes) duration,m.buffer_after_minutes FROM menus m JOIN staff_menus sm ON sm.menu_id=m.id AND sm.staff_id=? AND sm.is_offered=1 WHERE m.id=? AND m.line_account_id=? AND m.is_active=1 AND m.deleted_at IS NULL`).bind(slot.staffId, next.menu_id, slot.lineAccountId).first<{ duration: number; buffer_after_minutes: number ;}>();
  if (!menu) return { promoted: false, reason: 'unavailable' };
  const now = new Date(), endsAt = new Date(start + menu.duration * 60_000).toISOString(), blockEndsAt = new Date(Date.parse(endsAt) + menu.buffer_after_minutes * 60_000).toISOString();
  const capacity = await getStoreCapacitySnapshot(db, slot.lineAccountId, new Date(start), new Date(blockEndsAt));
  const holdMinutes = waitlistHoldMinutes(next.starts_at, now), expires = new Date(Math.min(start, now.getTime() + holdMinutes * 60_000)).toISOString();
  const result = await db.prepare(`UPDATE booking_waitlist SET status='invited',hold_minutes=?,invited_at=?,hold_expires_at=?,ends_at=?,block_ends_at=?,capacity_windows_json=?,notification_retry_key=?,updated_at=? WHERE id=? AND status='waiting'`).bind(holdMinutes, now.toISOString(), expires, endsAt, blockEndsAt, JSON.stringify(capacity.windows), crypto.randomUUID(), now.toISOString(), next.id).run();
  if (!result.meta.changes) return { promoted: false, reason: 'race' };
  const entry = (await db.prepare('SELECT * FROM booking_waitlist WHERE id=?').bind(next.id).first<WaitlistEntry>())!;
  if (env) await dispatchWaitlistInvites(env, slot.lineAccountId, liffBaseUrl);
  return { promoted: true, entry };
}
/** 通知のリースとLINEの再送キーで、並行実行・応答を失った再試行も1通にする。 */
export async function dispatchWaitlistInvites(env: Env['Bindings'], accountId?: string, liffBaseUrl = env.LIFF_URL ?? ''): Promise<void> {
  const db = env.DB, now = new Date().toISOString();
  const people = await db.prepare(`SELECT w.id,w.line_account_id account_id,f.line_user_id,w.starts_at,w.hold_expires_at,w.notification_retry_key,m.name detail,la.timezone FROM booking_waitlist w JOIN friends f ON f.id=w.friend_id AND f.line_account_id=w.line_account_id JOIN menus m ON m.id=w.menu_id JOIN line_accounts la ON la.id=w.line_account_id WHERE w.status='invited' AND w.notified_at IS NULL AND f.is_following=1 AND julianday(w.hold_expires_at)>julianday(?) AND (w.notification_claim_until IS NULL OR julianday(w.notification_claim_until)<=julianday(?)) AND (? IS NULL OR w.line_account_id=?) LIMIT 100`).bind(now, now, accountId ?? null, accountId ?? null).all<InviteRow>();
  const seats = restaurantTestEnabled(env) ? await db.prepare(`SELECT w.id,s.line_account_id account_id,w.line_uid line_user_id,w.starts_at,w.hold_expires_at,w.notification_retry_key,s.name detail,s.timezone FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id JOIN friends f ON f.line_account_id=s.line_account_id AND f.line_user_id=w.line_uid AND f.is_following=1 WHERE w.status='invited' AND w.notified_at IS NULL AND julianday(w.hold_expires_at)>julianday(?) AND (w.notification_claim_until IS NULL OR julianday(w.notification_claim_until)<=julianday(?)) AND (? IS NULL OR s.line_account_id=?) LIMIT 100`).bind(now, now, accountId ?? null, accountId ?? null).all<InviteRow>() : { results: [] as InviteRow[] };
  for (const [table, rows, featureId] of [['booking_waitlist', people.results, 'booking'], ['rt_seat_waitlist', seats.results, 'restaurant_test']] as const) {
    for (const row of rows) {
      if(table==='rt_seat_waitlist') {
        const managed=await db.prepare(`SELECT w.store_id FROM rt_seat_waitlist w JOIN rt_reservation_events e ON json_extract(e.payload_json,'$.waitlistId')=w.id JOIN rt_reservation_event_receipts r ON r.event_id=e.id AND r.consumer_key='followup' WHERE w.id=? AND (EXISTS(SELECT 1 FROM rt_store_followup_templates WHERE store_id=w.store_id) OR EXISTS(SELECT 1 FROM rt_store_followup_rows WHERE store_id=w.store_id))`).bind(row.id).first<{store_id:string}>();
        if(managed){const {processRestaurantEvents}=await import('../../services/restaurant-events.js');const {processScenarioSourceJobs}=await import('../scenarios/scenario-source-jobs/index.js');await processRestaurantEvents(env,managed.store_id);await processScenarioSourceJobs(env);continue;}
      }

      const claim = await db.prepare(`UPDATE ${table} SET notification_claim_until=? WHERE id=? AND status='invited' AND julianday(hold_expires_at)>julianday('now') AND notified_at IS NULL AND (notification_claim_until IS NULL OR julianday(notification_claim_until)<=julianday(?))`).bind(new Date(Date.now() + 60_000).toISOString(), row.id, now).run();
      if (!claim.meta.changes) continue;
      try {
        const book = table === 'booking_waitlist' ? waitlistBookUrl(liffBaseUrl, row.id) : `${liffBaseUrl.replace(/\/$/, '')}/booking?seat_waitlist=${encodeURIComponent(row.id)}`;
        const decline = table === 'booking_waitlist' ? waitlistDeclineUrl(liffBaseUrl, row.id) : `${book}&action=decline`;
        const sent = await sendAutomaticBookingLine(env, { accountId: row.account_id, to: row.line_user_id, text: `${formatSlotHeadline(row.starts_at, row.timezone ?? 'Asia/Tokyo')} に空きが出ました。\n${row.detail}\n${new Date(row.hold_expires_at).toLocaleTimeString('ja-JP', { timeZone: row.timezone ?? 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}まで仮押さえしています。\nこの時間で予約する：${book}\n今回は見送る：${decline}`, retryKey: row.notification_retry_key, featureId });
        if (sent) await db.prepare(`UPDATE ${table} SET notified_at=? WHERE id=? AND status='invited'`).bind(now, row.id).run();
      } catch { logger.error("waitlist_invite_send_failed"); }
    }
  }
}
interface InviteRow { id: string; account_id: string; line_user_id: string; starts_at: string; hold_expires_at: string; notification_retry_key: string; detail: string; timezone: string | null; }
