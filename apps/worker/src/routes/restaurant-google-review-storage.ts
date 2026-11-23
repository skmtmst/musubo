import type { Env } from '../worker-env.js';
import { dbFor } from '../services/db-router.js';
import { type GoogleReview } from '../services/google-business.js';

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 口コミタブ ----------

/**
 * 口コミの取り込みUPSERT。手動sync（下のエンドポイント）と定期再同期の両方から使う。
 *
 * どの接続から取り込んだのかを必ず書く。review_name は Google のロケーション名を含むので、
 * 同じ店舗に2つの接続があっても一意制約（store_id, review_name）は衝突しない。
 * 既に入っている行の connection_id が移行で空のままなら、ここで埋め直す。
 */
export async function upsertReviewsForEnv(
  env: Env['Bindings'],
  connection: { id: string; store_id: string },
  reviews: GoogleReview[],
): Promise<void> {
  const storeId = connection.store_id;
  const db = dbFor(env, storeId);
  const now = nowIso();
  const statements = reviews.map((review) =>
    db
      .prepare(
        `INSERT INTO rt_google_reviews
           (id, store_id, connection_id, review_name, reviewer_display_name, star_rating, comment, create_time, update_time, needs_attention,
            reply_status, reply_comment, reply_update_time, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(store_id, review_name) DO UPDATE SET
           connection_id = excluded.connection_id,
           reviewer_display_name = excluded.reviewer_display_name,
           star_rating = excluded.star_rating,
           comment = excluded.comment,
           update_time = excluded.update_time,
           needs_attention = excluded.needs_attention,
           reply_comment = excluded.reply_comment,
           reply_update_time = excluded.reply_update_time,
           reply_status = CASE
             WHEN excluded.reply_comment IS NOT NULL THEN 'published'
             WHEN rt_google_reviews.reply_status IN ('replied', 'pending_confirm', 'published') THEN 'unreplied'
             ELSE rt_google_reviews.reply_status END,
           updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        storeId,
        connection.id,
        review.name,
        review.reviewerDisplayName,
        review.starRating,
        review.comment,
        review.createTime,
        review.updateTime,
        review.starRating <= 3 ? 1 : 0,
        review.reply ? 'published' : 'unreplied',
        review.reply?.comment ?? null,
        review.reply?.updateTime ?? null,
        now,
        now,
      ),
  );
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}
