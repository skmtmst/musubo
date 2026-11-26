import { logger } from '@line-crm/shared/server';
import type { EventPayload } from './event-payload.js';
export type { EventPayload } from './event-payload.js';
import { patchFriendMetadata } from '../features/friends/friend-metadata/index.js';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import { stableWebhookStepId, type IncomingWebhookExecution } from './incoming-webhook-receipts.js';

function replayStep<T>(execution: IncomingWebhookExecution | undefined, key: string, work: () => Promise<T>): Promise<T> {
  return execution ? execution.step(key, work) : work();
}

/**
 * イベントバス — システム内イベントの発火と処理
 *
 * イベント発生時に以下を実行:
 * 1. アクティブな送信Webhookへ通知
 * 2. スコアリングルール適用
 * 3. 自動化ルール(IF-THEN)実行
 */

import {
  getActiveOutgoingWebhooksByEvent,
  hasMappedEcConversionSource,
  applyScoring,
  getActiveAutomationsByEvent,
  createAutomationLog,
  addTagToFriend,
  removeTagFromFriend,
  enrollFriendInScenario,
  jstNow,
  getFriendScore,
  recordAnalyticsEvent,
  recordRichMenuAssignment,
  createWebhookInteraction,
  finishWebhookInteraction,
  isOperationCapabilityStopped,
} from '@line-crm/db';
import {
  buildOutgoingWebhookBody,
  buildOutgoingWebhookHeaders,
  claimOutgoingDelivery,
  deliverOnce,
  deliverWebhook,
  enqueueOutgoingWebhookDelivery,
  failureReasonForDelivery,
  finishOutgoingDelivery,
  outgoingAttemptOf,
  outgoingDeliveryMaxAttempts,
  postWebhookSafely,
  releaseOutgoingDelivery,
  recordDeliveryOutcome,
} from './outgoing-webhook-delivery.js';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { sendAdConversions } from './ad-conversion.js';
import { dispatchAutomationEventWithLogging } from '../features/automations/automation-trigger-handlers/index.js';
import { applyActionScoreEvent } from './action-score-handlers.js';

import {
  applyRichMenuTargeting,
  isTargetingTrigger,
} from '../features/rich-menus/rich-menu-targeting/index.js';

