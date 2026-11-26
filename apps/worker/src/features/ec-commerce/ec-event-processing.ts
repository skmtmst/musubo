export type { EcDispatchSubscriber } from './dispatch-types.js';
import type { EcDispatchSubscriber } from './dispatch-types.js';
import { logger } from '@line-crm/shared/server';
import { workflowLineClient } from '../../services/workflow-line-client.js';
import { getEcDispatchStatus, markEcDispatch } from './ec-dispatch-ledger.js';
import { upsertEcEventReadModels } from '@line-crm/db';
import { acquireWorkflow, type WorkflowExecution } from '../../services/workflow-execution.js';
import {
  getWorkflowStep,
  attachEcOrderFriend,
  getCustomerNotificationSource,
  getFriendByLineUserIdForAccount,
  getLineAccountById,
  recordConversionSourceEvent,
  recordCustomerEcDelivery,
  setEcActionExecutionStatus,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { fireEvent, logOutgoingMessage } from '../../services/event-bus.js';
import {
  buildEcV6Event,
  ecDispatchIdempotencyKey,
  ecNotificationRetryKey,
} from './ec-event-publish.js';
import { classifyExternalDeliveryError } from '../../services/external-delivery-retry.js';
import { enqueuePostShippingFollowUps } from '../../services/nen-engagement.js';
import { ecFlexMessage } from './ec-notification-message.js';
import { syncNenEcTags, syncNenPetTags } from '../../services/nen-tag-sync.js';
// 受け取った会員情報の反映は、HTTP受付と再試行で同じ処理を使う。
import { syncMemberSnapshot, type EcEvent } from './member-snapshot.js';

/**
 * へ1回分の連携を行い、購読台帳へ結果を残す。側の失敗は台帳へ
 * `failed` として残してから投げ直す(呼び出し側は再試行へ回す)。
 * 送信済みの記録自体に失敗したときは黙殺せず、そのまま投げる。
 */
async function fireEcV6Event(
  db: D1Database,
  input: {
    eventId: string; lineAccountId: string; externalEventId: string;
    event: EcEvent; friendId: string; accessToken: string; now: string;
    credentialKey?: string;
    execution?: WorkflowExecution;
  },
): Promise<void> {
  const idempotencyKey = ecDispatchIdempotencyKey(input.lineAccountId, input.externalEventId, 'v6');
  // 送信済みの購読先は送らない。実行状態の更新失敗で再試行になっても、
  // 成功済みを再発火させない。並行受信は台帳claim(atomic UPDATE)が fence する。
  if (await getEcDispatchStatus(db, input.eventId, 'v6') === 'sent') return;
  const v6Event = buildEcV6Event(input.event, input.friendId);
  try {
    await fireEvent(
      db, v6Event.eventType, v6Event.payload, input.accessToken, input.lineAccountId,
      input.execution, input.credentialKey,
    );
  } catch (error) {
    try {
      await markEcDispatch(db, {
        eventId: input.eventId, subscriber: 'v6', status: 'failed',
        error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        idempotencyKey, now: input.now,
      });
    } catch (markError) {
      logger.error("services_ec_event_processing_failed");
    }
    throw error;
  }
  await markEcDispatch(db, {
    eventId: input.eventId, subscriber: 'v6', status: 'sent', idempotencyKey, now: input.now,
  });
}

/** 定義の公開版configから文面項目を取る。文字列以外・未設定は null へ畳む。 */
function notificationText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}


export type EcEventOutcome = 'processed' | 'skipped' | 'identity_pending' | 'duplicate';

