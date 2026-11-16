import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { buildOffsetListResponse, listQueryNumber } from '../lib/list-paging.js';
import { logger } from '@line-crm/shared/server';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import type {
  InstagramConnectionStatus,
  InstagramProfile,
  InstagramPost,
} from '@line-crm/shared';
import { activeTenantLineAccountSql } from '@line-crm/db';
import {
  requirePermission,
  requireRole,
  denyReadOnly,
} from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import {
  InstagramError,
  instagramConfig,
  instagramHash,
  instagramGraph,
  instagramShortToken,
  instagramLongToken,
  instagramRefreshToken,
  instagramCanPublish,
  instagramCanMessage,
  instagramUrlCode,
  instagramUrlDetail,
  instagramUrlScopes,
  INSTAGRAM_PUBLISH_SCOPE,
  INSTAGRAM_SCOPES,
  encryptInstagramCredential,
  decryptInstagramCredential,
  verifyInstagramSignature,
  type InstagramConfig,
} from '../services/instagram.js';
export const instagram = new Hono<Env>();
instagram.onError((e, c) => {
  if (!(e instanceof InstagramError)) throw new UnexpectedRouteError(c, { success: false, error: 'instagram_failed' });
  return inputError(c, { success: false, error: e.code }, e.status, e.code === 'account_required' ? ['lineAccountId'] : []);
});
type Connection = {
  line_account_id: string;
  page_id: string;
  instagram_id: string;
  page_name: string;
  username: string | null;
  page_token_encrypted: string;
  user_token_encrypted: string;
  expires_at: string;
  data_access_expires_at: string | null;
  version: number;
  profile_json: string | null;
  posts_json: string | null;
  synced_at: string | null;
  /** 同意済みの許可（カンマ区切り）。611 で追加。 */
  scopes: string;
};
// 同時投稿の許可を持たない古い接続も「認可が切れています」にして、同じ接続ボタンで取り直させる。
const expired = (r: Connection) =>
  Date.parse(r.expires_at) <= Date.now() ||
  (r.data_access_expires_at != null &&
    Date.parse(r.data_access_expires_at) <= Date.now()) ||
  !instagramCanPublish(r.scopes ?? '');
