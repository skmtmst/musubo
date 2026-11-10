import { reservationInstant } from '@line-crm/shared';
import { getBookingAdminSettings } from '@line-crm/db';
export type RestaurantConfirmationResponse = 'going' | 'change_requested' | 'cancel';
export type ConfirmationResult = {
    ok: true;
    response: RestaurantConfirmationResponse;
    version: number;
} | {
    ok: false;
    error: string;
    status: 403 | 404 | 409;
};
/** 本人と予約版を固定する。行きますは仮押さえの確定ではなく来店の返事。 */
export async function respondToRestaurantConfirmation(db: D1Database, input: {
    requestId: string;
    friendId: string;
    accountId: string;
    expectedVersion: number;
    response: RestaurantConfirmationResponse;
}, now = new Date()): Promise<ConfirmationResult> {
    const row = await db.prepare(`SELECT c.*,r.customer_version,r.status,r.starts_at,r.store_id,r.line_uid,
  s.name store_name FROM rt_reservation_confirmations c JOIN rt_reservations r ON r.id=c.reservation_id
  JOIN rt_stores s ON s.id=r.store_id JOIN friends f ON f.id=c.friend_id
  WHERE c.request_id=? AND c.friend_id=? AND s.line_account_id=? AND f.line_account_id=s.line_account_id
  AND f.line_user_id=r.line_uid AND f.is_following=1 AND s.status='active'`)
        .bind(input.requestId, input.friendId, input.accountId).first<{
        reservation_id: string;
        reservation_version: number;
        response: RestaurantConfirmationResponse | null;
        responded_at: string | null;
        expires_at: string;
        customer_version: number;
        status: string;
        starts_at: string;
        store_id: string;
        line_uid: string;
        store_name: string;
    }>();
    if (!row)
        return { ok: false, error: 'not_found', status: 404 };
    if (row.reservation_version !== input.expectedVersion)
        return { ok: false, error: 'version_conflict', status: 409 };
    if (row.response) {
        if (row.response === input.response && row.customer_version === input.expectedVersion + (row.response === 'cancel' ? 1 : 0))
            return { ok: true, response: row.response, version: row.customer_version };
        return { ok: false, error: 'response_conflict', status: 409 };
    }
    if (row.customer_version !== input.expectedVersion)
        return { ok: false, error: 'version_conflict', status: 409 };
    if (instantMs(row.expires_at) <= now.getTime() || row.status !== 'confirmed')
        return { ok: false, error: 'confirmation_expired', status: 409 };
    if (input.response === 'cancel') {
        const settings = await getBookingAdminSettings(db, input.accountId);
        if (!settings)
            return { ok: false, error: 'not_found', status: 404 };
        if (now.getTime() >= instantMs(row.starts_at) - settings.cancelDeadlineMinutesBefore * 60000)
            return { ok: false, error: 'self_deadline_passed', status: 403 };
    }
    const writes: D1PreparedStatement[] = [];
    if (input.response === 'cancel')
        writes.push(db.prepare(`UPDATE rt_reservations SET confirmation_revision = confirmation_revision + 1, status='cancelled',
  customer_version=customer_version+1,hold_expires_at=NULL,updated_at=datetime('now')
  WHERE id=? AND customer_version=? AND status='confirmed'
  AND EXISTS(SELECT 1 FROM rt_reservation_confirmations WHERE request_id=? AND response IS NULL AND julianday(expires_at)>julianday(?))`)
            .bind(row.reservation_id, input.expectedVersion, input.requestId, now.toISOString()));
    writes.push(db.prepare(`UPDATE rt_reservation_confirmations SET response=?,responded_at=?
  WHERE request_id=? AND friend_id=? AND response IS NULL AND julianday(expires_at)>julianday(?)
  AND EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id=reservation_id AND r.customer_version=? AND r.status=?) AND (?<>'cancel' OR changes()=1)`)
        .bind(input.response, now.toISOString(), input.requestId, input.friendId, now.toISOString(), input.expectedVersion + (input.response === 'cancel' ? 1 : 0), input.response === 'cancel' ? 'cancelled' : 'confirmed', input.response));
    if (input.response === 'cancel')
        writes.push(db.prepare(`INSERT OR IGNORE INTO rt_customer_notice_outbox
  (id,store_id,reservation_id,customer_version,line_uid,message,retry_key)
  SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rt_reservation_confirmations WHERE request_id=? AND response='cancel' AND responded_at=?)`)
            .bind('confirmation-cancel:' + input.requestId, row.store_id, row.reservation_id, input.expectedVersion + 1, row.line_uid, row.store_name + 'の予約を取り消しました。', crypto.randomUUID(), input.requestId, now.toISOString()));
    const results = await db.batch(writes);
    if (!results[input.response === 'cancel' ? 1 : 0].meta.changes)
        return { ok: false, error: 'version_conflict', status: 409 };
    return { ok: true, response: input.response, version: input.expectedVersion + (input.response === 'cancel' ? 1 : 0) };
}
export function parseRestaurantConfirmationPostback(data: string) {
    const m = /^rc:([a-f0-9-]{36}):(going|change_requested|cancel)$/.exec(data);
    return m ? { requestId: m[1], response: m[2] as RestaurantConfirmationResponse } : null;
}
function instantMs(value: string): number { return Date.parse(reservationInstant(value)); }
