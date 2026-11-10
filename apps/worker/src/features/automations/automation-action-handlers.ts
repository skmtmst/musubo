import { restaurantWaitlistVariables } from '../../services/restaurant-followup-delivery-variables.js';
import { readRestaurantAutomationDeliveryGate } from '../../services/restaurant-automation-delivery-gate.js';
import { restaurantBookingVariables, substituteRestaurantBooking } from '../../services/restaurant-booking-context.js';
import { expandVariables } from '../../services/message-interpolation.js';
import { resolveMetadata } from '../../services/step-metadata.js';
import { resolveSendInterpolationExtra } from '../../services/interpolation-context.js';
import { resolveMileageSource } from '../../services/mileage-ec-source.js';
import type { EventDispatcher } from '../../services/event-payload.js';
import { tracedFetch as fetch } from '@line-crm/shared/server';
import { classifyLinePushError } from './automation-line-errors.js';
import { isFriendDeliverySuppressed } from '@line-crm/db/src/friend-delivery-consents.js';
import { patchFriendMetadata } from '../friends/friend-metadata/index.js';
import {
  addTagToFriend,
  getLineAccountById,
  getFriendById,
  getSupportMarkById,
  jstNow,
  removeTagFromFriend,
  recordRichMenuAssignment,
  resolveWebhookSecret,
  setFriendSupportMark,
} from '@line-crm/db';
import { LineClient, type Message } from '@line-crm/line-sdk';

import {
  AutomationActionError,
  AutomationActionDeferred,
  type AutomationActionContext,
  type AutomationActionExecutor,
} from './automation-engine.js';
import type { Env } from '../../worker-env.js';
import {
  completeOutboundSendStatement,
  hashOutboundPayload,
  reserveOutboundSend,
} from '../../services/outbound-idempotency.js';
import { buildMessage } from '../../services/line-message.js';
import {
  buildOutgoingWebhookBody,
  buildOutgoingWebhookHeaders,
  postWebhookSafely,
  recordDeliveryOutcome,
  type SafePostOutcome,
  type WebhookDnsLookup,
} from '../../services/outgoing-webhook-delivery.js';

interface AutomationLineClient {
  pushMessage(to: string, messages: Message[], retryKey?: string): Promise<unknown>;
  linkRichMenuToUser(userId: string, richMenuId: string): Promise<unknown>;
  unlinkRichMenuFromUser(userId: string): Promise<unknown>;
  getRichMenuIdOfUser?(userId: string): Promise<{ richMenuId: string }>;
}

export interface AutomationActionExecutorDependencies {
  emitEvent?: EventDispatcher;
  credentialEncryptionKey?: string;
  /** 呼出元が配送台帳を管理する即時処理では、外部の受理確認まで待つ。 */
  webhookDeliveryMode?: 'queued' | 'immediate';
  resolveLineAccessToken?: (db: D1Database, lineAccountId: string) => Promise<string | null>;
  createLineClient?: (accessToken: string) => AutomationLineClient;
  fetch?: typeof fetch;
  lookupHost?: WebhookDnsLookup;
  now?: () => string;
  /**
   * 担当者通知の送達に使う環境（メール経路用）。渡さない呼び出しでは
   * メール経路のあるルールは送らずに止める（LINE・画面内通知は送れる）。
   */
  operatorMailEnv?: Env['Bindings'];
}

interface ScopedFriend {
  id: string;
  line_user_id: string;
  metadata: string;
}

function invalid(code: string, message: string): AutomationActionError {
  return new AutomationActionError(code, message, false);
}

function requiredString(value: unknown, code: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(code, `${label}が指定されていません`);
  return value.trim();
}

function requiredText(value: unknown, code: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(code, `${label}が指定されていません`);
  return value;
}

function parseRecord(value: unknown, code: string, label: string): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 下で項目エラーへ揃える。
    }
  }
  throw invalid(code, `${label}の形式が不正です`);
}

async function requireFriend(context: AutomationActionContext): Promise<ScopedFriend> {
  if (!context.friendId) throw invalid('friend_required', '対象の友だちが指定されていません');
  const friend = await context.db.prepare(
    `SELECT id, line_user_id, metadata
       FROM friends
      WHERE id = ? AND line_account_id = ?`,
  ).bind(context.friendId, context.lineAccountId).first<ScopedFriend>();
  if (!friend) throw invalid('friend_not_found', '対象の友だちがこのLINE公式アカウントにいません');
  return friend;
}