async function account(c: Context<Env>): Promise<string> {
  const id = c.req.query('lineAccountId');
  if (!id) throw new InstagramError('account_required', 400);
  if (!(await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [id])))
    throw new InstagramError('not_found', 404);
  return id;
}
async function connection(c: Context<Env>, id: string): Promise<Connection> {
  const row = await c.env.DB.prepare(
    'SELECT * FROM instagram_connections WHERE line_account_id=?',
  )
    .bind(id)
    .first<Connection>();
  if (!row) throw new InstagramError('disconnected', 404);
  return row;
}
const ready = (c: Context<Env>): InstagramConfig => {
  const cfg = instagramConfig(c.env);
  if (!cfg) throw new InstagramError('unconfigured', 503);
  return cfg;
};
instagram.use(
  '/api/instagram/*',
  async (c, next) => {
    if (c.req.path === '/api/instagram/webhook') return next();
    return requirePermission('/webhooks')(c, next);
  },
  async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.get('staff')?.readOnly
    )
      throw new InstagramError('read_only', 403);
    await next();
  },
);
instagram.get('/api/instagram/connection', async (c) => {
  const id = await account(c);
  const cfg = instagramConfig(c.env);
  if (!cfg)
    return c.json({
      success: true,
      data: {
        state: 'unconfigured',
        replyEnabled: false,
      } satisfies InstagramConnectionStatus,
    });
  const row = await c.env.DB.prepare(
    'SELECT * FROM instagram_connections WHERE line_account_id=?',
  )
    .bind(id)
    .first<Connection>();
  return c.json({
    success: true,
    data: row
      ? {
          state: expired(row) ? 'expired' : 'connected',
          replyEnabled: false,
          dmReconnectRequired: !instagramCanMessage(row.scopes ?? ''),
          connection: {
            pageId: row.page_id,
            instagramId: row.instagram_id,
            pageName: row.page_name,
            username: row.username,
            expiresAt: row.expires_at,
            dataAccessExpiresAt: row.data_access_expires_at,
            version: row.version,
            syncedAt: row.synced_at,
          },
        }
      : { state: 'disconnected', replyEnabled: false },
  });
});
instagram.post(
  '/api/instagram/oauth/start',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const id = await account(c),
      cfg = ready(c),
      state = crypto.randomUUID() + crypto.randomUUID(),
      hash = await instagramHash(state),
      now = new Date();
    await c.env.DB.prepare(
      "INSERT INTO instagram_oauth_states(state_hash,line_account_id,staff_id,phase,expires_at,created_at) VALUES(?,?,?,'started',?,?)",
    )
      .bind(
        hash,
        id,
        c.get('staff').id,
        new Date(now.getTime() + 10 * 60000).toISOString(),
        now.toISOString(),
      )
      .run();
    // 認可画面は Instagram 側（`www.instagram.com/oauth/authorize`）。Facebook の認可画面は
    // 使わない。Facebook の方式ではビジネスアカウントが Facebook ページにつながっていないと
    // 投稿の口が見つからず、ページを持たない店舗では必ず失敗する。こちらは Instagram に
    // ログインするだけで終わり、ページは一切見ない。版は付けない宛先。
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: cfg.appId,
      redirect_uri: cfg.redirectUri,
      state,
      response_type: 'code',
      // 同時投稿の許可（`instagram_business_content_publish`）が無いと投稿できないので、
      // 接続のときに一緒に貰う。用途に入っていない権限を混ぜると認可画面そのものが
      // 断られるため、求めるのは `services/instagram.ts` の2つだけ。
      scope: INSTAGRAM_SCOPES.join(','),
      // 以前このアプリをつないだことがあるアカウントだと、Instagram は許可の一覧を出さず
      // 「前につないだ○○と共有を続けますか？」という短い確認だけを出すことがある。
      // そのとき後から足した許可は渡されないまま戻ってくるため、接続が必ず失敗する。
      // これを入れると毎回ログインと許可の一覧からやり直すので、足した許可も必ず要求できる。
      force_reauth: 'true',
    }).toString();
    return c.json({
      success: true,
      data: {
        url: url.href,
        expiresAt: new Date(now.getTime() + 10 * 60000).toISOString(),
      },
    });
  },
);
/**
 * 認可が終わったあとに戻る画面。利用者が見るのは「設定 › SNS連携」だけなので、
 * 成否をクエリで伝えてそこへ戻す（restaurant-google.ts の折り返しと同じ形）。
 *
 * 失敗したときは、画面に出す文言を変えないまま、手がかりだけをクエリへ添える。
 * サーバー記録は閲覧の権限が無くて読めない場合があり、そのときは原因が全く分からなく
 * なってしまうため、戻り先のURLそのものに失敗の種別が残るようにしておく。
 * 添えるのは次の3つ。画面側は `instagram` の値だけを見るので、見た目は変わらない。
 *
 * - `instagram_code` … こちらで決めた失敗の種類名
 * - `instagram_detail` … 要求の宛先と、Instagram の応答の種別名・番号
 * - `instagram_scopes` … 利用者が許可した権限の名前
 *
 * 値は `instagramDiagnostic` で一度だけ安全な形へ絞ってから渡す。URLは利用者に見える
 * 場所なので、固定の識別子・許可一覧に載る名前・検査した整数しか置かない
 * （理由は `services/instagram.ts` の `instagramUrlDetail` に書いた）。
 */
