import { releaseQuotaSlot } from '../features/broadcasts/broadcast-quota-guard/index.js';
import { storedDeliveryLimit, deliveryLimitFromOptions, limitedDeliveryPlan, optionsWithDeliveryConfirmation } from '../features/broadcasts/broadcast-delivery-limit/index.js';
import { logger } from '@line-crm/shared/server';
import { simulationContext } from '../features/broadcasts/broadcast-simulation/index.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { validateAfterActionVersion } from './broadcast-after-action-validation.js';
import { parseJsonArray, sameJsonMeaning } from './broadcast-json.js';
import { inputError, validatedInputBody, readBoundedBytes } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getBroadcastById, updateBroadcast, requestBroadcastStop, resumeBroadcastSending, beginBroadcastRetryAttempt, closeClaimsForStop, reopenFailedClaims, getRetryableRecipientIds } from '@line-crm/db';
import type { BroadcastMessageType, BroadcastTargetType } from '@line-crm/db';
import { MAX_BROADCAST_MESSAGES, parseBroadcastMessageParts } from '../features/broadcasts/broadcast-message-set/index.js';
import type { SegmentCondition } from '@line-crm/shared';
import type { Env } from '../worker-env.js';

import { BROADCAST_DEFINITION_EDIT_KEY } from '@line-crm/shared';
import { canAccessBroadcast, BROADCAST_DRAFT_STEPS, validateMessageOptions, broadcastWriteBoundary, ACCOUNT_ACCESS_ERROR, unsupportedVariablesError, parseStoredSegmentConditions, rejectIfAudienceUnusable, recordLifecycle, serializeBroadcast, broadcastLedgerSummary, parseExpectedVersion, recordBroadcastControlAudit, queueMarkerFor, kickQueueProcessing } from './broadcasts-definition.js';
import type { Context } from 'hono';