export async function processEcEvent(
  db: D1Database,
  input: {
    account: NonNullable<Awaited<ReturnType<typeof getLineAccountById>>>;
    lineAccountId: string;
    event: EcEvent;
    eventRowId: string;
    now: string;
    credentialKey?: string;
    identityRecovery?: 'analytics_snapshot'|'non_delivery_actions';
  },
): Promise<EcEventOutcome> {
  const { account, lineAccountId, event, now, credentialKey } = input;
  const row = { id: input.eventRowId };
  const connector = await db.prepare('SELECT status,event_types_json FROM ec_connectors WHERE line_account_id=?').bind(lineAccountId).first<{status:string;event_types_json:string}>();
  if (connector && (connector.status==='paused' || !(JSON.parse(connector.event_types_json) as string[]).includes(event.event_type))) {
    await db.prepare("UPDATE ec_events SET status='skipped',error_message=?,updated_at=? WHERE id=? AND status IN ('received','failed')").bind(connector.status==='paused'?'connector_paused':'event_not_subscribed',now,row.id).run();
    await setEcActionExecutionStatus(db,{eventId:row.id,lineAccountId,status:'skipped',errorCode:connector.status==='paused'?'connector_paused':'event_not_subscribed',now});
    return 'skipped';
  }
  // 顧客 ID を全体で一意と扱わず、接続元・店舗・アカウントで絞って結び付ける。
  if(event.customer_id!=null) {
    const linked = await db.prepare(`SELECT f.line_platform_user_id AS line_user_id FROM ec_identity_links l JOIN friends f ON f.id=l.friend_id AND f.line_account_id=l.line_account_id
      JOIN ec_connectors c ON c.line_account_id=l.line_account_id AND c.shop_domain=l.shop_key
      WHERE l.line_account_id=? AND l.external_customer_id=? AND l.source_key=(SELECT source FROM ec_events WHERE id=?) AND l.unlinked_at IS NULL`).bind(lineAccountId,String(event.customer_id),row.id).first<{line_user_id:string}>();
    if(linked) event.line_user_id=linked.line_user_id;
  }

  const claim = await db.prepare(
    `UPDATE ec_events SET status = 'processing', error_message = NULL, updated_at = ?
     WHERE id = ? AND status IN ('received', 'failed')`,
  ).bind(now, row.id).run();
  if (!claim.meta.changes) return 'duplicate';

  // 元イベントの実行権は取り直さず、その確定後に工程のチェックポイントを追加する。
  const execution=await acquireWorkflow(db,{scopeId:`line:${lineAccountId}`,processKind:input.identityRecovery?'ec_identity_recovery':'ec_event',subjectId:row.id},{maxAttempts:50});
  if(!execution) {
    const done=await getWorkflowStep(db,{scopeId:`line:${lineAccountId}`,processKind:input.identityRecovery?'ec_identity_recovery':'ec_event',subjectId:row.id,stepKey:'__run'});
    if(done?.status==='succeeded') {
      if(await getEcDispatchStatus(db,row.id,'notification')==='sent' && event.line_user_id){
        const friend=await getFriendByLineUserIdForAccount(db,event.line_user_id,lineAccountId);
        const source=await getCustomerNotificationSource(db,lineAccountId,event.event_type);
        if(friend)await recordCustomerEcDelivery(db,{lineAccountId,sourceEventType:event.event_type,sourceEventId:event.event_id,
          metadata:{orderNumber:event.order?.number ?? null},definitionId:source?.definitionId ?? null,definitionVersionId:source?.versionId ?? null,
          recipientId:friend.id,idempotencyKey:await ecNotificationRetryKey(lineAccountId,event.event_id),attemptedSend:false,finish:{kind:'accepted'}});
      }
      const outcome=JSON.parse(done.result_json ?? '{}')?.outcome ?? 'processed';
      await db.prepare(`UPDATE ec_events SET status=?,updated_at=? WHERE id=? AND status='processing'`).bind(outcome,now,row.id).run();
      await setEcActionExecutionStatus(db,{eventId:row.id,lineAccountId,status:outcome==='processed'?'succeeded':'skipped',now});
      return outcome;
    }
    return 'duplicate';
  }
  try {
    // 初回受領が失敗しても同じ地点から回復できるよう、再送と cron がチェックポイントを共有する。イベント成功を返す前に表示用データを確定する。
    if(event.customer_id!=null) await (await import('./ec-identity-recovery.js')).detectEcIdentityCandidates(db,row.id,event,lineAccountId);
    await execution.step('read_models', async () => {
      const source = await execution.db.prepare('SELECT source FROM ec_events WHERE id=?').bind(row.id).first<{source:string}>();
      await upsertEcEventReadModels(execution.db, {
        eventId: row.id, sourceKey: source?.source ?? `eccube:${lineAccountId}`,
        externalEventId: event.event_id, eventType: event.event_type, lineAccountId,
        customerId: event.customer_id == null ? null : String(event.customer_id),
        occurredAt: event.occurred_at, order: event.order, refund: event.refund,
      }, now);
    });
    const outcome=await processClaimedEcEvent(execution.db,input,execution);
    await execution.complete({outcome});
    return outcome;
  }catch(error){
    const latest=await getWorkflowStep(db,execution.ref);
    if(latest?.lease_owner!==execution.owner && ['running','succeeded'].includes(latest?.status ?? '')) return 'duplicate';
    await execution.fail();throw error;
  }
}

