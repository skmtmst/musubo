import { logger } from '@line-crm/shared/server';
import { logWebhookStepFailure, recordWebhookAnalyticsEvent } from './webhook-analytics.js';
import { assignInbox } from '../services/inbox-assignment.js';
import { LineClient } from '@line-crm/line-sdk';
import type { WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import { upsertFriend, updateFriendFollowStatus, getFriendByLineUserIdForAccount, upsertChatOnMessage, jstNow, toJstString, recordIncomingLineMessage, recordLineMessageUnsend } from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { isFirstMessageTestEvent } from '../services/getting-started-first-message.js';

export // 署名確認前の巨大本文による負荷を防ぐため、1MiBに制限する。大量イベントをまとめても余裕を保ち、Worker の128MBメモリを圧迫しない。
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024;

export /**
 * friends.line_user_id はグローバル UNIQUE のため (C-2b までは1ユーザー1行)、
 * 別アカウント所有の行があるとこのアカウント用の行は INSERT できない。
 * その場合は相手の行に触れず「このアカウントでは友だちを解決できない」
 * として扱う。
 */
function isFriendScopeConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed: friends\.line_user_id/i.test(message);
}

export async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
  followOccurredAt?:string,
): Promise<Friend | null> {
  const friend = await getFriendByLineUserIdForAccount(db, userId, lineAccountId);
  if (friend?.line_account_id === lineAccountId) return friend;

  if (friend) {
    // 読み取った未割当行がまだ未割当で、対象アカウントに行がないときだけ引き当てる。
    if (!lineAccountId || friend.line_account_id !== null) return null;
    await db.prepare(`UPDATE friends SET line_account_id = ?, updated_at = ?
      WHERE id = ? AND line_account_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM friends WHERE line_account_id = ? AND line_platform_user_id = ?)`)
      .bind(lineAccountId, jstNow(), friend.id, lineAccountId, userId)
      .run();
    const scopedFriend = await getFriendByLineUserIdForAccount(db, userId, lineAccountId);
    if (scopedFriend?.line_account_id === lineAccountId) return scopedFriend;
    // 別アカウントが先に引き当てた場合は、受信アカウント用の行を作る。
  }

  let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
  try {
    profile = await lineClient.getProfile(userId);
  } catch (err) {
    // 署名済み受信は利用者の接触を証明するため、プロフィール取得に失敗してもLINE userIdで友だちを作る。
    logWebhookStepFailure('unknown_user_profile', err, lineAccountId);
  }

  try {
    const registered = await upsertFriend(db, {
      lineUserId: userId,
      lineAccountId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
      followOccurredAt,
    });
    if (registered.line_account_id !== lineAccountId) return null;
    logger.log("line_webhook_friend_registered");
    return registered;
  } catch (err) {
    if (!isFriendScopeConflict(err)) throw err;
    logger.warn("line_webhook_friend_scope_conflict");
    return null;
  }
}

