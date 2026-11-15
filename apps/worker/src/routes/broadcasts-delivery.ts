import { assertLimitedAudienceNames, LimitedBroadcastError, storedDeliveryLimit, limitedDeliveryPlan, optionsWithDeliveryConfirmation } from '../features/broadcasts/broadcast-delivery-limit/index.js';
import { scopeSegmentQuery, scopedFriendIds } from '../services/segment-query-scope.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { BROADCAST_DEFINITION_GUARD_SQL, broadcastDefinitionGuardArgs } from '../features/broadcasts/index.js';
import { logger } from '@line-crm/shared/server';
import { simulationContext, scheduleSimulation, processBroadcastSimulation, simulationPreview } from '../features/broadcasts/broadcast-simulation/index.js';
import { maybeStartAb, maybeReplayAbStart } from './broadcast-ab.js';
import { GapError } from '../services/gap-common.js';
import { broadcastSendPreview, broadcastQuietHoursShift } from '../services/gap-send-preview.js';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { sameJsonMeaning } from './broadcast-json.js';
import { parseJsonArray } from './broadcast-json.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getBroadcastById, deleteBroadcast } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { getSendPermissionForAccount } from '../services/send-entitlements.js';
import { processBroadcastSend, processQueuedBroadcasts, guardScheduledBroadcastQuota } from '../features/broadcasts/broadcast/index.js';
import { parseBroadcastMessageParts, unsupportedMessageVariables } from '../features/broadcasts/broadcast-message-set/index.js';
import { computeDedupBroadcastPreview } from '../services/dedup-broadcast.js';
import type { SegmentCondition } from '@line-crm/shared';
import { getLineAccountById } from '@line-crm/db';
import { isOperationCapabilityStopped } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { resolveLineToken } from '../services/line-token.js';

import { BROADCAST_DEFINITION_PUBLISH_KEY } from '@line-crm/shared';
import { hasRecipientVariables } from '../services/render-message.js';
import { releaseQuotaSlot } from '../features/broadcasts/broadcast-quota-guard/index.js';
import { dispatchOperatorEvent } from '../services/operator-notification-dispatch.js';
import { canAccessBroadcast, broadcastDeleteConflictMessage, broadcastWriteBoundary, broadcastAccountIds, rejectIfAudienceUnusable, serializeBroadcast, checkSendableAfterActionVersion, recordLifecycle, kickQueueProcessing } from './broadcasts-definition.js';
import type { Context } from 'hono';

export const delete__api_broadcasts_id_1 = async (c: Context<Env, "/api/broadcasts/:id">) => {
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);
  if (!existing || !await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
  if (existing.status !== 'draft' && existing.status !== 'scheduled') {
    return c.json({ success: false, error: broadcastDeleteConflictMessage(existing.status) }, 409);
  }
  const deleted = await deleteBroadcast(c.env.DB, id);
  if (!deleted) {
    const current = await getBroadcastById(c.env.DB, id);
    if (!current || !await canAccessBroadcast(c.env.DB, c.get('staff'), current)) {
      return fail(c, 404, 'BROADCAST_NOT_FOUND');
    }
    return c.json({ success: false, error: broadcastDeleteConflictMessage(current.status) }, 409);
  }
  return c.json({ success: true, data: null });
};