async function processClaimedEcEvent(db:D1Database,input:Parameters<typeof processEcEvent>[1],execution:WorkflowExecution):Promise<EcEventOutcome>{
  const {account,lineAccountId,event,now,credentialKey}=input;
  const row={id:input.eventRowId};
  // 受付口では弾いているが、保存済み payload の直叩きに備えてここでも守る。
  // 無いまま進むと誰宛か分からない送信になる。
  if (!event.line_user_id) {
    await db.prepare(
      `UPDATE ec_events SET status = 'identity_pending', error_message = 'line_identity_unmatched', updated_at = ? WHERE id = ?`,
    ).bind(now, row.id).run();
    await setEcActionExecutionStatus(db, {
      eventId: row.id, lineAccountId, status: 'skipped',
      errorCode: 'line_identity_unmatched', errorMessageSafe: 'LINEの友だちが見つかりません', now,
    });
    return 'identity_pending';
  }

  {
    //  顧客通知定義があるイベントは定義だけが正本。published の
    // ときだけ送り、文面は確定済み版の config から取る。定義が無いイベント
    // だけ従来の ec_notification_settings を見る(未移行の互換)。
    const notificationSource = await getCustomerNotificationSource(
      db, lineAccountId, event.event_type,
    );
    const ledgerBase = {
      lineAccountId,
      sourceEventType: event.event_type,
      sourceEventId: event.event_id,
      metadata: { orderNumber: event.order?.number ?? null },
      definitionId: notificationSource?.definitionId ?? null,
      definitionVersionId: notificationSource?.versionId ?? null,
    } as const;
    const friend = await getFriendByLineUserIdForAccount(db, event.line_user_id, lineAccountId);
    if (!friend || !friend.is_following) {
      await db.prepare(
        `UPDATE ec_events SET status = ?, error_message = ?, processed_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        friend ? 'skipped' : 'identity_pending',
        friend ? 'friend_not_following' : 'line_identity_unmatched',
        friend ? now : null,
        now,
        row.id,
      ).run();
      //  送れなかった結果も共通送信台帳へ残す。プロフィール同期は
      // 顧客通知を出さないので台帳へは書かない。
      if (event.event_type !== 'ec.customer.profile_updated') {
        await recordCustomerEcDelivery(db, {
          ...ledgerBase,
          recipientId: friend?.id ?? event.line_user_id,
          idempotencyKey: await ecNotificationRetryKey(lineAccountId, event.event_id),
          attemptedSend: false,
          finish: {
            kind: 'excluded',
            errorCode: friend ? 'friend_not_following' : 'line_identity_unmatched',
            errorMessage: friend ? 'LINEの友だちが現在フォローしていません' : 'LINEの友だちが見つかりません',
          },
        });
      }
      await setEcActionExecutionStatus(db, {
        eventId: row.id, lineAccountId, status: 'skipped',
        errorCode: friend ? 'friend_not_following' : 'line_identity_unmatched',
        errorMessageSafe: friend ? 'LINEの友だちが現在フォローしていません' : 'LINEの友だちが見つかりません',
        now,
      });
      return friend ? 'skipped' : 'identity_pending';
    }

    if (friend.line_account_id !== lineAccountId) throw new Error('EC event account mismatch');
    await attachEcOrderFriend(db, { eventId: row.id, lineAccountId, friendId: friend.id, now });
    const accessToken = account.channel_access_token;
    if (!accessToken) throw new Error('LINE access token is not configured');

    if(input.identityRecovery==='analytics_snapshot') {
      await attachEcOrderFriend(db,{eventId:row.id,lineAccountId,friendId:friend.id,now});
      await db.prepare("UPDATE ec_events SET status='processed',friend_id=?,processed_at=?,updated_at=? WHERE id=?").bind(friend.id,now,now,row.id).run();
      await setEcActionExecutionStatus(db,{eventId:row.id,lineAccountId,status:'succeeded',now});
      return 'processed';
    }
    await execution.step('member_snapshot',()=>syncMemberSnapshot(execution.mutationDb('member_snapshot'),friend.id,event,now));
    await execution.step('member_tags',()=>syncNenEcTags(execution.mutationDb('member_tags'),friend.id,new Date(now),input.identityRecovery?`ec-history:${lineAccountId}:${event.event_id}`:undefined));

    // 注文の確定を成果計測へ接続する。「注文が確定した」を起点に選んだ
    // 地点は、ここを通らないと 0 件のままになる。
    //
    // この位置は、この後のどの出口(通知停止で skipped / 通常の processed)を
    // 通っても必ず通る。冪等キーは EC 側の event_id なので、同じ注文の再送
    // (台帳 claim をすり抜けた再試行を含む)でも二度数えない。
    // 記録に失敗しても注文処理は続ける(通知を落とさない)。
    if (event.event_type === 'ec.order.confirmed') {
      // 注文にクーポンが使われていれば、発行台帳の used_at を立てる。
      // EC側のクーポン利用台帳とは別物なので、ここが記録口の1つになる
      // （もう1つは /api/integrations/eccube/coupon-usages）。冪等（used_at IS NULL の行だけ）。
      const couponCode = typeof event.order?.coupon_code === 'string' ? event.order.coupon_code.trim() : '';
      if (couponCode) {
        await db.prepare(
          `UPDATE nen_coupon_issues SET used_at = ? WHERE coupon_code = ? AND used_at IS NULL`,
        ).bind(event.occurred_at.slice(0, 19).replace('T', ' '), couponCode).run();
      }
      try {
        // 注文の合計を型付きの数値として渡す。無い・壊れているときは
        // 0円にせず金額なし(null)で記録し、metadata にも残して後から
        // 追えるようにする。
        const orderTotal = event.order?.total;
        const orderValue = typeof orderTotal === 'number'
          && Number.isFinite(orderTotal) && orderTotal >= 0
          ? orderTotal : null;
        await recordConversionSourceEvent(db, {
          sourceType: 'ec_order_confirmed',
          lineAccountId,
          friendId: friend.id,
          sourceEventId: event.event_id,
          value: orderValue,
          metadata: {
            ecEventId: event.event_id,
            orderNumber: event.order?.number ?? null,
            orderTotal: orderValue,
          },
        });
      } catch (error) {
        logger.error("services_ec_event_processing_failed");
      }
    }

    if(input.identityRecovery) {
      await db.prepare("UPDATE ec_events SET status='processed',friend_id=?,processed_at=?,updated_at=? WHERE id=?").bind(friend.id,now,now,row.id).run();
      await setEcActionExecutionStatus(db,{eventId:row.id,lineAccountId,status:'succeeded',now});
      return 'processed';
    }
    if (event.event_type === 'ec.customer.profile_updated') {
      const { syncNenPetProfiles } = await import('../../services/nen-engagement.js');
      await execution.step('pet_profiles',()=>syncNenPetProfiles(execution.mutationDb('pet_profiles'),event,friend.id));
      await execution.step('pet_tags',()=>syncNenPetTags(execution.mutationDb('pet_tags'),friend.id));

      await fireEcV6Event(db, {
        eventId: row.id, lineAccountId, externalEventId: event.event_id,
        event, friendId: friend.id, accessToken, now, credentialKey, execution,
      });
      await db.prepare(
        `UPDATE ec_events SET friend_id = ?, status = 'processed', processed_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(friend.id, now, now, row.id).run();
      await setEcActionExecutionStatus(db, {
        eventId: row.id, lineAccountId, status: 'succeeded', now,
      });
      return 'processed';
    }

    const setting = notificationSource
      ? {
          // 正本の定義があるときは、公開中の版だけを送る。下書き・停止は送らない。
          is_enabled: notificationSource.status === 'published' ? 1 : 0,
          title_override: notificationText(notificationSource.config.title) ?? notificationSource.name,
          intro_text: notificationText(notificationSource.config.introText),
          outro_text: notificationText(notificationSource.config.outroText),
          button_label: notificationText(notificationSource.config.buttonLabel),
          button_url: notificationText(notificationSource.config.buttonUrl),
          image_url: notificationText(notificationSource.config.imageUrl),
        }
      : await db.prepare(
          `SELECT COALESCE(a.is_enabled, s.is_enabled) AS is_enabled,
                  CASE WHEN a.line_account_id IS NULL THEN s.title_override ELSE a.title_override END AS title_override,
                  CASE WHEN a.line_account_id IS NULL THEN s.intro_text ELSE a.intro_text END AS intro_text,
                  CASE WHEN a.line_account_id IS NULL THEN s.outro_text ELSE a.outro_text END AS outro_text,
                  CASE WHEN a.line_account_id IS NULL THEN s.button_label ELSE a.button_label END AS button_label,
                  CASE WHEN a.line_account_id IS NULL THEN s.button_url ELSE a.button_url END AS button_url,
                  CASE WHEN a.line_account_id IS NULL THEN s.image_url ELSE a.image_url END AS image_url
             FROM ec_notification_settings s
             LEFT JOIN ec_notification_account_settings a
               ON a.event_type = s.event_type AND a.line_account_id = ?
            WHERE s.event_type = ?`,
        ).bind(lineAccountId, event.event_type).first<{
          is_enabled: number; title_override: string | null; intro_text: string | null; outro_text: string | null;
          button_label: string | null; button_url: string | null; image_url: string | null;
        }>();

    if (event.event_type === 'ec.order.shipped') {
      await execution.step('shipping_followups',()=>enqueuePostShippingFollowUps(execution.mutationDb('shipping_followups'),event,friend.id,account.id));
    }

    // 分析とシナリオ向けのイベントは保ち、取引通知の送信だけを独立して停止できるようにする。
    if (setting?.is_enabled === 0) {

      //  通知停止(定義の draft/stopped、旧設定のOFF)も共通台帳へ
      // 「対象外」として残す。この処理では送っていないので試行は増やさない。
      await recordCustomerEcDelivery(db, {
        ...ledgerBase,
        recipientId: friend.id,
        idempotencyKey: await ecNotificationRetryKey(lineAccountId, event.event_id),
        attemptedSend: false,
        finish: {
          kind: 'excluded',
          errorCode: 'notification_disabled',
          errorMessage: 'この通知は設定で停止されています',
        },
      });
      await fireEcV6Event(db, {
        eventId: row.id, lineAccountId, externalEventId: event.event_id,
        event, friendId: friend.id, accessToken, now, credentialKey, execution,
      });
      await db.prepare(
        `UPDATE ec_events SET friend_id = ?, status = 'skipped', error_message = 'notification_disabled', processed_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(friend.id, now, now, row.id).run();
      await setEcActionExecutionStatus(db, {
        eventId: row.id, lineAccountId, status: 'skipped',
        errorCode: 'notification_disabled', errorMessageSafe: 'この通知は設定で停止されています', now,
      });
      return 'skipped';
    }

    // 通知設定の見出し・前後の文章にも {{var.*}} を書ける。消えた
    // 共通情報は空文字へ置き換えず、この通知を止める（台帳に残る）。
    const { expandSendCommonVars } = await import('../../services/interpolation-context.js');
    const ecSource = { kind: 'notification' as const, id: row.id };
    const ecCtx = { lineAccountId, friendId: friend.id };
    const expandEcField = (value: string | null) =>
      value ? expandSendCommonVars(db, value, ecSource, ecCtx) : Promise.resolve(value);
    const [ecTitle, ecIntroText, ecOutroText] = await Promise.all([
      expandEcField(setting?.title_override ?? null),
      expandEcField(setting?.intro_text ?? null),
      expandEcField(setting?.outro_text ?? null),
    ]);
    const message = ecFlexMessage(event, {
      title: ecTitle ?? undefined,
      introText: ecIntroText ?? undefined,
      outroText: ecOutroText ?? undefined,
      buttonLabel: setting?.button_label,
      buttonUrl: setting?.button_url,
      imageUrl: setting?.image_url,
    });
    // 通知は購読先別の台帳で管理する。照合契約:
    // - sent → 送らない(再試行・並行とも)
    // - failed/なし → 固定retry keyで送る
    // - pending(送達不明: 送信後に台帳書込が落ちた) → 同じ固定keyで送り直す。
    //   LINE側がキーで重複を抑える(X-Line-Retry-Key、受理済みは409)ため安全。
    const lineClient = new LineClient(accessToken);
    //  共通台帳の冪等キーはLINEへ渡す固定retry keyと同じ値。
    // イベント再送や再試行で新しい送達行を作らず同じ行を確定する。
    const retryKey = await ecNotificationRetryKey(lineAccountId, event.event_id);
    if (await getEcDispatchStatus(db, row.id, 'notification') !== 'sent') {
      const notificationKey = ecDispatchIdempotencyKey(lineAccountId, event.event_id, 'notification');
      await markEcDispatch(db, {
        eventId: row.id, subscriber: 'notification', status: 'pending',
        idempotencyKey: notificationKey, now,
      });
      let providerRequestId: string | null = null;
      let attemptedSend=false;
      try {
        // LINE の送信開始・送達不明・再試行予算を共通で守り、既存のチェックポイントとキーを保持する。
        const pushed = await workflowLineClient(lineClient,execution,{
          stepKey:'customer_notification',retryKeyValidityMs:23*3600_000,onAttempt:()=>{attemptedSend=true;},
        })
          .pushMessageWithRequestId(event.line_user_id,[message],retryKey);
        providerRequestId = pushed.requestId;
      } catch (pushError) {
        const checkpoint=await getWorkflowStep(execution.db,{...execution.ref,stepKey:'customer_notification'});
        const unknown=checkpoint?.status==='unknown'||checkpoint?.status==='running';
        const classified=unknown?{code:'delivery_unknown',message:'送信結果を照合するまで再送しません。'}:classifyExternalDeliveryError(pushError);
        try {
          await markEcDispatch(db, {
            eventId: row.id, subscriber: 'notification', status: 'failed',
            error: classified.code,
            idempotencyKey: notificationKey, now,
          });
        } catch (markError) {
          logger.error("services_ec_event_processing_failed");
        }
        // 送れなかった結果も共通送信台帳へ残す。秘密値を含まない
        // 安全な分類だけ書く。
        await recordCustomerEcDelivery(db, {
          ...ledgerBase,
          recipientId: friend.id,
          idempotencyKey: retryKey,
          attemptedSend,
          finish: { kind: 'failed', errorCode: classified.code, errorMessage: classified.message },
        });
        throw pushError;
      }
      // 共通台帳を先に確定してから購読台帳を sent にする。台帳の
      // 書込が落ちた場合はイベントごと失敗へ回り、再処理で同じ冪等キーの
      // 行を復旧する(既に受理済みなら送達状態は戻らない)。
      await recordCustomerEcDelivery(db, {
        ...ledgerBase,
        recipientId: friend.id,
        idempotencyKey: retryKey,
        attemptedSend,
        finish: { kind: 'accepted', providerRequestId },
      });
      await markEcDispatch(db, {
        eventId: row.id, subscriber: 'notification', status: 'sent',
        idempotencyKey: notificationKey, now,
      });
      await logOutgoingMessage(db, {
        friendId: friend.id,
        messageType: message.type,
        content: message.type === 'text' ? message.text : JSON.stringify(message),
        deliveryType: 'push',
        source: 'ec_transactional',
        lineAccountId: account.id,
      });
    } else {
      // 送信済みだが共通台帳への書込だけ落ちていた分をここで復旧する。
      // 冪等キーが同じため、既に行があれば状態は変わらない。
      await recordCustomerEcDelivery(db, {
        ...ledgerBase,
        recipientId: friend.id,
        idempotencyKey: retryKey,
        attemptedSend: false,
        finish: { kind: 'accepted' },
      });
    }



    await fireEcV6Event(db, {
      eventId: row.id, lineAccountId, externalEventId: event.event_id,
      event, friendId: friend.id, accessToken, now, credentialKey, execution,
    });
    await db.prepare(
      `UPDATE ec_events SET friend_id = ?, status = 'processed', processed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(friend.id, now, now, row.id).run();

    await setEcActionExecutionStatus(db, {
      eventId: row.id, lineAccountId, status: 'succeeded', now,
    });

    return 'processed';
  }
}

/**
 * 処理に失敗したイベントを、再試行の待ち行列へ回す。上限に達したら
 * dead letter（permanent_failed）へ倒す。回数の計算は
 * setEcActionExecutionStatus が担う。
 */
export async function markEcEventFailed(
  db: D1Database,
  input: {
    eventRowId: string;
    externalEventId: string;
    lineAccountId: string;
    message: string;
    now: string;
  },
): Promise<void> {
  await db.prepare(
    `UPDATE ec_events SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
  ).bind(input.message, input.now, input.eventRowId).run();
  await setEcActionExecutionStatus(db, {
    eventId: input.eventRowId,
    lineAccountId: input.lineAccountId,
    status: 'retryable_failed',
    errorCode: 'event_processing_failed',
    errorMessageSafe: 'ECの処理を完了できませんでした',
    now: input.now,
  }).catch(() => undefined);
  logger.error("services_ec_event_processing_failed");
}