async function requireScopedResource(
  context: AutomationActionContext,
  input: { table: 'tags' | 'templates' | 'outgoing_webhooks'; id: string; code: string; label: string },
): Promise<void> {
  //  送信Webhookの削除は履歴を残す印なので、印のある行は
  // 「見つからない」として扱う。他の表に deleted_at は無い。
  const notDeleted = input.table === 'outgoing_webhooks' ? ' AND deleted_at IS NULL' : '';
  const row = await context.db.prepare(
    `SELECT id FROM ${input.table} WHERE id = ? AND line_account_id = ?${notDeleted}`,
  ).bind(input.id, context.lineAccountId).first<{ id: string }>();
  if (!row) throw invalid(input.code, `${input.label}が見つからないか、別のLINE公式アカウントにあります`);
}

async function resolveAccessToken(
  context: AutomationActionContext,
  dependencies: AutomationActionExecutorDependencies,
): Promise<string> {
  let token: string | null | undefined;
  if (dependencies.resolveLineAccessToken) {
    token = await dependencies.resolveLineAccessToken(context.db, context.lineAccountId);
  } else {
    const account = await getLineAccountById(
      context.db,
      context.lineAccountId,
      dependencies.credentialEncryptionKey,
    );
    token = account?.is_active === 1 ? account.channel_access_token : null;
  }
  if (!token) throw invalid('line_access_token_missing', 'LINE送信用のアクセストークンがありません');
  return token;
}

function classifyLineError(error: unknown): AutomationActionError {
  if (error instanceof AutomationActionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const permanent = /LINE API error:\s*(400|401|403|404)\b/.test(message);
  return new AutomationActionError(
    permanent ? 'line_request_rejected' : 'line_temporary_failure',
    message,
    !permanent,
  );
}

async function reserveLineOperation(
  context: AutomationActionContext,
  payload: string,
): Promise<'send' | 'replay'> {
  const reservation = await reserveOutboundSend(context.db, {
    key: context.idempotencyKey,
    channel: 'line',
    resourceId: `${context.action.type}:${context.lineAccountId}:${context.friendId ?? ''}`,
    payloadHash: await hashOutboundPayload(payload),
    retryInProgress: true,
    now: jstNow(),
  });
  if (reservation.kind === 'conflict') {
    throw invalid('idempotency_key_conflict', '同じ処理IDに異なる送信内容が指定されました');
  }
  if (reservation.kind === 'unknown' || reservation.kind === 'failed') {
    throw new AutomationActionError('delivery_unconfirmed', '送信結果は要確認です。自動では送り直しません', false);
  }
  if (reservation.kind === 'in_progress') {
    throw new AutomationActionError('outbound_state_unavailable', '送信状態を確認できません', true);
  }
  return reservation.kind === 'replay' ? 'replay' : 'send';
}

async function completeLineOperation(
  context: AutomationActionContext,
  responseId: string,
): Promise<void> {
  await context.db.batch([
    completeOutboundSendStatement(context.db, {
      key: context.idempotencyKey,
      responseId,
      now: jstNow(),
    }),
  ]);
}

function strictMessage(type: string, content: string, altText?: string): Message {
  const allowed = new Set([
    'text', 'image', 'flex', 'carousel', 'location', 'video', 'audio', 'sticker',
  ]);
  if (!allowed.has(type)) throw invalid('message_type_unsupported', `メッセージ種別 ${type} は使えません`);
  if (!content.trim()) throw invalid('message_content_missing', 'メッセージ内容が空です');
  const message = buildMessage(type, content, altText);
  if (type !== 'text' && message.type === 'text') {
    throw invalid('message_content_invalid', `${type}メッセージの内容が不正です`);
  }
  return message;
}

async function resolveMessage(
  context: AutomationActionContext,
  approvedTemplates?: ReadonlyMap<string,{message_type:string;message_content:string;message_bubbles_json:string|null}>,
): Promise<{ type: string; content: string; altText?: string }> {
  const templateId = context.action.params.templateId ?? context.action.params.template_id;
  if (templateId !== undefined) {
    const id = requiredString(templateId, 'template_id_missing', 'テンプレート');
    await requireScopedResource(context, {
      table: 'templates', id, code: 'template_not_found', label: 'テンプレート',
    });
    const template = approvedTemplates ? approvedTemplates.get(id) : await context.db.prepare(
      `SELECT message_type, message_content FROM templates
        WHERE id = ? AND line_account_id = ? AND message_bubbles_json IS NULL`,
    ).bind(id, context.lineAccountId).first<{ message_type: string; message_content: string }>();
    if (!template || ('message_bubbles_json' in template && template.message_bubbles_json)) throw invalid('template_not_found', 'テンプレートが見つかりません');
    return {
      type: template.message_type,
      content: template.message_content,
      altText: optionalString(context.action.params.altText),
    };
  }
  const type = optionalString(context.action.params.messageType) ?? 'text';
  const content = requiredText(context.action.params.content, 'message_content_missing', 'メッセージ内容');
  return { type, content, altText: optionalString(context.action.params.altText) };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function tagExecutor(context: AutomationActionContext, operation: 'add' | 'remove', dependencies: AutomationActionExecutorDependencies): Promise<void> {
  const friend = await requireFriend(context);
  const tagId = requiredString(context.action.params.tagId, 'tag_id_missing', 'タグ');
  await requireScopedResource(context, { table: 'tags', id: tagId, code: 'tag_not_found', label: 'タグ' });
  if (operation === 'add') {
    /*
     * 受信Webhookの起点では連動処理（マイル・成果）の失敗を握りつぶさない。
     * 受領は失敗状態で残り、同じ受信の再送で欠けた記録だけを復旧する
     * （安定キーで二重計上しない）。自動化など他の起点は従来どおり。
     */
    const fromIncomingWebhook = context.automationId.startsWith('incoming-webhook:');
    await addTagToFriend(context.db, friend.id, tagId, {
      sourceEventId: context.sourceEventId,
      strictSideEffects: fromIncomingWebhook,
    });
  } else {
    await removeTagFromFriend(context.db, friend.id, tagId);
  }
  const depth=Number(context.inputEvent?.automationDepth??0);
  if(depth<3) {
    const fireEvent = dependencies.emitEvent;
    if (!fireEvent) throw new Error('automation_event_dispatcher_missing');
    await fireEvent(context.db,'tag_change',{friendId:friend.id,sourceEventId:`automation-tag:${context.idempotencyKey}`,sourceKind:'automation',occurredAt:new Date().toISOString(),eventData:{tagId,action:operation,automationDepth:depth+1}},undefined,context.lineAccountId);
  }
}

function replaceMessagePlaceholder(value: unknown, message: string): unknown {
  if (typeof value === 'string') return value.replace(/\{\{message\}\}/g, message);
  if (Array.isArray(value)) return value.map((item) => replaceMessagePlaceholder(item, message));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, replaceMessagePlaceholder(item, message)]),
    );
  }
  return value;
}