export const put__api_broadcasts_id_1 = async (c: Context<Env, "/api/broadcasts/:id">) => {
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);

  if (!existing) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (!await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);

  if(await simulationContext(c.env.DB,existing.id))return c.json({success:false,error:'use_simulation_draft_endpoint'},409);
  if (existing.status !== 'draft' && existing.status !== 'scheduled') {
    return inputError(c, { success: false, error: 'Only draft or scheduled broadcasts can be updated' }, 400, []);
  }

  if (existing.status === 'scheduled' && !await sensitiveStepUpSatisfied(c, 'broadcast.send')) {
    return stepUpRequiredResponse(c, '予約した配信を変える前に本人確認してください');
  }
  const body = await c.req.json<{
    title?: string;
    messageType?: BroadcastMessageType;
    messageContent?: string;
    messageBubbles?: unknown[];
    targetType?: BroadcastTargetType;
    targetTagId?: string | null;
    segmentConditions?: unknown;
    scheduledAt?: string | null;
    trackLinks?: boolean;
    folderId?: string | null;
    measureOpens?: boolean;
    stealthSpreadMinutes?: number;
    lineAccountId?: string | null;
    accountIds?: string[];
    saveAsDraft?: boolean;
    draftStep?: 'basic' | 'audience' | 'message' | 'schedule' | 'confirm' | null;
    internalMemo?: string | null;
    messageOptions?: unknown;
    afterActionVersionId?: string | null;
    expectedVersion?: number;
    /** 1人運用のとき、送る人が確認で入れた人数 */
    confirmedRecipientCount?: unknown;
  }>();

  // 版を必須化する。認可・境界・存在の判定は上で済ませてあるため、
  // 他アカウントIDは従来どおり404のまま、ここへは来ない。
  if (body.expectedVersion === undefined) {
    return inputError(c, {
      success: false,
      error: 'expectedVersion（画面が読み込んだ版）が必要です。',
      code: 'EXPECTED_VERSION_REQUIRED',
    }, 400, ["expectedVersion"]);
  }
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return inputError(c, { success: false, error: 'expectedVersion must be a positive integer' }, 400, ["expectedVersion"]);
  }
  if (body.expectedVersion !== (existing.lock_version ?? 1)) {
    return c.json({ success: false, error: '本文または宛先が変わりました。画面を読み直してから保存してください。', code: 'VERSION_CONFLICT' }, 409);
  }
  if (body.draftStep !== undefined && body.draftStep !== null
      && !BROADCAST_DRAFT_STEPS.has(body.draftStep)) {
    return inputError(c, { success: false, error: 'draftStep is invalid' }, 400, ["draftStep"]);
  }
  if (body.scheduledAt != null && (!Number.isFinite(Date.parse(body.scheduledAt)) || Date.parse(body.scheduledAt) <= Date.now())) {
    return inputError(c, { success: false, error: '予約には未来の日時を指定してください', code: 'SCHEDULE_MUST_BE_FUTURE' }, 400, ['scheduledAt']);
  }
  const messageOptionsError = validateMessageOptions(body.messageOptions);
  if (messageOptionsError) return inputError(c, { success: false, error: messageOptionsError }, 400, ["messageOptions"]);

  const existingRaw = existing as unknown as Record<string, unknown>;
  const resultingTargetType = body.targetType ?? existing.target_type;
  const requestedAccountIds = resultingTargetType === 'multi-account-dedup'
    ? (body.accountIds ?? parseJsonArray(existingRaw.account_ids) ?? [null])
    : [body.lineAccountId !== undefined
        ? body.lineAccountId
        : (existingRaw.line_account_id as string | null | undefined) ?? null];
  // 変更後の宛先accountも共通境界へ渡す。/broadcasts持ちstaffだけが変えられる。
  const updateBoundary = await broadcastWriteBoundary(c, requestedAccountIds, { operationKey: BROADCAST_DEFINITION_EDIT_KEY });
  if (!updateBoundary.allowed) {
    return updateBoundary.reason === 'forbidden'
      ? c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403)
      : c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  const resultingTagId = body.targetTagId !== undefined ? body.targetTagId : existing.target_tag_id;
  const reservesBroadcast = body.saveAsDraft !== true
    && (body.scheduledAt !== undefined ? Boolean(body.scheduledAt) : existing.status === 'scheduled');
  // 書きかけの保存は許可し、予約として確定するときだけ宛先を必須にする。
  if (reservesBroadcast && resultingTargetType === 'tag' && !resultingTagId) {
    return inputError(c, { success: false, error: '送る相手を選んでください' }, 400, ["targetTagId"]);
  }
  const resultingAccountId = resultingTargetType === 'multi-account-dedup'
    ? null
    : (body.lineAccountId !== undefined
        ? body.lineAccountId
        : (existingRaw.line_account_id as string | null | undefined) ?? null);
  if (!await validateAfterActionVersion(
    c.env.DB,
    resultingAccountId,
    body.afterActionVersionId,
  )) {
    return inputError(c, { success: false, error: '配信後アクションの公開版が見つかりません' }, 400, ["targetType","lineAccountId","afterActionVersionId"]);
  }

  try {
    parseBroadcastMessageParts({
      messageType: body.messageType ?? existing.message_type,
      messageContent: body.messageContent ?? existing.message_content,
      messageBubbles: body.messageBubbles,
      messageBubblesJson: existing.message_bubbles_json,
      messageOptions: body.messageOptions,
          messageOptionsJson: existing.message_options_json,
    });
  } catch (error) { return inputError(c, { success: false, error: error instanceof Error ? error.message : '本文を確認してください' }, 400, ["messageContent"]); }

  if (body.messageContent !== undefined) {
    const variableError = unsupportedVariablesError(body.messageContent);
    if (variableError) {
      return inputError(c, { success: false, error: variableError }, 400, ["messageContent"]);
    }
  }

  if (body.messageBubbles !== undefined
      && (!Array.isArray(body.messageBubbles)
        || body.messageBubbles.length < 1
        || body.messageBubbles.length > MAX_BROADCAST_MESSAGES)) {
    return inputError(c, {
      success: false,
      error: `messageBubbles must contain 1 to ${MAX_BROADCAST_MESSAGES} items`,
    }, 400, ["messageBubbles"]);
  }

  let segmentConditions: string | null | undefined;
  if (body.segmentConditions !== undefined && body.segmentConditions !== null) {
    const raw = body.segmentConditions as { operator?: unknown; rules?: unknown };
    if ((raw.operator !== 'AND' && raw.operator !== 'OR') || !Array.isArray(raw.rules)) {
      return inputError(c, { success: false, error: 'segmentConditions must be { operator: "AND" | "OR", rules: [] }' }, 400, ["segmentConditions"]);
    }
    try {
      const { buildPublicSegmentQuery } = await import('../services/segment-query.js');
      buildPublicSegmentQuery(raw as SegmentCondition);
    } catch (segmentError) {
      return inputError(c, { success: false, error: segmentError instanceof Error ? segmentError.message : 'invalid segmentConditions' }, 400, ["segmentConditions"]);
    }
    segmentConditions = JSON.stringify(raw);
  } else if (body.segmentConditions === null) {
    segmentConditions = null;
  }

  // 分析の一時対象者は、下書きを保存し直すたびに所属・期限を確かめる。
  // 今回の条件が来なければ、保存済みの条件をそのまま確かめる。
  // 対象の決め方が segment 以外へ変わる保存では条件は使われないので確かめない。
  const resultingSegmentConditions = segmentConditions !== undefined
    ? parseStoredSegmentConditions(segmentConditions)
    : parseStoredSegmentConditions(existingRaw.segment_conditions);
  if (resultingTargetType === 'segment' && resultingSegmentConditions) {
    const audienceError = await rejectIfAudienceUnusable(
      c, resultingSegmentConditions, resultingAccountId,
    );
    if (audienceError) return audienceError;
  }

  if (body.targetType === 'segment' && !segmentConditions) {
    return inputError(c, { success: false, error: 'segmentConditions is required when targetType is "segment"' }, 400, ["targetType"]);
  }

  let stealthSpreadMinutes: number | undefined;
  if (body.stealthSpreadMinutes !== undefined) {
    const n = Number(body.stealthSpreadMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 720) {
      return inputError(c, { success: false, error: 'stealthSpreadMinutes must be an integer between 0 and 720' }, 400, ["stealthSpreadMinutes"]);
    }
    stealthSpreadMinutes = n;
  }

  // 予約日時だけが変わっても、配信の状態を一致させる。
  let statusUpdate: 'draft' | 'scheduled' | undefined = body.saveAsDraft ? 'draft' : undefined;
  if (!body.saveAsDraft && body.scheduledAt !== undefined) {
    statusUpdate = body.scheduledAt ? 'scheduled' : 'draft';
  }

  const snapshotSemanticsChanged = (
    (body.messageType !== undefined && body.messageType !== existing.message_type)
    || (body.messageContent !== undefined && body.messageContent !== existing.message_content)
    || (body.messageBubbles !== undefined
      && !sameJsonMeaning(existing.message_bubbles_json, body.messageBubbles))
    || (body.messageOptions !== undefined && !sameJsonMeaning(existing.message_options_json, body.messageOptions))
    || (body.targetType !== undefined && body.targetType !== existing.target_type)
    || (body.targetTagId !== undefined && body.targetTagId !== existing.target_tag_id)
    || (segmentConditions !== undefined
      && !sameJsonMeaning(existingRaw.segment_conditions, body.segmentConditions))
  );
  const unresolvedAttemptRestarted = !existing.common_var_snapshot
    && Boolean(existing.common_var_snapshot_at)
    && (body.scheduledAt !== undefined || snapshotSemanticsChanged);

  /*
   * 二者承認。新しく予約を入れるとき、1人運用の組織では
   * 人数の手入力との一致が要る。合わなければ予約を作らない。
   * 2人以上なら承認フロー（approval-request）へ進めるので、ここでは止めない。
   */
  let approvalConfirmedCount: number | undefined;
  const makesNewReservation = statusUpdate === 'scheduled' && existing.status !== 'scheduled';
  if (makesNewReservation) {
    try {
      const approval = await import('../features/broadcasts/broadcast-approval/index.js');
      const mergedForGate = {
        ...existing,
        target_type: body.targetType ?? existing.target_type,
        target_tag_id: body.targetTagId !== undefined ? body.targetTagId : existing.target_tag_id,
        segment_conditions: segmentConditions !== undefined
          ? segmentConditions
          : (existingRaw.segment_conditions as string | null | undefined) ?? null,
        line_account_id: resultingAccountId,
        message_options_json: body.messageOptions === undefined ? existing.message_options_json : body.messageOptions === null ? null : JSON.stringify(body.messageOptions),
        account_ids: resultingTargetType === 'multi-account-dedup'
          ? JSON.stringify(body.accountIds ?? [])
          : (existingRaw.account_ids as string | null | undefined) ?? null,
      } as typeof existing;
      const gate = await approval.evaluateApprovalGate(c.env.DB, mergedForGate);
      const limitedGate = await limitedDeliveryPlan(c.env.DB, mergedForGate, {requireConfirmation:false});
      const expectedRecipients = limitedGate?.recipientCount ?? gate.recipientCount;
      if (gate.required && gate.singleOperator) {
        const confirmed = typeof body.confirmedRecipientCount === 'string'
          && body.confirmedRecipientCount.trim() !== ''
          ? Number(body.confirmedRecipientCount)
          : body.confirmedRecipientCount;
        if (typeof confirmed !== 'number' || !Number.isInteger(confirmed)
          || confirmed !== expectedRecipients) {
          return c.json(
            {
              success: false,
              error: `送る相手は${expectedRecipients.toLocaleString('ja-JP')}人です。人数を入れて一致させてください。`,
              code: 'COUNT_MISMATCH',
              recipientCount: gate.recipientCount,
              threshold: gate.threshold,
            },
            409,
          );
        }
        approvalConfirmedCount = confirmed;
      }
    } catch (gateError) {
      logger.error("broadcasts.broadcasts_id_put_failed");
      return c.json({ success: false, error: '承認の確認ができませんでした。しばらくしてからもう一度お試しください。' }, 503);
    }
  }

  const resultingOptions = body.messageOptions === undefined
    ? JSON.parse(existing.message_options_json ?? '{}') as Record<string, unknown>
    : body.messageOptions as Record<string, unknown> | null;
  const limited = deliveryLimitFromOptions(resultingOptions);
  let limitedMessageOptions: string | undefined;
  if (!limited && storedDeliveryLimit(existing) && existing.status === 'scheduled' && statusUpdate !== 'draft') {
    return inputError(c,{success:false,error:'上限を解除する場合は、下書きに戻して送る人数を確かめ直してください。'},409,['deliveryLimit']);
  }
  if (limited) {
    if (!resultingAccountId || resultingTargetType === 'multi-account-dedup') return inputError(c,{success:false,error:'人数に上限を付ける配信は、1つのLINEアカウントで作ってください。'},400,['messageOptions']);
    const publicOptions = { ...resultingOptions }; delete publicOptions.deliveryLimitConfirmation;
    limitedMessageOptions = JSON.stringify(publicOptions);
    if (statusUpdate === 'scheduled' || (existing.status === 'scheduled' && statusUpdate !== 'draft')) {
      try {
        const definition = { ...existing, target_type: resultingTargetType,
          target_tag_id: body.targetTagId === undefined ? existing.target_tag_id : body.targetTagId,
          line_account_id: resultingAccountId,
          segment_conditions: segmentConditions === undefined ? existing.segment_conditions : segmentConditions,
          message_options_json: limitedMessageOptions };
        const plan = await limitedDeliveryPlan(c.env.DB, definition, {requireConfirmation:false});
        if (body.confirmedRecipientCount !== plan!.recipientCount) return inputError(c,{success:false,error:'上限人数と送る相手をもう一度確かめてください。'},409,['deliveryLimit']);
        limitedMessageOptions = optionsWithDeliveryConfirmation(definition, plan!.recipientCount, body.expectedVersion + 1);
      } catch(error) { return inputError(c,{success:false,error:error instanceof Error?error.message:'送る人数を確認できませんでした。'},409,['deliveryLimit']); }
    }
  }

  const updates: Parameters<typeof updateBroadcast>[2] = {
    title: body.title,
    message_type: body.messageType,
    message_content: body.messageContent,
    ...(body.messageBubbles !== undefined
      ? { message_bubbles_json: JSON.stringify(body.messageBubbles) }
      : {}),
    target_type: body.targetType,
    target_tag_id: body.targetTagId,
    ...(segmentConditions !== undefined ? { segment_conditions: segmentConditions } : {}),
    ...(stealthSpreadMinutes !== undefined
      ? { stealth_spread_minutes: stealthSpreadMinutes }
      : {}),
    scheduled_at: body.scheduledAt,
    ...(body.trackLinks !== undefined ? { track_links: body.trackLinks ? 1 : 0 } : {}),
    ...(body.folderId !== undefined ? { folder_id: body.folderId } : {}),
    ...(body.measureOpens !== undefined ? { measure_opens: body.measureOpens ? 1 : 0 } : {}),
    ...(statusUpdate !== undefined ? { status: statusUpdate } : {}),
    ...(body.internalMemo !== undefined ? { internal_memo: body.internalMemo } : {}),
    ...(body.draftStep !== undefined ? { draft_step: body.draftStep } : {}),
    ...(body.saveAsDraft ? { draft_payload_json: JSON.stringify(body) } : {}),
    ...(body.messageOptions !== undefined
      ? { message_options_json: body.messageOptions === null ? null : JSON.stringify(body.messageOptions) }
      : {}),
    ...(body.afterActionVersionId !== undefined
      ? { after_action_version_id: body.afterActionVersionId }
      : {}),
    ...(limitedMessageOptions === undefined ? {} : {message_options_json:limitedMessageOptions}),
    // 解決失敗の再予約、またはsnapshotの意味を実際に変える編集だけを新しい試行にする。
    // 画面は未変更項目もPUTへ含めるため、presenceだけで判定するとprovider再試行で
    // 固定snapshotを誤って捨ててしまう。
    resetCommonVarSnapshot: unresolvedAttemptRestarted || snapshotSemanticsChanged,
    resetApproval: snapshotSemanticsChanged,
    approvalConfirmedCount,
    resetDeliveryAttempt: true,
  };
  let updated;
  try {
    updated = await updateBroadcast(c.env.DB, id, updates, body.expectedVersion);
  } catch {
    logger.error("broadcasts.update_approval_definition_failed");
    return c.json({ success: false, error: '本文と承認状態を保存できませんでした。画面を読み直し、内容を確かめてから保存し直してください。', code: 'BROADCAST_SAVE_FAILED' }, 503);
  }

  if (!updated) {
    return c.json({ success: false, error: '別の画面で下書きが更新されました', code: 'VERSION_CONFLICT' }, 409);
  }

  /*
   * 二者承認。承認の対象（宛先・本文）が変わったら、もらった承認は
   * 白紙に戻す。古い内容への承認で新しい内容を送らせない。
   */
  if (snapshotSemanticsChanged) {
    try {
      const approval = await import('../features/broadcasts/broadcast-approval/index.js');
      if (approval.readApprovalStatus(existing) === 'pending'
        || approval.readApprovalStatus(existing) === 'approved') {
        await approval.recordBroadcastApprovalEvent(c.env.DB, id, c.get('staff')?.id ?? '', 'cancelled', '内容の変更');
      }
    } catch (approvalError) {
      logger.error("broadcasts.broadcasts_id_put_failed");
    }
  }

  await recordLifecycle(
    c.env.DB, id, c.get('staff')?.id, makesNewReservation ? 'scheduled' : 'updated',
  );
  return c.json({ success: true, data: updated ? serializeBroadcast(updated) : null });
};

