import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import { getFriendsByLineUserIds, readProxyPushRecipient } from './line-proxy-recipients.js';
import { hasSuppressedDeliveryRecipients } from '@line-crm/db/src/friend-delivery-consents.js';
import { Hono } from 'hono';
import { readBoundedBytes, readBoundedText } from '../lib/input-errors.js';
import type { Context } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import {
  listLineAccountsWithTenantStatus,
  getFriendByLineUserIdForAccount,
  upsertFriend,
  getChatByFriendId,
  createChat,
  updateChat,
  isOperationCapabilityStopped,
  jstNow,
  OPERATION_CAPABILITIES,
} from '@line-crm/db';
import type { Friend, LineAccount, OperationCapability } from '@line-crm/db';



import { OPERATION_PROXY_CAPABILITY_HEADER } from '../services/operation-send-paths.js';
import { authenticateApiToken } from '../middleware/auth.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { accountFeatureAvailability } from '../services/feature-enforcement.js';
import { messageToLogPayload } from '../services/step-delivery.js';
import type { Env } from '../worker-env.js';

/**
 * LINE API の直接送信が管理画面のチャット履歴から欠落しないよう、push / multicast / broadcast を messages_log に記録して転送する。
 * チャネルトークンは登録済みの値と照合し、未登録ならオープンリレーを防ぐため401で拒む。
 * API キー認証では Worker がチャネルトークンを保持し、呼び出し元へ配らない。複数アカウントの送信元は X-Line-Account-Id で指定する。
 * 担当者の個別返信だけ X-Line-Harness-Source: manual を付け、source='manual' とする。通常は source='external'。
 * reply は replyToken から宛先を解決できず、narrowcast は宛先が未確定なので、記録せず転送する。
 */
const lineProxy = new Hono<Env>();

// multicast の500宛先・5メッセージを収めつつ、上流送信前のメモリを制限するため、本文は Webhook と同じ1MiBまでとする。
const MAX_PROXY_BODY_SIZE = 1024 * 1024;

// 画像などのバイナリを壊さないよう ArrayBuffer で読み、LINE の1MB上限に余裕を持つ3MiBで制限する。
const MAX_BINARY_BODY_SIZE = 3 * 1024 * 1024;

// reply/narrowcast も JSON として解析し、履歴へ残らないことを案内する。
const MESSAGE_SEND_PATHS = new Set([
  '/v2/bot/message/push',
  '/v2/bot/message/multicast',
  '/v2/bot/message/broadcast',
  '/v2/bot/message/reply',
  '/v2/bot/message/narrowcast',
]);

// broadcast_dispatch の緊急停止  で止める送信パス。
// 例外は2系統: reply (replyToken 前提の1:1返信) と、push に
// X-Line-Harness-Source: manual を付けた担当者の個別返信。自動 push
// (manual 指定なし) は一斉送信と同じく停止対象。
const BULK_DISPATCH_PATHS = new Set([
  '/v2/bot/message/broadcast',
  '/v2/bot/message/multicast',
  '/v2/bot/message/narrowcast',
]);

// 未知の宛先はプロフィール取得と複数の D1 問い合わせを消費するため件数を制限する。超過分は黙って落とさず警告を残す。
const MAX_FRIEND_CREATIONS = 20;

// D1 の約100バインド上限に収めるため、8引数の行を12行ずつ INSERT し、25文を batch にまとめて問い合わせ予算を守る。
const ROWS_PER_INSERT = 11;
const STATEMENTS_PER_BATCH = 25;

const AUTH_FAILED = {
  message:
    'Authentication failed. Confirm that the access token in the authorization header is valid.',
};

// push/multicast の宛先のうち friend として記録できるのは実ユーザーのみ。
// group (C…) / room (R…) 宛は friend 行を捏造しないためスキップする。
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

type ParsedSend = { to?: unknown; messages?: unknown };

type ProxyLogSource = 'external' | 'manual';

type LogRow = {
  friendId: string;
  messageType: string;
  content: string;
  deliveryType: string | null;
  lineAccountId: string | null;
};