async function metadataExecutor(context: AutomationActionContext): Promise<void> {
  const friend = await requireFriend(context);
  const raw = context.action.params.values ?? context.action.params.data;
  const parsedValues = parseRecord(raw, 'metadata_invalid', '友だち情報');
  const message = typeof context.inputEvent.text === 'string' ? context.inputEvent.text : '';
  const values = replaceMessagePlaceholder(parsedValues, message) as Record<string, unknown>;
  parseRecord(friend.metadata || '{}', 'friend_metadata_invalid', '現在の友だち情報');
  if (!await patchFriendMetadata(context.db, friend.id, values, { lineAccountId: context.lineAccountId })) {
    throw invalid('friend_update_failed', '友だち情報を更新できませんでした');
  }
}

async function supportMarkExecutor(
  context: AutomationActionContext,
  dependencies: AutomationActionExecutorDependencies,
): Promise<void> {
  const friend = await requireFriend(context);
  const markId = requiredString(context.action.params.markId, 'support_mark_id_missing', '対応マーク');
  const account = await context.db.prepare(
    `SELECT tenant_id FROM line_accounts WHERE id = ?`,
  ).bind(context.lineAccountId).first<{ tenant_id: string }>();
  if (!account) throw invalid('line_account_not_found', 'LINE公式アカウントが見つかりません');
  const scope = { tenantId: account.tenant_id, lineAccountId: context.lineAccountId };
  const mark = await getSupportMarkById(context.db, markId, scope);
  if (!mark) {
    throw invalid('support_mark_not_found', '対応マークが見つからないか、別のLINE公式アカウントにあります');
  }

  const protectionMinutes = Number(context.action.params.manualProtectionMinutes ?? 0);
  if (Number.isFinite(protectionMinutes) && protectionMinutes > 0) {
    const now = dependencies.now?.() ?? new Date().toISOString();
    const protectedChange = await context.db.prepare(
      `SELECT 1 AS ok
         FROM operation_audit
        WHERE target_kind = 'support_mark' AND action = 'changed'
          AND friend_id = ? AND actor_id IS NOT NULL
          AND datetime(created_at) >= datetime(?, ?)
        LIMIT 1`,
    ).bind(friend.id, now, `-${Math.floor(protectionMinutes)} minutes`).first<{ ok: number }>();
    if (protectedChange) return;
  }

  const updated = await setFriendSupportMark(context.db, friend.id, mark.id, scope, null, {
    source: 'automation',
    automationId: context.automationId,
    automationVersionId: context.automationVersionId,
    sourceEventId: context.sourceEventId,
    reason: typeof context.inputEvent.type === 'string' ? context.inputEvent.type : 'condition_matched',
  });
  if (!updated) throw invalid('support_mark_update_failed', '対応マークを変更できませんでした');
}

