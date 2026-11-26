import { logger } from '@line-crm/shared/server';
import { resolveLineSender } from '../services/line-senders.js';
import { GapError } from '../services/gap-common.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import type { Message } from '@line-crm/line-sdk';
import { getChatById, updateChat, jstNow } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { classifyLineOutboundFailure, completeOutboundSendStatement, failOutboundSend, hashOutboundPayload, isValidIdempotencyKey, reserveOutboundSend } from '../services/outbound-idempotency.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { inboxEventStatement, acquireInboxReplyLease, releaseInboxReplyLease } from '../services/inbox-events.js';
import { fireEvent } from '../services/event-bus.js';
import { renderChatMessageContent, unresolvedVariablesPayload } from '../services/manual-send-interpolation.js';
import { buildChatMessage, ChatAttachmentError } from '../services/chat-attachments.js';
import { resolveOrCreateChat, resolveFriendAndAccessToken, QuotedMessageRow, resolveQuotedMessage } from './chats-definition.js';
import type { Context } from 'hono';

export const post__api_chats_id_send_1 = async (c: Context<Env, "/api/chats/:id/send">) => {
  if (c.get('impersonation')) return c.json({ success: false, code: 'IMPERSONATION_SEND_BLOCKED', error: '代理ログイン中は送れません' }, 403);
  if (c.get('staff').readOnly) return c.json({ success: false, error: 'forbidden' }, 403);
  let leasedConversationId: string | null = null;
  try {
    const chatId = c.req.param('id');
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return inputError(c, { success: false, error: '有効なIdempotency-Keyが必要です' }, 400, []);
    }
    const chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return fail(c, 404, 'CHAT_NOT_FOUND');

    // 壊れたJSONは外側catchの500に落とさない。運用者が原因を判別できるよう400で返す。
    let body: { messageType?: string; content: string; revision?: number; quotedMessageId?: string; correctionOfMessageId?: string; senderId?: string };
    try {
      body = await c.req.json<{ messageType?: string; content: string; revision?: number; quotedMessageId?: string; correctionOfMessageId?: string; senderId?: string }>();
    } catch {
      return inputError(c, { success: false, error: 'content is required' }, 400, ["content"]);
    }
    if (typeof body?.content !== 'string' || !body.content) return inputError(c, { success: false, error: 'content is required' }, 400, ["content"]);
    if (body.revision !== undefined && body.revision !== chat.revision) {
      return c.json({
        success: false,
        error: 'ほかの担当者が先に更新しました。最新の会話を確認してください',
        code: 'REVISION_CONFLICT',
        data: { revision: chat.revision },
      }, 409);
    }

    const { friend, accessToken, liffId } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
      'chats.manual-send',
    );
    if (!friend) return fail(c, 404, 'FRIEND_NOT_FOUND');
    if (friend.is_following !== 1) return c.json({ success: false, error: 'ブロックまたは友だち解除された相手には送信できません', code: 'FRIEND_NOT_FOLLOWING' }, 409);

    if (!await canAccessAllLineAccounts(
      c.env.DB,
      c.get('staff'),
      [friend.line_account_id ?? null],
    )) {
      return fail(c, 404, 'CHAT_NOT_FOUND');
    }

    if (body.correctionOfMessageId !== undefined) {
      if (typeof body.correctionOfMessageId !== 'string' || !await c.env.DB.prepare(
        `SELECT id FROM messages_log WHERE id=? AND friend_id=? AND line_account_id IS ? AND direction='outgoing'
         AND unsent_at IS NULL AND (delivery_type IS NULL OR delivery_type!='test')`,
      ).bind(body.correctionOfMessageId, friend.id, friend.line_account_id ?? null).first()) {
        return c.json({ success: false, error: 'correction_source_not_found' }, 404);
      }
    }

    let sender: Awaited<ReturnType<typeof resolveLineSender>> | null = null;
    if (body.senderId !== undefined) {
      if (typeof body.senderId !== 'string' || !friend.line_account_id) return c.json({success:false,error:'invalid_sender'},400);
      try { sender = await resolveLineSender(c.env.DB,friend.line_account_id,c.get('staff'),body.senderId); }
      catch(e) { if(e instanceof GapError) return c.json({success:false,error:e.code},e.status); throw e; }
    }

    // 差し込みは一斉配信と同じ解決器で置き換える。解決しきれない
    // `{{…}}` が残るなら、LINE呼出し0・履歴書込み0のまま構造化して拒否する。
    // lease・冪等予約より前に置くので、拒否時はDBへ何も書かない。
    const rendered = await renderChatMessageContent(
      c.env.DB, friend, body.messageType ?? 'text', body.content, liffId,
      { kind: 'chat', id: friend.id },
    );
    if (rendered.unresolved.length > 0) {
      return inputError(c, { success: false, ...unresolvedVariablesPayload(rendered.unresolved) }, 400, ["friend","messageType","content","liffId"]);
    }

    // 引用元の検証は外部送信より前に行う。別friend・別アカウント・取消済みを
    // 指定されてもここで止め、LINE呼び出しも保存もしない。
    let quoted: QuotedMessageRow | null = null;
    if (body.quotedMessageId) {
      quoted = await resolveQuotedMessage(c.env.DB, {
        friendId: friend.id,
        lineAccountId: friend.line_account_id ?? null,
        quotedMessageId: body.quotedMessageId,
      });
      if (!quoted) {
        return c.json({ success: false, error: '引用元のメッセージが見つかりません' }, 404);
      }
    }

    const leaseNow = new Date();
    const lease = await acquireInboxReplyLease(c.env.DB, {
      channel: 'line',
      conversationId: friend.id,
      staffId: c.get('staff').id,
      conversationRevision: chat.revision,
      now: leaseNow.toISOString(),
      expiresAt: new Date(leaseNow.getTime() + 60_000).toISOString(),
    });
    if (!lease.acquired) {
      return c.json({
        success: false,
        error: 'ほかの担当者が返信中です。送信せず、少し待って最新の会話を確認してください',
        code: 'REPLY_LEASE_CONFLICT',
        data: { staffId: lease.staffId, expiresAt: lease.expiresAt },
      }, 409);
    }
    leasedConversationId = friend.id;

    // LINE APIでメッセージ送信
    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken);
    const messageType = body.messageType ?? 'text';
    let message: Message;
    let renewalMessage: Message | undefined;
    try {
      const built = await buildChatMessage({
        messageType, content: rendered.content, bucket: c.env.IMAGES, signingSecret: c.env.API_KEY,
        owner: { friendId: friend.id, lineAccountId: friend.line_account_id ?? null },
        origin: c.env.WORKER_URL || new URL(c.req.url).origin,
      });
      message = built.message;
      renewalMessage = built.renewalMessage;
      rendered.content = built.content;
    } catch (error) {
      if (error instanceof ChatAttachmentError) return inputError(c, { success: false, code: error.code, error: error.message }, 400, ["attachmentIds"]);
      throw error;
    }

    // 引用元にLINEのquoteTokenが残っていれば、顧客側にも引用表示として届く。
    if (quoted?.quote_token) message.quoteToken = quoted.quote_token;
    if (sender) Object.assign(message, {sender});

    const payloadHash = await hashOutboundPayload(
      JSON.stringify({
        chatId: chat.id,
        friendId: friend.id,
        messageType,
        content: body.content,
        quotedMessageId: quoted?.id ?? null,
        correctionOfMessageId: body.correctionOfMessageId ?? null,
        senderId: body.senderId ?? null,
        sender,
      }),
    );
    const reservation = await reserveOutboundSend(c.env.DB, {
      key: idempotencyKey,
      channel: 'line',
      resourceId: chat.id,
      payloadHash,
      lineAccountId: friend.line_account_id ?? null,
      // in_progress はLINE受理後の応答喪失を含み得るため、自動再送しない。
      retryInProgress: false,
      now: new Date().toISOString(),
    });
    if (reservation.kind === 'conflict') {
      await releaseInboxReplyLease(c.env.DB, { channel: 'line', conversationId: friend.id, staffId: c.get('staff').id });
      leasedConversationId = null;
      return c.json({ success: false, error: '同じ送信キーを別の内容には使用できません' }, 409);
    }
    if (reservation.kind === 'in_progress') {
      await releaseInboxReplyLease(c.env.DB, { channel: 'line', conversationId: friend.id, staffId: c.get('staff').id });
      leasedConversationId = null;
      return c.json({
        success: false,
        error: '同じメッセージを送信中か、送信結果を確認中です',
        code: 'OUTBOUND_SEND_IN_PROGRESS',
      }, 409);
    }
    if (reservation.kind === 'failed') {
      await releaseInboxReplyLease(c.env.DB, { channel: 'line', conversationId: friend.id, staffId: c.get('staff').id });
      leasedConversationId = null;
      return c.json({
        success: false,
        error: reservation.retryable ? '再送できる時刻までお待ちください' : 'この送信は自動再送できません',
        code: reservation.code,
        data: { retryable: reservation.retryable, nextRetryAt: reservation.nextRetryAt },
      }, 409);
    }
    if (reservation.kind === 'unknown') {
      await releaseInboxReplyLease(c.env.DB, { channel: 'line', conversationId: friend.id, staffId: c.get('staff').id });
      leasedConversationId = null;
      return c.json({
        success: false,
        error: 'LINEへの送達結果を確認できないため、自動再送を停止しました',
        code: reservation.code,
        data: { retryable: false, nextRetryAt: null },
      }, 409);
    }
    if (reservation.kind === 'replay') {
      await releaseInboxReplyLease(c.env.DB, { channel: 'line', conversationId: friend.id, staffId: c.get('staff').id });
      leasedConversationId = null;
      return c.json({
        success: true,
        data: {
          sent: true,
          messageId: reservation.responseId,
          sentByStaffName: c.get('staff').name,
          revision: chat.revision,
          replayed: true,
        },
      });
    }

    // LINE 側にも同じキーを渡す。DB保存前に通信が切れて再実行されても、
    // LINE API が同一リクエストを二重配信しない。
    const outboundLeaseToken = reservation.leaseToken;
    try {
      await lineClient.pushMessage(friend.line_user_id, [message, ...(renewalMessage ? [renewalMessage] : [])], idempotencyKey);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const failure = classifyLineOutboundFailure(error, failedAt);
      await failOutboundSend(c.env.DB, {
        key: idempotencyKey,
        leaseToken: outboundLeaseToken,
        status: failure.status,
        code: failure.code,
        retryable: failure.retryable,
        nextRetryAt: failure.nextRetryAt,
        now: failedAt,
      });
      await releaseInboxReplyLease(c.env.DB, {
        channel: 'line', conversationId: friend.id, staffId: c.get('staff').id,
      });
      leasedConversationId = null;
      return inputError(c, {
        success: false,
        error: sender && (error as {status?:number})?.status===400 ? '送り手の名前かアイコンを確認してください。送り手なしで送ることもできます' : failure.status === 'unknown'
          ? 'LINEへの送達結果を確認できないため、自動再送を停止しました'
          : 'LINEへ送信できませんでした',
        code: failure.code,
        data: { retryable: failure.retryable, nextRetryAt: failure.nextRetryAt },
      }, failure.httpStatus, []);
    }

    // メッセージログに記録
    const logId = idempotencyKey;
    const sentAt = jstNow();
    try {
      await c.env.DB.batch([
        c.env.DB
          .prepare(`INSERT OR IGNORE INTO messages_log
            (id, friend_id, direction, message_type, content, source, line_account_id,
             sent_by_staff_id, created_at, quoted_message_id, correction_of_message_id, sender_id, sender_snapshot_json)
            VALUES (?, ?, 'outgoing', ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            logId,
            friend.id,
            messageType,
            rendered.content,
            friend.line_account_id ?? null,
            c.get('staff').id,
            sentAt,
            quoted?.id ?? null,
            body.correctionOfMessageId ?? null,
            body.senderId ?? null,
            sender ? JSON.stringify(sender) : null,
          ),
        completeOutboundSendStatement(c.env.DB, {
          key: idempotencyKey,
          responseId: logId,
          now: new Date().toISOString(),
          leaseToken: outboundLeaseToken,
        }),
      ]);
    } catch {
      const failedAt = new Date().toISOString();
      await failOutboundSend(c.env.DB, {
        key: idempotencyKey,
        leaseToken: outboundLeaseToken,
        status: 'unknown',
        code: 'OUTBOUND_CONFIRMATION_FAILED',
        retryable: false,
        nextRetryAt: null,
        now: failedAt,
      });
      await releaseInboxReplyLease(c.env.DB, {
        channel: 'line', conversationId: friend.id, staffId: c.get('staff').id,
      });
      leasedConversationId = null;
      return c.json({
        success: false,
        error: 'LINEには受理された可能性がありますが、送信履歴を確定できませんでした',
        code: 'OUTBOUND_CONFIRMATION_FAILED',
        data: { retryable: false, nextRetryAt: null },
      }, 503);
    }

    // チャットの最終メッセージ日時を更新（chat.id を直接使う — friend_id で呼ばれても resolveOrCreateChat 済み）
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', lastMessageAt: sentAt });
    const updatedChat = await getChatById(c.env.DB, chat.id);
    await inboxEventStatement(c.env.DB, {
      channel: 'line',
      conversationId: friend.id,
      eventType: 'send',
      before: null,
      after: { messageId: logId, status: 'in_progress', source: 'manual' },
      actorStaffId: c.get('staff').id,
      correlationId: idempotencyKey,
      createdAt: sentAt,
    }).run();

    // 初回返信の時刻を残す（107）。
    //
    // 受信してから最初に返すまでの時間を出すために要る。
    // まだ入っていないときだけ入れる。2回目以降の返信で上書きすると、
    // 「最初に返すまで」ではなく「最後に返したのはいつか」になる。
    //
    // 失敗しても送信そのものは成功しているので、握りつぶす。
    try {
      await c.env.DB
        .prepare(
          `UPDATE chats SET first_replied_at = ?
            WHERE id = ? AND first_replied_at IS NULL`,
        )
        .bind(jstNow(), chat.id)
        .run();
    } catch (e) {
      logger.error("chats.chats_id_send_post_failed");
    }

    await fireEvent(c.env.DB, 'manual_reply_sent', {
      sourceEventId: logId,
      sourceKind: 'manual_reply',
      occurredAt: sentAt,
      friendId: friend.id,
      eventData: { staffId: c.get('staff').id },
    }, undefined, friend.line_account_id).catch((error) => {
      logger.error("chats.chats_id_send_post_failed");
    });

    await releaseInboxReplyLease(c.env.DB, {
      channel: 'line', conversationId: friend.id, staffId: c.get('staff').id,
    });
    leasedConversationId = null;

    return c.json({
      success: true,
      data: {
        sent: true,
        messageId: logId,
        sentByStaffName: c.get('staff').name,
        revision: updatedChat?.revision ?? chat.revision + 1,
      },
    });
  } catch (err) {
    if (leasedConversationId) {
      await releaseInboxReplyLease(c.env.DB, {
        channel: 'line', conversationId: leasedConversationId, staffId: c.get('staff').id,
      }).catch(() => undefined);
    }
    throw err;
  }
};

export const post__api_chats_id_render_preview_2 = async (c: Context<Env, "/api/chats/:id/render-preview">) => {
  try {
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return fail(c, 404, 'CHAT_NOT_FOUND');

    let body: { messageType?: unknown; content?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return inputError(c, { success: false, error: 'content is required' }, 400, ["content"]);
    }
    const content = typeof body?.content === 'string' ? body.content : '';
    if (!content) return inputError(c, { success: false, error: 'content is required' }, 400, ["content"]);
    const messageType = typeof body.messageType === 'string' ? body.messageType : 'text';

    const { friend, liffId } = await resolveFriendAndAccessToken(
      c.env.DB, chat.friend_id, c.env.LINE_CHANNEL_ACCESS_TOKEN, 'chats.render-preview',
    );
    if (!friend) return fail(c, 404, 'FRIEND_NOT_FOUND');
    if (!await canAccessAllLineAccounts(
      c.env.DB, c.get('staff'), [friend.line_account_id ?? null],
    )) {
      return fail(c, 404, 'CHAT_NOT_FOUND');
    }

    // 送信しないプレビュー。共通情報は送信と同じ期限・代替値で解決するが、台帳には記録しない。
    const rendered = await renderChatMessageContent(
      c.env.DB, friend, messageType, content, liffId,
    );
    return c.json({
      success: true,
      data: { content: rendered.content, unresolved: rendered.unresolved },
    });
  } catch (err) {
    throw err;
  }
};
