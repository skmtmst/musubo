import { deliveryLimitFromOptions, limitedDeliveryPlan, optionsWithDeliveryConfirmation } from '../features/broadcasts/broadcast-delivery-limit/index.js';
import { validateAfterActionVersion } from './broadcast-after-action-validation.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getBroadcastById, createBroadcast } from '@line-crm/db';
import type { Broadcast as DbBroadcast } from '@line-crm/db';
import { MAX_BROADCAST_MESSAGES, parseBroadcastMessageParts, unsupportedMessageVariables } from '../features/broadcasts/broadcast-message-set/index.js';
import { parseBroadcastDeliveryLimit, type SegmentCondition } from '@line-crm/shared';
import { getLineAccountById } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { BROADCAST_DEFINITION_EDIT_KEY } from '@line-crm/shared';
import { buildWarnings, hasRecentSimilarBroadcast, previewAudience } from '../features/broadcasts/broadcast-preflight/index.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { fetchQuotaDetails } from '../features/broadcasts/broadcast-quota-guard/index.js';
import { ACCOUNT_ACCESS_ERROR, STANDARD_CONDITION_AXES, BROADCAST_ONLY_CONDITION_AXES, CreateBroadcastBody, UUID_PATTERN, BROADCAST_DRAFT_STEPS, validateMessageOptions, broadcastWriteBoundary, rejectIfAudienceUnusable, sameCreateRequest, serializeBroadcast, recordLifecycle } from './broadcasts-definition.js';
import type { Context } from 'hono';

