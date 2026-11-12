import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { CredentialEncryptionKeyError, encryptCredential } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { auditLog } from '../lib/audit-log.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { dbFor } from '../services/db-router.js';
import { randomToken } from '../services/google-business.js';
import { UberEatsError, buildAuthorizeUrl as buildUberAuthorizeUrl, exchangeAuthorizationCode as exchangeUberAuthorizationCode } from '../services/uber-eats.js';
import { UBER_PROVISIONING_SCOPES } from '../services/uber-eats-hosts.js';
import { verifySupportRelay } from '../services/support-relay.js';
import { UBER_PROBE_CHECK_BODY, platformCooldownStore, probeUberSandboxToken, uberProbeReadiness, uberProbeSecret } from '../services/ubereats-token-probe.js';
import { fail, staffTenantId } from './restaurant-google.js';
import { UBER_OAUTH_CALLBACK_PATH, uberOAuthClient } from '../services/restaurant-delivery.js';
import { isoFromMs, deliveryStore } from './restaurant-delivery-common.js';
import { registerUberStoreRoutes } from './restaurant-delivery-ubereats-stores.js';
import { registerUberConnectionManagementRoutes } from './restaurant-delivery-uber-connection-management.js';
import { posActivationUnresolved, POS_ACTIVATION_STARTED, POS_ACTIVATION_UNKNOWN } from '../services/uber-pos-activation.js';
import { saveUberOAuthConnection } from '../features/uber-delivery/index.js';

export function uberOAuthModeForConnection(
  connection: { status: string; uber_store_id: string | null } | null,
): 'connect' | 'reconnect' {
  return connection && connection.status !== 'disconnected' && connection.uber_store_id
    ? 'reconnect' : 'connect';
}