function containsCancelVersion(text: string): boolean {
  // Decode individual escapes even if another part of the body is malformed.
  let normalized = text;
  for (let i = 0; i < 3; i++) {
    normalized = normalized.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return /expected\s*version/i.test(normalized);
}

export const post__api_broadcasts_id_cancel_2 = async (c: Context<Env, "/api/broadcasts/:id/cancel">) => {
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);
  if (!existing || !await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
  const body = validatedInputBody(c) ?? {};
  if(!validatedInputBody(c)) {
    let value: unknown;
    const bytes=await readBoundedBytes(c.req.raw,64*1024);
    if(bytes===null)return c.json({success:false,error:'送信内容が大きすぎます'},413);
    if(bytes.length){
      const type=(c.req.header('content-type')??'').split(';')[0].trim().toLowerCase();
      if(type==='application/x-www-form-urlencoded') {
        const text=new TextDecoder().decode(bytes);
        const values=new URLSearchParams(text).getAll('expectedVersion');
        if (containsCancelVersion(text)) {
          if (values.length === 0) return inputError(c,{success:false,error:'版を確認してください'},400,['expectedVersion']);
          try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); decodeURIComponent(text.replace(/\+/g, ' ')); }
          catch { return inputError(c,{success:false,error:'送信内容の形式を確認してください'},400,['expectedVersion']); }
        }
        if(values.length>1)return inputError(c,{success:false,error:'版を確認してください'},400,['expectedVersion']);
        value=values[0];
      } else if(type==='multipart/form-data') {
        try {
          const form=await new Request(c.req.url,{method:'POST',headers:c.req.raw.headers,body:bytes}).formData();
          const values=form.getAll('expectedVersion');
          if(values.length>1)return inputError(c,{success:false,error:'版を確認してください'},400,['expectedVersion']);
          value=values[0];
        } catch { return inputError(c,{success:false,error:'送信内容の形式を確認してください'},400); }
      } else {
        // Content-Type が違っても JSON またはフォームとして読める版は照合する。
        const text=new TextDecoder().decode(bytes);
        if (containsCancelVersion(text)) {
          try {
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
            if (text.trimStart().startsWith('{')) {
              const parsed: unknown = JSON.parse(text);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('expectedVersion' in parsed)) throw new Error('invalid version');
              body.expectedVersion = (parsed as Record<string, unknown>).expectedVersion;
            } else {
              decodeURIComponent(text.replace(/\+/g, ' '));
              const values = new URLSearchParams(text).getAll('expectedVersion');
              if (values.length !== 1) throw new Error('invalid version');
              value = values[0];
            }
          } catch { return inputError(c,{success:false,error:'送信内容の版を確認してください'},400,['expectedVersion']); }
        }
      }
    }
    if(value!==undefined) {
      if(typeof value!=='string'||!/^\d+$/.test(value))return inputError(c,{success:false,error:'版を確認してください'},400,['expectedVersion']);
      body.expectedVersion=Number(value);
    }
  }
  const version = body.expectedVersion;
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) {
    return inputError(c, { success: false, error: 'expectedVersion must be a positive integer' }, 400, ['expectedVersion']);
  }
  const conflict = async () => {
    const latest = await getBroadcastById(c.env.DB, id);
    if (!latest || !await canAccessBroadcast(c.env.DB, c.get('staff'), latest)) return fail(c, 404, 'BROADCAST_NOT_FOUND');
    return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの人が予約を変えました。読み直してから、もう一度選んでください', data: serializeBroadcast(latest) }, 409);
  };
  if (version !== undefined && version !== (existing.lock_version ?? 1)) return conflict();
  if (existing.status !== 'scheduled' || !existing.scheduled_at) {
    return version === undefined ? c.json({ success: false, error: 'Only scheduled broadcasts can be cancelled' }, 409) : conflict();
  }

  const result = await c.env.DB.prepare(
    `UPDATE broadcasts
       SET status = 'draft', scheduled_at = NULL, batch_lock_at = NULL,
           common_var_snapshot = NULL, common_var_snapshot_at = NULL,
           lock_version = COALESCE(lock_version, 1) + 1
       WHERE id = ? AND status = 'scheduled' AND scheduled_at IS NOT NULL
         AND (? IS NULL OR COALESCE(lock_version, 1) = ?)`,
  ).bind(id, version ?? null, version ?? null).run();

  if ((result.meta.changes ?? 0) !== 1) {
    return version === undefined ? c.json({ success: false, error: 'Broadcast is no longer scheduled' }, 409) : conflict();
  }

  const updated = await getBroadcastById(c.env.DB, id);
  if (!updated) {
      throw new Error('broadcast_missing_after_cancellation');
  }
  if (existing.line_account_id && storedDeliveryLimit(existing)) await releaseQuotaSlot(c.env.DB,existing.line_account_id,id);
  await recordLifecycle(c.env.DB, id, c.get('staff')?.id, 'cancelled');
  return c.json({ success: true, data: serializeBroadcast(updated) });
};