function toAdConversionAmount(value: unknown): number | undefined {
  const amount = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

/**
 * 通常イベントから広告成果への対応表。購入に結びつく出来事だけ送る。
 * どれを送るかはここで一元管理し、各呼び出し側では決めない。
 */
export function adConversionForEvent(
  eventType: string,
  payload: EventPayload,
): { eventName: string; value?: number; currency?: string; amountInMinorUnit?: boolean } | null {
  if (payload.conversionEventName) {
    return {
      eventName: payload.conversionEventName,
      value: payload.conversionValue,
      currency: payload.conversionCurrency,
      amountInMinorUnit: payload.conversionAmountInMinorUnit,
    };
  }
  if (eventType === 'cv_fire' && payload.eventData?.type === 'purchase') {
    return { eventName: 'Purchase', value: toAdConversionAmount(payload.eventData?.amount) };
  }
  if (eventType === 'ec.order.confirmed' || eventType === 'ec.order.payment_received') {
    // 金額の読みどころを統一: 正規形 orderTotal → 互換 order.total → 旧 total。
    // (EC側の通貨・単位の正規化はの結合時に渡す。今は値だけ通す)
    const eventData = payload.eventData ?? {};
    const order = eventData.order as Record<string, unknown> | undefined;
    return {
      eventName: 'Purchase',
      value: toAdConversionAmount(eventData.orderTotal ?? order?.total ?? eventData.total),
    };
  }
  return null;
}

/** 自動化のスコア条件が最新値を読めるよう、Webhook・スコア・広告通知を先に並行実行し、その後で更新済みスコアを自動化・通知へ渡す。 */
export async function fireEvent(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  execution?: IncomingWebhookExecution,
  /**
   * 広告連携の秘密の復号鍵。無いときは暗号化された行の即時送信を見送り、
   * 待ち行列に残して定期 drain に任せる（旧行の平文はそのまま送る）。
   */
  credentialKey?: string,
  options?: { internalOnly?: boolean },
): Promise<void> {
  db = execution?.db ?? db;
  let outgoingWebhookLineAccountId = lineAccountId;
  if (outgoingWebhookLineAccountId === undefined && payload.friendId) {
    const friend = await db
      .prepare('SELECT line_account_id FROM friends WHERE id = ?')
      .bind(payload.friendId)
      .first<{ line_account_id: string | null }>();
    outgoingWebhookLineAccountId = friend?.line_account_id;
  }

  // Webhook・スコア更新・広告への成果通知は、互いに独立なので並行に進める。
  const phase1: Promise<unknown>[] = [
    ...(options?.internalOnly ? [] : [fireOutgoingWebhooks(db, eventType, payload, outgoingWebhookLineAccountId, execution)]),
    replayStep(execution, 'event:scoring', () => processScoring(db, eventType, payload, outgoingWebhookLineAccountId, lineAccessToken, execution)),
  ];
  const mappedEcSource = (eventType === 'ec.order.confirmed' || eventType === 'ec.order.payment_received')
    && outgoingWebhookLineAccountId && await hasMappedEcConversionSource(db, outgoingWebhookLineAccountId);
  const adConversion = !options?.internalOnly && payload.friendId && !mappedEcSource ? adConversionForEvent(eventType, payload) : null;
  if (payload.friendId && adConversion) {
    phase1.push(
      sendAdConversions(db, payload.friendId, adConversion.eventName, adConversion.value, {
        // 発生元の安定IDを冪等キーにし、再配達の二重送信を止める。
        idempotencyKey: payload.sourceEventId
          ? `${payload.sourceKind ?? eventType}:${payload.sourceEventId}`
          : undefined,
        // イベント確定時の所属を渡す。友だち移動後の再送でも旧所属で送る。
        lineAccountId: lineAccountId ?? outgoingWebhookLineAccountId ?? undefined,
        // 通貨・単位が分かるときだけ渡す。無いときは円・主単位扱い。
        currency: adConversion.currency,
        amountInMinorUnit: adConversion.amountInMinorUnit,
        credentialKey,
      }),
    );
  }
  const phase1Results = await Promise.allSettled(phase1);
  if (execution && phase1Results.some((result) => result.status === 'rejected')) {
    throw new Error('incoming_event_phase_failed');
  }

  // 自動化が古いスコアを読まないよう、更新後の値を入力へ含める。
  const enrichedPayload: EventPayload = payload.friendId
    ? {
        ...payload,
        eventData: {
          ...payload.eventData,
          currentScore: await getFriendScore(db, payload.friendId),
        },
      }
      : payload;

  // 業務の正本は既存台帳のまま。発生元ID・時刻・アカウントがそろった事実だけを
  // 分析用の追記台帳へ写す。失敗しても送信やタグ処理は巻き添えにしない。
  if (lineAccountId && enrichedPayload.sourceEventId && enrichedPayload.occurredAt) {
    const mappedType = eventType === 'cv_fire'
      ? 'conversion_created'
      : eventType === 'calendar_booked'
        ? 'booking_confirmed'
        : eventType;
    try {
      await recordAnalyticsEvent(db, {
        lineAccountId,
        friendId: enrichedPayload.friendId,
        eventType: mappedType,
        sourceKind: enrichedPayload.sourceKind ?? 'event_bus',
        sourceId: enrichedPayload.sourceEventId,
        occurredAt: enrichedPayload.occurredAt,
        dimensions: enrichedPayload.eventData,
        numericValue: enrichedPayload.conversionValue,
      });
    } catch (error) {
      logger.error("analytics.record_event_failed");
    }
  }


  await replayStep(execution, 'event:legacy-automations', () => processAutomations(db, eventType, enrichedPayload, lineAccessToken, lineAccountId, execution));

  // は発生元の不変IDとアカウントが分かるイベントだけを受け付ける。
  // 旧イベントの時刻などからIDを推測すると再配達で二重実行になるため、
  // 接続元が明示していないイベントは移行PRで接続するまで実行しない。
  if (lineAccountId && enrichedPayload.sourceEventId) {
    await replayStep(execution, 'event:automations', () => dispatchAutomationEventWithLogging(db, {
      lineAccountId,
      eventType,
      sourceEventId: enrichedPayload.sourceEventId!,
      friendId: enrichedPayload.friendId,
      eventData: enrichedPayload.eventData,
      lineAccessToken,
    }, { emitEvent: fireEvent }));
  }

  // リッチメニューの出し分けを見直す。
  //
  // オートメーションの後に置くのは、オートメーションでタグを付ける構成が
  // 多いため。先に見直すと、いま付いたばかりのタグが条件に反映されない。
  await reevaluateRichMenuTargeting(db, eventType, enrichedPayload, lineAccessToken, lineAccountId);
}

/**
 * 友だちごとに出すメニューを選び直す。
 *
 * 失敗しても呼び出し元には投げ返さない。メニューの出し分けは、そのとき
 * 起きていること（メッセージへの返信やタグ付け）の付随処理なので、
 * ここで転ぶと本体まで巻き添えになる。
 */
async function reevaluateRichMenuTargeting(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
): Promise<void> {
  if (!isTargetingTrigger(eventType)) return;
  if (!payload.friendId || !lineAccessToken || !lineAccountId) return;
  try {
    // 緊急停止 : メッセージ送信ではないが、イベントに連動して顧客側の
    // 表示を変える LINE 呼び出しなので automation_actions の停止に連動する。
    if (await isOperationCapabilityStopped(db, lineAccountId, 'automation_actions')) return;
    await applyRichMenuTargeting(db, payload.friendId, lineAccountId, lineAccessToken);
  } catch (err) {
    logger.error("event_bus.reevaluate_rich_menu_targeting_failed");
  }
}

/**
 * 送信Webhookへの通知。fireEvent を通る出来事はここへ流れ、
 * 個別の発火点（フォーム回答・予約）からも直接呼べる。
 */
export async function fireOutgoingWebhooks(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccountId?: string | null,
  execution?: IncomingWebhookExecution,
): Promise<void> {
  try {
    if (lineAccountId == null) {
      logger.log("outgoing_webhook_line_account_unknown");
    }
    const webhooks = await getActiveOutgoingWebhooksByEvent(db, eventType, lineAccountId);
    for (const wh of webhooks) {
      await replayStep(execution, `event:outgoing:${wh.id}`, async () => {
      let interactionId: string | null = null;
      const started = Date.now();
      try {
        const idempotencyKey = payload.sourceEventId
          ? `outgoing_webhook:${wh.id}:${payload.sourceKind ?? eventType}:${payload.sourceEventId}`
          : crypto.randomUUID();
        // 本文は共通封筒（要件26 §6-2）で組み立てる。
        // 冪等キー＝封筒の id＝X-Harness-Event-Id で、再送しても同じ出来事と
        // 判定できる。replyToken・変換測定用の値など内部情報は data に入れない。
        const deliveryAccountId = wh.line_account_id ?? lineAccountId;
        const body = buildOutgoingWebhookBody({
          eventId: idempotencyKey,
          eventType,
          occurredAt: payload.occurredAt ?? execution?.occurredAt ?? new Date().toISOString(),
          accountId: deliveryAccountId ?? null,
          data: { friendId: payload.friendId ?? null, ...payload.eventData },
          attempt: 1,
        });
        // 配送は台帳(outgoing_webhook_deliveries)へ先に積んでから送る。
        // 同じ出来事の再発火は (webhook_id, idempotency_key) の UNIQUE で
        // 積み増さず、Worker中断・cron再実行の送り残しは sweep が回収する。
        if (!deliveryAccountId) {
          // 緊急停止 : アカウント不明でもグローバル (*) の
          // webhook_outgoing 停止には従う。この経路は台帳へ積めないので、
          // 停止中の通知は送らず手放す（送達の約束が作れないため）。
          if (await isOperationCapabilityStopped(db, null, 'webhook_outgoing')) return;
          // 台帳は所属必須。アカウント不明の旧行（getActive… が通常返さない
          // 分）は従来どおりその場で送り、成否だけ記録する。
          const result = await deliverWebhook(wh, body, { idempotencyKey });
          try {
            await recordDeliveryOutcome(db, wh.id, result.ok);
          } catch (outcomeError) {
            logger.error("event_bus.record_delivery_outcome_failed");
          }
          if (execution && !result.ok) throw new Error('incoming_outgoing_delivery_failed');
          return;
        }
        const queued = await enqueueOutgoingWebhookDelivery(db, {
          lineAccountId: deliveryAccountId,
          webhookId: wh.id,
          eventType,
          body,
          idempotencyKey,
          maxAttempts: outgoingDeliveryMaxAttempts(wh.max_retries),
        });
        if (!queued) return; // 台帳済み。以後の回収は sweep の仕事。
        // 緊急停止 : webhook_outgoing が止まっている統括は台帳へ
        // 積んだまま初回配送を送らない。pending の行は復旧後に sweep の
        // cron が届けるので、出来事自体は失われない。
        if (await isOperationCapabilityStopped(db, deliveryAccountId, 'webhook_outgoing')) return;
        // 再送は Worker 内で sleep せず台帳の next_retry_at へ積む。
        // ここでは1回だけ送る。失敗しても行は retry_wait で残り、delivery
        // レーンの cron が決められた時刻に送り直す。
        const lease = await claimOutgoingDelivery(db, queued);
        if (!lease) return; // 別の実行が取り掛かった
        // d23b : 取り掛かり〜送信のあいだに緊急停止へ切り替わった分は、
        // lease を外して送る前の状態へ戻す。sweep側と同じ再確認。
        if (await isOperationCapabilityStopped(db, deliveryAccountId, 'webhook_outgoing')) {
          await releaseOutgoingDelivery(db, queued, lease);
          return;
        }
        if (lineAccountId) {
          try {
            const interaction = await createWebhookInteraction(db, {
              lineAccountId,
              direction: 'outgoing',
              webhookId: wh.id,
              webhookName: wh.name,
              eventType,
              triggerSummary: eventType,
              requestBodyJson: body,
              idempotencyKey,
            });
            interactionId = interaction.id;
          } catch (logError) {
            // 記録の一時障害で、本体の外部通知まで止めない。
            logger.error("event_bus.create_outgoing_interaction_failed");
          }
        }
        const result = await deliverOnce(wh, body, { idempotencyKey });
        const outcome = await finishOutgoingDelivery(db, queued, lease, outgoingAttemptOf(result));
        if (outcome !== 'delivered') {
          logger.error("event_bus.deliver_webhook_failed");
        }
        if (interactionId && lineAccountId) {
          try {
            await finishWebhookInteraction(db, interactionId, lineAccountId, {
              status: outcome === 'delivered' ? 'succeeded' : 'failed',
              responseStatus: result.lastStatus,
              attemptCount: result.attempts,
              durationMs: Date.now() - started,
              failureReason: outcome === 'delivered' ? null : failureReasonForDelivery(result),
            });
          } catch (logError) {
            // 届いた通知を、台帳更新の失敗だけで「送信失敗」とは扱わない。
            logger.error("event_bus.finish_outgoing_interaction_failed");
          }
        }
        // 連続失敗は配送単位で数える。再送待ち(retry_wait)は未確定なので
        // 動かさず、届いたか恒久失敗に確定したときだけ成否を記録する。
        if (outcome === 'delivered' || outcome === 'failed') {
          try {
            await recordDeliveryOutcome(db, wh.id, outcome === 'delivered');
          } catch (outcomeError) {
            // 連続失敗数の更新は補助情報。配送結果そのものを巻き戻さない。
            logger.error("event_bus.record_delivery_outcome_failed");
          }
        }
      } catch (err) {
        if (interactionId && lineAccountId) {
          try {
            await finishWebhookInteraction(db, interactionId, lineAccountId, {
              status: 'failed',
              responseStatus: null,
              attemptCount: 1,
              durationMs: Date.now() - started,
              failureReason: 'unknown',
            });
          } catch (logError) {
            logger.error("event_bus.record_outgoing_failure_failed");
          }
        }
        logger.error("event_bus.deliver_webhook_failed");
        if (execution) throw err;
      }
      });
    }
  } catch (err) {
    logger.error("event_bus.dispatch_outgoing_webhooks_failed");
    if (execution) throw err;
  }
}

/** スコアリングルール適用 */
export async function processScoring(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccountId?: string | null,
  lineAccessToken?: string,
  execution?: IncomingWebhookExecution,
): Promise<void> {
  if (!payload.friendId) return;
  try {
    if (lineAccountId && payload.sourceEventId && payload.sourceKind && payload.occurredAt) {
      const v6 = await applyActionScoreEvent(db, {
        lineAccountId,
        friendId: payload.friendId,
        eventType,
        source: payload.sourceKind,
        sourceEventId: payload.sourceEventId,
        subjectKey: typeof payload.eventData?.subjectKey === 'string'
          ? payload.eventData.subjectKey
          : null,
        occurredAt: payload.occurredAt,
        lineAccessToken,
      }, fireEvent);
      // 公開後または明示停止後は旧ルールへ戻さず、二重加点を防ぐ。
      if (v6.configured) return;
    }
    /*
     * 旧ルールにも発生元の不変IDを渡す。実行台帳(execution)が無い経路でも
     * payload.sourceEventId が分かれば決定的な履歴IDで受け付けるので、
     * 同じイベントを走り直してもスコアと履歴は二重に増えない。
     */
    const scoreSourceEventId = execution?.sourceEventId ?? payload.sourceEventId;
    if (scoreSourceEventId) await applyScoring(db, payload.friendId, eventType, scoreSourceEventId);
    else await applyScoring(db, payload.friendId, eventType);
  } catch (err) {
    logger.error("event_bus.apply_scoring_failed");
    if (execution) throw err;
  }
}

/** 自動化ルール(IF-THEN)実行 */
async function processAutomations(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  execution?: IncomingWebhookExecution,
): Promise<void> {
  try {
    const allAutomations = await getActiveAutomationsByEvent(db, eventType);
    // 指定アカウントと互換用の所属なし自動化だけを対象にする。
    const automations = allAutomations.filter(
      (a) => Boolean(a.line_account_id && lineAccountId && a.line_account_id === lineAccountId),
    );

    for (const automation of automations) {
      const conditions = JSON.parse(automation.conditions) as Record<string, unknown>;
      const actions = JSON.parse(automation.actions) as Array<{ type: string; params: Record<string, string> }>;

      // 条件チェック（簡易版: 条件が空なら常にマッチ）
      if (!matchConditions(conditions, payload)) continue;

      const results: Array<{ action: string; success: boolean; error?: string }> = [];

      for (const [index, action] of actions.entries()) {
        // 緊急停止 : automation_actions が止まっている統括のアクション
        // (LINE送信・Webhook起動・メニュー切替) は実行しない。イベント駆動の
        // 動作はキューへ積めないので、止まった分は手放す。
        if (await isOperationCapabilityStopped(
          db, automation.line_account_id ?? lineAccountId ?? null, 'automation_actions',
        )) break;
        try {
          await replayStep(execution, `event:legacy:${automation.id}:${index}`, async () => {
            if (payload.recoveryWithoutReply && ['send_message', 'send_webhook', 'switch_rich_menu', 'remove_rich_menu'].includes(action.type)) {
              payload.onRecoveryReview?.(action.type === 'send_message' ? 'reply_input_unavailable' : 'delivery_unknown');
              throw new Error('line_recovery_external_review');
            }
            const idempotencyKey = execution
              ? await stableWebhookStepId(execution.sourceEventId, `legacy:${automation.id}:${index}`) : undefined;
            const actionDb = execution && 'mutationDb' in execution
              ? (execution as import('./workflow-execution.js').WorkflowExecution).mutationDb(`event:legacy:${automation.id}:${index}`) : db;
            await executeAction(actionDb, action, payload, lineAccessToken, lineAccountId, idempotencyKey, automation.id, eventType);
          });
          results.push({ action: action.type, success: true });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.push({ action: action.type, success: false, error: errorMsg });
          if (payload.recoveryWithoutReply && errorMsg === 'line_recovery_external_review') continue;
          if (execution) throw err;
        }
      }

      const allSuccess = results.every((r) => r.success);
      const anySuccess = results.some((r) => r.success);

      await createAutomationLog(db, {
        automationId: automation.id,
        friendId: payload.friendId,
        eventData: JSON.stringify(payload.eventData ?? {}),
        actionsResult: JSON.stringify(results),
        status: allSuccess ? 'success' : anySuccess ? 'partial' : 'failed',
      });
    }
  } catch (err) {
    logger.error("event_bus.process_automations_failed");
    if (execution) throw err;
  }
}

/** 条件マッチング */
function matchConditions(
  conditions: Record<string, unknown>,
  payload: EventPayload,
): boolean {
  // 条件が空 → 常にマッチ
  if (Object.keys(conditions).length === 0) return true;

  // score_threshold チェック
  if (conditions.score_threshold !== undefined && payload.eventData) {
    const currentScore = payload.eventData.currentScore as number | undefined;
    if (currentScore !== undefined && currentScore < (conditions.score_threshold as number)) {
      return false;
    }
  }

  // tag_id チェック
  if (conditions.tag_id !== undefined && payload.eventData) {
    if (payload.eventData.tagId !== conditions.tag_id) return false;
  }

  // keyword チェック（message_received / postback_received イベント用）
  if (conditions.keyword !== undefined && payload.eventData) {
    const text = payload.eventData.text as string | undefined;
    if (!text || !text.includes(conditions.keyword as string)) return false;
  }

  // keyword_exact（完全一致）
  if (conditions.keyword_exact) {
    const rawText = payload.eventData?.text as string | undefined;
    const text = (rawText || '').trim();
    if (text !== conditions.keyword_exact) {
      return false;
    }
  }

  return true;
}

/** アクション実行 */
async function executeAction(
  db: D1Database,
  action: { type: string; params: Record<string, string> },
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  idempotencyKey?: string,
  automationId?: string,
  eventType?: string,
): Promise<void> {
  const friendId = payload.friendId;
  if (!friendId && action.type !== 'send_webhook') {
    throw new Error('friendId is required for this action');
  }

  switch (action.type) {
    case 'add_tag':
      await addTagToFriend(db, friendId!, action.params.tagId);
      break;

    case 'remove_tag':
      await removeTagFromFriend(db, friendId!, action.params.tagId);
      break;

    case 'start_scenario':
      if (idempotencyKey) await enrollFriendInScenario(db, friendId!, action.params.scenarioId, idempotencyKey);
      else await enrollFriendInScenario(db, friendId!, action.params.scenarioId);
      break;

    case 'send_message': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_platform_user_id AS line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);

      // template_id が set なら templates から content/type を resolve、
      // なければ inline params を使う。template が見つからない (削除済 等) は
      // inline fallback (content が空なら下流の JSON.parse が throw → automation
      // 全体は partial 扱い)。
      let resolvedType = action.params.messageType || 'text';
      let resolvedContent = action.params.content ?? '';
      const tplId = action.params.template_id;
      if (tplId) {
        const { getTemplateById } = await import('@line-crm/db');
        const tpl = await getTemplateById(db, tplId);
        if(tpl?.message_bubbles_json)throw new Error('MULTIPLE_MESSAGES_REQUIRE_BUNDLE_SENDER');
        if (tpl) {
          resolvedType = tpl.message_type;
          resolvedContent = tpl.message_content;
        }
      }

      // テンプレート/直接本文に {{var.*}} が書かれていても、この経路は従来
      // 差し込みを展開せず生のまま送っていた。消えた共通情報は fail-closed で
      // 止め、解決できるものは送信時点の値へ置き換える。
      const { expandSendCommonVars } = await import('./interpolation-context.js');
      resolvedContent = await expandSendCommonVars(
        db, resolvedContent,
        { kind: 'automation', id: automationId ?? tplId ?? 'send_message' },
        { lineAccountId: lineAccountId ?? null, friendId, messageType: resolvedType },
      );

      let msg: Message;
      let logContent: string;
      if (resolvedType === 'flex') {
        const contents = JSON.parse(resolvedContent);
        msg = { type: 'flex', altText: action.params.altText || extractFlexAltText(contents), contents };
        logContent = JSON.stringify(contents);
      } else if (resolvedType === 'image') {
        // template に "originalContentUrl" / "previewImageUrl" を持つ JSON が入る前提。
        // parse 失敗時は text fallback ではなく throw → automation 側で partial 扱いにする。
        const parsed = JSON.parse(resolvedContent) as { originalContentUrl: string; previewImageUrl: string };
        msg = {
          type: 'image',
          originalContentUrl: parsed.originalContentUrl,
          previewImageUrl: parsed.previewImageUrl,
        };
        logContent = JSON.stringify(parsed);
      } else {
        msg = { type: 'text', text: resolvedContent };
        logContent = resolvedContent;
      }

      let deliveryType: 'reply' | 'push';
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, [msg]);
          payload.replyToken = undefined;
          deliveryType = 'reply';
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isTokenError = errMsg.includes('400') || errMsg.includes('Invalid reply token');
          if (isTokenError) {
            await lineClient.pushMessage(friend.line_user_id, [msg]);
            deliveryType = 'push';
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, [msg], idempotencyKey);
        deliveryType = 'push';
      }

      // log は実際に送信した msg の type を反映する。msgType が 'image' 等で
      // else 経路に入った場合、actual message は text なので 'text' で記録すべき。
      // params の messageType をそのまま使うと admin 側で画像/Flex プレースホルダ
      // が出てしまう。
      await logOutgoingMessage(db, {
        friendId,
        messageType: msg.type,
        content: logContent,
        deliveryType,
        source: 'automation',
        lineAccountId,
      });
      break;
    }

    case 'send_webhook': {
      const url = action.params.url;
      if (url) {
        // 旧式の直書きURL経路でも共通封筒と X-Harness-* の
        // ヘッダを使う。secret を持たない経路なので署名は付かないが、
        // イベントIDと時刻は他経路と同じ名前で渡す。
        const eventId = idempotencyKey ?? crypto.randomUUID();
        const body = buildOutgoingWebhookBody({
          eventId,
          eventType: eventType ?? 'legacy_automation.send_webhook',
          occurredAt: payload.occurredAt ?? new Date().toISOString(),
          accountId: lineAccountId ?? null,
          data: { friendId: friendId ?? null, ...payload.eventData },
          attempt: 1,
        });
        const headers = await buildOutgoingWebhookHeaders({ eventId, body });
        // 共通の安全送信へ通す。検査を迂回する直 fetch は置かない。
        const outcome = await postWebhookSafely(url, { headers, body });
        if ('blocked' in outcome) {
          throw new Error(`send_webhook_url_unsafe: ${outcome.blocked}`);
        }
        if (idempotencyKey && !outcome.response.ok) throw new Error(`incoming_legacy_webhook_rejected:${outcome.response.status}`);
      }
      break;
    }

    case 'switch_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_platform_user_id AS line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.linkRichMenuToUser(friend.line_user_id, action.params.richMenuId);
      if (lineAccountId) {
        await recordRichMenuAssignment(db, {
          friendId,
          lineAccountId,
          lineRichMenuId: action.params.richMenuId,
          reasonKind: 'legacy_automation',
          reasonEventId: payload.sourceEventId ?? null,
          idempotencyKey: payload.sourceEventId
            ? `${payload.sourceEventId}:switch_rich_menu:${friendId}`
            : undefined,
        });
      }
      break;
    }

    case 'remove_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_platform_user_id AS line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.unlinkRichMenuFromUser(friend.line_user_id);
      if (lineAccountId) {
        await recordRichMenuAssignment(db, {
          friendId,
          lineAccountId,
          lineRichMenuId: null,
          reasonKind: 'legacy_automation',
          reasonEventId: payload.sourceEventId ?? null,
          idempotencyKey: payload.sourceEventId
            ? `${payload.sourceEventId}:remove_rich_menu:${friendId}`
            : undefined,
        });
      }
      break;
    }

    case 'set_metadata': {
      if (!friendId) break;
      // {{message}} を受信メッセージ内容に置換してからパース
      // JSON文字列内に埋め込むため、JSON仕様に準拠して全制御文字をエスケープ
      const escapeForJsonString = (s: string): string =>
        s
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/[\u0000-\u001f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      const messageText = (payload.eventData?.text as string | undefined) || '';
      const raw = (action.params.data || '{}')
        .replace(/\{\{message\}\}/g, escapeForJsonString(messageText));
      const patch = JSON.parse(raw) as Record<string, unknown>;
      if (!await patchFriendMetadata(db, friendId, patch)) throw new Error('friend_metadata_unavailable');
      break;
    }

    default:
      logger.warn("event_bus.validate_action_failed");
  }
}

/** 送信メッセージを messages_log に記録（失敗しても例外を上げない） */
export async function logOutgoingMessage(
  db: D1Database,
  params: {
    friendId: string;
    messageType: string;
    content: string;
    deliveryType: 'reply' | 'push';
    source: string;
    lineAccountId?: string | null;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        params.friendId,
        params.messageType,
        params.content,
        params.deliveryType,
        params.source,
        params.lineAccountId ?? null,
        jstNow(),
      )
      .run();
    return id;
  } catch (err) {
    logger.error("event_bus.log_outgoing_message_failed");
    return null;
  }
}