type ResolvedCaller = {
  /** 上流の LINE API で使うチャネルアクセストークン。 */
  upstreamToken: string;
  /** DB 登録済みならアカウント ID、環境の既定なら null を使う。 */
  lineAccountId: string | null;
  /**
 * 配信ログの範囲を確定するため、登録アカウントの総数を持つ。
 */
  accountCount: number;
  /** Harness のスタッフキーで認証した場合だけ保持する。 */
  staff?: Awaited<ReturnType<typeof authenticateApiToken>>;
};

function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function asMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is Message => !!m && typeof m === 'object' && 'type' in m);
}

/** チャネルトークンは DB・環境へ照合し、Harness の API キーは指定アカウント・単一の稼働アカウント・既定トークンへ解決する。認証や検証に失敗したら応答を返す。 */
async function resolveCaller(c: Context<Env>, token: string): Promise<ResolvedCaller | Response> {
  const accounts = await listLineAccountsWithTenantStatus(c.env.DB);
  // LINE API の直前の共通境界として、停止中アカウントをトークン解決から外す。個別処理が取得時の検査を忘れても送信させない。
  const active = accounts.filter((a) => a.is_active && a.tenant_status === 'active');

  // DB にあるトークンは統括境界を保つ。同じ値が環境にもあっても、停止中の統括が代替経路へ抜けないようにする。
  const registeredByToken = accounts.find((a) => a.channel_access_token === token);
  if (registeredByToken && registeredByToken.tenant_status !== 'active') {
    return c.json({ code: 'TENANT_SUSPENDED', message: '契約先の利用が停止されています' }, 403);
  }

  const byChannelToken = active.find((a) => a.channel_access_token === token);
  if (byChannelToken) {
    return {
      upstreamToken: token,
      lineAccountId: byChannelToken.id,
      accountCount: active.length,
    };
  }
  if (token === c.env.LINE_CHANNEL_ACCESS_TOKEN && !registeredByToken) {
    return { upstreamToken: token, lineAccountId: null, accountCount: active.length };
  }

  // harness API キー経路 — worker 側でチャネルトークンを解決する。
  const staff = await authenticateApiToken(c, token);
  if (!staff) return c.json(AUTH_FAILED, 401);

  const method = c.req.method.toUpperCase();
  if (staff.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return c.json({ message: 'Read-only staff cannot mutate LINE data' }, 403);
  }

  const requestedId = c.req.header('X-Line-Account-Id');
  let account: LineAccount | undefined;
  if (requestedId) {
    account = active.find((a) => a.id === requestedId || a.channel_id === requestedId);
    if (!account) {
      return c.json({ message: `Unknown X-Line-Account-Id: ${requestedId}` }, 400);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, staff, [account.id])) {
      return c.json({ message: 'LINE account not found' }, 404);
    }
  } else if (active.length === 1) {
    account = active[0];
  } else if (active.length > 1) {
    return c.json(
      { message: 'Multiple LINE accounts registered — set the X-Line-Account-Id header' },
      400,
    );
  }

  if (account && !await canAccessAllLineAccounts(c.env.DB, staff, [account.id])) {
    return c.json({ message: 'LINE account not found' }, 404);
  }
  if (account) {
    return {
      upstreamToken: account.channel_access_token,
      lineAccountId: account.id,
      accountCount: active.length,
      staff,
    };
  }
  if (c.env.LINE_CHANNEL_ACCESS_TOKEN) {
    // 稼働アカウントが0でも登録済みアカウントの停止を守る。未登録の互換用既定値だけを所属なしで扱う。
    const registeredDefault = accounts.some(
      (a) => a.channel_access_token === c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (registeredDefault || !await canAccessAllLineAccounts(c.env.DB, staff, [null])) {
      return c.json({ message: 'LINE account not found' }, 404);
    }
    return {
      upstreamToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
      lineAccountId: null,
      accountCount: active.length,
      staff,
    };
  }
  return c.json({ message: 'No LINE account configured' }, 400);
}

