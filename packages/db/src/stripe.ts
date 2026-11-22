import { boundedListLimit, jstNow } from './utils.js';
// Stripe決済連携クエリヘルパー

export interface StripeEventRow {
  id: string;
  stripe_event_id: string;
  event_type: string;
  friend_id: string | null;
  amount: number | null;
  currency: string | null;
  metadata: string | null;
  processed_at: string;
}

export async function getStripeEvents(db: D1Database, opts: {
  friendId?: string; eventType?: string; limit?: number;
  lineAccountIds?: readonly string[]; includeUnassigned?: boolean;
} = {}): Promise<StripeEventRow[]> {
  const limit = boundedListLimit(opts.limit, 100);
  if (opts.lineAccountIds !== undefined) {
    const conditions = ['(f.line_account_id IN (SELECT value FROM json_each(?))'
      + (opts.includeUnassigned ? ' OR (e.friend_id IS NULL OR (f.id IS NOT NULL AND f.line_account_id IS NULL))' : '') + ')'];
    const binds: unknown[] = [JSON.stringify(opts.lineAccountIds)];
    if (opts.friendId) { conditions.push('e.friend_id = ?'); binds.push(opts.friendId); }
    if (opts.eventType) { conditions.push('e.event_type = ?'); binds.push(opts.eventType); }
    const result = await db.prepare(`SELECT e.* FROM stripe_events e LEFT JOIN friends f ON f.id = e.friend_id
      WHERE ${conditions.join(' AND ')} ORDER BY e.processed_at DESC LIMIT ?`)
      .bind(...binds, limit).all<StripeEventRow>();
    return result.results;
  }
  if (opts.friendId) {
    const result = await db.prepare(`SELECT * FROM stripe_events WHERE friend_id = ? ORDER BY processed_at DESC LIMIT ?`)
      .bind(opts.friendId, limit).all<StripeEventRow>();
    return result.results;
  }
  if (opts.eventType) {
    const result = await db.prepare(`SELECT * FROM stripe_events WHERE event_type = ? ORDER BY processed_at DESC LIMIT ?`)
      .bind(opts.eventType, limit).all<StripeEventRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM stripe_events ORDER BY processed_at DESC LIMIT ?`)
    .bind(limit).all<StripeEventRow>();
  return result.results;
}

export async function getStripeEventByStripeId(db: D1Database, stripeEventId: string): Promise<StripeEventRow | null> {
  return db.prepare(`SELECT * FROM stripe_events WHERE stripe_event_id = ?`).bind(stripeEventId).first<StripeEventRow>();
}

export async function createStripeEvent(
  db: D1Database,
  input: { stripeEventId: string; eventType: string; friendId?: string; amount?: number; currency?: string; metadata?: string },
): Promise<StripeEventRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  // 削除後に届いた通知で顧客 ID や自由形式の metadata を再保存しない。
  await db.prepare(`INSERT INTO stripe_events (id, stripe_event_id, event_type, friend_id, amount, currency, metadata, processed_at)
    VALUES (?, ?, ?, CASE WHEN EXISTS(SELECT 1 FROM friends WHERE id=?) THEN ? ELSE NULL END, ?, ?,
      CASE WHEN ? IS NOT NULL AND NOT EXISTS(SELECT 1 FROM friends WHERE id=?) THEN NULL ELSE ? END, ?)`)
    .bind(id, input.stripeEventId, input.eventType, input.friendId ?? null, input.friendId ?? null, input.amount ?? null, input.currency ?? null,
      input.friendId ?? null, input.friendId ?? null, input.metadata ?? null, now).run();
  return (await db.prepare(`SELECT * FROM stripe_events WHERE id = ?`).bind(id).first<StripeEventRow>())!;
}