async function scenarioExecutor(context: AutomationActionContext): Promise<void> {
  const friend = await requireFriend(context);
  const scenarioId = requiredString(context.action.params.scenarioId, 'scenario_id_missing', 'シナリオ');
  const scenario = await context.db.prepare(
    `SELECT s.id FROM scenarios s
      WHERE s.id = ? AND s.line_account_id = ? AND s.is_active = 1
        AND EXISTS (
          SELECT 1 FROM scenario_steps step
          WHERE step.scenario_id = s.id AND step.is_draft = 0
        )`,
  ).bind(scenarioId, context.lineAccountId).first<{ id: string }>();
  if (!scenario) throw invalid('scenario_not_found', '配信できるシナリオが見つかりません');

  const existing = await context.db.prepare(
    `SELECT id FROM friend_scenarios
      WHERE friend_id = ? AND scenario_id = ? AND status IN ('active', 'delivering') LIMIT 1`,
  ).bind(friend.id, scenario.id).first<{ id: string }>();
  if (existing) return;

  // 既存の登録規則（並行可否、初回配信日時）を保つため、DBヘルパーを使う。
  const { enrollFriendInScenario } = await import('@line-crm/db');
  const enrolled = context.automationId.startsWith('incoming-webhook:')
    ? await enrollFriendInScenario(context.db, friend.id, scenario.id, context.stepExecutionId)
    : await enrollFriendInScenario(context.db, friend.id, scenario.id);
  if (!enrolled) throw invalid('scenario_enrollment_rejected', 'シナリオの開始条件を満たしていません');
}

async function changeScenarioStatus(
  context: AutomationActionContext,
  operation: 'stop' | 'resume',
): Promise<void> {
  const friend = await requireFriend(context);
  const scenarioId = requiredString(context.action.params.scenarioId, 'scenario_id_missing', 'シナリオ');
  const scenario = await context.db.prepare(
    `SELECT id FROM scenarios WHERE id = ? AND line_account_id = ?`,
  ).bind(scenarioId, context.lineAccountId).first<{ id: string }>();
  if (!scenario) throw invalid('scenario_not_found', 'シナリオが見つかりません');
  const from = operation === 'stop' ? "('active', 'delivering')" : "('paused')";
  const to = operation === 'stop' ? 'paused' : 'active';
  await context.db.prepare(
    `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = ?, updated_at = ?
      WHERE friend_id = ? AND scenario_id = ? AND status IN ${from}`,
  ).bind(to, jstNow(), friend.id, scenario.id).run();
}