function requiredProxyPermission(method: string, path: string): string | null {
  if (method === 'POST' && ['/v2/bot/message/broadcast', '/v2/bot/message/multicast', '/v2/bot/message/narrowcast'].includes(path)) {
    return '/broadcasts';
  }
  if (
    (method === 'POST' && ['/v2/bot/message/push', '/v2/bot/message/reply'].includes(path)) ||
    (method === 'GET' && /^\/v2\/bot\/(?:profile\/[^/]+|message\/[^/]+\/content)$/.test(path))
  ) {
    return '/chats';
  }
  if (/^\/v2\/bot\/richmenu(?:\/|$)/.test(path)) return '/rich-menus';
  return null;
}

/** 未知の宛先は友だちを作るが、送信を理由に既存友だちの所属を変えないよう、line_account_id は新規作成時だけに設定する。 */
async function createFriendForRecipient(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  try {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      logger.error("line_proxy.create_friend_for_recipient_failed");
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      lineAccountId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    if (lineAccountId) {
      await db
        .prepare(
          'UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL',
        )
        .bind(lineAccountId, friend.id)
        .run();
    }
    return friend;
  } catch (err) {
    logger.error("line_proxy.create_friend_for_recipient_failed");
    return null;
  }
}

/**
 * 同じ送信キー（X-Line-Retry-Key）への再送で履歴を二重に書かないため、
 * キーがある送信は内容から決まるIDを使う。初回の200で履歴を書けなかった
 * 場合も、LINEが「受理済み」を返す409の再送で同じIDへ同じ行を補完できる。
 */