function snsReturnUrl(
  c: Context<Env>,
  result: 'connected' | 'failed',
  diagnostic?: InstagramDiagnostic,
): string {
  const base = (c.env.ADMIN_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const url = new URL(
    `${base || new URL(c.req.url).origin}${INSTAGRAM_RETURN_PATH}`,
  );
  url.searchParams.set('instagram', result);
  if (result === 'failed' && diagnostic) {
    url.searchParams.set('instagram_code', diagnostic.code);
    if (diagnostic.detail)
      url.searchParams.set('instagram_detail', diagnostic.detail);
    if (diagnostic.scopes)
      url.searchParams.set('instagram_scopes', diagnostic.scopes);
  }
  return url.toString();
}
type InstagramDiagnostic = {
  code: string;
  detail: string | null;
  scopes: string | null;
};
/**
 * 失敗の手がかりを、サーバー記録と戻り先URLのどちらへ出しても安全な形に絞る。
 *
 * 絞り込みはここ1か所だけで行い、記録とURLは同じ値を使う。
 * `detail` と `scopes` は Instagram の応答由来なので、`instagramUrl*` が通した部分
 * （固定の識別子・許可一覧に載る名前・整数）しか残らない。
 */
function instagramDiagnostic(failure: {
  code: string;
  detail: string | null;
  grantedScopes: string | null;
}): InstagramDiagnostic {
  return {
    code: instagramUrlCode(failure.code),
    detail: instagramUrlDetail(failure.detail),
    scopes: instagramUrlScopes(failure.grantedScopes),
  };
}
const INSTAGRAM_RETURN_PATH = '/settings/sns';
/**
 * Instagram の認可コード応答の利用者 ID とプロフィールを保存し、SNS 連携設定へ戻す。Facebook ページ選択を不要にするため、その情報は参照しない。
 */
instagram.get(
  '/api/instagram/oauth/callback',
  requireRole('owner', 'admin'),
  denyReadOnly(),
  async (c) => {
    let hash: string | null = null;
    // 失敗したときだけサーバー記録へ出す手がかり。権限の名前だけで、合鍵や個人の情報は入れない。
    let grantedScopes: string | null = null;
    try {
      const cfg = ready(c),
        state = c.req.query('state');
      if (!state || state.length > 256)
        throw new InstagramError('invalid_callback', 400);
      // 先に state を控える。この後でどこで失敗しても、使い切りの state を必ず捨てられるようにする。
      hash = await instagramHash(state);
      // 利用者が認可画面で「許可しない」を選んだとき。`error=access_denied` が付いて戻る。
      // 失敗の種別を分けておけば、作りの不具合と見分けられる。
      if (c.req.query('error'))
        throw new InstagramError('instagram_login_denied', 403);
      // Instagram は成功した戻り先URLの末尾に `#_` を足す。付いたままだと認可コードが
      // 1文字ずれて必ず引き換えに失敗するので、ここで落とす。
      const code = (c.req.query('code') ?? '').replace(/#_$/, '');
      if (!code || code.length > 4096)
        throw new InstagramError('invalid_callback', 400);
      const row = await c.env.DB.prepare(
        "SELECT line_account_id FROM instagram_oauth_states WHERE state_hash=? AND staff_id=? AND phase='started' AND expires_at>?",
      )
        .bind(hash, c.get('staff').id, new Date().toISOString())
        .first<{ line_account_id: string }>();
      if (
        !row ||
        !(await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [
          row.line_account_id,
        ]))
      )
        throw new InstagramError('invalid_oauth_state', 403);
      const id = row.line_account_id;
      const claimed = await c.env.DB.prepare(
        "UPDATE instagram_oauth_states SET phase='exchanging' WHERE state_hash=? AND staff_id=? AND phase='started' AND expires_at>?",
      )
        .bind(hash, c.get('staff').id, new Date().toISOString())
        .run();
      if (!claimed.meta.changes)
        throw new InstagramError('oauth_state_used', 409);
      // 認可コードを短期の合鍵へ。許可された権限はこの応答にしか入っていないので、
      // ここで控えて同時投稿の許可を確かめる。
      const short = await instagramShortToken(cfg, code);
      grantedScopes = short.scopes.join(',');
      // 同時投稿の許可が無い接続は保存しない。画面は未接続のままなので、もう一度ログインすれば取り直せる。
      if (!short.scopes.includes(INSTAGRAM_PUBLISH_SCOPE))
        throw new InstagramError('instagram_publish_not_granted', 403);
      const long = await instagramLongToken(cfg, short.token);
      const profile = await instagramGraph<InstagramProfile>(
        cfg,
        'me',
        long.token,
        {
          fields:
            'id,username,name,biography,profile_picture_url,followers_count,media_count',
        },
      );
      // /me の文字列IDを優先する。認可応答の user_id は大きな JSON 数値で
      // 返る場合があり、JavaScript で丸められると投稿先が存在しないIDになる。
      const profileId = typeof profile.id === 'string' ? profile.id : '';
      const instagramId = /^\d{1,24}$/.test(profileId) ? profileId : short.userId;
      if (!/^\d{1,24}$/.test(instagramId))
        throw new InstagramError('instagram_business_account_required', 403);
      // 同じ統括なら複数のLINEアカウントで共有できる。別統括への接続は
      // Webhook の顧客データを混ぜないため拒否する（DBのトリガーでも守る）。
      const otherConnection = await c.env.DB.prepare(
        `SELECT 1 FROM instagram_connections existing
         JOIN line_accounts old_account ON old_account.id=existing.line_account_id
         JOIN line_accounts new_account ON new_account.id=?
         WHERE existing.instagram_id=? AND existing.line_account_id<>?
           AND COALESCE(old_account.tenant_id,?)<>COALESCE(new_account.tenant_id,?)
         LIMIT 1`,
      )
        .bind(id, instagramId, id, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID)
        .first();
      if (otherConnection)
        throw new InstagramError('instagram_account_other_organization', 409);
      // 画面に出す名前。`page_name` は空にできない列なので、表示名→利用者名→IDの順に埋める。
      const pageName = profile.name || profile.username || instagramId;
      // この方式の合鍵は1本だけ（ページ用と利用者用の区別が無い）。列は両方そのまま使う。
      const pageToken = await encryptInstagramCredential(
          long.token,
          cfg.encryptionKey,
        ),
        userToken = pageToken;
      // ブラウザの折り返しでは版を預かれないので、保存の直前に今の版を読んで衝突だけ見る。
      const current = await c.env.DB.prepare(
        'SELECT version FROM instagram_connections WHERE line_account_id=?',
      )
        .bind(id)
        .first<{ version: number }>();
      const expectedVersion = current?.version ?? 0;
      const now = new Date().toISOString();
      const result = await c.env.DB.prepare(
        `INSERT INTO instagram_connections(line_account_id,page_id,instagram_id,page_name,username,page_token_encrypted,user_token_encrypted,expires_at,data_access_expires_at,scopes,profile_json,refreshed_at,connected_by) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM instagram_connections WHERE line_account_id=?) ON CONFLICT(line_account_id) DO UPDATE SET page_id=excluded.page_id,instagram_id=excluded.instagram_id,page_name=excluded.page_name,username=excluded.username,page_token_encrypted=excluded.page_token_encrypted,user_token_encrypted=excluded.user_token_encrypted,expires_at=excluded.expires_at,data_access_expires_at=excluded.data_access_expires_at,scopes=excluded.scopes,profile_json=excluded.profile_json,posts_json=NULL,synced_at=NULL,refreshed_at=excluded.refreshed_at,connected_by=excluded.connected_by,version=version+1 WHERE version=?`,
      )
        .bind(
          id,
          instagramId,
          instagramId,
          pageName,
          profile.username ?? null,
          pageToken,
          userToken,
          long.expiresAt,
          long.dataAccessExpiresAt,
          short.scopes.join(','),
          JSON.stringify(profile),
          now,
          c.get('staff').id,
          expectedVersion,
          id,
          expectedVersion,
        )
        .run();
      if (!result.meta.changes)
        throw new InstagramError('version_conflict', 409);
      await c.env.DB.prepare(
        'DELETE FROM instagram_oauth_states WHERE state_hash=?',
      )
        .bind(hash)
        .run();
      return c.redirect(snsReturnUrl(c, 'connected'));
    } catch (e) {
      // 失敗の中身は画面に出さない（文言は「つなげませんでした」のまま）。
      // ただし理由が分からないと直せないので、安全な形に絞った手がかりを記録と戻り先URLへ残す。
      const diagnostic = instagramDiagnostic({
        code: e instanceof InstagramError ? e.code : 'instagram_failed',
        detail: e instanceof InstagramError ? (e.detail ?? null) : null,
        grantedScopes,
      });
      logger.error("instagram_oauth_callback_failed");
      // 使い切りの state は必ず捨てて、やり直せる状態に戻す。
      if (hash)
        await c.env.DB.prepare(
          'DELETE FROM instagram_oauth_states WHERE state_hash=?',
        )
          .bind(hash)
          .run();
      return c.redirect(snsReturnUrl(c, 'failed', diagnostic));
    }
  },
);
instagram.post(
  '/api/instagram/refresh',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const id = await account(c),
      cfg = ready(c),
      r = await connection(c, id);
    if (expired(r)) throw new InstagramError('meta_token_expired', 409);
    // Instagram は同じ合鍵を延長するので、つながっている相手と許可の範囲は変わらない。
    // 投稿先IDは /me の正確な値で照合し、古い丸め済みIDだけ修復する。
    const long = await instagramRefreshToken(
      cfg,
      await decryptInstagramCredential(
        r.user_token_encrypted,
        cfg.encryptionKey,
      ),
    );
    // 既に保存された丸め済みIDも、接続確認時に同じ合鍵の /me から修復する。
    const profile = await instagramGraph<InstagramProfile>(cfg, 'me', long.token, {
      fields: 'id,username',
    });
    const exactId = typeof profile.id === 'string' ? profile.id : '';
    if (!/^\d{1,24}$/.test(exactId))
      throw new InstagramError('instagram_business_account_required', 403);
    // 合鍵は1本だけなので、2つの列へ同じものを入れ直す。
    const token = await encryptInstagramCredential(
        long.token,
        cfg.encryptionKey,
      ),
      user = token;
    const saved = await c.env.DB.prepare(
      'UPDATE instagram_connections SET page_id=?,instagram_id=?,page_token_encrypted=?,user_token_encrypted=?,expires_at=?,data_access_expires_at=?,scopes=?,refreshed_at=?,version=version+1 WHERE line_account_id=? AND version=?',
    )
      .bind(
        exactId,
        exactId,
        token,
        user,
        long.expiresAt,
        long.dataAccessExpiresAt,
        // 許可の範囲は延長で変わらないので、保存済みの値をそのまま残す。
        r.scopes,
        new Date().toISOString(),
        id,
        r.version,
      )
      .run();
    if (!saved.meta.changes) throw new InstagramError('version_conflict', 409);
    return c.json({
      success: true,
      data: {
        expiresAt: long.expiresAt,
        dataAccessExpiresAt: long.dataAccessExpiresAt,
        version: r.version + 1,
      },
    });
  },
);
instagram.delete(
  '/api/instagram/connection',
  requireRole('owner', 'admin'),
  async (c) => {
    const id = await account(c),
      b = await c.req.json<{ expectedVersion: number }>().catch(() => null);
    if (!b || !Number.isSafeInteger(b.expectedVersion) || b.expectedVersion < 1)
      throw new InstagramError('expected_version_required', 400);
    // 子を先に消す。版が変わっていたら本文・トークンを消さない。
    const r = await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM instagram_messages WHERE line_account_id=? AND EXISTS(SELECT 1 FROM instagram_connections WHERE line_account_id=? AND version=?)',
      ).bind(id, id, b.expectedVersion),
      c.env.DB.prepare(
        'DELETE FROM instagram_oauth_states WHERE line_account_id=? AND EXISTS(SELECT 1 FROM instagram_connections WHERE line_account_id=? AND version=?)',
      ).bind(id, id, b.expectedVersion),
      c.env.DB.prepare(
        'DELETE FROM instagram_connections WHERE line_account_id=? AND version=?',
      ).bind(id, b.expectedVersion),
    ]);
    if (!r[2]!.meta.changes) throw new InstagramError('version_conflict', 409);
    return c.json({ success: true, data: { disconnected: true } });
  },
);
instagram.post(
  '/api/instagram/sync',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const id = await account(c),
      cfg = ready(c),
      r = await connection(c, id);
    if (expired(r)) throw new InstagramError('meta_token_expired', 409);
    const token = await decryptInstagramCredential(
      r.page_token_encrypted,
      cfg.encryptionKey,
    );
    const [profile, posts] = await Promise.all([
      instagramGraph<InstagramProfile>(cfg, r.instagram_id, token, {
        fields:
          'id,username,name,biography,profile_picture_url,followers_count,media_count',
      }),
      instagramGraph<{ data: InstagramPost[] }>(
        cfg,
        `${r.instagram_id}/media`,
        token,
        {
          fields:
            'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
          limit: '25',
        },
      ),
    ]);
    const saved = await c.env.DB.prepare(
      'UPDATE instagram_connections SET profile_json=?,posts_json=?,username=?,synced_at=? WHERE line_account_id=? AND version=?',
    )
      .bind(
        JSON.stringify(profile),
        JSON.stringify(posts.data ?? []),
        profile.username ?? null,
        new Date().toISOString(),
        id,
        r.version,
      )
      .run();
    if (!saved.meta.changes) throw new InstagramError('version_conflict', 409);
    return c.json({
      success: true,
      data: { profile, posts: posts.data ?? [] },
    });
  },
);
for (const part of ['profile', 'posts'] as const) {
  instagram.get(`/api/instagram/${part}`, async (c) => {
    const id = await account(c);
    if (!instagramConfig(c.env))
      return c.json({
        success: true,
        data: { state: 'unconfigured', value: null },
      });
    const r = await connection(c, id);
    return c.json({
      success: true,
      data: {
        state: expired(r) ? 'expired' : 'connected',
        value: JSON.parse(
          (part === 'profile' ? r.profile_json : r.posts_json) ?? 'null',
        ),
        syncedAt: r.synced_at,
      },
    });
  });
}
instagram.get('/api/instagram/messages', async (c) => {
  const id = await account(c);
  if (!instagramConfig(c.env))
    return c.json({
      success: true,
      data: { state: 'unconfigured', messages: [], total: null },
    });
  const limit = listQueryNumber(c.req.query('limit'), 50),
    before = c.req.query('beforeId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new InstagramError('invalid_limit', 400);
  const anchor = before
    ? await c.env.DB.prepare(
        'SELECT received_at FROM instagram_messages WHERE id=? AND line_account_id=?',
      )
        .bind(before, id)
        .first<{ received_at: string }>()
    : null;
  if (before && !anchor) throw new InstagramError('not_found', 404);
  const args: unknown[] = [id];
  if (anchor) args.push(anchor.received_at, anchor.received_at, before);
  args.push(limit);
  const messages = (
    await c.env.DB.prepare(
      `SELECT id,sender_id senderId,recipient_id recipientId,content,attachments_json,received_at receivedAt FROM instagram_messages WHERE line_account_id=? ${anchor ? 'AND (received_at<? OR (received_at=? AND id<?))' : ''} ORDER BY received_at DESC,id DESC LIMIT ?`,
    )
      .bind(...args)
      .all()
  ).results;
  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) n FROM instagram_messages WHERE line_account_id=?',
  )
    .bind(id)
    .first<{ n: number }>();
  const responseItems = messages.map((r) => ({
        ...r,
        attachments: JSON.parse(String(r.attachments_json)),
        attachments_json: undefined,
      }));
  return c.json({
    success: true,
    data: buildOffsetListResponse({ messages: responseItems,
      total: total!.n, items: responseItems, paging: { limit }, sort: [{ field: 'receivedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }),
  });
});
instagram.post('/api/instagram/messages/:id/reply', inputJsonBoundary(), async (c) => {
  await account(c);
  return c.json(
    { success: false, error: 'meta_review_required', enabled: false },
    403,
  );
});
instagram.get('/api/instagram/webhook', async (c) => {
  const token = c.env.META_WEBHOOK_VERIFY_TOKEN,
    challenge = c.req.query('hub.challenge');
  if (
    !token ||
    c.req.query('hub.mode') !== 'subscribe' ||
    !challenge ||
    (await instagramHash(c.req.query('hub.verify_token') ?? '')) !==
      (await instagramHash(token))
  )
    return c.text('Forbidden', 403);
  return c.text(challenge);
});
instagram.post('/api/instagram/webhook', async (c) => {
  if (!c.env.META_APP_SECRET)
    return c.json({ success: false, error: 'unconfigured' }, 503);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > 1048576)
    return c.json({ success: false, error: 'payload_too_large' }, 413);
  if (
    !(await verifyInstagramSignature(
      raw,
      c.req.header('X-Hub-Signature-256'),
      c.env.META_APP_SECRET,
    ))
  )
    return c.json({ success: false, error: 'invalid_signature' }, 401);
  let payload: {
    object?: string;
    entry?: Array<{
      id: string;
      messaging?: Array<{
        sender?: { id: string };
        recipient?: { id: string };
        timestamp?: number;
        message?: {
          mid?: string;
          text?: string;
          attachments?: Array<{ type?: unknown; payload?: { url?: unknown } }>;
          is_echo?: boolean;
          is_deleted?: boolean;
        };
      }>;
    }>;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, 400);
  }
  if (
    !payload ||
    payload.object !== 'instagram' ||
    !Array.isArray(payload.entry)
  )
    return c.json({ success: true });
  for (const entry of payload.entry) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !Array.isArray(entry.messaging)
    )
      continue;
    const matches = await c.env.DB.prepare(
      `SELECT ig.line_account_id,ig.instagram_id,COALESCE(la.tenant_id,'${DEFAULT_TENANT_ID}') tenant_id FROM instagram_connections ig JOIN line_accounts la ON la.id=ig.line_account_id WHERE (ig.instagram_id=? OR ig.page_id=?) AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`,
    )
      .bind(entry.id, entry.id)
      .all<{ line_account_id: string; instagram_id: string; tenant_id: string }>();
    const rows = matches.results;
    if (!rows.length) continue;
    // DBに不整合が生じても異なる統括間に受信内容を配らない。
    if (rows.some((row) => row.tenant_id !== rows[0].tenant_id))
      continue;
    for (const row of rows) for (const event of entry.messaging ?? []) {
      const msg = event?.message;
      if (
        typeof msg?.mid !== 'string' ||
        msg.mid.length > 512 ||
        msg.is_echo ||
        typeof event.sender?.id !== 'string' ||
        event.recipient?.id !== row.instagram_id ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp! <= 0 ||
        event.timestamp! > 8640000000000000
      )
        continue;
      if (msg.is_deleted) {
        await c.env.DB.prepare(
          'DELETE FROM instagram_messages WHERE id=? AND line_account_id=?',
        )
          .bind(msg.mid, row.line_account_id)
          .run();
        continue;
      }
      const attachments = Array.isArray(msg.attachments)
        ? msg.attachments.slice(0, 20).flatMap((a) => {
            if (!a || typeof a.type !== 'string' || a.type.length > 40)
              return [];
            let url: string | null = null;
            if (
              typeof a.payload?.url === 'string' &&
              a.payload.url.length <= 8192
            ) {
              try {
                const u = new URL(a.payload.url);
                if (u.protocol === 'https:' && !u.username && !u.password)
                  url = u.href;
              } catch {}
            }
            return [{ type: a.type, url }];
          })
        : [];
      if (
        (typeof msg.text !== 'string' && !attachments.length) ||
        (typeof msg.text === 'string' && msg.text.length > 20000)
      )
        continue;
      const receivedAt = new Date(event.timestamp!).toISOString();
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO instagram_messages(id,line_account_id,instagram_id,sender_id,recipient_id,content,attachments_json,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
        .bind(
          msg.mid,
          row.line_account_id,
          row.instagram_id,
          event.sender.id,
          event.recipient.id,
          msg.text ?? '',
          JSON.stringify(attachments),
          receivedAt,
          new Date().toISOString(),
        )
        .run();
    }
  }
  return c.json({ success: true });
});