export /** 停止中の統括も受信データは保持するが、外部の副作用は起こさない。新しい返信経路で送信が復活しないよう、handleEvent と分離して守る。 */
async function handleStoppedTenantEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccountId: string | null,
  lineMessageAccountKey: string,
  legacyLineMessageAccountKey?: string,
): Promise<void> {
  if (isFirstMessageTestEvent(event)) return;
  if (event.type === 'unsend') {
    await recordLineMessageUnsend(db, {
      lineMessageAccountKey,
      lineAccountId,
      lineMessageId: event.unsend.messageId,
      sourceUserId: event.source.type === 'user' ? event.source.userId : null,
      unsentAt: toJstString(new Date(event.timestamp)),
    });
    return;
  }

  const userId = event.source.type === 'user' ? event.source.userId : undefined;
  if (!userId) return;

  if (event.type === 'unfollow') {
    const friend = await getFriendByLineUserIdForAccount(db, userId, lineAccountId);
    const applied = await updateFriendFollowStatus(db, userId, false, lineAccountId, toJstString(new Date(event.timestamp)));
    if (applied === false) return;
    await recordWebhookAnalyticsEvent(db, lineAccountId, event, {
      friendId: friend?.id,
      eventType: 'friend_unfollow',
      dimensions: { tenantStopped: true },
    });
    return;
  }

  const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId,toJstString(new Date(event.timestamp)));
  if (!friend) return;

  if (event.type === 'follow') {
    await updateFriendFollowStatus(db, userId, true, lineAccountId, toJstString(new Date(event.timestamp)));
    await recordWebhookAnalyticsEvent(db, lineAccountId, event, {
      friendId: friend.id,
      eventType: 'friend_follow',
      dimensions: { tenantStopped: true },
    });
    return;
  }

  if (event.type === 'postback') {
    const data = (event as unknown as { postback: { data: string } }).postback.data || '[メニュー]';
    try {
      await db.prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at, line_event_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), friend.id, data, lineAccountId, jstNow(), toJstString(new Date(event.timestamp))).run();
    } catch (error) {
      logWebhookStepFailure('stopped_tenant_postback_log', error, lineAccountId, event);
    }
    return;
  }

  if (event.type !== 'message') return;
  const message = event.message as {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    title?: string;
    packageId?: string | number;
    package_id?: string | number;
    stickerId?: string | number;
    sticker_id?: string | number;
    stickerResourceType?: string | number;
    sticker_resource_type?: string | number;
    quoteToken?: string;
  };
  const labels: Record<string, string> = {
    sticker: '[スタンプ]', image: '[画像]', audio: '[音声]', video: '[動画]',
    file: message.fileName ? `[ファイル: ${message.fileName}]` : '[ファイル]',
    location: message.title ? `[位置情報: ${message.title}]` : '[位置情報]',
  };
  let content = message.type === 'text' ? (message.text ?? '') : (labels[message.type] ?? `[${message.type}]`);
  if (message.type === 'sticker') {
    const sticker = createStickerMessageContent(message);
    if (sticker) content = JSON.stringify(sticker);
  }
  const recorded = await recordIncomingLineMessage(db, {
    id: crypto.randomUUID(),
    friendId: friend.id,
    messageType: message.type,
    content,
    lineAccountId,
    lineMessageAccountKey,
    legacyLineMessageAccountKey,
    lineMessageId: message.id,
    createdAt: jstNow(),
    lineEventAt: toJstString(new Date(event.timestamp)),
    quoteToken: message.quoteToken ?? null,
  });
  if (!recorded.inserted || recorded.isUnsent) return;
  await upsertChatOnMessage(db, friend.id, toJstString(new Date(event.timestamp)));
  if(friend.line_account_id) await assignInbox(db,friend.line_account_id,friend.id);
  await recordWebhookAnalyticsEvent(db, lineAccountId, event, {
    friendId: friend.id,
    eventType: 'message_received',
    dimensions: { messageType: message.type, matched: false, tenantStopped: true },
  });
}

export /** 契約者専用LINEへ届いた 6 桁の確認コードを権限者の紐づけとして処理する。処理したら true。 */
async function handleNoticeLinkCode(
  env: Env['Bindings'],
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccountId: string | null,
): Promise<boolean> {
  if (event.type !== 'message' || event.message.type !== 'text' || !lineAccountId) return false;
  const text = (event.message as TextEventMessage).text.trim();
  if (!/^\d{6}$/.test(text)) return false;
  const userId = event.source.type === 'user' ? event.source.userId : undefined;
  if (!userId) return false;
  const { tryLinkStaffByCode } = await import('../services/platform-announcements.js');
  const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId,toJstString(new Date(event.timestamp)));
  if (!friend) return false;
  return tryLinkStaffByCode(env, {
    lineAccountId,
    friendId: friend.id,
    text,
    reply: async (message) => {
      if (event.replyToken) await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: message }]);
    },
  });
}

export /**
 * follow の外部送信の結末。「送っていない」と「送ったか分からない」を
 * 分けて持つ。分けないと、届いたかもしれない実行を自動で送り直す。
 */
type FollowSendOutcome = 'none' | 'failed' | 'unknown' | 'delivered';

export /**
 * 同じ意味の送信に、実行が違っても同じ値になるキーを作る（`X-Line-Retry-Key`）。
 * LINE は同じキーの2回目を受け付け済みとして扱うので、予約と関門をすり抜けた
 * 万一の同時送信でも二重に届かない。UUID の形にそろえる。
 */
function stableRetryKey(seed: string): string {
  // FNV-1a を4本、別の初期値で回して128bitぶんの桁を作る。
  const offsets = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const words = offsets.map((offset) => {
    let hash = offset >>> 0;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  });
  const hex = words.join('');
  return [
    hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export /**
 * 送信の例外を「届いていない」と「届いたかもしれない」に分ける。
 * LINE が 4xx で断ったときは受け付けられていないので届いていない。
 * 通信断・タイムアウト・429・5xx は結果を知らないだけで届いていることがある。
 */
function classifyFollowSendFailure(error: unknown): 'failed' | 'unknown' {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) return 'failed';
  return 'unknown';
}