export async function deterministicLogId(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const bytes = new Uint8Array(digest.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

/** 多数配信でも D1 の問い合わせ予算を守るよう、履歴を複数行 INSERT にする。 */
async function insertLogRows(
  db: D1Database,
  rows: LogRow[],
  source: ProxyLogSource,
  logKey?: string | null,
  sentAt = jstNow(),
  staffId: string | null = null,
): Promise<void> {
  if (rows.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const values = chunk
      .map(() => `(?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`)
      .join(', ');
    const params: unknown[] = [];
    for (const [index, row] of chunk.entries()) {
      params.push(
        logKey
          ? await deterministicLogId(`line-proxy-send:${logKey}:${row.friendId}:${i + index}`)
          : crypto.randomUUID(),
        row.friendId,
        row.messageType,
        row.content,
        row.deliveryType,
        source,
        row.lineAccountId,
        sentAt,
        staffId,
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at, sent_by_staff_id)
           VALUES ${values}`,
        )
        .bind(...params),
    );
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
}

/** 1:1 push は operator 手動送信と同じ扱いでチャットを更新する (chats.ts:608 と同型)。 */
async function touchChat(db: D1Database, friendId: string, manualReply: boolean, sentAt: string): Promise<void> {
  const chat = (await getChatByFriendId(db, friendId)) ?? (await createChat(db, { friendId }));
  await updateChat(db, chat.id, { status: 'in_progress', lastMessageAt: sentAt, manualReply });
}

/** 上流では送信済みなので、履歴保存の失敗で200をエラーへ変えて再送を誘発しない。記録処理は例外を外へ投げない。 */
async function logProxySend(
  db: D1Database,
  caller: ResolvedCaller,
  path: string,
  rawBody: string,
  source: ProxyLogSource,
  logKey?: string | null,
  knownPushRecipient?: Friend | null,
): Promise<void> {
  try {
    const parsed = JSON.parse(rawBody) as ParsedSend;
    const messages = asMessages(parsed.messages);
    if (messages.length === 0) return;
    const payloads = messages.map(messageToLogPayload);
    const lineClient = new LineClient(caller.upstreamToken);
    const { lineAccountId } = caller;
    const rowsFor = (friendId: string, deliveryType: string | null): LogRow[] =>
      payloads.map((p) => ({
        friendId,
        messageType: p.messageType,
        content: p.content,
        deliveryType,
        lineAccountId,
      }));

    if (path === '/v2/bot/message/push' && typeof parsed.to === 'string') {
      if (!LINE_USER_ID_RE.test(parsed.to)) {
        logger.warn("line_proxy.record_push_send_failed");
        return;
      }
      const friend =
        (knownPushRecipient !== undefined ? knownPushRecipient : await getFriendByLineUserIdForAccount(db, parsed.to, lineAccountId)) ??
        (await createFriendForRecipient(db, lineClient, parsed.to, lineAccountId));
      if (!friend) return;
      const sentAt=jstNow();
      const staffId=source==='manual'&&caller.staff?.id ? (await db.prepare('SELECT id FROM staff_members WHERE id=?').bind(caller.staff.id).first<{id:string}>())?.id??null : null;
      await insertLogRows(db, rowsFor(friend.id, 'push'), source, logKey, sentAt, staffId);
      await touchChat(db, friend.id, source === 'manual',sentAt);
      return;
    }

    if (path === '/v2/bot/message/multicast' && Array.isArray(parsed.to)) {
      const userIds = [
        ...new Set(
          parsed.to.filter((t): t is string => typeof t === 'string' && LINE_USER_ID_RE.test(t)),
        ),
      ];
      const known = await getFriendsByLineUserIds(db, userIds, lineAccountId);
      const rows: LogRow[] = [];
      let created = 0;
      let skipped = 0;
      for (const userId of userIds) {
        let friend = known.get(userId) ?? null;
        if (!friend) {
          if (created >= MAX_FRIEND_CREATIONS) {
            skipped++;
            continue;
          }
          created++;
          friend = await createFriendForRecipient(db, lineClient, userId, lineAccountId);
        }
        if (friend) rows.push(...rowsFor(friend.id, 'push'));
      }
      if (skipped > 0) {
        logger.warn("line_proxy.record_multicast_send_failed");
      }
      await insertLogRows(db, rows, source, logKey);
      return;
    }

    if (path === '/v2/bot/message/broadcast') {
      // broadcast は1チャネルにしか届かないため、その所属の友だちだけを記録する。単一登録では所属 NULL の互換データも含める。
      let friendIds: string[] = [];
      if (caller.accountCount <= 1 && lineAccountId) {
        // 単一稼働でも、停止した別アカウントに固定された行は対象に含めない。
        const result = await db
          .prepare(
            'SELECT id FROM friends WHERE is_following = 1 AND (line_account_id = ? OR line_account_id IS NULL)',
          )
          .bind(lineAccountId)
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else if (caller.accountCount <= 1) {
        const result = await db
          .prepare('SELECT id FROM friends WHERE is_following = 1')
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else if (lineAccountId) {
        const result = await db
          .prepare('SELECT id FROM friends WHERE is_following = 1 AND line_account_id = ?')
          .bind(lineAccountId)
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else {
        // 複数アカウントで未登録トークンの宛先は特定できないため、全友だちへ送った履歴を作らない。全体配信の記録にはアカウント登録が必要。
        logger.warn("line_proxy_broadcast_not_logged_env_token_is_not_registered_in_line_accounts_and_multiple_accou");
        return;
      }
      const rows = friendIds.flatMap((friendId) => rowsFor(friendId, null));
      await insertLogRows(db, rows, source, logKey);
      logger.log("routes_line_proxy_log");
      return;
    }

    if (path === '/v2/bot/message/reply' || path === '/v2/bot/message/narrowcast') {
      logger.warn("line_proxy.record_broadcast_send_failed");
    }
  } catch (err) {
    logger.error("line_proxy.log_proxy_send_failed");
  }
}

function proxyHandler(prefix: string, upstreamBase: string, logSends: boolean) {
  return async (c: Context<Env>): Promise<Response> => {
    const url = new URL(c.req.url);
    const encodedPath = url.pathname.slice(prefix.length);
    // 上流が復号する /%70ush などで検査を回避しないよう、復号したパスで送信を判定する。
    let path: string;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      return c.json({ message: 'Not found' }, 404);
    }
    if (!path.startsWith('/v2/bot/') || !encodedPath.startsWith('/v2/bot/')) {
      return c.json({ message: 'Not found' }, 404);
    }

    const token = bearerToken(c.req.header('Authorization'));
    if (!token) return c.json(AUTH_FAILED, 401);

    // オープンリレーを防ぐため、既知のチャネルまたは Harness キー以外のトークンは拒む。
    const caller = await resolveCaller(c, token);
    if (caller instanceof Response) return caller;

    const method = c.req.method.toUpperCase();
    if (caller.staff) {
      const requiredPermission = requiredProxyPermission(method, path);
      if (!requiredPermission) return c.json({ message: 'LINE proxy endpoint not allowed' }, 403);
      if (caller.staff.role === 'staff' && !caller.staff.permissionKeys?.includes(requiredPermission)) {
        return c.json({ message: 'Permission denied' }, 403);
      }
    }
    const isMessageSend = logSends && method === 'POST' && MESSAGE_SEND_PATHS.has(path);

    // 互換入口も、認証方式によらず管理 API と同じ機能スイッチ・契約を守る。
    const featureId = method === 'POST' && BULK_DISPATCH_PATHS.has(path)
      ? 'broadcasts'
      : /^\/v2\/bot\/(?:richmenu(?:\/|$)|user\/[^/]+\/richmenu(?:\/|$))/.test(path) ? 'rich_menus' : null;
    if (featureId && !caller.lineAccountId && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return c.json({
        code: 'LINE_ACCOUNT_REQUIRED',
        message: 'Register this LINE channel before using account-scoped features.',
      }, 400);
    }
    if (featureId && caller.lineAccountId) {
      const availability = await accountFeatureAvailability(c.env.DB, caller.lineAccountId, featureId);
      const retainedRead = ['GET', 'HEAD'].includes(method) && availability.reason === 'contract_unavailable';
      if (!availability.effectiveEnabled && !retainedRead) {
        return c.json({
          message: availability.message,
          code: availability.reason === 'contract_unavailable' ? 'FEATURE_NOT_ENTITLED'
            : availability.reason === 'dependency_disabled' ? 'FEATURE_DEPENDENCY_DISABLED' : 'FEATURE_DISABLED',
          featureId,
          reason: availability.reason,
        }, 403);
      }
    }

    // Proxy 経由の自動送信と、人間が行う個別返信を区別する。未指定は従来どおり
    // external。manual は 1:1 push だけに限定し、一斉配信で未対応をまとめて消す
    // 事故を防ぐ。独自ヘッダーは上流 LINE API には転送しない。
    const requestedSource = c.req.header('X-Line-Harness-Source');
    let logSource: ProxyLogSource = 'external';
    if (isMessageSend && requestedSource) {
      if (requestedSource !== 'manual') {
        return c.json({ message: 'X-Line-Harness-Source must be manual' }, 400);
      }
      if (path !== '/v2/bot/message/push') {
        return c.json(
          { message: 'X-Line-Harness-Source: manual is only supported for push messages' },
          400,
        );
      }
      logSource = 'manual';
    }

    // 履歴の解析に必要なメッセージはテキストで読み、画像などはバイト列のまま読み、文字コード変換で壊さない。
    let rawBody: string | undefined;
    let binaryBody: ArrayBuffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const cap = isMessageSend ? MAX_PROXY_BODY_SIZE : MAX_BINARY_BODY_SIZE;
      const declared = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
      if (Number.isFinite(declared) && declared > cap) {
        return c.json({ message: 'Payload too large' }, 413);
      }
      if (isMessageSend) {
        const text = await readBoundedText(c.req.raw, cap);
        if (text === null) {
          return c.json({ message: 'Payload too large' }, 413);
        }
        rawBody = text;
      } else {
        const bytes = await readBoundedBytes(c.req.raw, cap);
        if (bytes === null) {
          return c.json({ message: 'Payload too large' }, 413);
        }
        binaryBody = bytes.buffer as ArrayBuffer;
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${caller.upstreamToken}`,
    };
    const contentType = c.req.header('Content-Type');
    if (contentType) headers['Content-Type'] = contentType;
    const retryKey = c.req.header('X-Line-Retry-Key');
    if (retryKey) headers['X-Line-Retry-Key'] = retryKey;

    /*
     * 緊急停止の判定は副作用 (上流fetch) の直前に置く。
     * broadcast/multicast/narrowcast と manual 指定なしの自動 push は、
     * 該当 capability が止まっている間は上流へ一切出さない。
     * 例外は reply と X-Line-Harness-Source: manual の push —— 人間が
     * 相手を見て送る1:1返信は一斉送信の停止対象ではない。
     *
     * X-Line-Harness-Capability で送信経路の停止対象を名乗れる。
     * 値が無い・知らない値の自動送信は従来どおり broadcast_dispatch
     * (一斉送信 = 安全側) として止める。
     * アカウント単位の停止とグローバル (*) の停止の両方が効く。
     */
    const requestedCapability = c.req.header(OPERATION_PROXY_CAPABILITY_HEADER);
    const dispatchCapability: OperationCapability =
      requestedCapability &&
      (OPERATION_CAPABILITIES as readonly string[]).includes(requestedCapability)
        ? (requestedCapability as OperationCapability)
        : 'broadcast_dispatch';
    const isBulkDispatch =
      method === 'POST' &&
      (BULK_DISPATCH_PATHS.has(path) ||
        (path === '/v2/bot/message/push' && logSource !== 'manual'));
    if (
      isBulkDispatch &&
      (await isOperationCapabilityStopped(c.env.DB, caller.lineAccountId, dispatchCapability))
    ) {
      return c.json(
        { message: 'Message dispatch is stopped by emergency operation control' },
        409,
      );
    }

    let knownPushRecipient: Friend | null | undefined;
    if(isBulkDispatch) {
      let uids:string[]|undefined;
      if(path.endsWith('/push')||path.endsWith('/multicast')) {
        let payload: {to?:unknown};
        try {payload=JSON.parse(rawBody??'{}');} catch {return c.json({message:'Invalid message payload'},400);}
        if(typeof payload.to==='string') uids=[payload.to];
        else if(Array.isArray(payload.to)&&payload.to.every(v=>typeof v==='string')) uids=payload.to;
        else return c.json({message:'Invalid message recipients'},400);
      }
      let suppressed: boolean;
      if(path==='/v2/bot/message/push'&&caller.lineAccountId&&uids?.length===1&&LINE_USER_ID_RE.test(uids[0])) {
        const recipient=await readProxyPushRecipient(c.env.DB,caller.lineAccountId,uids[0]);
        knownPushRecipient=recipient.friend; suppressed=recipient.suppressed;
      } else suppressed=await hasSuppressedDeliveryRecipients(c.env.DB,caller.lineAccountId,uids);
      if(suppressed) {
        return c.json({message:'Message dispatch contains recipients with delivery suppression',code:'DELIVERY_CONSENT_SUPPRESSED'},409);
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamBase}${encodedPath}${url.search}`, {
        method,
        headers,
        body: rawBody ?? binaryBody,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.error("line_proxy.proxy_handler_failed");
      return c.json({ message: 'Upstream request failed' }, 502);
    }

    /*
     * LINE が同じ送信キーを受理済みとして返す409（応答消失後の再送
     * など）でも履歴を書く。本文は一度だけ届いているが、初回の200で履歴の
     * 保存が落ちたとき、再送の409へ追従して同じ決まったIDの行を補完する。
     * insertLogRows は送信キーから決まるIDの INSERT OR IGNORE なので、
     * 初回の保存が済んでいれば二重には書かない。
     */
    const dedupeAccepted = Boolean(
      retryKey && upstream.status === 409 && upstream.headers.get('x-line-accepted-request-id'),
    );
    if (isMessageSend && rawBody && (upstream.ok || dedupeAccepted)) {
      // 多数宛先の記録で応答が遅れ再送されないよう、可能ならバックグラウンドへ分ける。Workers 以外ではその場で待つ。
      const logging = logProxySend(c.env.DB, caller, path, rawBody, logSource, retryKey, knownPushRecipient);
      try {
        c.executionCtx.waitUntil(logging);
      } catch {
        await logging;
      }
    }

    const responseHeaders = new Headers();
    for (const name of [
      'content-type',
      'x-line-request-id',
      'x-line-accepted-request-id',
      'retry-after',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    // 大きな画像・動画でメモリを膨らませたり内容を壊したりしないよう、応答は stream のまま返す。
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  };
}

lineProxy.all('/line-api/*', proxyHandler('/line-api', 'https://api.line.me', true));
lineProxy.all('/line-api-data/*', proxyHandler('/line-api-data', 'https://api-data.line.me', false));

export { lineProxy };