async function sendMessageExecutor(
  context: AutomationActionContext,
  dependencies: AutomationActionExecutorDependencies,
): Promise<{ output: Record<string, unknown> }> {
  const initialGate=await readRestaurantAutomationDeliveryGate(context.db,context.runId,dependencies.now?.()??jstNow(),context);
  if(!initialGate.allowed)throw invalid(initialGate.reason,'予約または承認の内容が変わったため送信できません');
  const friend = await requireFriend(context);
  if(await isFriendDeliverySuppressed(context.db,friend.id)) throw invalid('delivery_consent_suppressed','配信停止・同意の状態により送信できません');
  const resolved = await resolveMessage(context,initialGate.approval.managed?initialGate.approval.snapshot.templates:undefined);
  // テンプレート/直接本文に {{var.*}} が書かれていても、この経路は従来
  // 差し込みを展開せず生のまま送っていた。消えた共通情報は fail-closed で
  // 止め、解決できるものは送信時点の値へ置き換える。
  let content: string;
  try {
    const { expandSendCommonVars } = await import('../../services/interpolation-context.js');
    if(initialGate.source.restaurant){
      const body=substituteRestaurantBooking(resolved.content,initialGate.source.context);
      const vars={...restaurantBookingVariables(initialGate.source.context),...(initialGate.source.waitlistId?await restaurantWaitlistVariables(context.db,context.lineAccountId,initialGate.source.waitlistId):{})};
      const scanned=body.replace(/\{\{\s*var\.([a-z][a-z0-9_]*)\s*\}\}/g,(match,key:string)=>key in vars?'':match);
      const fullFriend=await getFriendById(context.db,friend.id);
      if(!fullFriend)throw invalid('friend_not_found','対象の友だちが見つかりません');
      const extra=await resolveSendInterpolationExtra(context.db,friend.id,scanned,{kind:'automation',id:context.action.id});
      content=expandVariables(body,{...fullFriend,metadata:await resolveMetadata(context.db,fullFriend)},undefined,resolved.type,
        {...extra,vars:{...extra.vars,...vars},deliveredAt:new Date(dependencies.now?.()??jstNow())});
    }else{
      content = await expandSendCommonVars(
        context.db, resolved.content,
        { kind: 'automation', id: context.action.id },
        { lineAccountId: context.lineAccountId, messageType: resolved.type },
      );
    }
  } catch (error) {
    const { CommonVarResolutionFailedError } = await import('../../services/interpolation-context.js');
    if (error instanceof CommonVarResolutionFailedError) {
      throw invalid(
        'common_var_unresolved',
        `共通情報を解決できません: ${error.failures.map((f) => `{{var.${f.varKey}}}`).join(', ')}`,
      );
    }
    throw error;
  }
  const message = strictMessage(resolved.type, content, resolved.altText);
  const payload = JSON.stringify({ to: friend.line_user_id, messages: [message] });
  if (await reserveLineOperation(context, payload) === 'replay') {
    return { output: { replayed: true } };
  }
  const token = await resolveAccessToken(context, dependencies);
  const client = (dependencies.createLineClient ?? ((value) => new LineClient(value)))(token);
  // 送信呼び出しと送信後の記録は分けて失敗を見る。
  // 呼び出し前の失敗（resolve・検証・予約）は未送信の失敗、
  // 呼び出し後の失敗（受理不明・記録失敗）は照合待ちにする。
  // まとめて分類すると、受理済みの送信を未送信として返却・再送する。
  const finalGate=await readRestaurantAutomationDeliveryGate(context.db,context.runId,dependencies.now?.()??jstNow(),context);
  if(!finalGate.allowed)throw invalid(finalGate.reason,'予約または承認の内容が変わったため送信できません');
  if(finalGate.approval.managed||finalGate.source.restaurant){
    const right=await context.db.prepare(`UPDATE automation_run_steps SET lease_expires_at=lease_expires_at
      WHERE id=? AND status='running' AND automation_run_id=?
        AND EXISTS(SELECT 1 FROM automation_runs WHERE id=? AND status='running' AND automation_version_id=?)
        AND (${initialGate.guard.sql}) AND (${finalGate.guard.sql})`)
      .bind(context.stepExecutionId,context.runId,context.runId,context.automationVersionId,...initialGate.guard.binds,...finalGate.guard.binds).run();
    if(right.meta.changes!==1)throw invalid('restaurant_source_changed','予約または承認の内容が変わったため送信できません');
  }
  let response: unknown;
  try {
    response = await client.pushMessage(friend.line_user_id, [message], context.idempotencyKey);
  } catch (error) {
    throw classifyLinePushError(error);
  }
  const now = dependencies.now?.() ?? jstNow();
  const logId = crypto.randomUUID();
  const source = context.inputEvent.source === 'friend_bulk_run' ? 'friend_bulk_run' : 'automation_v6';
  try {
    await context.db.batch([
      context.db.prepare(
        `INSERT INTO messages_log
           (id, friend_id, direction, message_type, content, broadcast_id,
            scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'push', ?, ?, ?)`,
      ).bind(logId, friend.id, message.type, content, source, context.lineAccountId, now),
      completeOutboundSendStatement(context.db, {
        key: context.idempotencyKey,
        responseId: responseId(response, context.stepExecutionId),
        now,
      }),
    ]);
  } catch {
    /*
     * LINEは受理した後の記録だけ失敗した。未送信として送り直すと
     * 二重に届くので、送達不明として投げる。呼び出し側は送らず
     * 確定もせず、照合待ちに残す（Webhook経路と同じ扱い）。
     */
    throw new AutomationActionError(
      'delivery_unconfirmed',
      '送信後の記録に失敗しました',
      true,
    );
  }
  return { output: { messageLogId: logId, replayed: false } };
}