export const post__api_broadcasts_id_stop_3 = async (c: Context<Env, "/api/broadcasts/:id/stop">) => {
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);
  if (!existing || !await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);

  /*
   * 全員配信（target_type='all'）は止められない。
   *
   * LINE の broadcast の口は「全員へ配って」と1回頼むだけで、こちらに
   * 宛先の一覧が無い。頼んだあとに止める手段が LINE 側に無いので、
   * **できないことをできるように見せない**。
   */
  if (existing.target_type === 'all' && !existing.segment_conditions) {
    return c.json({
      success: false,
      error: '全員への配信は、送り始めると途中で止められません（LINE側に停止の口がありません）。',
      code: 'BROADCAST_NOT_STOPPABLE',
    }, 409);
  }
  if (existing.status !== 'sending') {
    return c.json({
      success: false,
      error: '送信中の配信だけ停止できます。',
      code: 'BROADCAST_NOT_SENDING',
    }, 409);
  }

  // 冪等: もう止まっているなら、同じ結果をそのまま返す。連打や再送信で
  // 失敗に見せない（運用者は「止まったのか、止まっていないのか」だけを
  // 知りたい）。
  const rawExisting = existing as unknown as Record<string, unknown>;
  if (rawExisting.stopped_at) {
    return c.json({
      success: true,
      data: {
        ...serializeBroadcast(existing),
        ledger: await broadcastLedgerSummary(c.env.DB, id),
      },
      alreadyStopped: true,
    });
  }

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const expectedVersion = parseExpectedVersion((body as Record<string, unknown>).expectedVersion);
  if (expectedVersion === null) {
    return inputError(c, {
      success: false,
      error: 'expectedVersion（画面が読み込んだ版）が必要です。',
      code: 'EXPECTED_VERSION_REQUIRED',
    }, 400, ["expectedVersion"]);
  }

  const changes = await requestBroadcastStop(c.env.DB, {
    id,
    expectedVersion,
    actorId: c.get('staff')?.id ?? null,
  });
  if (changes !== 1) {
    // 負けた側。相手が止めていたなら冪等に成功で返す。そうでなければ
    // 版が食い違っている（別の操作が先に入った）。
    const current = await getBroadcastById(c.env.DB, id);
    const currentRaw = current as unknown as Record<string, unknown> | null;
    if (current && currentRaw?.stopped_at) {
      return c.json({
        success: true,
        data: {
          ...serializeBroadcast(current),
          ledger: await broadcastLedgerSummary(c.env.DB, id),
        },
        alreadyStopped: true,
      });
    }
    return c.json({
      success: false,
      error: '配信の状態が更新されました（自動復旧を含みます）。画面を読み直してからやり直してください。',
      code: 'VERSION_MISMATCH',
    }, 409);
  }

  /*
   * 台帳を締める。
   *
   *   外へ出したあと決着していない相手 → **送達不明**。成功とも失敗とも
   *     断定しない。再送の対象にしない（at-most-once）
   *   押さえただけで外へ出していない相手 → **失敗**。まだ誰にも届いて
   *     いないので送り直してよい
   */
  const closed = await closeClaimsForStop(c.env.DB, id);
  const updated = await getBroadcastById(c.env.DB, id);
  const ledger = await broadcastLedgerSummary(c.env.DB, id);
  await recordBroadcastControlAudit(c, 'broadcast.stop', existing, {
    undeliveredUnknown: closed.unknown,
    releasedForRetry: closed.failed,
    sent: ledger.sent,
  });
  await recordLifecycle(c.env.DB, id, c.get('staff')?.id, 'stopped', {
    undeliveredUnknown: closed.unknown,
    sent: ledger.sent,
  });
  return c.json({
    success: true,
    data: { ...serializeBroadcast(updated ?? existing), ledger },
    stoppedUnknownCount: closed.unknown,
  });
};