export function registerDeliveryUber(restaurantDelivery: Hono<Env>): void {
  // ---------- Uber Eats のログイン連携（店舗が自分でつなぐ経路） ----------
  //
  // 公式仕様の根拠は docs/integrations/uber-eats-connection.md の2節・5節。
  // 店舗が鍵を写して貼る操作はない。店舗がすることは「ログインして許可する」だけで、
  // 認可コードからトークンへの交換はここ（サーバ間）で行う。
  // 戻り先URLは配備の設定から組み立てる（呼び出し元のホストからは作らない）。
  // 入口と戻り先が1文字でも違うと Uber 側ではじかれるため。

  /** 認可の一時状態を入れるCookie。戻り先の道だけに限る。 */
  const UBER_STATE_COOKIE = 'lh_uber_state';

  /** 一時状態の寿命。1回使い切りで、これを過ぎたら使えない。 */
  const UBER_STATE_MAX_AGE_SEC = 600;

  /** 認可のあと店舗を戻す管理画面の道（設定 › デリバリー連携）。 */
  const UBER_ADMIN_RETURN_PATH = '/settings/delivery';

  interface UberOAuthStateRow {
    state: string;
    account_id: string;
    store_id: string;
    staff_id: string;
    mode: 'connect' | 'reconnect';
    expires_at: number;
    used_at: number | null;
    created_at: number;
  }

  interface UberConnectionRow {
    store_id: string;
    account_id: string;
    uber_store_id: string | null;
    uber_store_name: string | null;
    access_token_expires_at: number | null;
    granted_scope: string | null;
    status: 'pending_store' | 'connected' | 'expired' | 'no_permission' | 'disconnected';
    connected_at: number | null;
    provisioned_at: number | null;
    disconnected_at: number | null;
    updated_at: number | null;
    last_error: string | null;
    version: number;
  }

  function uberStateCookie(value: string, maxAge = UBER_STATE_MAX_AGE_SEC): string {
    return `${UBER_STATE_COOKIE}=${encodeURIComponent(value)}; Path=${UBER_OAUTH_CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  }

  function readUberStateCookie(header: string | undefined): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [key, ...value] = part.trim().split('=');
      if (key === UBER_STATE_COOKIE) {
        try {
          return decodeURIComponent(value.join('='));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /** 店舗を設定画面へ戻す。結果は符号だけで、自由文や秘密値は載せない。 */
  function uberReturnUrl(c: Context<Env>, lineAccountId: string | null, result: string): string {
    const base = (c.env.ADMIN_PUBLIC_URL ?? '').replace(/\/+$/, '');
    const url = new URL(`${base || new URL(c.req.url).origin}${UBER_ADMIN_RETURN_PATH}`);
    if (lineAccountId) url.searchParams.set('account_id', lineAccountId);
    url.searchParams.set('ubereats', result);
    return url.toString();
  }

  async function uberConnectionFor(c: Context<Env>, storeId: string): Promise<UberConnectionRow | null> {
    return dbFor(c.env, storeId)
      .prepare(
        `SELECT store_id, account_id, uber_store_id, uber_store_name, access_token_expires_at,
              granted_scope, status, connected_at, provisioned_at, disconnected_at, updated_at, last_error, version
         FROM rt_delivery_uber_connections WHERE store_id = ? LIMIT 1`,
      )
      .bind(storeId)
      .first<UberConnectionRow>();
  }

  /**
   * いまの接続の状態。画面を開き直したときに本当の状態を出すための読み取り口。
   *
   * 見るのはD1だけで、Uber へは問い合わせない。トークンの口は1時間100回までの制限があり、
   * 画面を表示するたびに使うものではない（docs/integrations/uber-eats-connection.md 5節）。
   * 返すのは状態・日時・分類済みの符号だけ。トークン・鍵・Uber が返した自由文は返さない。
   */
  restaurantDelivery.get(
    '/api/restaurant-test/delivery/ubereats/connection',
    requireRole('owner', 'admin'),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const row = await uberConnectionFor(c, store.id);
      return c.json({
        success: true,
        store: { id: store.id, name: store.name },
        // 接続の設定がこの環境にあるか。無ければ画面はつなぐボタンを押させない。
        oauthConfigured: uberOAuthClient(c.env) !== null,
        connection: {
          status: row?.status ?? 'disconnected',
          version: row?.version ?? null,
          storeName: row?.uber_store_name ?? null,
          connectedAt: isoFromMs(row?.connected_at),
          // POST /pos_data が通った時刻。ここが入って初めて Uber 側で連携が有効。
          provisionedAt: isoFromMs(row?.provisioned_at),
          checkedAt: isoFromMs(row?.updated_at),
          lastError: row?.last_error ?? null,
        },
      });
    },
  );

  registerUberConnectionManagementRoutes(restaurantDelivery, { deliveryStore, isoFromMs });

  /**
   * 認可画面へ渡す入口。店舗管理者以上だけが押せる。
   * ここでは一時状態を作るだけで、接続情報には触らない。
   */
  restaurantDelivery.post(
    '/api/restaurant-test/delivery/ubereats/connect/start',
    requireRole('owner', 'admin'),
    async (c) => {
      const client = uberOAuthClient(c.env);
      if (!client) {
        return fail(c, 503, 'Uber Eats 接続の設定がこの環境にありません', { code: 'oauth_not_configured' });
      }
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      if (!store.lineAccountId) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');

      const existing = await uberConnectionFor(c, store.id);
      if (posActivationUnresolved(existing?.last_error)
        || existing?.last_error === 'pos_deactivation_started'
        || existing?.last_error === 'pos_deactivation_unknown'
        || existing?.last_error === 'pos_disconnect_reauthorization_pending'
        || existing?.last_error === 'store_provision_review_required'
        || existing?.last_error === 'store_menu_refresh_review_required') {
        return fail(c, 409, 'お店をつないだ結果の確認が必要です。送り直さず musubo へお知らせください', { code: POS_ACTIVATION_UNKNOWN });
      }
      const mode = uberOAuthModeForConnection(existing);
      const state = randomToken(32);
      const now = Date.now();
      await dbFor(c.env, store.id)
        .prepare(
          `INSERT INTO rt_delivery_uber_oauth_states
           (state, account_id, store_id, staff_id, mode, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          state,
          store.lineAccountId,
          store.id,
          c.get('staff')!.id,
          mode,
          now + UBER_STATE_MAX_AGE_SEC * 1000,
          now,
        )
        .run();
      c.header('Set-Cookie', uberStateCookie(state));
      auditLog(
        c,
        'restaurant.delivery.ubereats.connect.start',
        { id: store.id, kind: 'rt_store' },
        { lineAccountId: store.lineAccountId },
      );
      return c.json({
        success: true,
        mode,
        authorizeUrl: buildUberAuthorizeUrl({
          clientId: client.clientId,
          redirectUri: client.redirectUri,
          state,
          hosts: client.hosts,
          // 店舗の認可で求めるのは店舗一覧と連携の有効化だけ。運用の権限は混ぜられない。
          scopes: UBER_PROVISIONING_SCOPES,
        }),
      });
    },
  );

  /**
   * Uber からの戻り。
   *
   * 管理画面（別ホスト）から Worker への認可開始はクロスサイト通信になるため、
   * ブラウザのCookie制限で state Cookie が保存されない場合がある。
   * 届いた場合は追加検査として一致を必須にし、届かない場合もDB上の高エントロピーな
   * state・担当者・期限・未使用の全条件が一致すれば続ける（Google 接続と同じ考え方）。
   *
   * stateの不一致・期限切れ・使い回し・担当者違いでは、接続情報を一切書き換えない。
   */
  restaurantDelivery.get(
    UBER_OAUTH_CALLBACK_PATH,
    requireRole('owner', 'admin'),
    async (c) => {
      c.header('Set-Cookie', uberStateCookie('', 0));
      const state = c.req.query('state') ?? '';
      const code = c.req.query('code') ?? '';
      const cookieState = readUberStateCookie(c.req.header('cookie'));
      const stateRow = state
        ? await dbFor(c.env)
            .prepare(
              `SELECT state, account_id, store_id, staff_id, mode, expires_at, used_at, created_at
               FROM rt_delivery_uber_oauth_states WHERE state = ? LIMIT 1`,
            )
            .bind(state)
            .first<UberOAuthStateRow>()
        : null;
      const lineAccountId = stateRow?.account_id ?? null;

      if (
        !stateRow ||
        (cookieState !== null && cookieState !== state) ||
        stateRow.used_at ||
        stateRow.expires_at < Date.now()
      ) {
        return c.redirect(uberReturnUrl(c, lineAccountId, 'error:invalid_state'));
      }
      if (stateRow.staff_id !== c.get('staff')!.id) {
        return c.redirect(uberReturnUrl(c, lineAccountId, 'error:invalid_state'));
      }
      /*
       * ここから先は1回使い切り。交換に失敗しても同じ符号は二度使えない。
       * 同じstateのcallbackが同時に二度来ても片方だけが通るよう、
       * 使用済みへの更新は「まだ使われていない」条件付きで行い、
       * 1件書き換えられたときだけ先へ進む（Google Sheets 連携の  と同じ）。
       */
      const consumed = await dbFor(c.env, stateRow.store_id)
        .prepare('UPDATE rt_delivery_uber_oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL')
        .bind(Date.now(), state)
        .run();
      if (Number(consumed.meta?.changes ?? 0) !== 1) {
        return c.redirect(uberReturnUrl(c, lineAccountId, 'error:invalid_state'));
      }
      if (c.req.query('error') || !code) {
        return c.redirect(uberReturnUrl(c, lineAccountId, 'error:denied'));
      }
      // 店舗が今もこの担当者の統括に属しているか（stateの発行後に変わっていないか）。
      const store = await dbFor(c.env, stateRow.store_id)
        .prepare(
          `SELECT s.id, s.line_account_id FROM rt_stores s
           JOIN rt_organizations o ON o.id = s.organization_id
          WHERE s.id = ? AND o.tenant_id = ? LIMIT 1`,
        )
        .bind(stateRow.store_id, staffTenantId(c))
        .first<{ id: string; line_account_id: string | null }>();
      if (!store) return c.redirect(uberReturnUrl(c, lineAccountId, 'error:store_missing'));
      const currentConnection = await uberConnectionFor(c, store.id);
      if (posActivationUnresolved(currentConnection?.last_error)
        || currentConnection?.last_error === 'pos_deactivation_started'
        || currentConnection?.last_error === 'pos_deactivation_unknown'
        || currentConnection?.last_error === 'pos_disconnect_reauthorization_pending'
        || currentConnection?.last_error === 'store_provision_review_required'
        || currentConnection?.last_error === 'store_menu_refresh_review_required') {
        return c.redirect(uberReturnUrl(c, lineAccountId, `error:${POS_ACTIVATION_UNKNOWN}`));
      }
      if (currentConnection?.disconnected_at
        && stateRow.created_at <= currentConnection.disconnected_at) {
        return c.redirect(uberReturnUrl(c, lineAccountId, 'error:connection_changed'));
      }

      const client = uberOAuthClient(c.env);
      if (!client) return c.redirect(uberReturnUrl(c, lineAccountId, 'error:oauth_not_configured'));

      const db = dbFor(c.env, store.id);
      const fetchFn = fetch;
      try {
        const token = await exchangeUberAuthorizationCode({
          client,
          code,
          fetch: fetchFn,
          requiredScopes: UBER_PROVISIONING_SCOPES,
        });
        const accessEnc = await encryptCredential(token.accessToken, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
        const now = Date.now();
        // つなぐ店舗を選ぶ手順（設計 DL-4）が残っているので、まだ `connected` にしない。
        const saved = await saveUberOAuthConnection({
          db, storeId: store.id, accountId: stateRow.account_id, tenantId: staffTenantId(c), mode: stateRow.mode,
          staffId: stateRow.staff_id, accessTokenEnc: accessEnc,
          accessTokenExpiresAt: token.expiresAtMs, grantedScope: token.scope.join(' '),
          stateCreatedAt: stateRow.created_at, expectedVersion: currentConnection?.version ?? 1, nowMs: now,
        });
        if (!saved) {
          return c.redirect(uberReturnUrl(c, lineAccountId, `error:${POS_ACTIVATION_UNKNOWN}`));
        }
        auditLog(
          c,
          'restaurant.delivery.ubereats.connect',
          { id: store.id, kind: 'rt_store' },
          { lineAccountId },
        );
        return c.redirect(uberReturnUrl(c, lineAccountId,
          stateRow.mode === 'reconnect' ? 'reauthorized' : 'pending_store'));
      } catch (error) {
        // 残すのは分類済みの符号だけ。Uber から返った自由文・本文・例外は保存も表示もしない。
        if (error instanceof CredentialEncryptionKeyError) {
          return c.redirect(uberReturnUrl(c, lineAccountId, 'error:encryption_key_missing'));
        }
        const code_ = error instanceof UberEatsError ? error.kind : 'token_exchange_failed';
        // すでにある接続だけに理由を残す。新規の失敗では行を作らない。
        await db
          .prepare(
            `UPDATE rt_delivery_uber_connections SET last_error = ?, version = version + 1, updated_at = ? WHERE store_id = ?
             AND COALESCE(last_error, '') NOT IN
               ('${POS_ACTIVATION_STARTED}', '${POS_ACTIVATION_UNKNOWN}',
                'pos_deactivation_started', 'pos_deactivation_unknown',
                'pos_disconnect_reauthorization_pending',
                'store_provision_review_required', 'store_menu_refresh_review_required')`,
          )
          .bind(code_, Date.now(), store.id)
          .run();
        logger.error("restaurant_delivery.register_delivery_uber_failed");
        return c.redirect(uberReturnUrl(c, lineAccountId, `error:${code_}`));
      }
    },
  );

  registerUberStoreRoutes(restaurantDelivery, { deliveryStore, uberConnectionFor, isoFromMs });

  /**
   * Uber Eats Sandbox への最小の実接続（トークン1回）を配備先の中から行う口。画面は持たない。
   *
   * Application ID と Client Secret は配備先の暗号化された秘密設定で読み戻せないため、
   * 外から curl で叩くには秘密値を取り出すことになる。取り出さずに済むよう、
   * 「配備先の中から1回だけ送って、結果の形だけを返す」入口をここに置く。
   *
   * - 管理画面の認証は通さない（`/api/` で始まらないため共通認証の対象外）。
   *   代わりに `/webhooks/xserver/support-email` と同じ合言葉の署名で守る。
   *   `x-nen-timestamp`（通算秒10桁）と `x-nen-signature`（`<時刻>.<本文>` の HMAC-SHA256・16進）。
   * - 返すのは「取れたか」と `scope` と残り秒だけ。
   *   **トークンの値と Client Secret は返さない・記録しない。**
   * - 接続先が Sandbox でないときは送らない。冷却時間の中でも送らない。
   * - 本文が `{"mode":"check"}` のときは下見。署名を確かめたあと、Uber へは送らずに
   *   接続先と設定の有無だけを返す。トークンの口の回数も冷却時間も使わない。
   */
  restaurantDelivery.post('/internal/ubereats/sandbox-token-probe', async (c) => {
    if (!restaurantTestEnabled(c.env)) return fail(c, 404, 'Not found');
    const gate = uberProbeSecret(c.env);
    // 合言葉が無いあいだは口を閉じたまま。誰でも叩ける状態にはしない。
    // 返すのは「届いていない」か「短すぎる」かの理由だけ。長さも値も返さない。
    if (!gate.ok) return c.json({ success: false, code: gate.code }, 503);
    const rawBody = await c.req.text();
    const verified = await verifySupportRelay(
      gate.secret,
      c.req.header('x-nen-timestamp'),
      c.req.header('x-nen-signature'),
      rawBody,
    );
    if (!verified) return c.json({ success: false, code: 'probe_unauthorized' }, 401);
    // 下見。Uber へは送らないので、トークンの口の回数も冷却時間も使わない。
    if (rawBody === UBER_PROBE_CHECK_BODY) {
      return c.json({ success: true, mode: 'check', ...uberProbeReadiness(c.env) });
    }
    const outcome = await probeUberSandboxToken({
      env: c.env,
      store: platformCooldownStore(dbFor(c.env)),
      fetch: (url, init) => fetch(url, init),
      nowMs: Date.now(),
    });
    switch (outcome.kind) {
      case 'ok':
        return c.json({
          success: true,
          environment: 'sandbox',
          scope: outcome.scope,
          expiresInSec: outcome.expiresInSec,
        });
      case 'sandbox_only':
        return c.json({ success: false, code: 'probe_sandbox_only' }, 403);
      case 'cooldown':
        return c.json({ success: false, code: 'probe_cooldown', retryAfterSec: outcome.retryAfterSec }, 429);
      case 'uber_error':
        // 残すのは分類済みの符号だけ。Uber から返った自由文・本文は保存も表示もしない。
        logger.error("restaurant_delivery.internal_ubereats_sandbox_token_probe_create_failed");
        return c.json(
          { success: false, code: outcome.code, uberCode: outcome.uberCode, status: outcome.status },
          502,
        );
      case 'network_failed':
        logger.error("restaurant_delivery.internal_ubereats_sandbox_token_probe_create_failed");
        return c.json({ success: false, code: 'probe_network_failed' }, 502);
      default:
        return c.json({ success: false, code: 'oauth_not_configured' }, 503);
    }
  });
}