function responseId(response: unknown, fallback: string): string {
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    for (const key of ['requestId', 'sentMessageId', 'messageId']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  return fallback;
}

async function resolveRichMenuId(context: AutomationActionContext): Promise<string> {
  const supplied = context.action.params.richMenuPageId ?? context.action.params.richMenuId;
  const id = requiredString(supplied, 'rich_menu_id_missing', 'リッチメニュー');
  const page = await context.db.prepare(
    `SELECT p.line_richmenu_id
       FROM rich_menu_pages p
       JOIN rich_menu_groups g ON g.id = p.group_id
      WHERE (p.id = ? OR p.line_richmenu_id = ?)
        AND g.account_id = ? AND g.status = 'published'
        AND p.line_richmenu_id IS NOT NULL
      LIMIT 1`,
  ).bind(id, id, context.lineAccountId).first<{ line_richmenu_id: string }>();
  if (!page) throw invalid('rich_menu_not_found', '公開済みのリッチメニューが見つかりません');
  return page.line_richmenu_id;
}

async function richMenuExecutor(
  context: AutomationActionContext,
  dependencies: AutomationActionExecutorDependencies,
  operation: 'link' | 'unlink',
): Promise<{ output: Record<string, unknown> }> {
  const friend = await requireFriend(context);
  const richMenuId = operation === 'link' ? await resolveRichMenuId(context) : null;
  const payload = JSON.stringify({ userId: friend.line_user_id, operation, richMenuId });
  if (await reserveLineOperation(context, payload) === 'replay') {
    return { output: { replayed: true } };
  }
  try {
    const token = await resolveAccessToken(context, dependencies);
    const client = (dependencies.createLineClient ?? ((value) => new LineClient(value)))(token);
    let alreadyApplied = false;
    if (context.automationId.startsWith('incoming-webhook:') && client.getRichMenuIdOfUser) {
      try {
        const current = await client.getRichMenuIdOfUser(friend.line_user_id);
        alreadyApplied = operation === 'link' && current.richMenuId === richMenuId;
      } catch (error) {
        if (/LINE API error:\s*404\b/.test(error instanceof Error ? error.message : String(error))) {
          alreadyApplied = operation === 'unlink';
        } else {
          throw error;
        }
      }
    }
    if (!alreadyApplied && operation === 'link') {
      await client.linkRichMenuToUser(friend.line_user_id, richMenuId!);
    } else if (!alreadyApplied) {
      await client.unlinkRichMenuFromUser(friend.line_user_id);
    }
    await recordRichMenuAssignment(context.db, {
      friendId: friend.id,
      lineAccountId: context.lineAccountId,
      lineRichMenuId: richMenuId,
      reasonKind: 'automation',
      reasonEventId: context.stepExecutionId,
      idempotencyKey: context.stepExecutionId,
    });
    await completeLineOperation(context, context.stepExecutionId);
    return { output: { replayed: false } };
  } catch (error) {
    throw classifyLineError(error);
  }
}

async function webhookExecutor(
  context: AutomationActionContext,
  dependencies: AutomationActionExecutorDependencies,
): Promise<{ output: Record<string, unknown> }> {
  const webhookId = requiredString(context.action.params.webhookId, 'webhook_id_missing', '送信Webhook');
  await requireScopedResource(context, {
    table: 'outgoing_webhooks', id: webhookId, code: 'webhook_not_found', label: '送信Webhook',
  });
  const webhook = await context.db.prepare(
    `SELECT id, url, secret, secret_encrypted FROM outgoing_webhooks
      WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL`,
  ).bind(webhookId, context.lineAccountId).first<{ id: string; url: string; secret: string | null; secret_encrypted?: string | null }>();
  if (!webhook) throw invalid('webhook_not_active', '動作中の送信Webhookが見つかりません');
  // 送り先の安全確認はpostWebhookSafelyが送信直前と転送先の各段で行う。
  // 署名は送信直前に復号した値で付ける。secretが設定済みで読めない
  // (鍵不足・復号失敗)ときだけ送らずに止める。未設定の旧行は従来どおり送る。
  let sendSecret: string | null = null;
  if (webhook.secret_encrypted || webhook.secret) {
    try {
      sendSecret = await resolveWebhookSecret(webhook, dependencies.credentialEncryptionKey);
    } catch {
      throw invalid('webhook_secret_unavailable', '送信Webhookのsecretを確認できませんでした');
    }
    if (!sendSecret) throw invalid('webhook_secret_unavailable', '送信Webhookのsecretを確認できませんでした');
  }

  // 本文は共通封筒（要件26 §6-2）、ヘッダは X-Harness-* の
  // 共通契約に揃える。イベントIDは冪等キー（step.id）と同じ値なので、
  // 自動化の再試行で同じ出来事を指し続ける。
  const body = buildOutgoingWebhookBody({
    eventId: context.idempotencyKey,
    eventType: typeof context.inputEvent?.type === 'string' ? context.inputEvent.type : 'automation.send_webhook',
    occurredAt: typeof context.inputEvent?.occurredAt === 'string'
      ? context.inputEvent.occurredAt
      : (dependencies.now?.() ?? new Date().toISOString()),
    accountId: context.lineAccountId,
    data: { friendId: context.friendId ?? null, event: context.inputEvent },
    attempt: context.attemptNumber,
  });
  if (dependencies.webhookDeliveryMode !== 'immediate') {
    const { enqueueOutgoingWebhookDelivery, findOutgoingDeliveryByKey } = await import('../../services/outgoing-webhook-delivery.js');
    const queued = await enqueueOutgoingWebhookDelivery(context.db, {
      lineAccountId: context.lineAccountId, webhookId, eventType: 'automation.send_webhook',
      body, idempotencyKey: context.idempotencyKey, maxAttempts: 8,
    });
    const delivery = queued ?? await findOutgoingDeliveryByKey(context.db, webhookId, context.idempotencyKey);
    if (!delivery) throw new Error('webhook_delivery_not_recorded');
    if (delivery.status === 'delivered') return { output: { webhookId, deliveryId: delivery.id, delivered: true } };
    if (delivery.status === 'failed') throw invalid('webhook_delivery_failed', '送信Webhookを届けられませんでした');
    // 後続アクションが先に進まないよう、outbox への登録だけでは完了とせず受理確認を待つ。
    throw new AutomationActionDeferred();
  }
  const headers = await buildOutgoingWebhookHeaders({ eventId: context.idempotencyKey, body, secret: sendSecret });
  // 送信直前の再検査は配送側と共有する。転送先の各段も送る前に確かめる。
  let outcome: SafePostOutcome;
  try {
    outcome = await postWebhookSafely(
      webhook.url,
      { headers, body, signal: AbortSignal.timeout(10_000) },
      { fetchImpl: dependencies.fetch ?? fetch, lookupHost: dependencies.lookupHost },
    );
  } catch (error) {
    await recordDeliveryOutcome(context.db, webhook.id, false);
    throw new AutomationActionError(
      'webhook_connection_failed',
      error instanceof Error ? error.message : '送信Webhookへ接続できませんでした',
      true,
    );
  }
  if ('blocked' in outcome) {
    // 安全でない送り先。秘密値を残さず失敗台帳だけに記録する。
    await recordDeliveryOutcome(context.db, webhook.id, false);
    throw invalid('webhook_url_unsafe', '送信WebhookのURLが安全ではありません');
  }
  const response = outcome.response;
  if (!response.ok) {
    await recordDeliveryOutcome(context.db, webhook.id, false);
    throw new AutomationActionError(
      'webhook_rejected',
      `送信WebhookがHTTP ${response.status}を返しました`,
      response.status === 429 || response.status >= 500,
    );
  }
  try {
    await recordDeliveryOutcome(context.db, webhook.id, true);
  } catch {
    /*
     * HTTP 200 は受けている。送ったあとの記録だけ失敗した。
     * 失敗として送り直すと二重に届くので、送達不明として投げる。
     * 呼び出し側は送らず確定もせず、照合待ちに残す。
     */
    throw new AutomationActionError(
      'delivery_unconfirmed',
      '送信後の記録に失敗しました',
      false,
    );
  }
  return { output: { status: response.status } };
}

/**
 * すること「担当へ知らせる」。担当者通知のルールを、自動通知として
 * 動かす（`X-Line-Harness-Source: manual` は付けない。自動の扱い）。
 * 送り先・経路はルール側に従い、文面だけこの処理のひと言で上書きする。
 */
async function notifyStaffExecutor(
  context: AutomationActionContext,
  dependencies: AutomationActionExecutorDependencies,
): Promise<{ output: Record<string, unknown> }> {
  const ruleId = requiredString(context.action.params.notificationRuleId, 'notification_rule_required', '担当者通知');
  const message = requiredText(context.action.params.message, 'message_required', '通知文');
  const { getNotificationRuleById } = await import('@line-crm/db');
  const rule = await getNotificationRuleById(context.db, ruleId, context.lineAccountId);
  if (!rule || rule.is_active !== 1) {
    throw invalid('notification_rule_not_found', '担当者通知が見つからないか、別のLINE公式アカウントにあります');
  }
  const { dispatchOperatorRule, ruleChannels } = await import('../../services/operator-notification-dispatch.js');
  const mailEnv = dependencies.operatorMailEnv;
  if (ruleChannels(rule).includes('email') && !mailEnv) {
    throw invalid('email_unavailable', 'メールの送信先が使えないため、担当者通知を送れませんでした');
  }
  // メール経路が無ければ env は読まれない（送達側が env を使うのはメールだけ）。
  const result = await dispatchOperatorRule(
    context.db,
    mailEnv as Env['Bindings'],
    rule,
    {
      lineAccountId: context.lineAccountId,
      sourceEventId: context.sourceEventId,
      message,
      executionMode: context.isTest ? 'test' : 'automatic',
    },
  );
  return { output: { notificationRuleId: rule.id, accepted: result.accepted, failed: result.failed } };
}

async function reminderExecutor(context: AutomationActionContext, operation: 'start' | 'stop'): Promise<void> {
  const friend = await requireFriend(context);
  const reminderId = requiredString(context.action.params.reminderId, 'reminder_id_missing', 'リマインダ');
  const reminder = await context.db.prepare('SELECT id FROM reminders WHERE id = ? AND line_account_id = ?')
    .bind(reminderId, context.lineAccountId).first();
  if (!reminder) throw invalid('reminder_not_found', 'リマインダが見つからないか、別のLINE公式アカウントにあります');
  if (operation === 'stop') {
    await context.db.prepare(`UPDATE friend_reminders SET status = 'cancelled', updated_at = ?
      WHERE friend_id = ? AND reminder_id = ? AND status = 'active'`).bind(jstNow(), friend.id, reminderId).run();
    return;
  }
  const sourceEventId = `action:${context.idempotencyKey}`;
  const existing = () => context.db.prepare('SELECT id FROM friend_reminders WHERE friend_id = ? AND reminder_id = ? AND source_event_id = ?')
    .bind(friend.id, reminderId, sourceEventId).first();
  if (await existing()) return;
  const { enrollFriendInReminder } = await import('@line-crm/db');
  try {
    await enrollFriendInReminder(context.db, { friendId: friend.id, reminderId,
      targetDate: typeof context.action.params.targetDate === 'string' ? context.action.params.targetDate : jstNow().slice(0, 10),
      sourceKind: 'automation', sourceId: context.action.id, sourceEventId });
  } catch (error) { if (!await existing()) throw error; }
}

async function mileageExecutor(context: AutomationActionContext): Promise<void> {
  const friend = await requireFriend(context);
  const amount = context.action.params.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
    throw invalid('mileage_amount_invalid', '付与マイルは1から100万の整数で指定してください');
  }
  let source: 'ec' | 'musubo';
  try { source = await resolveMileageSource(context.db, context.lineAccountId); }
  catch { throw new AutomationActionError('MILEAGE_SOURCE_UNAVAILABLE', 'マイルの管理元を確認できませんでした', true); }
  if (source === 'ec') return;
  const { postMileageEntry } = await import('@line-crm/db');
  await postMileageEntry(context.db, { beneficiaryFriendId: friend.id, entryType: 'grant', amount,
    reason: '設定した処理による付与', source: 'automation', sourceEventId: context.sourceEventId,
    idempotencyKey: `action:${context.idempotencyKey}` });
}