export const post__api_broadcasts_id_resume_4 = async (c: Context<Env, "/api/broadcasts/:id/resume">) => {
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);
  if (!existing || !await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
  const rawExisting = existing as unknown as Record<string, unknown>;
  if (existing.status !== 'sending' || !rawExisting.stopped_at) {
    return c.json({
      success: false,
      error: '停止中の配信だけ再開できます。',
      code: 'BROADCAST_NOT_STOPPED',
    }, 409);
  }

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const expectedVersion = parseExpectedVersion((body as Record<string, unknown>).expectedVersion);
  if (expectedVersion === null) {
    return inputError(c, {
      success: false,
      error: 'expectedVersion（画面が読み込んだ版）が必要です。',
      code: 'EXPECTED_VERSION_REQUIRED',
    }, 400, ["expectedVersion"]);
  }

  const changes = await resumeBroadcastSending(c.env.DB, {
    id,
    expectedVersion,
    segmentConditions: queueMarkerFor(existing),
  });
  if (changes !== 1) {
    return c.json({
      success: false,
      error: '別の操作が先に入りました。画面を読み直してからやり直してください。',
      code: 'VERSION_MISMATCH',
    }, 409);
  }

  const updated = await getBroadcastById(c.env.DB, id);
  const ledger = await broadcastLedgerSummary(c.env.DB, id);
  await recordBroadcastControlAudit(c, 'broadcast.resume', existing, { sent: ledger.sent });
  await recordLifecycle(c.env.DB, id, c.get('staff')?.id, 'resumed');
  kickQueueProcessing(c, 'resume');
  return c.json({ success: true, data: { ...serializeBroadcast(updated ?? existing), ledger } });
};