export const post__api_broadcasts_id_send_2 = async (c: Context<Env, "/api/broadcasts/:id/send">) => {
  if(c.get('impersonation'))return c.json({success:false,code:'IMPERSONATION_SEND_BLOCKED',error:'代理ログイン中は送れません'},403);
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);

  if (!existing) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (!await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
  // 行のaccountを共通境界へ渡す。/broadcasts持ちstaffだけが送れる。
  const sendBoundary = await broadcastWriteBoundary(c, broadcastAccountIds(existing), { operationKey: BROADCAST_DEFINITION_PUBLISH_KEY });
  if (!sendBoundary.allowed) {
    return sendBoundary.reason === 'forbidden'
      ? c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403)
      : fail(c, 404, 'BROADCAST_NOT_FOUND');
  }

  // 宛先をまだ選んでいない下書きを、承認・送信開始へ進めない。
  if (existing.target_type === 'tag' && !existing.target_tag_id) {
    return inputError(c, { success: false, error: '送る相手を選んでください' }, 400, ["targetTagId"]);
  }
  const limitedDelivery = storedDeliveryLimit(existing);
  let approvedLimitCount: number | undefined;
  let confirmedOptions: string | undefined;
  if (limitedDelivery && await simulationContext(c.env.DB, id)) return c.json({success:false,error:'人数に上限を付ける配信は、シミュレーションと併用できません。'},409);
  if (limitedDelivery && await c.env.DB.prepare('SELECT broadcast_id FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first()) return c.json({success:false,error:'人数に上限を付ける配信は、A/Bと併用できません。'},409);
  /*
   * 二者承認のゲート（m12a / -06 §6）。送信時点の宛先数で判定する。
   * 承認が要る人数なのに承認済みでなければ送らない。1人運用の組織では
   * 人数の手入力との一致を見る。既存の原子ロック（下の claim）は変えない。
   */
  try {
    const { enforceBroadcastSendApproval } = await import('../features/broadcasts/broadcast-approval/index.js');
    const sendBody = await c.req.json<{ confirmedRecipientCount?: unknown; expectedVersion?:unknown; scheduledAt?:unknown;testMode?:unknown }>().catch(() => null);
    if(await simulationContext(c.env.DB,id)){const result=await scheduleSimulation(c.env.DB,id,sendBody??{},c.req.header('Idempotency-Key')??'');await processBroadcastSimulation(c.env.DB,id);return c.json({success:true,data:{...result,...await simulationPreview(c.env.DB,id)}});}
    const abReplay=await maybeReplayAbStart(c,id,sendBody);if(abReplay)return abReplay;
    if (existing.correction_of_broadcast_id && sendBody?.expectedVersion === undefined) return c.json({success:false,error:'送る前の確認が必要です'},409);
    if(sendBody?.expectedVersion!==undefined) {
      const current=await broadcastSendPreview(c.env.DB,existing);
      if(sendBody.expectedVersion!==current.expectedVersion||sendBody.confirmedRecipientCount!==current.recipients||current.recipients===0)
        return c.json({success:false,code:'SEND_PREVIEW_CHANGED',error:'送る相手が変わりました。もう一度確かめてください',data:current},409);
    }

    if (limitedDelivery) {
      const plan = await limitedDeliveryPlan(c.env.DB, existing, {requireConfirmation:false});
      if (sendBody?.expectedVersion !== (existing.lock_version ?? 1) || sendBody.confirmedRecipientCount !== plan!.recipientCount) return c.json({success:false,code:'SEND_PREVIEW_CHANGED',error:'上限人数と送る相手をもう一度確かめてください。'},409);
      approvedLimitCount = plan!.recipientCount;
      const parts = parseBroadcastMessageParts({messageType:existing.message_type,messageContent:existing.message_content,messageBubblesJson:existing.message_bubbles_json,messageOptionsJson:existing.message_options_json,altText:existing.alt_text});
      if (parts.some(part => hasRecipientVariables(part.messageContent))) {
        try { await assertLimitedAudienceNames(c.env.DB, plan!.query); }
        catch (error) { if (error instanceof LimitedBroadcastError) return inputError(c,{success:false,error:error.message},400,['name']); throw error; }
      }
      confirmedOptions = optionsWithDeliveryConfirmation(existing, approvedLimitCount, existing.lock_version ?? 1);
    }

    const approvalGate = await enforceBroadcastSendApproval(c.env.DB, existing, {
      confirmedRecipientCount: sendBody?.confirmedRecipientCount,
    });
    if (!approvalGate.allowed) {
      return inputError(c, {
          success: false,
          error: approvalGate.error,
          code: approvalGate.code,
          recipientCount: approvalGate.recipientCount,
          threshold: approvalGate.threshold,
        }, approvalGate.status as 409, []);
    }
    const abResponse=await maybeStartAb(c,id,sendBody);if(abResponse)return abResponse;
    if(sendBody?.expectedVersion!==undefined && existing.line_account_id) {
      if(sendBody.scheduledAt!==undefined && (typeof sendBody.scheduledAt!=='string'||!Number.isFinite(Date.parse(sendBody.scheduledAt))||Date.parse(sendBody.scheduledAt)<=Date.now()))return c.json({success:false,error:'invalid_scheduled_at'},400);
      const at=typeof sendBody.scheduledAt==='string'?sendBody.scheduledAt:new Date().toISOString();
      const shifted=await broadcastQuietHoursShift(c.env.DB,existing.line_account_id,at),scheduled=shifted??(sendBody.scheduledAt as string|undefined);
      if(scheduled){
        const scheduledOptions=approvedLimitCount===undefined?existing.message_options_json:optionsWithDeliveryConfirmation(existing,approvedLimitCount,(existing.lock_version??1)+1);
        const result=await c.env.DB.prepare("UPDATE broadcasts SET status='scheduled',scheduled_at=?,message_options_json=?,lock_version=lock_version+1 WHERE id=? AND status='draft' AND lock_version=? AND COALESCE(approval_status,'none')=?").bind(scheduled,scheduledOptions,id,sendBody.expectedVersion,broadcastDefinitionGuardArgs(existing)[1]).run();
        if(!result.meta.changes)return c.json({success:false,error:'version_conflict'},409);
        return c.json({success:true,data:{scheduled:true,scheduledAt:scheduled,quietHoursShiftTo:shifted}});
      }
    }

  } catch (gateError) {
    if (gateError instanceof LimitedBroadcastError) return inputError(c,{success:false,error:gateError.message},409,["deliveryLimit"]);
    if(gateError instanceof GapError)return c.json({success:false,error:gateError.code},gateError.status);
    // 数えられない（DB到達不能など）ときは送らない。誤送信より停止を選ぶ。
    logger.error("broadcasts.broadcasts_id_send_post_failed");
    return c.json({ success: false, error: '承認の確認ができませんでした。しばらくしてからもう一度お試しください。' }, 503);
  }

  let existingParts;
  try {
    existingParts = parseBroadcastMessageParts({
      messageType: existing.message_type,
      messageContent: existing.message_content,
      messageBubblesJson: existing.message_bubbles_json,
      messageOptionsJson: existing.message_options_json,
      altText: existing.alt_text,
    });
  } catch (messageError) {
    return inputError(c, {
      success: false,
      error: messageError instanceof Error ? messageError.message : '配信内容を読み取れません',
    }, 400, ["messageContent"]);
  }
  const unsupported = unsupportedMessageVariables(existingParts);
  if (unsupported.length > 0) {
    return inputError(c, {
      success: false,
      error: `Unsupported broadcast variables: ${unsupported.map((v) => `{{${v}}}`).join(', ')}`,
    }, 400, ["messageContent"]);
  }

  /*
   * 絞り込み条件で宛先を決める配信。
   *
   * 条件は下書きを作ったときに segment_conditions へ入っている。ここで
   * 読み直して使う。ここを通さないと、この下の「宛先ごとの分岐」が
   * target_type='tag' 以外を全部「全員」として扱うため、絞り込んだつもりの
   * 配信が全員に届く。
   *
   * 送信自体は必ずキューに載せる。条件に当たる人数は事前に読めないので、
   * その場で送ると Worker の30秒制限を超えうる。
   */
  if (existing.target_type === 'segment' && !limitedDelivery) {
    const rawConditions = (existing as unknown as Record<string, unknown>).segment_conditions as string | null;
    let conditions: SegmentCondition | null = null;
    try {
      conditions = rawConditions ? (JSON.parse(rawConditions) as SegmentCondition) : null;
    } catch {
      conditions = null;
    }
    if (!conditions || !Array.isArray(conditions.rules)) {
      return inputError(c, { success: false, error: 'この配信には絞り込み条件が入っていません' }, 400, []);
    }

    // 分析の一時対象者は送信直前にも所属・期限を確かめ直す。
    const sendAudienceError = await rejectIfAudienceUnusable(
      c, conditions,
      (existing as unknown as Record<string, unknown>).line_account_id as string | null,
    );
    if (sendAudienceError) return sendAudienceError;

    const { buildSegmentQuery } = await import('../services/segment-query.js');
    let sql: string;
    let bindings: unknown[];
    try {
      ({ sql, bindings } = buildSegmentQuery(conditions));
    } catch (segmentError) {
      return inputError(c, { success: false, error: segmentError instanceof Error ? segmentError.message : '絞り込み条件を読めません' }, 400, []);
    }

    const accountId = (existing as unknown as Record<string, unknown>).line_account_id as string | null;
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const scoped = scopeSegmentQuery({ sql, bindings }, accountId
      ? { allowedAccountIds: [accountId], canSeeUnassigned: false }
      : scope);
    const fixedAudience = existing.correction_of_broadcast_id
      ? ' WHERE EXISTS (SELECT 1 FROM broadcast_send_claims c WHERE c.broadcast_id=? AND c.friend_id=q.id)' : '';
    const audience = await c.env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN (${DELIVERY_CONSENT_ALLOWED_SQL.replaceAll('f.', 'q.')}) AND (q.display_name IS NULL OR trim(q.display_name) = '') THEN 1 ELSE 0 END) AS missing_name
      FROM (${scoped.sql}) q${fixedAudience}`)
      .bind(...scoped.bindings, ...(existing.correction_of_broadcast_id ? [id] : []))
      .first<{ total: number; missing_name: number | null }>();

    // 名前を差し込む本文は、名前の無い人がいると差し込めない。送る前に止める。
    if (hasRecipientVariables(existing.message_content) && Number(audience?.missing_name ?? 0) > 0) {
      return inputError(c, {
        success: false,
        error: `Cannot personalize broadcast: ${audience!.missing_name} recipient(s) have no display name`,
      }, 400, ["name"]);
    }

    const total = Number(audience?.total ?? 0);
    const lockResult = await c.env.DB.prepare(
      `UPDATE broadcasts
            SET status = 'sending', batch_offset = 0, total_count = ?
          WHERE id = ? AND status IN ('draft','scheduled') ${BROADCAST_DEFINITION_GUARD_SQL}`,
    ).bind(total, id, ...broadcastDefinitionGuardArgs(existing)).run();
    if (!lockResult.meta.changes) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    try {
      const ctx = c.executionCtx as ExecutionContext;
      const defaultClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      ctx.waitUntil(
        processQueuedBroadcasts(c.env.DB, defaultClient, c.env.WORKER_URL).catch((err) => {
          logger.error("broadcasts.broadcasts_id_send_post_failed");
        }),
      );
    } catch (kickErr) {
      // waitUntil が使えない環境では cron が拾う。送れないわけではない。
      logger.warn("broadcasts.kick_queue_processing_failed");
    }

    return c.json({
      success: true,
      data: { id, status: 'sending', totalCount: total },
      queued: true,
      message: 'Broadcast queued for batch processing',
    }, 202);
  }

  // broadcast/multicast は本文を共有するため、受信者別の変数があれば少人数でも個別 push のキューへ進め、Worker の制限内で送る。
  if (hasRecipientVariables(existing.message_content)
    && existing.target_type !== 'multi-account-dedup' && !limitedDelivery) {
    const rawExisting = existing as unknown as Record<string, unknown>;
    const accountId = rawExisting.line_account_id as string | null;
    const where: string[] = ['f.is_following = 1', 'COALESCE(f.is_hidden,0)=0', DELIVERY_CONSENT_ALLOWED_SQL];
    const binds: unknown[] = [];
    if (accountId) {
      where.push('f.line_account_id = ?');
      binds.push(accountId);
    } else {
      const ids = scopedFriendIds(await getVisibleLineAccountScope(c.env.DB, c.get('staff')));
      where.push(`f.id IN (${ids.sql})`);
      binds.push(...ids.bindings);
    }
    if (existing.target_type === 'tag') {
      if (!existing.target_tag_id) {
        return inputError(c, { success: false, error: 'targetTagId is required for tag delivery' }, 400, ["targetTagId"]);
      }
      where.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(existing.target_tag_id);
    }

    const audience = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
                SUM(CASE WHEN f.display_name IS NULL OR trim(f.display_name) = '' THEN 1 ELSE 0 END) AS missing_name
           FROM friends f
          WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ total: number; missing_name: number | null }>();
    const total = Number(audience?.total ?? 0);
    const missingName = Number(audience?.missing_name ?? 0);
    if (missingName > 0) {
      return inputError(c, {
        success: false,
        error: `Cannot personalize broadcast: ${missingName} recipient(s) have no display name`,
      }, 400, ["name"]);
    }

    const conditions: SegmentCondition = existing.target_type === 'tag'
      ? { operator: 'AND', rules: [
          { type: 'is_following', value: true },
          { type: 'tag_exists', value: existing.target_tag_id! },
        ] }
      : { operator: 'AND', rules: [{ type: 'is_following', value: true }] };
    const lockResult = await c.env.DB.prepare(
      `UPDATE broadcasts
            SET status = 'sending', batch_offset = 0, total_count = ?, segment_conditions = ?
          WHERE id = ? AND status IN ('draft','scheduled') ${BROADCAST_DEFINITION_GUARD_SQL}`,
    ).bind(total, JSON.stringify(conditions), id, ...broadcastDefinitionGuardArgs(existing)).run();
    if (!lockResult.meta.changes) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    try {
      const ctx = c.executionCtx as ExecutionContext;
      const defaultClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      ctx.waitUntil(
        processQueuedBroadcasts(c.env.DB, defaultClient, c.env.WORKER_URL).catch((err) => {
          logger.error("broadcasts.broadcasts_id_send_post_failed");
        }),
      );
    } catch (kickErr) {
      logger.warn("broadcasts.kick_queue_processing_failed");
    }

    return c.json({
      success: true,
      data: { id, status: 'sending', totalCount: total },
      queued: true,
      message: 'Personalized broadcast queued for per-recipient delivery',
    }, 202);
  }

  // multi-account-dedup は常にキュー方式 — Worker の30秒制限を超えるため
  if (existing.target_type === 'multi-account-dedup') {
    // アカウントごとの送信ループが実行時間を超えないよう、同期送信せず sending と batch_offset=0 で必ずキューへ載せる。表示が0/0のままにならないよう、軽い単一 SQL で対象数だけは同期確定する。
    const rawExisting = existing as unknown as Record<string, unknown>;
    const accountIds = parseJsonArray(rawExisting.account_ids) ?? [];
    const dedupPriority = parseJsonArray(rawExisting.dedup_priority) ?? [];
    const preview = await computeDedupBroadcastPreview(
      c.env.DB,
      accountIds,
      dedupPriority,
      existing.target_tag_id ?? null,
    );

    // executor (processMultiAccountDedupBroadcast) は inactive/missing
    // アカウントを skip するので、total_count もそれに揃える。preview は
    // inactive 分も含めた全件を返すため、ここでアカウント状態を引き直して
    // active 分だけ集計する。これで confirm/progress UI と実送信数が一致する。
    let projectedTotal = 0;
    let missingDisplayNames = 0;
    const { getLineAccountById } = await import('@line-crm/db');
    for (const a of preview.perAccount) {
      const account = await getLineAccountById(c.env.DB, a.accountId);
      if (account && account.is_active) {
        projectedTotal += a.recipients.length;
        missingDisplayNames += a.recipients.filter((r) => !r.displayName?.trim()).length;
      }
    }
    if (hasRecipientVariables(existing.message_content) && missingDisplayNames > 0) {
      return inputError(c, {
        success: false,
        error: `Cannot personalize broadcast: ${missingDisplayNames} recipient(s) have no display name`,
      }, 400, ["name"]);
    }

    const lockResult = await c.env.DB.prepare(
      `UPDATE broadcasts SET status = 'sending', batch_offset = 0, total_count = ? WHERE id = ? AND status IN ('draft','scheduled') ${BROADCAST_DEFINITION_GUARD_SQL}`
    ).bind(projectedTotal, id, ...broadcastDefinitionGuardArgs(existing)).run();
    if (!lockResult.meta.changes) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    // cron (5min) を待たず即時にバックグラウンド処理を起動する。waitUntil なら
    // レスポンス返却後も Worker が処理を続行できる。失敗しても cron が拾うので
    // 二重で安全。processQueuedBroadcasts 内の楽観ロック (batch_offset=-1) が
    // 並走を防ぐ。
    try {
      const ctx = c.executionCtx as ExecutionContext;
      const defaultClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      ctx.waitUntil(
        processQueuedBroadcasts(c.env.DB, defaultClient, c.env.WORKER_URL).catch((err) => {
          logger.error("broadcasts.broadcasts_id_send_post_failed");
        }),
      );
    } catch (kickErr) {
      // ExecutionContext 未利用環境 (test 等) — cron 経由にフォールバック
      logger.warn("broadcasts_delivery.count_followers_failed");
    }

    return c.json({
      success: true,
      data: { id, status: 'sending', totalCount: projectedTotal },
      queued: true,
      message: 'Broadcast queued for immediate background processing',
    }, 202);
  }

  // target_type='tag' で対象が多い場合はキュー方式
  if (existing.target_type === 'tag' && existing.target_tag_id && !limitedDelivery) {
    const { getFriendsByTag } = await import('@line-crm/db');
    const friends = await getFriendsByTag(
      c.env.DB,
      existing.target_tag_id,
      existing.line_account_id ?? null,
      existing.line_account_id == null ? await getVisibleLineAccountScope(c.env.DB, c.get('staff')) : undefined,
    );
    const followingCount = friends.filter(f => f.is_following).length;

    if (followingCount > 500) {
      // Atomic lock: status='draft'|'scheduled' のときだけ status='sending' に遷移
      const tagMarker = JSON.stringify({ operator: 'AND', rules: [{ type: 'tag_exists', value: existing.target_tag_id }] });
      const lockResult = await c.env.DB.prepare(
        `UPDATE broadcasts SET status = 'sending', batch_offset = 0, segment_conditions = ? WHERE id = ? AND status IN ('draft','scheduled') ${BROADCAST_DEFINITION_GUARD_SQL}`
      ).bind(tagMarker, id, ...broadcastDefinitionGuardArgs(existing)).run();
      if (!lockResult.meta.changes) {
        return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
      }
      const result = await getBroadcastById(c.env.DB, id);
      return c.json({ success: true, data: result ? serializeBroadcast(result) : null, queued: true, message: 'Broadcast queued for batch processing by Cron' }, 202);
    }
  }

  // 500人以下またはtarget_type='all'は即時送信
  // accessToken 解決は lock 前に行う (setup 失敗時に status='sending' で stuck しないため、
  // 即時送信パスには recoverStalledBroadcasts がない)
  let accountToken: string | null = null;
  const broadcastAccountId = (existing as unknown as Record<string, unknown>).line_account_id;
  // 課金の状態（トライアル終了・解約）で配信が止まっている統括は送らない（★36-2）。
  const sendPermission = await getSendPermissionForAccount(c.env.DB, (broadcastAccountId as string | null) ?? null);
  if (!sendPermission.allowed) {
    return c.json({ success: false, error: sendPermission.reason ?? '配信が止まっています' }, 409);
  }
  if (broadcastAccountId) {
    const { getLineAccountById } = await import('@line-crm/db');
    const account = await getLineAccountById(c.env.DB, broadcastAccountId as string);
    accountToken = account?.channel_access_token ?? null;
  }
  const accessToken = resolveLineToken({
    accountToken,
    defaultToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
    accountId: (broadcastAccountId as string | null) ?? null,
    context: 'broadcasts.immediate-send',
  });
  const lineClient = new LineClient(accessToken);

  // 即時送信も LINE 送信の直前に枠と後続アクション版を見直す。
  // ここで止めれば status は draft のまま。確認後の競合は claim と台帳境界が防ぐ。
  const sendAccountId = (broadcastAccountId as string | null) ?? null;
  // 緊急停止 : broadcast_dispatch が止まっている統括の今すぐ送信は
  // 受け付けない。claim 前に止めるので draft/scheduled のまま残る。
  if (await isOperationCapabilityStopped(c.env.DB, sendAccountId, 'broadcast_dispatch')) {
    return c.json({ success: false, error: '緊急停止中のため送信できません' }, 409);
  }
  const afterActionCheck = await checkSendableAfterActionVersion(
    c.env.DB,
    sendAccountId,
    existing.after_action_version_id ?? null,
  );
  if (!afterActionCheck.ok) {
    return c.json({ success: false, error: afterActionCheck.error }, 409);
  }
  const quotaCheck = await guardScheduledBroadcastQuota(c.env.DB, existing, sendAccountId, { reserveBroadcastId: id, confirmedRecipientCount: approvedLimitCount });
  if (quotaCheck.blocked) {
    return c.json({ success: false, error: quotaCheck.message ?? '送信枠が足りないため送れません' }, 409);
  }

  // 予約はこの後 claim→送信の成否に関わらず外す（置き去りは30分で無効になる）。
  // 注釈の言い換え: 別配信間の残枠競合はこの予約台帳で排他する。配信単位の
  // claim は行の二重送信を防ぎ、枠の超過は台帳の合計で防ぐ。
  try {
  // atomic lock — 'draft' と 'scheduled' を分けて単一 UPDATE で claim する。
  // 各 UPDATE は単一 write statement なので read-then-write transaction の
  // SQLITE_BUSY_SNAPSHOT を引き起こさず、claim 成功時の status も WHERE 句から
  // 一意に確定する (rollback 時の status 復元に使用)。
  let claimedStatus: 'draft' | 'scheduled' | null = null;
  const draftClaim = await c.env.DB.prepare(
    `UPDATE broadcasts SET status = 'sending', message_options_json = ? WHERE id = ? AND status = 'draft' ${BROADCAST_DEFINITION_GUARD_SQL}`
  ).bind(confirmedOptions ?? existing.message_options_json ?? null, id, ...broadcastDefinitionGuardArgs(existing)).run();
  if (draftClaim.meta.changes) {
    claimedStatus = 'draft';
  } else {
    const schedClaim = await c.env.DB.prepare(
      `UPDATE broadcasts SET status = 'sending', message_options_json = ? WHERE id = ? AND status = 'scheduled' ${BROADCAST_DEFINITION_GUARD_SQL}`
    ).bind(confirmedOptions ?? existing.message_options_json ?? null, id, ...broadcastDefinitionGuardArgs(existing)).run();
    if (schedClaim.meta.changes) {
      claimedStatus = 'scheduled';
    }
  }
  if (!claimedStatus) {
    return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
  }
  await recordLifecycle(c.env.DB, id, c.get('staff')?.id, 'send_started', { fromStatus: claimedStatus });

  // processBroadcastSend は内部の try/catch で multicast 失敗を 'draft' に戻すが、
  // 冒頭 (updateBroadcastStatus / getBroadcastById / autoTrackContent / buildMessage) で
  // 失敗した場合は内部 catch の対象外。lock を外側で必ず rollback する。
  try {
    await processBroadcastSend(c.env.DB, lineClient, id, c.env.WORKER_URL, quotaCheck.recipientLimitCount === undefined ? undefined : {recipientLimitCount:quotaCheck.recipientLimitCount});
  } catch (err) {
    await c.env.DB.prepare(
      `UPDATE broadcasts SET status = ? WHERE id = ? AND status = 'sending'`
    ).bind(claimedStatus, id).run();
    throw err;
  }

  const result = await getBroadcastById(c.env.DB, id);
  if (result?.status === 'sending' && (result.segment_conditions || limitedDelivery)) kickQueueProcessing(c, 'consent-filtered');
  if (result?.status === 'sent' && result.line_account_id) {
    try {
      await dispatchOperatorEvent(c.env.DB, c.env, {
        lineAccountId: result.line_account_id,
        eventType: 'broadcast_completed',
        sourceEventId: result.id,
        message: `「${result.title}」の一斉配信が完了しました`,
        executionMode: 'automatic',
      });
    } catch (notificationError) {
      // 配信本体は完了済み。通知の失敗で再配信させず、台帳の回収口に残す。
      logger.error("broadcasts.broadcasts_id_send_post_failed");
    }
  }
  return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } finally {
    const retained = limitedDelivery ? await getBroadcastById(c.env.DB, id) : null;
    if (sendAccountId && !(limitedDelivery && retained?.status === 'sending')) await releaseQuotaSlot(c.env.DB, sendAccountId, id);
  }
};

export const post__api_broadcasts_id_send_segment_3 = async (c: Context<Env, "/api/broadcasts/:id/send-segment">) => {
  const id = c.req.param('id');
  const existing = await getBroadcastById(c.env.DB, id);

  if (!existing) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (!await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (storedDeliveryLimit(existing)) return c.json({success:false,error:'上限付きの配信は、送信前の確認から送ってください。'},409);
  if (existing?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);

  if (existing.correction_of_broadcast_id) return c.json({ success: false, error: '送る前の確認から送信してください' }, 409);
  const body = await c.req.json<{ conditions: SegmentCondition }>();

  if (!body.conditions || !body.conditions.operator || !Array.isArray(body.conditions.rules)) {
    return inputError(c, { success: false, error: 'conditions with operator and rules array is required' }, 400, ["conditions"]);
  }

  const segmentAudienceChanged = existing.target_type !== 'segment' || !sameJsonMeaning(existing.segment_conditions, body.conditions);
  if (existing.correction_of_broadcast_id && segmentAudienceChanged) return c.json({ success: false, error: '訂正の宛先は変更できません' }, 409);
  /*
   * 二者承認のゲート。絞り込み送信も人数で判定する。
   * 送る条件は行に無いので、今回の条件を重ねた行で数える。
   */
  try {
    const { enforceBroadcastSendApproval } = await import('../features/broadcasts/broadcast-approval/index.js');
    const mergedForGate = {
      ...existing,
      target_type: 'segment',
      segment_conditions: JSON.stringify(body.conditions),
      ...(segmentAudienceChanged ? { approval_status: 'none' } : {}),
    } as typeof existing;
    const segmentGate = await enforceBroadcastSendApproval(c.env.DB, mergedForGate, {
      confirmedRecipientCount: (body as { confirmedRecipientCount?: unknown }).confirmedRecipientCount,
    });
    if (!segmentGate.allowed) {
      return inputError(c, {
          success: false,
          error: segmentGate.error,
          code: segmentGate.code,
          recipientCount: segmentGate.recipientCount,
          threshold: segmentGate.threshold,
        }, segmentGate.status as 409, []);
    }
  } catch (gateError) {
    logger.error("broadcasts.broadcasts_id_send_segment_post_failed");
    return c.json({ success: false, error: '承認の確認ができませんでした。しばらくしてからもう一度お試しください。' }, 503);
  }

  // 分析の一時対象者は送信直前にも所属・期限を確かめ直す。
  const audienceError = await rejectIfAudienceUnusable(
    c, body.conditions,
    (existing as unknown as Record<string, unknown>).line_account_id as string | null,
  );
  if (audienceError) return audienceError;

  let segmentParts;
  try {
    segmentParts = parseBroadcastMessageParts({
      messageType: existing.message_type,
      messageContent: existing.message_content,
      messageBubblesJson: existing.message_bubbles_json,
      messageOptionsJson: existing.message_options_json,
      altText: existing.alt_text,
    });
  } catch (messageError) {
    return inputError(c, {
      success: false,
      error: messageError instanceof Error ? messageError.message : '配信内容を読み取れません',
    }, 400, ["messageContent"]);
  }
  const unsupported = unsupportedMessageVariables(segmentParts);
  if (unsupported.length > 0) {
    return inputError(c, {
      success: false,
      error: `Unsupported broadcast variables: ${unsupported.map((v) => `{{${v}}}`).join(', ')}`,
    }, 400, ["messageContent"]);
  }

  if (segmentParts.some((part) => hasRecipientVariables(part.messageContent))) {
    const { buildPublicSegmentQuery } = await import('../services/segment-query.js');
    const { sql, bindings } = buildPublicSegmentQuery(body.conditions);
    const accountId = (existing as unknown as Record<string, unknown>).line_account_id as string | null;
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const scoped = scopeSegmentQuery({ sql, bindings }, accountId
      ? { allowedAccountIds: [accountId], canSeeUnassigned: false }
      : scope);
    const audience = await c.env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN (${DELIVERY_CONSENT_ALLOWED_SQL.replaceAll('f.', 'q.')}) AND (q.display_name IS NULL OR trim(q.display_name) = '') THEN 1 ELSE 0 END) AS missing_name
      FROM (${scoped.sql}) q`)
      .bind(...scoped.bindings)
      .first<{ total: number; missing_name: number | null }>();
    if (Number(audience?.missing_name ?? 0) > 0) {
      return inputError(c, {
        success: false,
        error: `Cannot personalize broadcast: ${audience!.missing_name} recipient(s) have no display name`,
      }, 400, []);
    }
  }

  // Atomic lock: status='draft'|'scheduled' のときだけ status='sending' に遷移
  const lockResult = await c.env.DB.prepare(
    `UPDATE broadcasts SET status = 'sending', batch_offset = 0, target_type = 'segment', segment_conditions = ?, approval_status = CASE WHEN ? THEN 'none' ELSE approval_status END, lock_version = lock_version + ? WHERE id = ? AND status IN ('draft','scheduled') ${BROADCAST_DEFINITION_GUARD_SQL}`
  ).bind(JSON.stringify(body.conditions), segmentAudienceChanged ? 1 : 0, segmentAudienceChanged ? 1 : 0, id, ...broadcastDefinitionGuardArgs(existing)).run();
  if (!lockResult.meta.changes) {
    return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
  }

  const result = await getBroadcastById(c.env.DB, id);
  return c.json({ success: true, data: result ? serializeBroadcast(result) : null, queued: true, message: 'Broadcast queued for batch processing by Cron' }, 202);
};
