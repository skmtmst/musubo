/**
 * つなぐお店を選ぶ（設計 DL-4 / フレーム `X5d8UF`）。
 *
 * `routes/restaurant-delivery.ts` から切り出した入れ物で、中身は動かしていない。
 * 入口の並び（お店の一覧 → 確定）も、呼び出し位置を同じところに置いて変えていない。
 *
 * 親（`restaurant-delivery.ts`）からは読み込まない。店舗の引き当て・接続の読み取り・
 * 時刻の整え方だけを引数（`deps`）で受け取る。親と行き違いにならないようにするため。
 */
import { logger } from '@line-crm/shared/server';
import type { Context, Hono } from 'hono';
import { decryptCredential } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { auditLog } from '../lib/audit-log.js';
import { dbFor } from '../services/db-router.js';
import { randomToken } from '../services/google-business.js';
import {
  UberEatsError,
  activatePosIntegration as activateUberPosIntegration,
  listStores as listUberStores,
  tokenNeedsRenewal as uberTokenNeedsRenewal,
} from '../services/uber-eats.js';
import { uberOAuthClient } from '../services/restaurant-delivery.js';
import { fail } from './restaurant-google.js';
import type { StoreContext } from './restaurant-google.js';
import { claimPosActivation, failPosActivation, finishPosActivation, posActivationUnresolved, POS_ACTIVATION_UNKNOWN } from '../services/uber-pos-activation.js';

/** 接続の状態。`rt_delivery_uber_connections.status` と同じ並び。 */
type UberConnectionStatus = 'pending_store' | 'connected' | 'expired' | 'no_permission' | 'disconnected';

/** 確定のあと画面へ返す1行ぶん。ここで読むのはこの6つだけ。 */
interface UberStoreConnectionRow {
  status: UberConnectionStatus;
  uber_store_name: string | null;
  connected_at: number | null;
  provisioned_at: number | null;
  updated_at: number | null;
  last_error: string | null;
}

/** 親が持っている引き当て・読み取り・時刻の整え方。入口を2つ生やすのに必要なぶんだけ受け取る。 */
export interface UberStoreRoutesDeps {
  deliveryStore(c: Context<Env>): Promise<StoreContext | null>;
  uberConnectionFor(c: Context<Env>, storeId: string): Promise<UberStoreConnectionRow | null>;
  isoFromMs(value: number | null | undefined): string | null;
}

/** 保存した加盟店トークンの読み戻しに失敗したときの理由。画面にはこの符号だけを渡す。 */
type UberTokenFailure = 'not_connected' | 'auth_expired' | 'encryption_key_missing' | 'pos_activation_unknown';

const UBER_TOKEN_FAILURE_MESSAGES: Record<UberTokenFailure, string> = {
  not_connected: 'まだ Uber Eats にログインしていません',
  auth_expired: 'Uber Eats のログインの有効期限が切れました。もう一度つないでください',
  encryption_key_missing: 'Uber Eats 接続の設定がこの環境にありません',
  pos_activation_unknown: 'お店をつないだ結果を確認する必要があります。送り直さず musubo へお知らせください',
};

interface UberTokenRow {
  access_token_enc: string | null;
  access_token_expires_at: number | null;
  status: UberConnectionStatus;
  last_error: string | null;
  version: number;
}

/** 失敗の理由を分類済みの符号だけで残す。必要なときは状態も進める。 */
async function uberMarkConnectionError(
  c: Context<Env>,
  storeId: string,
  code: string,
  status?: UberConnectionStatus,
): Promise<void> {
  const db = dbFor(c.env, storeId);
  const now = Date.now();
  if (status) {
    await db
      .prepare(
        `UPDATE rt_delivery_uber_connections
            SET last_error = ?, status = ?, version = version + 1, updated_at = ?
          WHERE store_id = ? AND COALESCE(last_error, '') NOT IN
            ('pos_activation_started', 'pos_activation_unknown', 'pos_deactivation_started', 'pos_deactivation_unknown',
             'pos_disconnect_reauthorization_pending',
             'store_provision_review_required', 'store_menu_refresh_review_required')`,
      )
      .bind(code, status, now, storeId)
      .run();
    return;
  }
  await db
    .prepare(`UPDATE rt_delivery_uber_connections SET last_error = ?, version = version + 1, updated_at = ? WHERE store_id = ?
      AND COALESCE(last_error, '') NOT IN
        ('pos_activation_started', 'pos_activation_unknown', 'pos_deactivation_started', 'pos_deactivation_unknown',
         'pos_disconnect_reauthorization_pending',
         'store_provision_review_required', 'store_menu_refresh_review_required')`)
    .bind(code, now, storeId)
    .run();
}

/**
 * 保存した加盟店のトークン（権限は `eats.pos_provisioning`）を読み戻す。
 *
 * Uber は更新用トークンを返さないため、期限が近い・切れているときは裏で取り直せない。
 * その場合は `expired` にして、画面からもう一度ログインしてもらう。
 * 返すのは復号した値そのものだけで、呼び出し側は応答にも記録にも載せない。
 */