export const post__api_broadcasts_id_retry_failed_5 = async (c: Context<Env, "/api/broadcasts/:id/retry-failed">) => {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);
    if (!existing || !await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
      return fail(c, 404, 'BROADCAST_NOT_FOUND');
    }
    if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
    if (existing.target_type === 'all' && !existing.segment_conditions) {
      return c.json({
        success: false,
        error: '全員への配信は宛先の一覧を持たないため、失敗した相手だけの再送ができません。',
        code: 'BROADCAST_NOT_RETRYABLE',
      }, 409);
    }
    const rawExisting = existing as unknown as Record<string, unknown>;
    const stopped = !!rawExisting.stopped_at;
    if (!(existing.status === 'sent' || (existing.status === 'sending' && stopped))) {
      return c.json({
        success: false,
        error: '送信済み、または停止中の配信だけ再送できます。',
        code: 'BROADCAST_NOT_RETRYABLE',
      }, 409);
    }

    // 再送できるのは一時的な失敗だけ。恒常的な失敗（ブロックなど）は
    // 送り直しても通らないので対象にしない。
    const retryable = await getRetryableRecipientIds(c.env.DB, id);
    if (retryable.length === 0) {
      return c.json({
        success: false,
        error: '再送できる相手がいません。一時的な失敗だけを送り直します（送達不明・届けられなかった相手は送りません）。',
        code: 'NO_RETRY_TARGET',
      }, 409);
    }

    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const expectedVersion = parseExpectedVersion((body as Record<string, unknown>).expectedVersion);
    if (expectedVersion === null) {
      return inputError(c, {
        success: false,
        error: 'expectedVersion（画面が読み込んだ版）が必要です。',
        code: 'EXPECTED_VERSION_REQUIRED',
      }, 400, ["expectedVersion"]);
    }

    const attempt = await beginBroadcastRetryAttempt(c.env.DB, {
      id,
      expectedVersion,
      segmentConditions: queueMarkerFor(existing),
    });
    if (attempt.changes !== 1 || attempt.attemptNo === null) {
      return c.json({
        success: false,
        error: '別の操作が先に入りました。画面を読み直してからやり直してください。',
        code: 'VERSION_MISMATCH',
      }, 409);
    }

    // 失敗した相手だけを新しい試行番号で開け直す。送達済み・送達不明の行は
    // 触らない（`state = 'failed'` で絞る）。
    const reopened = await reopenFailedClaims(c.env.DB, id, attempt.attemptNo);
    const updated = await getBroadcastById(c.env.DB, id);
    const ledger = await broadcastLedgerSummary(c.env.DB, id);
    await recordBroadcastControlAudit(c, 'broadcast.retry_failed', existing, {
      attemptNo: attempt.attemptNo,
      retryTargets: reopened,
      skippedUnknown: ledger.unknown,
    });
    await recordLifecycle(c.env.DB, id, c.get('staff')?.id, 'retried', {
      attemptNo: attempt.attemptNo,
      retryTargets: reopened,
    });
    kickQueueProcessing(c, 'retry-failed');
    return c.json({
      success: true,
      data: { ...serializeBroadcast(updated ?? existing), ledger },
      attemptNo: attempt.attemptNo,
      retryTargets: reopened,
    }, 202);
  };