export function createAutomationActionExecutors(
  dependencies: AutomationActionExecutorDependencies = {},
): Record<string, AutomationActionExecutor> {
  return {
    add_tag: (context) => tagExecutor(context, 'add', dependencies),
    remove_tag: (context) => tagExecutor(context, 'remove', dependencies),
    notify_staff: (context) => notifyStaffExecutor(context, dependencies),
    set_metadata: metadataExecutor,
    set_support_mark: (context) => supportMarkExecutor(context, dependencies),
    start_scenario: scenarioExecutor,
    stop_scenario: (context) => changeScenarioStatus(context, 'stop'),
    resume_scenario: (context) => changeScenarioStatus(context, 'resume'),
    send_message: (context) => sendMessageExecutor(context, dependencies),
    start_reminder: (context) => reminderExecutor(context, 'start'),
    stop_reminder: (context) => reminderExecutor(context, 'stop'),
    event_booking: async (context) => {
      const { executeEventBookingAction } = await import('../../services/event-booking-actions.js');
      await executeEventBookingAction(context);
    },
    grant_mileage: mileageExecutor,
    send_webhook: (context) => webhookExecutor(context, dependencies),
    switch_rich_menu: (context) => richMenuExecutor(context, dependencies, 'link'),
    remove_rich_menu: (context) => richMenuExecutor(context, dependencies, 'unlink'),
  };
}
