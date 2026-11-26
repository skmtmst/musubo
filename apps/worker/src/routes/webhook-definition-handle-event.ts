import { handleFollowEvent } from './webhook-follow-event.js';
import { logWebhookStepFailure, recordWebhookAnalyticsEvent } from './webhook-analytics.js';
import { assignInbox } from '../services/inbox-assignment.js';
import { webhookDemoTargets } from '../services/webhook-demo-targets.js';
import { parseRestaurantConfirmationPostback, respondToRestaurantConfirmation } from '../services/restaurant-confirmations.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { handleResearchTap } from '../services/research-tap.js';
import { handleExtraPostback } from '../services/tap-extras.js';

import { stableWebhookStepId } from '../services/incoming-webhook-receipts.js';
import type { WorkflowExecution } from '../services/workflow-execution.js';
import { redeemCoupon } from '../services/coupon-redemption.js';
import { LineClient } from '@line-crm/line-sdk';
import { parseTapPostbackData } from '../lib/rich-menu-tap.js';
import { parseCarouselPostbackData } from '../lib/carousel-tap.js';
import { handleCarouselTap } from '../services/carousel-tap.js';
import { handleRichMenuTap } from '../features/rich-menus/rich-menu-tap/index.js';
import type { WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import { updateFriendFollowStatus, getFriendByLineUserIdForAccount, upsertChatOnMessage, jstNow, resolveLineCredential, toJstString, recordIncomingLineMessage, recordLineMessageUnsend } from '@line-crm/db';

import { fireEvent } from '../services/event-bus.js';
import { matchAndReply } from '../features/auto-replies/auto-reply/index.js';
import { buildMessage } from '../services/step-delivery.js';

import { parseQuestionPostback } from '../features/scenarios/scenario-question/index.js';
import { handleQuestionAnswer } from '../features/scenarios/scenario-question-answer/index.js';
import type { Env } from '../worker-env.js';
import { awardActivityMileage } from '../services/activity-mileage.js';

import { snapshotLineReplyPolicy } from '../services/line-webhook-reply-policy.js';
import { ensureFriendFromWebhookUser } from './webhook-definition-is-friend-scope-conflict.js';
import { handleFirstMessageTestEvent, isFirstMessageTestEvent } from '../services/getting-started-first-message.js';

export async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null,
  lineMessageAccountKey: string,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  ecommerce?: { baseUrl: string; secret: string },
  operatorMailEnv?: Env['Bindings'],
  execution?: WorkflowExecution,
  legacyLineMessageAccountKey?: string,
): Promise<void> {
  const replay=<T>(key:string,work:()=>Promise<T>):Promise<T>=>execution?execution.step(key,work):work();
  if (isFirstMessageTestEvent(event)) {
    await replay('first_message_test', () => handleFirstMessageTestEvent(execution?.mutationDb('first_message_test') ?? db, lineAccountId, event));
    return;
  }
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

  if (event.type === 'follow') {
    await handleFollowEvent(db, lineClient, event, lineAccessToken, lineAccountId, lineMessageAccountKey, workerUrl, liffUrl, r2, ecommerce, operatorMailEnv, execution);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const relationship = await replay('unfollow_relationship', async () => {
      const ownedDb = execution?.mutationDb('unfollow_relationship') ?? db;
      const friend = await getFriendByLineUserIdForAccount(ownedDb, userId, lineAccountId);
      const applied = await updateFriendFollowStatus(ownedDb, userId, false, lineAccountId, toJstString(new Date(event.timestamp)));
      return { friendId: friend?.id ?? null, applied, occurredAt: toJstString(new Date(event.timestamp)) };
    });
    const friend = relationship.friendId ? { id: relationship.friendId } : null;
    if (relationship.applied === false) return;
    await replay('recordWebhookAnalyticsEvent:2',()=>recordWebhookAnalyticsEvent(execution?.mutationDb('recordWebhookAnalyticsEvent:2') ?? db, lineAccountId, event, {
      friendId: friend?.id,
      eventType: 'friend_unfollow',
    }));
    if (friend) {
      await replay('fireEvent:3',()=>fireEvent(db, 'friend_unfollow', {
        sourceEventId: event.webhookEventId,
        sourceKind: 'line_webhook',
        occurredAt: new Date(event.timestamp).toISOString(),
        friendId: friend.id,
      }, lineAccessToken, lineAccountId, execution));
    }
    return;
  }

  // Flex ボタンの postback も自動返信条件へ通すが、入力の文をチャットに表示しない。
  if (event.type === 'postback') {
    // 専用の見本の返事は予約や自動返信の起点にしない。
    if (/^test:restaurant_(going|change|cancel)$/.test(event.postback.data)) return;
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId,toJstString(new Date(event.timestamp)));
    if (!friend) return;

    let rawPostbackData = (event as unknown as { postback: { data: string } }).postback.data;
    if (rawPostbackData.startsWith('tx=')) {
      const inner = await replay('tap_extra', () => handleExtraPostback(execution?.mutationDb('tap_extra') ?? db, friend.id, lineAccountId ?? null, rawPostbackData, event.webhookEventId));
      if (inner === null) return;
      rawPostbackData = inner;
    }
    if (rawPostbackData.startsWith('research:')) {
      const text = await replay('research_tap', () => handleResearchTap(db, friend.id, lineAccountId ?? null, rawPostbackData));
      if (event.replyToken) await lineClient.replyMessage(event.replyToken, [{ type: 'text', text }]);
      return;
    }
    if (rawPostbackData.startsWith('coupon_use:')) {
      const [assetId, receiptId] = rawPostbackData.slice('coupon_use:'.length).split(':');
      const result = await redeemCoupon(db, friend, lineAccountId ?? null, assetId, event.webhookEventId, new Date(event.timestamp), receiptId, {executorDependencies:{resolveLineAccessToken:async()=> 'existing-client',createLineClient:()=>lineClient}});
      if (!result.replayed && event.replyToken) await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: result.message }]);
      return;
    }

    /*
     * リッチメニューのボタン。
     *
     * どのボタンが押されたかを知るために、publish のときに data の先頭へ area の
     * id を付けている。ここで剥がして、運用者が設定した本来の data だけを下流へ流す。
     * 自動応答やオートメーションは「data がこの文字列と一致したら」で判定しているので、
     * こちらの都合で付けた目印を混ぜたままにすると、今まで当たっていた条件に
     * 当たらなくなる。
     *
     * 剥がすついでに、そのボタンに設定された動き（タグ付け・スコア加算・
     * テンプレート送信）をここで実行する。
     */
    /*
     * カルーセルの選択肢。
     *
     * リッチメニューと同じ考え方で、data にテンプレートと選択肢の番号を入れて
     * ある。押されたら、その選択肢に設定されたアクションを実行する。
     * 「1人につき1回まで」の制限にかかっていれば、決めたテキストを返して終わる。
     */
    const carouselTap = parseCarouselPostbackData(rawPostbackData);
    if (carouselTap) {
      await replay('recordWebhookAnalyticsEvent:1',()=>recordWebhookAnalyticsEvent(execution?.mutationDb('recordWebhookAnalyticsEvent:1') ?? db, lineAccountId, event, {
        friendId: friend.id,
        eventType: 'postback_received',
        dimensions: { matched: true },
      }));
      try {
        const result = await handleCarouselTap(db, lineClient, friend, carouselTap, {
          lineAccountId,
          replyToken: event.replyToken,
          sourceEventId: event.webhookEventId,
        });
        // 制限にかかったときは、ここで終わる。自動応答まで回すと、
        // 「もう押せません」と自動応答の両方が届く。
        if (result.kind === 'blocked') return;
      } catch (err) {
        logWebhookStepFailure('carousel_tap', err, lineAccountId, event);
      }
      // カルーセルの data は運用者が組んだ文字列ではないので、自動応答の
      // キーワード照合には回さない。
      return;
    }

    const tap = parseTapPostbackData(rawPostbackData);
    let postbackReplyToken: string | undefined = event.replyToken;
    let tapLabel: string | null = null;
    if (tap) {
      try {
        const tapResult = await replay('handleRichMenuTap:0',()=>handleRichMenuTap(execution?.mutationDb('handleRichMenuTap:0') ?? db, lineClient, friend, tap.areaId, {
          lineAccountId,
          replyToken: postbackReplyToken,
          sourceEventId: event.webhookEventId,
        }));
        if (tapResult.replyTokenConsumed) postbackReplyToken = undefined;
        tapLabel = tapResult.target?.label ?? null;
      } catch (err) {
        // ボタンの動きが失敗しても、下の自動応答までは止めない。
        logWebhookStepFailure('rich_menu_tap', err, lineAccountId, event);
      }
    }
    const postbackData = tap ? (tap.inner ?? '') : rawPostbackData;
    // 押されたボタンに本来の data が無い（テンプレートを送るだけ等）ときは、
    // トーク履歴に空行を残さないようボタン名を出す。
    const postbackLogText =
      postbackData || (tapLabel ? `[メニュー] ${tapLabel}` : '[メニュー]');

    /*
     * シナリオの質問メッセージの選択肢。
     *
     * data が `sq:<stepId>:<index>` の形なら、こちらで処理して抜ける。
     * auto_replies のキーワード照合には回さない。`sq:...` は利用者が
     * 打った言葉ではないので、キーワードに当たっても意味がない。
     *
     * 記録も向こうで取る（押した回数を数えるのに、記録より先に読む必要が
     * あるため）。
     */
    const restaurantReply = parseRestaurantConfirmationPostback(postbackData);
    if(restaurantReply && operatorMailEnv && restaurantTestEnabled(operatorMailEnv) && lineAccountId) {
      const confirmation=await db.prepare('SELECT reservation_version FROM rt_reservation_confirmations WHERE request_id=? AND friend_id=?').bind(restaurantReply.requestId,friend.id).first<{reservation_version:number}>();
      if(confirmation)await replay('restaurant_confirmation',()=>respondToRestaurantConfirmation(execution?.db??db,{...restaurantReply,friendId:friend.id,accountId:lineAccountId,expectedVersion:confirmation.reservation_version}));
      return;
    }
    const questionHit = parseQuestionPostback(postbackData);
    if (questionHit) {
      const answered = await replay('handleQuestionAnswer:0',()=>handleQuestionAnswer(execution?.db ?? db,
        lineClient,
        friend,
        { ...questionHit, lineAccountId },
        postbackReplyToken,
      ));
      if (answered.handled) {
        await replay('fireEvent:2',()=>fireEvent(db, 'postback_received', {
          sourceEventId: event.webhookEventId,
          sourceKind: 'line_webhook',
          occurredAt: new Date(event.timestamp).toISOString(),
          friendId: friend.id,
          eventData: { text: postbackData, matched: true },
          replyToken: answered.replyTokenConsumed ? undefined : postbackReplyToken,
        }, lineAccessToken, lineAccountId, execution));
        return;
      }
    }

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
    // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
    // delivery_type='push' は厳密には push ではないが、incoming/non-test として
    // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    await replay('postback_context', async () => ({ plain: !tap, hasData: Boolean(postbackData) }));
    let postbackIncomingLogId: string | null = null;
    try {
      postbackIncomingLogId=await replay('incoming_postback_log',async()=>{
        const id=await stableWebhookStepId(event.webhookEventId,'incoming-postback');
        await (execution?.mutationDb('incoming_postback_log') ?? db)
          .prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at, line_event_at)
            VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?, ?)`)
          .bind(id,friend.id,postbackLogText,lineAccountId ?? null,jstNow(),toJstString(new Date(event.timestamp))).run();
        return id;
      });
    } catch (err) {
      postbackIncomingLogId = null;
      logWebhookStepFailure('incoming_postback_log', err, lineAccountId, event);
    }

    // postback data を auto_replies にマッチさせて返信 (テキスト経路と共通)。
    // silent + automation で「返信なしでタグだけ付ける」構成もここで成立する。
    // 本来の data が無いボタン（テンプレートを送るだけ等）は、自動応答の
    // キーワード照合に回さない。空文字はどのキーワードとも照らし合わせようがない。
    // 返信の権利（replyToken）を先にテンプレート送信で使い切っている場合も回さない。
    // 自動応答は reply でしか返せないので、使い切った後に呼ぶと送信が失敗する。
    await replay('reply_policy', () => snapshotLineReplyPolicy(db, lineAccountId, 'postback'));
    const { matched: postbackMatched, replyTokenConsumed: postbackReplyTokenConsumed } = await replay('auto_reply', async () =>
      postbackData && postbackReplyToken
        ? await matchAndReply(db, lineClient, friend, postbackData, postbackReplyToken, {
            lineAccountId,
            workerUrl,
            logContext: 'postback',
            messageKind: 'postback',
            incomingEventId: event.webhookEventId,
            operatorMailEnv,
            incomingMessageLogId: postbackIncomingLogId,
            occurredAt: new Date(event.timestamp).toISOString(),
          })
        : { matched: false, replyTokenConsumed: false });

    // イベントバス発火: 専用イベント postback_received。
    // postback.data を text に載せることで、IF-THEN 自動化の keyword /
    // keyword_exact 条件がリッチメニューのタップ（タグ付与等）に効く。
    // message_received を流用しないのは意図的 — 流用すると既存インストールの
    // message_received スコアリング・catch-all 自動化・送信 Webhook 購読者が
    // メニュータップで誤発火し、条件側に source を見る術がないため。
    // なお upsertChatOnMessage は呼ばない: メニュータップは自発メッセージでは
    // ないので、未対応 inbox を汚さないのが正しい (テキスト経路との意図的な差分)。
    await replay('fireEvent:1',()=>fireEvent(db, 'postback_received', {
      sourceEventId: event.webhookEventId,
      sourceKind: 'line_webhook',
      occurredAt: new Date(event.timestamp).toISOString(),
      friendId: friend.id,
      // data が無いボタンでも、ボタン名でオートメーションを組めるようにする。
      eventData: { text: postbackData || tapLabel || '', matched: postbackMatched },
      replyToken: postbackReplyTokenConsumed ? undefined : postbackReplyToken,
    }, lineAccessToken, lineAccountId, execution));

    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ログ・受信箱・メディア保存はそのままに、自動応答の種別条件へ渡す。
  // 本文は捏造せず空文字で評価するため、キーワード条件のルールは当たらない。
  // 種別 + 時間帯等の条件で絞ったルール（例: 画像に定型文を返す）のみが動く。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId,toJstString(new Date(event.timestamp)));
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
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
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if (msg.type === 'image' && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    let logId = crypto.randomUUID();
    const recorded = await replay('incoming_message', () => recordIncomingLineMessage(execution?.mutationDb('incoming_message') ?? db, {
      id: logId,
      friendId: friend.id,
      messageType: msg.type,
      content: finalContent,
      lineAccountId,
      lineMessageAccountKey,
      legacyLineMessageAccountKey,
      lineMessageId: msg.id,
      createdAt: jstNow(),
      lineEventAt: toJstString(new Date(event.timestamp)),
      quoteToken: msg.quoteToken ?? null,
    }));
    logId = recorded.id;
    // 別webhook IDで同じmessageが再送された場合と、先に取消済みの場合は
    // マイル・自動応答・未読化などの副作用を繰り返さない。
    if (!recorded.inserted || recorded.isUnsent) return;
    await replay('reply_policy', () => snapshotLineReplyPolicy(db, lineAccountId, msg.type));
    await replay('awardActivityMileage:1',()=>awardActivityMileage(execution?.mutationDb('awardActivityMileage:1') ?? db, {
      eventType: 'message_received',
      source: 'line',
      sourceEventId: logId,
      friendId: friend.id,
      metadata: { messageType: msg.type },
    }));
    // 自動応答の評価へ渡す。重複抑止・停止中除外・別アカウント分離は
    // 既存の matchAndReply が担う。replyToken はメッセージイベントに付く。
    const { matched: nonTextMatched } = await replay('auto_reply', () => matchAndReply(
      db,
      lineClient,
      friend,
      '',
      event.replyToken,
      {
        lineAccountId,
        workerUrl,
        logContext: 'non-text-message',
        messageKind: msg.type,
        incomingEventId: event.webhookEventId,
            operatorMailEnv,
        incomingMessageLogId: logId,
        occurredAt: new Date(event.timestamp).toISOString(),
      },
    ));

    // 自動応答に当たらなかった自発メッセージだけ chat を unread に戻す
    // （テキスト経路と同じ扱い）。これが無いと resolved 除外
    // (unanswered-inbox CANDIDATES_SQL) が「解決済み後に画像だけ送ってきた
    // 友だち」をバッジ・未対応一覧から永久に落としてしまう。
    if (!nonTextMatched) {
      await replay('incoming_chat',()=>upsertChatOnMessage(execution?.mutationDb('incoming_chat') ?? db, friend.id, toJstString(new Date(event.timestamp))));
      if(friend.line_account_id) await assignInbox(db,friend.line_account_id,friend.id);
      if(operatorMailEnv&&lineAccountId)await replay('operator_push',async()=>{
        const chat=await db.prepare('SELECT id,COALESCE(assignee_staff_id,operator_id) AS operator_id FROM chats WHERE friend_id=?').bind(friend.id).first<{id:string;operator_id:string|null}>();if(!chat)return;
        const {dispatchOperatorEvent}=await import('../services/operator-notification-dispatch.js');
        await dispatchOperatorEvent(db,operatorMailEnv!,{lineAccountId:lineAccountId!,eventType:chat.operator_id?'inbox_assigned_reply':'inbox_new_inquiry',sourceEventId:logId,executionMode:'automatic'});
      });
    }
    if(!nonTextMatched&&lineAccountId)await replay('ai_qa_simulation',async()=>{
      const {simulateIncomingQa}=await import('../services/ai-auto-qa.js');
      await simulateIncomingQa(db,{account:lineAccountId,friendId:friend.id,eventId:event.webhookEventId??logId,question:content,kind:msg.type});
    });
    await replay('recordWebhookAnalyticsEvent:0',()=>recordWebhookAnalyticsEvent(execution?.mutationDb('recordWebhookAnalyticsEvent:0') ?? db, lineAccountId, event, {
      friendId: friend.id,
      eventType: 'message_received',
      dimensions: { messageType: msg.type, matched: nonTextMatched },
    }));
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId,toJstString(new Date(event.timestamp)));
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    let logId = crypto.randomUUID();

    // 受信メッセージをLINE message ID単位で記録する。取消が先着していた
    // 場合は本文を入れず、以後の副作用も起こさない。
    const recorded = await replay('incoming_message', () => recordIncomingLineMessage(execution?.mutationDb('incoming_message') ?? db, {
      id: logId,
      friendId: friend.id,
      messageType: 'text',
      content: incomingText,
      lineAccountId,
      lineMessageAccountKey,
      legacyLineMessageAccountKey,
      lineMessageId: textMessage.id,
      createdAt: now,
      lineEventAt: toJstString(new Date(event.timestamp)),
      quoteToken: textMessage.quoteToken ?? null,
    }));
    logId = recorded.id;
    if (!recorded.inserted || recorded.isUnsent) return;
    await replay('reply_policy', () => snapshotLineReplyPolicy(db, lineAccountId, 'text'));

    await replay('awardActivityMileage:0',()=>awardActivityMileage(execution?.mutationDb('awardActivityMileage:0') ?? db, {
      eventType: 'message_received',
      source: 'line',
      sourceEventId: logId,
      friendId: friend.id,
      metadata: { messageType: 'text' },
      occurredAt: now,
    }));

    // 同じ本人の UUID から別アカウントへ送る操作を扱う。
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {

          const otherFriends = await webhookDemoTargets(db, friendRecord.user_id, lineAccountId);

          for (const other of otherFriends) {
            const accessToken = await resolveLineCredential(
              other.channel_access_token_encrypted,
              other.channel_access_token,
              { lineAccountId: other.line_account_id, field: 'channel_access_token' },
            );
            const otherClient = new LineClient(accessToken);
            await otherClient.pushMessage(other.line_user_id, [buildMessage('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }


          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        logWebhookStepFailure('cross_account_trigger', err, lineAccountId, event);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）。
    // silent タイプは返信しないが matched=true になり unread / push を抑止する。
    const { matched, replyTokenConsumed } = await replay('auto_reply', () => matchAndReply(
      db,
      lineClient,
      friend,
      incomingText,
      event.replyToken,
      // 種別は LINE から届いたものをそのまま渡す。ルール側で
      // 「画像には返さない」といった絞り込みができる。
      {
        lineAccountId,
        workerUrl,
        messageKind: event.message?.type ?? 'text',
        incomingEventId: event.webhookEventId,
            operatorMailEnv,
        incomingMessageLogId: logId,
        occurredAt: new Date(event.timestamp).toISOString(),
      },
    ));

    // auto_replies にマッチしなかった = 自発メッセージ → unread にする
    if (!matched) {
      await replay('incoming_chat',()=>upsertChatOnMessage(execution?.mutationDb('incoming_chat') ?? db, friend.id, toJstString(new Date(event.timestamp))));
      if(friend.line_account_id) await assignInbox(db,friend.line_account_id,friend.id);
      if(operatorMailEnv&&lineAccountId)await replay('operator_push',async()=>{
        const chat=await db.prepare('SELECT id,COALESCE(assignee_staff_id,operator_id) AS operator_id FROM chats WHERE friend_id=?').bind(friend.id).first<{id:string;operator_id:string|null}>();if(!chat)return;
        const {dispatchOperatorEvent}=await import('../services/operator-notification-dispatch.js');
        await dispatchOperatorEvent(db,operatorMailEnv!,{lineAccountId:lineAccountId!,eventType:chat.operator_id?'inbox_assigned_reply':'inbox_new_inquiry',sourceEventId:logId,executionMode:'automatic'});
      });
    }

    // シミュレーションだけなので replyToken を消費せず、未読・担当者通知も抑止しない。キーワードルールを優先する。
    if (!matched && lineAccountId) await replay('ai_qa_simulation', async()=>{
      const {simulateIncomingQa}=await import('../services/ai-auto-qa.js');
      await simulateIncomingQa(db,{account:lineAccountId,friendId:friend.id,eventId:event.webhookEventId??logId,question:incomingText,kind:event.message?.type??'text'});
    });

    // 自動返信が消費していない replyToken だけを message_received のイベントへ渡す。
    await replay('fireEvent:0',()=>fireEvent(db, 'message_received', {
      sourceEventId: event.webhookEventId,
      sourceKind: 'line_webhook',
      occurredAt: new Date(event.timestamp).toISOString(),
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId, execution));

    return;
  }
}
