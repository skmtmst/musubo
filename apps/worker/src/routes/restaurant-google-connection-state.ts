/**
 * Google接続1件ぶんの「状態・候補・履歴」の書き込みだけを集めた所。
 * 複数接続では、どの行を書き換えるかを接続の id で必ず決める（店舗だけで絞らない）。
 * 公開する型と関数は routes/restaurant-google.ts 経由でも読み込める。
 */
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { dbFor } from '../services/db-router.js';
import type { GoogleLocation } from '../services/google-business.js';
import { nowIso } from './restaurant-google-review-storage.js';

export type ConnectionStatus = 'pending_location' | 'connected' | 'expired' | 'no_permission' | 'disconnected';

/** 状態・履歴の書き込み先を一意に決めるための最小の形。 */
export type ConnectionRef = { id: string; store_id: string };

/**
 * 店舗の選択候補を、この接続の分だけ入れ替える。
 * 候補は認可の途中だけ使う一時的なもの（移行での割り当ては無い）ので、
 * 古い環境から残った connection_id が NULL の行もここで一緒に片付ける。
 */
export async function replaceLocationCandidates(
  db: ReturnType<typeof dbFor>,
  storeId: string,
  connectionId: string,
  locations: readonly GoogleLocation[],
): Promise<void> {
  await db
    .prepare('DELETE FROM rt_google_location_candidates WHERE store_id = ? AND (connection_id = ? OR connection_id IS NULL)')
    .bind(storeId, connectionId)
    .run();
  if (locations.length === 0) return;
  await db.batch(
    locations.map((location) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO rt_google_location_candidates (id, store_id, connection_id, location_name, location_title, address_text) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), storeId, connectionId, location.name, location.title, location.addressText),
    ),
  );
}

/**
 * 接続1件の状態を書き換える。同じ店舗の他の接続の状態と版は触らない。
 * （store_id だけで絞ると、片方の権限切れで両方が expired になってしまう）
 */
export async function setConnectionStatusForEnv(env: Env['Bindings'], connection: ConnectionRef, status: ConnectionStatus, error?: string | null): Promise<void> {
  await dbFor(env, connection.store_id)
    .prepare(`UPDATE rt_google_connections SET confirmation_revision = confirmation_revision + CASE WHEN status IS NOT ? THEN 1 ELSE 0 END, status = ?, last_sync_error = COALESCE(?, last_sync_error), updated_at = ? WHERE id = ?`)
    .bind(status, status, error ?? null, nowIso(), connection.id)
    .run();
}

export async function setConnectionStatus(c: Context<Env>, connection: ConnectionRef, status: ConnectionStatus, error?: string | null): Promise<void> {
  await setConnectionStatusForEnv(c.env, connection, status, error);
}

/**
 * 操作の記録の宛先。接続が決まる前に失敗した場合（認可の戻りで例外など）は
 * 接続が無いこともあるので、店舗だけで残せるように id は null を許す。
 */
export type LogTarget = { id: string | null; store_id: string };

export async function writeLog(
  c: Context<Env>,
  connection: LogTarget,
  input: { kind: 'review_reply' | 'connect' | 'reconnect' | 'disconnect'; targetName?: string | null; beforeText?: string | null; afterText?: string | null; requestId?: string | null; result: 'accepted' | 'failed' | 'unknown'; error?: string | null },
): Promise<void> {
  await dbFor(c.env, connection.store_id)
    .prepare(
      `INSERT INTO rt_google_write_log (id, store_id, connection_id, kind, target_name, staff_id, before_text, after_text, request_id, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      connection.store_id,
      connection.id,
      input.kind,
      input.targetName ?? null,
      c.get('staff')?.id ?? null,
      input.beforeText ?? null,
      input.afterText ?? null,
      input.requestId ?? null,
      input.result,
      input.error ?? null,
    )
    .run();
}