export const post__api_broadcasts_preflight_1 = async (c: Context<Env, "/api/broadcasts/preflight">) => {
  const body = await c.req.json<{
    targetType?: unknown;
    targetTagId?: unknown;
    lineAccountId?: unknown;
    accountIds?: unknown;
    messageContent?: unknown;
    segmentConditions?: unknown;
    scheduledAt?: unknown;
    messageCount?: unknown;
    deliveryLimit?: unknown;
    correctionDraftId?: unknown;
  }>();

  let deliveryLimit: ReturnType<typeof parseBroadcastDeliveryLimit>;
  try { deliveryLimit = parseBroadcastDeliveryLimit(body.deliveryLimit); } catch (error) {
    return inputError(c, {success:false,error:error instanceof Error ? error.message : '上限人数を確認してください。'},400,['deliveryLimit']);
  }
  const targetType = String(body.targetType ?? 'all');
  if (deliveryLimit && (targetType === 'multi-account-dedup' || !body.lineAccountId)) return inputError(c,{success:false,error:'人数に上限を付ける配信は、1つのLINEアカウントで作ってください。'},400,['deliveryLimit']);
  const requestedAccountIds = targetType === 'multi-account-dedup'
    ? (Array.isArray(body.accountIds) ? body.accountIds.map(String) : [null])
    : [body.lineAccountId == null ? null : String(body.lineAccountId)];
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), requestedAccountIds)) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  /*
   * 条件が読めないときは数えない。
   *
   * 読めない条件を捨てて数えると、絞り込みが無い状態＝全員の人数が出る。
   * 取り消せない操作の直前に、実際より多い数字を出すのがいちばん困る。
   */
  let segmentConditions: SegmentCondition | null = null;
  if (targetType === 'segment' && body.segmentConditions) {
    const raw = body.segmentConditions as SegmentCondition;
    try {
      const { buildSegmentWhere } = await import('../services/segment-query.js');
      buildSegmentWhere(raw);
      segmentConditions = raw;
    } catch (segmentError) {
      return inputError(c, { success: false, error: segmentError instanceof Error ? segmentError.message : 'invalid segmentConditions' }, 400, ["targetType","segmentConditions"]);
    }
  }
  let fixedBroadcastId: string | undefined;
  if (body.correctionDraftId !== undefined) {
    if (typeof body.correctionDraftId !== 'string') return inputError(c, { success: false, error: '下書きを確認できません' }, 400, ['correctionDraftId']);
    const fixed = await getBroadcastById(c.env.DB, body.correctionDraftId);
    if (!fixed || !fixed.correction_of_broadcast_id || fixed.line_account_id !== body.lineAccountId || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [fixed.line_account_id])) return fail(c, 404, 'BROADCAST_NOT_FOUND');
    if (deliveryLimit || targetType !== 'segment') return inputError(c, { success: false, error: '訂正の宛先は変更できません' }, 409, []);
    segmentConditions = fixed.segment_conditions ? JSON.parse(fixed.segment_conditions) as SegmentCondition : null;
    if (!segmentConditions) return inputError(c, { success: false, error: '訂正の宛先を確認できません' }, 409, []);
    fixedBroadcastId = fixed.id;
  }
  const preview = await previewAudience(c.env.DB, {
    targetType,
    fixedBroadcastId,
    targetTagId: body.targetTagId ? String(body.targetTagId) : null,
    lineAccountId: body.lineAccountId ? String(body.lineAccountId) : null,
    accountIds: Array.isArray(body.accountIds) ? body.accountIds.map(String) : undefined,
    segmentConditions,
  });
  const audience = { total: preview.sendable, hiddenExcluded: preview.exclusions.hidden, consentExcluded: preview.exclusions.paused };

  // 同じ本文の配信が直近にあるかは、本文が渡されたときだけ見る。
  // 下書きの段階では本文が空のこともある。
  const content = typeof body.messageContent === 'string' ? body.messageContent : '';
  const hasRecentSimilar = content
    ? await hasRecentSimilarBroadcast(c.env.DB, content, new Date().toISOString())
    : false;
  const accountIds = requestedAccountIds.filter((id): id is string => typeof id === 'string');
  const quotaParts = await Promise.all(accountIds.map(async (accountId) => {
    const account = await getLineAccountById(c.env.DB, accountId);
    if (!account) return { limit: null, used: null, unlimited: false, failures: [], reason: 'LINEアカウントを読み直してください。' };
    return fetchQuotaDetails(account.channel_access_token);
  }));
  const quotaKnown = quotaParts.length > 0
    && quotaParts.every((part) => part.limit !== null && part.used !== null);
  const quotaLimit = quotaKnown
    ? quotaParts.reduce((sum, part) => sum + (part.limit ?? 0), 0)
    : null;
  const quotaUsed = quotaKnown
    ? quotaParts.reduce((sum, part) => sum + (part.used ?? 0), 0)
    : null;
  const unlimited = quotaParts.length > 0 && quotaParts.every(part => part.unlimited);
  let selectedCount = preview.sendable;
  let candidateCount = preview.sendable;
  if (deliveryLimit) {
    try {
      const plan = await limitedDeliveryPlan(c.env.DB, {
        id: 'preflight', target_type: targetType as DbBroadcast['target_type'], line_account_id: String(body.lineAccountId),
        target_tag_id: body.targetTagId ? String(body.targetTagId) : null,
        segment_conditions: segmentConditions ? JSON.stringify(segmentConditions) : null,
        message_options_json: JSON.stringify({ deliveryLimit }), lock_version: 1,
      }, { requireConfirmation: false, quota: quotaParts[0] });
      selectedCount = plan!.recipientCount;
      candidateCount = plan!.candidateCount;
    } catch (error) { return inputError(c, {success:false,error:error instanceof Error ? error.message : '送る人数を確認できませんでした。'},409,['deliveryLimit']); }
  }
  // 同じ送信リクエストの吹き出し数を、月の送信枠へ重ねて数えない。
  const planned = selectedCount;
  const remaining = quotaLimit === null || quotaUsed === null ? null : Math.max(0, quotaLimit - quotaUsed);
  const quotaState = unlimited ? 'available' : remaining === null ? 'unavailable' : planned > remaining ? 'insufficient' : 'available';
  const scheduledAt = typeof body.scheduledAt === 'string' && body.scheduledAt ? body.scheduledAt : null;
  let concurrentBroadcasts: Array<{ id: string; title: string; scheduledAt: string }> = [];
  if (scheduledAt && accountIds.length > 0) {
    const placeholders = sqlIdSet(accountIds).sql;
    const rows = await c.env.DB.prepare(
      `SELECT id, title, scheduled_at
           FROM broadcasts
          WHERE status = 'scheduled' AND scheduled_at IS NOT NULL
            AND line_account_id IN (${placeholders})
            AND ABS(strftime('%s', scheduled_at) - strftime('%s', ?)) <= 3600
          ORDER BY scheduled_at, id LIMIT 10`,
    ).bind(...(accountIds.length ? sqlIdSet(accountIds).binds : []), scheduledAt).all<{ id: string; title: string; scheduled_at: string }>();
    concurrentBroadcasts = rows.results.map((row) => ({ id: row.id, title: row.title, scheduledAt: row.scheduled_at }));
  }

  return c.json({
    success: true,
    data: {
      audienceCount: selectedCount,
      ...(deliveryLimit ? { deliveryLimit: { candidateCount, recipientCount: selectedCount, random: true } } : {}),
      hiddenExcluded: audience.hiddenExcluded,
      consentExcluded: audience.consentExcluded,
      warnings: buildWarnings(audience, { hasRecentSimilar }),
      audience: {
        matched: preview.matched,
        sendable: preview.sendable,
        evaluatedAt: preview.evaluatedAt,
        representatives: preview.representatives,
      },
      exclusions: preview.exclusions,
      quota: {
        unlimited,
        monthlyUsed: quotaUsed,
        monthlyLimit: quotaLimit,
        remaining,
        planned,
        state: quotaState,
        reason: quotaState === 'unavailable' ? quotaParts.find(part => part.reason)?.reason ?? '送信枠を取得できませんでした。LINEの接続設定を確かめてください。' : null,
        failures: quotaParts.flatMap(part => part.failures),
      },
      concurrentBroadcasts,
      conditionAxes: {
        standard: STANDARD_CONDITION_AXES.map(([key, label]) => ({ key, label })),
        broadcastOnly: BROADCAST_ONLY_CONDITION_AXES.map(([key, label]) => ({ key, label })),
      },
    },
  });
};