async function uberMerchantToken(
  c: Context<Env>,
  storeId: string,
): Promise<{ ok: true; token: string; version: number } | { ok: false; code: UberTokenFailure }> {
  const row = await dbFor(c.env, storeId)
    .prepare(
      `SELECT access_token_enc, access_token_expires_at, status, last_error, version
         FROM rt_delivery_uber_connections WHERE store_id = ? LIMIT 1`,
    )
    .bind(storeId)
    .first<UberTokenRow>();
  if (posActivationUnresolved(row?.last_error)
    || row?.last_error === 'pos_deactivation_started'
    || row?.last_error === 'pos_deactivation_unknown'
    || row?.last_error === 'pos_disconnect_reauthorization_pending'
    || row?.last_error === 'store_provision_review_required'
    || row?.last_error === 'store_menu_refresh_review_required') return { ok: false, code: POS_ACTIVATION_UNKNOWN };
  if (!row?.access_token_enc || row.status === 'disconnected') {
    return { ok: false, code: 'not_connected' };
  }
  if (uberTokenNeedsRenewal(row.access_token_expires_at, Date.now())) {
    await uberMarkConnectionError(c, storeId, 'auth_expired', 'expired');
    return { ok: false, code: 'auth_expired' };
  }
  try {
    return {
      ok: true,
      token: await decryptCredential(row.access_token_enc, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY),
      version: row.version,
    };
  } catch {
    // 鍵が無い・変わった。復号できない事実だけを残し、鍵も本文も出さない。
    return { ok: false, code: 'encryption_key_missing' };
  }
}

/** 候補の見分け用の一行。番地・市区・郵便番号だけで、人の名前や連絡先は入らない。 */
function uberCandidateAddress(location: {
  address: string | null;
  city: string | null;
  postalCode: string | null;
} | null): string | null {
  if (!location) return null;
  const text = [location.postalCode, location.city, location.address]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  return text || null;
}

/** Uber の失敗の種類から、接続の状態を進めるべきものだけを選ぶ。 */
function uberStatusForError(error: unknown): UberConnectionStatus | undefined {
  if (!(error instanceof UberEatsError)) return undefined;
  if (error.kind === 'auth_expired') return 'expired';
  if (error.kind === 'no_permission') return 'no_permission';
  return undefined;
}