export const post__api_broadcasts_2 = async (c: Context<Env, "/api/broadcasts">) => {
  const body = await c.req.json<CreateBroadcastBody>();
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  const saveAsDraft = body.saveAsDraft === true;
  const title = body.title?.trim() || (saveAsDraft ? '名称未設定' : '');
  const messageType = body.messageType ?? (saveAsDraft ? 'text' : undefined);
  const messageContent = body.messageContent ?? (saveAsDraft ? '' : undefined);
  const targetType = body.targetType ?? (saveAsDraft ? 'all' : undefined);

  if (idempotencyKey && !UUID_PATTERN.test(idempotencyKey)) {
    return inputError(c, { success: false, error: 'Idempotency-Key must be a UUID' }, 400, []);
  }

  if (!title || !messageType || messageContent === undefined || !targetType) {
    return inputError(c, { success: false, error: 'title, messageType, messageContent, and targetType are required' }, 400, ["title","messageType","messageContent","targetType"]);
  }
  if (body.draftStep !== undefined && !BROADCAST_DRAFT_STEPS.has(body.draftStep)) {
    return inputError(c, { success: false, error: 'draftStep is invalid' }, 400, ["draftStep"]);
  }
  const messageOptionsError = validateMessageOptions(body.messageOptions);
  if (messageOptionsError) return inputError(c, { success: false, error: messageOptionsError }, 400, ["messageOptions"]);

  const requestedAccountIds = targetType === 'multi-account-dedup'
    ? (Array.isArray(body.accountIds) ? body.accountIds : [null])
    : [body.lineAccountId ?? null];
  // 要求accountを共通境界へ渡す。/broadcasts持ちstaffだけが作れる。
  const createBoundary = await broadcastWriteBoundary(c, requestedAccountIds, { operationKey: BROADCAST_DEFINITION_EDIT_KEY });
  if (!createBoundary.allowed) {
    return createBoundary.reason === 'forbidden'
      ? c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403)
      : c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }

  let messageParts: ReturnType<typeof parseBroadcastMessageParts> = [];
  if (!saveAsDraft || body.messageBubbles !== undefined || messageContent) {
    try {
      messageParts = parseBroadcastMessageParts({
        messageType,
        messageContent,
        messageBubbles: body.messageBubbles,
        messageOptions: body.messageOptions,
        altText: body.altText,
      });
    } catch (messageError) {
      return inputError(c, {
        success: false,
        error: messageError instanceof Error ? messageError.message : `messageBubbles must contain 1 to ${MAX_BROADCAST_MESSAGES} items`,
      }, 400, ["messageContent"]);
    }
  }

  // 配る時間の指定。長すぎると送りきる前に日をまたぐので上限を置く。
  if (body.stealthSpreadMinutes !== undefined) {
    const n = Number(body.stealthSpreadMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 720) {
      return inputError(c, { success: false, error: 'stealthSpreadMinutes must be an integer between 0 and 720' }, 400, ["stealthSpreadMinutes"]);
    }
    body.stealthSpreadMinutes = n;
  }

  const unsupported = unsupportedMessageVariables(messageParts);
  if (unsupported.length > 0) {
    return inputError(c, {
      success: false,
      error: `Unsupported broadcast variables: ${unsupported.map((v) => `{{${v}}}`).join(', ')}`,
    }, 400, ["messageContent"]);
  }

  if (targetType === 'tag' && !body.targetTagId && !saveAsDraft) {
    return inputError(c, { success: false, error: 'targetTagId is required when targetType is "tag"' }, 400, ["targetType","saveAsDraft","targetTagId"]);
  }

  /*
   * 絞り込み条件は、下書きを作るこの時点で受け取って保存する。
   *
   * 送信の受け口（send-segment）でも条件を渡せるが、そちらだけにすると
   * 下書きに「誰に送るか」が入っていない状態で残る。一覧から送信を押した人が
   * 条件を持っていないので、全員に送ってしまう。
   */
  let segmentConditions: string | null = null;
  if (body.segmentConditions !== undefined && body.segmentConditions !== null) {
    const raw = body.segmentConditions as { operator?: unknown; rules?: unknown };
    if ((raw.operator !== 'AND' && raw.operator !== 'OR') || !Array.isArray(raw.rules)) {
      return inputError(c, { success: false, error: 'segmentConditions must be { operator: "AND" | "OR", rules: [] }' }, 400, ["segmentConditions"]);
    }
    try {
      // 保存する前に組み立ててみる。作れない条件をそのまま入れると、
      // 送信を押した時点で初めて失敗する。
      const { buildPublicSegmentQuery } = await import('../services/segment-query.js');
      buildPublicSegmentQuery(raw as SegmentCondition);
    } catch (segmentError) {
      return inputError(c, { success: false, error: segmentError instanceof Error ? segmentError.message : 'invalid segmentConditions' }, 400, ["segmentConditions"]);
    }
    segmentConditions = JSON.stringify(raw);
  }

  // 分析の一時対象者は保存時点で所属・期限を確かめる。
  // segment 以外の宛先では条件は使われないので確かめない。
  if (targetType === 'segment' && segmentConditions) {
    const audienceError = await rejectIfAudienceUnusable(
      c, JSON.parse(segmentConditions) as SegmentCondition, body.lineAccountId ?? null,
    );
    if (audienceError) return audienceError;
  }

  if (targetType === 'segment' && !segmentConditions && !saveAsDraft) {
    return inputError(c, { success: false, error: 'segmentConditions is required when targetType is "segment"' }, 400, ["targetType","saveAsDraft"]);
  }

  if (targetType === 'multi-account-dedup') {
    if (!Array.isArray(body.accountIds) || body.accountIds.length < 1) {
      return fail(c, 400, 'ACCOUNT_IDS_LENGTH_1_REQUIRED_FOR_MULTI_ACCOUNT_DEDUP', {}, ["accountIds"]);
    }
    if (!Array.isArray(body.dedupPriority)) {
      return inputError(c, { success: false, error: 'dedupPriority (array, may be empty) required for multi-account-dedup' }, 400, ["dedupPriority"]);
    }
    // 不正なアカウントを優先先として保存しないよう、accountIds にない項目を除く。
    body.dedupPriority = body.dedupPriority.filter((id: unknown) =>
      typeof id === 'string' && body.accountIds!.includes(id));
  }

  if (!await validateAfterActionVersion(
    c.env.DB,
    body.lineAccountId ?? null,
    body.afterActionVersionId,
  )) {
    return inputError(c, { success: false, error: '配信後アクションの公開版が見つかりません' }, 400, ["lineAccountId","afterActionVersionId"]);
  }

  if (idempotencyKey) {
    const existing = await getBroadcastById(c.env.DB, idempotencyKey);
    if (existing) {
      if (!sameCreateRequest(existing, body)) {
        return c.json({ success: false, error: 'Idempotency-Key was already used with a different request' }, 409);
      }
      c.header('Idempotency-Replayed', 'true');
      return c.json({ success: true, data: serializeBroadcast(existing) }, 200);
    }
  }

  if (body.scheduledAt != null && (!Number.isFinite(Date.parse(body.scheduledAt)) || Date.parse(body.scheduledAt) <= Date.now())) {
    return inputError(c, { success: false, error: '予約には未来の日時を指定してください', code: 'SCHEDULE_MUST_BE_FUTURE' }, 400, ['scheduledAt']);
  }

  const newBroadcastId = idempotencyKey ?? crypto.randomUUID();
  let storedMessageOptions = body.messageOptions == null ? null : JSON.stringify(body.messageOptions);
  if (deliveryLimitFromOptions(body.messageOptions)) {
    if (targetType === 'multi-account-dedup' || !body.lineAccountId) return inputError(c,{success:false,error:'人数に上限を付ける配信は、1つのLINEアカウントで作ってください。'},400,['messageOptions']);
    if (body.scheduledAt && !saveAsDraft) {
      try {
        const definition = { id: newBroadcastId, target_type: targetType, target_tag_id: body.targetTagId ?? null, line_account_id: body.lineAccountId,
          segment_conditions: segmentConditions, message_options_json: storedMessageOptions, lock_version: 1 } as DbBroadcast;
        const plan = await limitedDeliveryPlan(c.env.DB, definition, {requireConfirmation:false});
        if (body.confirmedRecipientCount !== plan!.recipientCount) return inputError(c,{success:false,error:'上限人数と送る相手をもう一度確かめてください。'},409,['deliveryLimit']);
        storedMessageOptions = optionsWithDeliveryConfirmation(definition, plan!.recipientCount, 1);
      } catch (error) { return inputError(c,{success:false,error:error instanceof Error?error.message:'送る人数を確認できませんでした。'},409,['deliveryLimit']); }
    }
  }

  let broadcast: DbBroadcast;
  try {
    broadcast = await createBroadcast(c.env.DB, {
      id: newBroadcastId,
      title,
      stealthSpreadMinutes: body.stealthSpreadMinutes ?? 0,
      messageType,
      messageContent,
      messageBubblesJson: body.messageBubbles ? JSON.stringify(body.messageBubbles) : null,
      targetType,
      targetTagId: body.targetTagId ?? null,
      scheduledAt: body.scheduledAt ?? null,
      accountIds: body.accountIds,
      dedupPriority: body.dedupPriority,
      trackLinks: body.trackLinks,
      lineAccountId: body.lineAccountId ?? null,
      altText: body.altText ?? null,
      segmentConditions,
      folderId: body.folderId ?? null,
      measureOpens: body.measureOpens,
      internalMemo: body.internalMemo ?? null,
      draftStep: body.draftStep ?? null,
      draftPayloadJson: saveAsDraft ? JSON.stringify(body) : null,
          messageOptionsJson: storedMessageOptions,
      afterActionVersionId: body.afterActionVersionId ?? null,
      saveAsDraft,
    });
  } catch (createError) {
    // 同時再送は主キーで1件だけ確定し、負けた要求も保存済みの同じ結果を返す。
    const existing = idempotencyKey
      ? await getBroadcastById(c.env.DB, idempotencyKey)
      : null;
    if (!existing) throw createError;
    if (!sameCreateRequest(existing, body)) {
      return c.json({ success: false, error: 'Idempotency-Key was already used with a different request' }, 409);
    }
    c.header('Idempotency-Replayed', 'true');
    return c.json({ success: true, data: serializeBroadcast(existing) }, 200);
  }

  await recordLifecycle(c.env.DB, broadcast.id, c.get('staff')?.id, 'created');
  return c.json({ success: true, data: serializeBroadcast(broadcast) }, 201);
};