/** 「つなぐお店を選ぶ」の入口2つを親の経路へ生やす。 */
export function registerUberStoreRoutes(app: Hono<Env>, deps: UberStoreRoutesDeps): void {
  const { deliveryStore, uberConnectionFor, isoFromMs } = deps;

  /**
   * ログインした人が管理しているお店の一覧。
   *
   * 呼ぶのは「つなぐお店を選んでください」を開いたときだけ。画面の表示ごとには呼ばない。
   * 使うのは認可画面で得た加盟店のトークンで、アプリ自身のトークンではない
   * （権限 `eats.pos_provisioning`・services/uber-eats-hosts.ts）。
   * 取れた候補は次の確定で突き合わせるため `rt_delivery_uber_store_candidates` に入れ替えで保存する。
   */
  app.get(
    '/api/restaurant-test/delivery/ubereats/stores',
    requireRole('owner', 'admin'),
    async (c) => {
      const client = uberOAuthClient(c.env);
      if (!client) {
        return fail(c, 503, 'Uber Eats 接続の設定がこの環境にありません', { code: 'oauth_not_configured' });
      }
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');

      const token = await uberMerchantToken(c, store.id);
      if (!token.ok) {
        return fail(c, 409, UBER_TOKEN_FAILURE_MESSAGES[token.code], { code: token.code });
      }

      const fetchFn = fetch;
      let stores;
      try {
        stores = await listUberStores({
          fetch: fetchFn,
          accessToken: token.token,
          hosts: client.hosts,
          singleAttempt: true,
        });
      } catch (error) {
        // 残すのは分類済みの符号だけ。Uber から返った自由文・本文・例外は保存も表示もしない。
        const code = error instanceof UberEatsError ? error.kind : 'store_list_failed';
        await uberMarkConnectionError(c, store.id, code, uberStatusForError(error));
        logger.error("restaurant_delivery.restaurant_test_delivery_ubereats_stores_list_failed");
        return fail(c, 502, 'Uber Eats からお店の一覧を取れませんでした', { code });
      }

      const db = dbFor(c.env, store.id);
      const now = Date.now();
      // 前に出した候補は残さない。選べるのは今回取れたものだけにする。
      await db.prepare('DELETE FROM rt_delivery_uber_store_candidates WHERE store_id = ?').bind(store.id).run();
      for (const candidate of stores) {
        await db
          .prepare(
            `INSERT INTO rt_delivery_uber_store_candidates
               (id, store_id, uber_store_id, uber_store_name, external_store_id, address_text, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            randomToken(16),
            store.id,
            candidate.storeId,
            candidate.name,
            candidate.externalStoreId,
            uberCandidateAddress(candidate.location),
            now,
          )
          .run();
      }

      return c.json({
        success: true,
        stores: stores.map((candidate) => ({
          id: candidate.storeId,
          name: candidate.name,
          address: uberCandidateAddress(candidate.location) ?? '',
        })),
      });
    },
  );

  /**
   * 選ばれたお店で連携を有効にする（`POST /v1/eats/stores/{id}/pos_data`）。
   *
   * - 画面から来たIDはそのまま送らない。直前に自分で保存した候補と一致したものだけを通す。
   * - 連携の有効化は重ねて送ると設定が入れ替わるため、自動では再試行しない
   *   （services/uber-eats.ts の `retry: false`）。押し直しは人の操作として扱う。
   * - ここが通った時刻が `provisioned_at`。これが入って初めて Uber 側で連携が有効になる。
   */
  app.post(
    '/api/restaurant-test/delivery/ubereats/stores/select',
    requireRole('owner', 'admin'),
    async (c) => {
      const client = uberOAuthClient(c.env);
      if (!client) {
        return fail(c, 503, 'Uber Eats 接続の設定がこの環境にありません', { code: 'oauth_not_configured' });
      }
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');

      const body = await c.req.json<{ storeId?: unknown }>().catch(() => ({}) as { storeId?: unknown });
      const uberStoreId = typeof body.storeId === 'string' ? body.storeId.trim() : '';
      if (!uberStoreId) return fail(c, 400, 'つなぐお店を選んでください', { code: 'store_id_required' }, ['storeId']);

      const db = dbFor(c.env, store.id);
      const candidate = await db
        .prepare(
          `SELECT uber_store_id, uber_store_name, external_store_id
             FROM rt_delivery_uber_store_candidates
            WHERE store_id = ? AND uber_store_id = ? LIMIT 1`,
        )
        .bind(store.id, uberStoreId)
        .first<{ uber_store_id: string; uber_store_name: string; external_store_id: string | null }>();
      if (!candidate) {
        return fail(c, 404, 'そのお店は選べません。お店の一覧を取り直してください', {
          code: 'store_not_candidate',
        });
      }

      const token = await uberMerchantToken(c, store.id);
      if (!token.ok) {
        return fail(c, 409, UBER_TOKEN_FAILURE_MESSAGES[token.code], { code: token.code });
      }

      const fetchFn = fetch;
      const claimed = await claimPosActivation(db, {
        storeId: store.id, accountId: store.lineAccountId!, uberStoreId: candidate.uber_store_id,
        name: candidate.uber_store_name, externalId: candidate.external_store_id, version: token.version,
      });
      if (!claimed) return fail(c, 409, '接続の状態が変わりました。画面を開き直して確認してください', { code: 'connection_changed' });
      try {
        await activateUberPosIntegration(
          { fetch: fetchFn, accessToken: token.token, hosts: client.hosts, singleAttempt: true },
          candidate.uber_store_id,
          {
            // musubo 側の店舗ID。届いた注文をどの店舗のものとして扱うかの手掛かりになる。
            integratorStoreId: store.id,
            // 受付とキャンセルを musubo の画面で行うため、注文の管理役はこちら側になる。
            isOrderManager: true,
          },
        );
      } catch (error) {
        const code = error instanceof UberEatsError ? error.kind : 'provisioning_failed';
        const unknown = !(error instanceof UberEatsError) || error.status === null || error.status === 408 || (error.status ?? 0) >= 500 || error.kind === 'unknown';
        await failPosActivation(db, store.id, unknown ? POS_ACTIVATION_UNKNOWN : code, unknown ? undefined : uberStatusForError(error));
        logger.error("restaurant_delivery.restaurant_test_delivery_ubereats_stores_select_create_failed");
        return fail(c, 502, unknown ? UBER_TOKEN_FAILURE_MESSAGES.pos_activation_unknown : 'Uber Eats でお店をつなげませんでした', { code: unknown ? POS_ACTIVATION_UNKNOWN : code });
      }

      try {
        if (!await finishPosActivation(db, store.id, candidate.uber_store_id)) throw new Error('activation_save_conflict');
      } catch {
        // D1 が結果不明を記録できなくても、送信開始の印を残し、再送させない。
        return fail(c, 502, UBER_TOKEN_FAILURE_MESSAGES.pos_activation_unknown, { code: POS_ACTIVATION_UNKNOWN });
      }
      // 選び終わったら候補は残さない（移行 636 の注記）。
      await db.prepare('DELETE FROM rt_delivery_uber_store_candidates WHERE store_id = ?').bind(store.id).run();

      auditLog(
        c,
        'restaurant.delivery.ubereats.store.select',
        { id: store.id, kind: 'rt_store' },
        { lineAccountId: store.lineAccountId },
      );
      const row = await uberConnectionFor(c, store.id);
      return c.json({
        success: true,
        connection: {
          status: row?.status ?? 'connected',
          storeName: row?.uber_store_name ?? candidate.uber_store_name,
          connectedAt: isoFromMs(row?.connected_at),
          provisionedAt: isoFromMs(row?.provisioned_at),
          checkedAt: isoFromMs(row?.updated_at),
          lastError: row?.last_error ?? null,
        },
      });
    },
  );
}
