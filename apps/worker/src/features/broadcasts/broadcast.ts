import { assertLimitedAudienceNames, storedDeliveryLimit, limitedDeliveryPlan, freezeLimitedAudience, holdLimitedBroadcast, renewLimitedReservation, LimitedBroadcastError } from './broadcast-delivery-limit.js';
import { scopeStoredBroadcastSegmentQuery, restrictSegmentInput, scopedFriendIds, storedBroadcastFriendScope } from '../../services/segment-query-scope.js';
import { BROADCAST_DEFINITION_GUARD_SQL, broadcastDefinitionGuardArgs } from './broadcast-definition-guard.js';
import { logger } from '@line-crm/shared/server';
import {processBroadcastSimulation} from './broadcast-simulation.js';
import { broadcastWideContext } from './broadcast-wide-context.js';
import { DELIVERY_CONSENT_ALLOWED_SQL, recordSuppressedBroadcastRecipients, suppressedFriendIds, hasSuppressedDeliveryRecipients } from '@line-crm/db/src/friend-delivery-consents.js';
import { holdMissingBroadcastAudience, confirmedHqAudience, broadcastAudienceToken } from './broadcast-audience-snapshot.js';
import { buildBroadcastAudienceQuery as buildSegmentQuery } from './broadcast-audience-query.js';
import { buildMessage } from '../../services/line-message.js';
import {
  getBroadcastById,
  getBroadcasts,
  getQueuedBroadcasts,
  updateBroadcastStatus,
  updateBroadcastBatchProgress,
  getFriendsByTag,
  jstNow,
  updateBroadcastLineRequestId,
  createBroadcastInsight,
  getBlockedRecipientIds,
  markBroadcastRecipientsDispatched,
  buildBroadcastSettleStatements,
  settleBroadcastRecipients,
  isBroadcastStopped,
  isOperationCapabilityStopped,
  listLineAccountsWithTenantStatus,
  recordBroadcastLifecycleEvent,
  recordSkippedDelivery,
} from '@line-crm/db';
import type { Broadcast } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep } from '../../services/stealth.js';
import {
  type BroadcastRenderContext,
} from '../../services/render-message.js';
import { aggregationUnitFor, aggregationUnits } from './broadcast-aggregation.js';
import { getFriendFieldMap } from '@line-crm/db';
import { contentNeedsFriendFields } from '../../services/interpolation-context.js';
import { createBroadcastRetryKey } from './broadcast-retry-key.js';
import { processBroadcastAfterActions } from './broadcast-after-actions.js';
import { classifyDeliveryFailure, deliveryErrorCode } from './broadcast-delivery-outcome.js';
import { evaluateQuota, fetchQuota, shortfallMessage } from './broadcast-quota-guard.js';
import { getSendPermissionForAccount, type SendPermissionCache } from '../../services/send-entitlements.js';
import { recordLineTokenDefaultFallback } from '../../services/line-token.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import { isStoppedTenantStatus } from '../../services/tenant-runtime-status.js';
import { assertAnalyticsAudiencesUsable, BroadcastAudienceError } from '../../services/segment-audience-guard.js';
import type { SegmentCondition } from '@line-crm/shared';
import {
  assertMessagePartsResolved,
  autoTrackMessageParts,
  buildMessages,
  combinedMessageContent,
  hasRecipientVariablesInParts,
  parseBroadcastMessageParts,
  renderMessageParts,
  unsupportedMessageVariables,
  varyTextMessages,
} from './broadcast-message-set.js';
import {
  commonVarValuesForAccount,
  prepareBroadcastCommonVarSnapshot,
} from '../../services/common-var-snapshot.js';

// LINE の multicast は 1 リクエストで最大 500 人まで宛先に取れる（LINE の仕様）。
// これ以上に増やすことはできない。
const MULTICAST_BATCH_SIZE = 500;
// 差し込み（{{name}} など）があると本文が人ごとに変わるので multicast が使えず、
// push を 1 人ずつ送る。この数はレート制限ではなく **区切りの単位**で、
// 「ここまで送ったら時間を見る／少し待つ」という判断をこの粒度で行う。
// 小さいほど中断したときの取りこぼしが減り、大きいほど待ちの回数が減る。
const PERSONALIZED_PUSH_BATCH_SIZE = 10;

/**
 * 差し込み配信は multicast が使えないため、1人ずつ push する。
 * Workers の subrequest 上限1,000に対し、1人あたり照合・友だち取得・送信・記録で最大4回使う。150人なら600回となる。
 * 10人ごとに batch_offset を保存し、実行が切れても次の cron で再開する。送信済み照合により二重送信を防ぐ。
 */
const PERSONALIZED_PUSH_PER_TICK = 150;

export async function processBroadcastSend(
  db: D1Database,
  lineClient: LineClient,
  broadcastId: string,
  workerUrl?: string,
  delivery?: { recipientLimitCount: number },
  expectedLockVersion?: number,
): Promise<Broadcast> {
  if(await processBroadcastSimulation(db,broadcastId))return (await getBroadcastById(db,broadcastId))!;

  if(expectedLockVersion!==undefined) {
    const active=await db.prepare("UPDATE broadcasts SET status='sending' WHERE id=? AND status='sending' AND stopped_at IS NULL AND lock_version=?")
      .bind(broadcastId,expectedLockVersion).run();
    if(!active.meta.changes)return (await getBroadcastById(db,broadcastId))!;
  } else await updateBroadcastStatus(db, broadcastId, 'sending');

  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const storedParts = parseBroadcastMessageParts({
    messageType: broadcast.message_type,
    messageContent: broadcast.message_content,
    messageBubblesJson: broadcast.message_bubbles_json,
    messageOptionsJson: broadcast.message_options_json,
    altText: broadcast.alt_text,
  });
  const commonVarSnapshot = await prepareBroadcastCommonVarSnapshot(
    db,
    broadcast,
    combinedMessageContent(storedParts),
  );

  const unsupportedVariables = unsupportedMessageVariables(storedParts);
  if (unsupportedVariables.length > 0) {
    throw new Error(
      `Unsupported broadcast variables: ${unsupportedVariables.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }

  if (storedDeliveryLimit(broadcast)) {
    const plan = await limitedDeliveryPlan(db, broadcast);
    if (hasRecipientVariablesInParts(storedParts)) await assertLimitedAudienceNames(db, plan!.query);
    await freezeLimitedAudience(db, broadcast, Math.min(plan!.recipientCount, delivery?.recipientLimitCount ?? plan!.recipientCount));
    return (await getBroadcastById(db, broadcastId))!;
  }

  let fixedHqAudience: ReturnType<typeof confirmedHqAudience>;
  try { fixedHqAudience=confirmedHqAudience(broadcast); }
  catch { await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:1,known:0,started:true,expectedLockVersion});return (await getBroadcastById(db,broadcastId))!; }
  if(fixedHqAudience){
    const stored=typeof broadcast.segment_conditions==='string'?JSON.parse(broadcast.segment_conditions):null;
    if(!stored||!Array.isArray(stored.rules))throw new BroadcastAudienceError('audience_missing');
    await assertAnalyticsAudiencesUsable(db,stored,broadcast.line_account_id??null);
    const known=await db.prepare('SELECT COUNT(*) n FROM broadcast_send_claims WHERE broadcast_id=?').bind(broadcast.id).first<{n:number}>();
    if(await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:fixedHqAudience.count,known:Number(known?.n??0),started:true,expectedLockVersion}))return (await getBroadcastById(db,broadcastId))!;
    if(hasRecipientVariablesInParts(storedParts)){
      const missing=await db.prepare(`SELECT COUNT(*) n FROM broadcast_send_claims c JOIN friends f ON f.id=c.friend_id
        WHERE c.broadcast_id=? AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND (${DELIVERY_CONSENT_ALLOWED_SQL}) AND (f.display_name IS NULL OR trim(f.display_name)='')`).bind(broadcast.id).first<{n:number}>();
      if(Number(missing?.n??0)>0)throw new Error('Cannot personalize broadcast: recipient has no display name');
    }
    await db.prepare("UPDATE broadcasts SET status='sending',batch_offset=0 WHERE id=?").bind(broadcast.id).run();
    return (await getBroadcastById(db,broadcastId))!;
  }

  // LINE broadcast は一部の友だちを除外できないため、同意条件がある場合は all 設定を保ったまま、再開可能な宛先台帳の経路へ切り替える。
  if (broadcast.target_type === 'all' && !hasRecipientVariablesInParts(storedParts)
    && await hasSuppressedDeliveryRecipients(db, broadcast.line_account_id ?? null)) {
    const conditions = JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] });
    await db.prepare(`UPDATE broadcasts SET status='sending',batch_offset=0,segment_conditions=? WHERE id=?`)
      .bind(conditions, broadcast.id).run();
    return (await getBroadcastById(db, broadcastId))!;
  }

  // broadcast/multicast は全員で同じメッセージを使うため、宛先ごとの変数があれば再開可能なキューへ切り替える。
  if (hasRecipientVariablesInParts(storedParts)
    && broadcast.target_type !== 'multi-account-dedup') {
    const raw = broadcast as unknown as Record<string, unknown>;
    const accountId = raw.line_account_id as string | null;

    /*
     * 絞り込み条件つきの個人化配信。
     *
     * 保存済みの segment_conditions をそのまま残す。is_following だけへ
     * 上書きすると、分析の一時対象者（analytics_audience）を含む条件が消えて
     * 全フォロワーへ届く。条件はキュー側が各束で読み直すので、期限切れの
     * 対象者は残りが自然に0人になる。
     */
    if (broadcast.target_type === 'segment') {
      const stored = raw.segment_conditions as string | null;
      if (!stored) {
        throw new Error('segment_conditions is required for segment broadcast');
      }
      let storedConditions: SegmentCondition;
      try {
        storedConditions = JSON.parse(stored) as SegmentCondition;
      } catch {
        throw new Error('segment_conditions is malformed');
      }
      // 分析の一時対象者は送信直前にも所属・期限を確かめ直す。
      await assertAnalyticsAudiencesUsable(db, storedConditions, accountId);
      const { sql, bindings } = buildSegmentQuery(storedConditions);
      const scoped = await scopeStoredBroadcastSegmentQuery(db, { sql, bindings }, accountId);
      const segmentAudience = await db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN (${DELIVERY_CONSENT_ALLOWED_SQL.replaceAll('f.', 'q.')}) AND (q.display_name IS NULL OR trim(q.display_name) = '') THEN 1 ELSE 0 END) AS missing_name
        FROM (${scoped.sql}) q`)
        .bind(...scoped.bindings)
        .first<{ total: number; missing_name: number | null }>();
      if (Number(segmentAudience?.missing_name ?? 0) > 0) {
        throw new Error(`Cannot personalize broadcast: ${segmentAudience!.missing_name} recipient(s) have no display name`);
      }
      const frozen = await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?').bind(broadcast.id).first<{n:number}>();
      await db.prepare(
        `UPDATE broadcasts
            SET status = 'sending', batch_offset = 0, total_count = ?
          WHERE id = ? AND lock_version=? AND stopped_at IS NULL AND status='sending'`,
      ).bind(Number(frozen?.n || segmentAudience?.total || 0), broadcast.id,broadcast.lock_version ?? 1).run();
      return (await getBroadcastById(db, broadcastId))!;
    }

    const where: string[] = ['f.is_following = 1', 'COALESCE(f.is_hidden,0)=0', DELIVERY_CONSENT_ALLOWED_SQL];
    const binds: unknown[] = [];
    if (accountId) {
      where.push('f.line_account_id = ?');
      binds.push(accountId);
    } else {
      const ids = scopedFriendIds(await storedBroadcastFriendScope(db, null));
      where.push(`f.id IN (${ids.sql})`);
      binds.push(...ids.bindings);
    }
    if (broadcast.target_type === 'tag') {
      if (!broadcast.target_tag_id) throw new Error('target_tag_id is required for personalized tag broadcast');
      where.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(broadcast.target_tag_id);
    }
    const audience = await db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN f.display_name IS NULL OR trim(f.display_name) = '' THEN 1 ELSE 0 END) AS missing_name
         FROM friends f WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ total: number; missing_name: number | null }>();
    if (Number(audience?.missing_name ?? 0) > 0) {
      throw new Error(`Cannot personalize broadcast: ${audience!.missing_name} recipient(s) have no display name`);
    }
    const conditions = broadcast.target_type === 'tag'
      ? { operator: 'AND', rules: [
          { type: 'is_following', value: true },
          { type: 'tag_exists', value: broadcast.target_tag_id },
        ] }
      : { operator: 'AND', rules: [{ type: 'is_following', value: true }] };
    await db.prepare(
      `UPDATE broadcasts
          SET status = 'sending', batch_offset = 0, total_count = ?, segment_conditions = ?
        WHERE id = ?`,
    ).bind(Number(audience?.total ?? 0), JSON.stringify(conditions), broadcast.id).run();
    return (await getBroadcastById(db, broadcastId))!;
  }

  /*
   * 絞り込み配信は、この関数では送らずキューへ渡す。
   *
   * ここを通さないと、下のふつうの経路（LINE の broadcast/multicast）へ
   * 落ちて**全員に届く**。予約した絞り込み配信が全員に飛ぶ形で表に出る。
   * 条件は下書きの segment_conditions に入っているので、
   * status='sending' に移せば processQueuedBroadcasts が拾う。
   */
  if (broadcast.target_type === 'segment') {
    const raw = broadcast as unknown as Record<string, unknown>;
    const stored = raw.segment_conditions as string | null;
    if (!stored) {
      throw new Error('segment_conditions is required for segment broadcast');
    }
    const conditions = JSON.parse(stored) as { operator: 'AND' | 'OR'; rules: unknown[] };
    if (!conditions || !Array.isArray(conditions.rules)) {
      throw new Error('segment_conditions is malformed');
    }
    const accountId = raw.line_account_id as string | null;
    // 分析の一時対象者は送信直前にも所属・期限を確かめ直す。
    // BroadcastAudienceError は呼出し側が拾い、予約を下書きへ戻す。
    await assertAnalyticsAudiencesUsable(
      db, conditions as Parameters<typeof buildSegmentQuery>[0], accountId,
    );
    const { sql, bindings } = buildSegmentQuery(conditions as Parameters<typeof buildSegmentQuery>[0]);
    const scoped = await scopeStoredBroadcastSegmentQuery(db, { sql, bindings }, accountId);
    const row = await db.prepare(`SELECT COUNT(*) AS cnt FROM (${scoped.sql}) q`)
      .bind(...scoped.bindings).first<{ cnt: number }>();

    // 名前を差し込む本文は、名前の無い人がいると差し込めない。送る前に止める。
    if (hasRecipientVariablesInParts(storedParts)) {
      const missing = await db.prepare(`SELECT SUM(CASE WHEN (${DELIVERY_CONSENT_ALLOWED_SQL.replaceAll('f.', 'q.')}) AND (q.display_name IS NULL OR trim(q.display_name) = '') THEN 1 ELSE 0 END) AS missing_name
        FROM (${scoped.sql}) q`).bind(...scoped.bindings).first<{ missing_name: number | null }>();
      if (Number(missing?.missing_name ?? 0) > 0) {
        throw new Error(`Cannot personalize broadcast: ${missing!.missing_name} recipient(s) have no display name`);
      }
    }

    const frozen = await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?').bind(broadcast.id).first<{n:number}>();
    await db
      .prepare(`UPDATE broadcasts SET status = 'sending', batch_offset = 0, total_count = ? WHERE id = ? AND lock_version=? AND stopped_at IS NULL AND status='sending'`)
      .bind(Number(frozen?.n || row?.cnt || 0), broadcast.id,broadcast.lock_version ?? 1)
      .run();
    return (await getBroadcastById(db, broadcastId))!;
  }

  // multi-account-dedup は inline 送信せず cron queue (processQueuedBroadcasts) に委譲する。
  // この関数は scheduled / 即時の単一 account 経路用で、毎回 auto-track を実行する。dedup を
  // ここで送ると (1) auto-track がここと queue 側で二重実行されて tracked link が重複し、
  // (2) 分割送信 (chunking) の継続が queue 側にあるため partial-sent のまま sent 扱いになる。
  // よって total_count だけ確定して status='sending', batch_offset=0 にし、queue に渡す。
  // total_count は executor が inactive を skip するのに合わせ、active アカウントの当選者数で
  // 計算する (routes 即時送信パスと同じロジック)。
  if (broadcast.target_type === 'multi-account-dedup') {
    const { computeDedupBroadcastPreview } = await import('../../services/dedup-broadcast.js');
    const accountIds = (broadcast.account_ids ? JSON.parse(broadcast.account_ids) : []) as string[];
    const dedupPriority = (broadcast.dedup_priority ? JSON.parse(broadcast.dedup_priority) : []) as string[];
    const preview = await computeDedupBroadcastPreview(db, accountIds, dedupPriority, broadcast.target_tag_id ?? null);
    let projectedTotal = 0;
    const { getLineAccountById } = await import('@line-crm/db');
    for (const a of preview.perAccount) {
      const account = await getLineAccountById(db, a.accountId);
      if (account && account.is_active) projectedTotal += a.recipients.length;
    }
    await db
      .prepare(`UPDATE broadcasts SET status = 'sending', batch_offset = 0, total_count = ? WHERE id = ?`)
      .bind(projectedTotal, broadcast.id)
      .run();
    return (await getBroadcastById(db, broadcastId))!;
  }

  // URL の計測リンク化は track_links で制御し、0 の場合は短縮せず元の URL を送る。
  const broadcastAccountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
  let finalParts = await autoTrackMessageParts(
    db,
    storedParts,
    workerUrl,
    broadcastAccountId,
    broadcast.track_links !== 0,
    broadcast.id,
  );
  /*
   * 配信全体で決まる差し込みを、ここで置き換える。
   *   {{liff_id}} … この配信のアカウントの LIFF ID
   *   {{var.…}}   … 共通情報
   *   {{date…}}   … 配信日・目標日までの日数
   * ここは tag / all 系の単一 account 経路のみ (multi-account-dedup は冒頭で
   * queue に委譲済みで到達しない。dedup の置換は dedup-broadcast.ts 側で
   * per-account に行う)。
   */
  const wideContext = await broadcastWideContext(
    db,
    broadcastAccountId,
    combinedMessageContent(finalParts),
    commonVarValuesForAccount(commonVarSnapshot, broadcastAccountId),
    broadcast.id,
  );
  finalParts = renderMessageParts(finalParts, wideContext);
  assertMessagePartsResolved(finalParts);
  const messages = buildMessages(finalParts);
  let totalCount = 0;
  let successCount = 0;

  try {
    if (broadcast.target_type === 'all') {
      // 緊急停止 : 送る直前に broadcast_dispatch を確かめる。
      // 停止中は status='sending' のまま戻り、完了とは書かない。
      if (await isOperationCapabilityStopped(db, broadcastAccountId, 'broadcast_dispatch')) {
        return (await getBroadcastById(db, broadcastId))!;
      }

      const retryKey = await createBroadcastRetryKey(
        broadcast.id,
        'broadcast',
        JSON.stringify(messages),
      );
      if (await hasSuppressedDeliveryRecipients(db,broadcastAccountId)) {
        await db.prepare(`UPDATE broadcasts SET batch_offset=0,segment_conditions=? WHERE id=?`)
          .bind(JSON.stringify({operator:'AND',rules:[{type:'is_following',value:true}]}),broadcast.id).run();
        return (await getBroadcastById(db,broadcastId))!;
      }
      if (storedDeliveryLimit(broadcast)) throw new LimitedBroadcastError('上限付きの配信の宛先を確認できません。全員へは送りません。');
      const { requestId } = await lineClient.broadcast(messages, retryKey);
      await updateBroadcastLineRequestId(db, broadcast.id, requestId, null);
      if (broadcastAccountId) {
        try {
          const { recordUnknownAnalyticsUrlExposures } = await import('@line-crm/db');
          for (const [index, part] of finalParts.entries()) {
            await recordUnknownAnalyticsUrlExposures(db, {
              lineAccountId: broadcastAccountId,
              messageId: `line-broadcast:${broadcast.id}:${index + 1}`,
              content: part.messageContent,
              sourceKind: 'broadcast_all',
              sourceId: broadcast.id,
              sentAt: jstNow(),
            });
          }
        } catch (error) {
          logger.error("services_broadcast_failed");
        }
      }
      // broadcast API から正確な件数が得られないため、0 はここでは不明を表す。
      totalCount = 0;
      successCount = 0;
    } else if (broadcast.target_type === 'tag') {
      if (!broadcast.target_tag_id) {
        throw new Error('target_tag_id is required for tag-targeted broadcasts');
      }

      const ledger = await db.prepare(`SELECT COUNT(*) AS n,SUM(state='sent') AS sent
        FROM broadcast_send_claims WHERE broadcast_id=?`).bind(broadcastId).first<{n:number;sent:number}>();
      const known = Number(ledger?.n ?? 0);
      if (await holdMissingBroadcastAudience(db, {id:broadcastId,expected:broadcast.total_count,known,
        started:known>0 || broadcast.success_count>0 || Number((broadcast as unknown as {batch_offset?:number}).batch_offset ?? 0)>0})) {
        return (await getBroadcastById(db,broadcastId))!;
      }
      let followingFriends: Awaited<ReturnType<typeof getFriendsByTag>>;
      if (known > 0) {
        await db.prepare(`UPDATE broadcast_send_claims SET state='unknown',error_code='interrupted_dispatch'
          WHERE broadcast_id=? AND state='claimed' AND dispatched_at IS NOT NULL`).bind(broadcastId).run();
        // 最初の台帳の宛先を保ち、現在の所属・ブロック・非表示だけを確認する。
        const ids = scopedFriendIds(await storedBroadcastFriendScope(db, broadcastAccountId));
        await db.prepare(`UPDATE broadcast_send_claims SET state='failed',error_code='recipient_unavailable'
          WHERE broadcast_id=? AND ((state='claimed' AND dispatched_at IS NULL)
            OR (state='failed' AND error_code IN ('line_http_429','stopped_before_dispatch') AND attempt_no=?))
            AND friend_id NOT IN (${ids.sql})`).bind(broadcastId,Number(broadcast.send_attempt_no ?? 1),...ids.bindings).run();
        followingFriends = (await db.prepare(`SELECT f.* FROM friends f JOIN broadcast_send_claims c ON c.friend_id=f.id
          WHERE c.broadcast_id=? AND ((c.state='claimed' AND c.dispatched_at IS NULL)
            OR (c.state='failed' AND c.error_code IN ('line_http_429','stopped_before_dispatch') AND c.attempt_no=?))
            AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND f.id IN (${ids.sql}) ORDER BY c.friend_id`)
          .bind(broadcastId,Number(broadcast.send_attempt_no ?? 1),...ids.bindings).all<import('@line-crm/db').Friend>()).results;
        totalCount = broadcast.total_count || known;
        successCount = Number(ledger?.sent ?? 0);
      } else {
        const friends = await getFriendsByTag(db, broadcast.target_tag_id, broadcastAccountId,
          broadcastAccountId == null ? await storedBroadcastFriendScope(db, null) : undefined);
        followingFriends = friends.filter((f) => f.is_following && !f.is_hidden);
        totalCount = followingFriends.length;
        // 送信前に全IDを残す。JSON配列を1変数で渡しD1のbind数上限に当てない。
        await db.batch([
          db.prepare(`INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state)
            SELECT ?,value,?,?,'claimed' FROM json_each(?)
            WHERE NOT EXISTS(SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=?)`)
            .bind(broadcastId,broadcastAccountId,Number(broadcast.send_attempt_no ?? 1),JSON.stringify(followingFriends.map(f=>f.id)),broadcastId),
          db.prepare('UPDATE broadcasts SET total_count=? WHERE id=?').bind(totalCount,broadcastId),
        ]);
      }

      // 自然な送信間隔を保つため、バッチ間に遅延を入れる。
      const now = jstNow();
      const totalBatches = Math.ceil(followingFriends.length / MULTICAST_BATCH_SIZE);
      // 開封数を取らない配信では null。集計ユニットは月1,000の上限がある。
      const unit = aggregationUnitFor(broadcast);
      /*
       * 送達台帳。予約した tag 配信はこの関数の中で最後まで送るので、
       * 束と束のあいだが唯一の止めどころになる。台帳がないと、失敗した束の
       * 相手が誰だったのかが残らず——今までは `console.error` だけで消えていた
       * ——「失敗した相手だけ送り直す」ができない。
       */
      const blocked = await getBlockedRecipientIds(db, broadcast.id);
      const attemptNo = Number((broadcast as unknown as Record<string, unknown>).send_attempt_no ?? 1) || 1;
      for (let i = 0; i < followingFriends.length; i += MULTICAST_BATCH_SIZE) {
        // 次の束へ進む前に停止を読み直す。送り終えた束は取り消せないので、
        // **新しい束を始めないことで止める**。
        // 緊急停止  の broadcast_dispatch も同じ止めどころで読む。
        if (await isBroadcastStopped(db, broadcastId) ||
            await isOperationCapabilityStopped(db, broadcastAccountId, 'broadcast_dispatch')) break;
        const batchIndex = Math.floor(i / MULTICAST_BATCH_SIZE);
        const batch = followingFriends.slice(i, i + MULTICAST_BATCH_SIZE);
        const suppressed = await suppressedFriendIds(db,batch.map(f=>f.id));
        await recordSuppressedBroadcastRecipients(db,broadcast.id,[...suppressed]);
        const sendable = batch.filter((f) => !blocked.has(f.id)&&!suppressed.has(f.id));
        if (sendable.length === 0) continue;
        const sendableIds = sendable.map((f) => f.id);
        const lineUserIds = sendable.map((f) => f.line_user_id);


        if (batchIndex > 0) {
          const delay = calculateStaggerDelay(followingFriends.length, batchIndex, MULTICAST_BATCH_SIZE);
          await sleep(delay);
        }


        const batchMessages = varyTextMessages(messages, batchIndex, totalBatches);

        await markBroadcastRecipientsDispatched(db, {
          broadcastId,
          attemptNo,
          lineAccountId: broadcastAccountId,
          friendIds: sendableIds,
        });
        try {
          const retryKey = await createBroadcastRetryKey(
            broadcast.id,
            'multicast',
            `attempt:${attemptNo}`,
            ...sendableIds,
            JSON.stringify(batchMessages),
          );
          const { requestId } = await lineClient.multicast(lineUserIds, batchMessages, aggregationUnits(unit), retryKey);
          successCount += sendable.length;

          // 成功分だけをまとめて記録する。送信元は配信設定時のアカウントに固定し、Webhook で変わり得る friends.line_account_id を使わない。
          const broadcastAccount = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
          const logStmts = sendable.flatMap(friend => finalParts.map(part =>
            db.prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
            ).bind(crypto.randomUUID(), friend.id, part.messageType, part.messageContent, broadcastId, broadcastAccount, now),
          ));
          await db.batch([
            ...logStmts,
            db.prepare('UPDATE broadcasts SET success_count=success_count+? WHERE id=?').bind(sendable.length,broadcastId),
            ...buildBroadcastSettleStatements(db, {
              broadcastId,
              friendIds: sendableIds,
              state: 'sent',
              lineRequestId: requestId,
            }),
          ]);
          for (const id of sendableIds) blocked.add(id);
        } catch (err) {
          logger.error("services_broadcast_failed");
          // 失敗したバッチは送信成功として記録せず、失敗先を台帳へ残す。再送できるのは未送信と断定できた宛先だけ。
          const outcome = classifyDeliveryFailure(err);
          await settleBroadcastRecipients(db, {
            broadcastId,
            friendIds: sendableIds,
            state: outcome,
            errorCode: deliveryErrorCode(err),
          });
          if (outcome === 'unknown') for (const id of sendableIds) blocked.add(id);
        }
      }
      await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
    }
    // multi-account-dedup はこの関数の冒頭で queue に委譲済み (ここには到達しない)。

    // 停止で束の途中を抜けた配信を「送信済み」にしない。送り残した
    // 相手がいるのに完了と書くと、再開も失敗分の再送もできなくなる。
    // 緊急停止  の broadcast_dispatch も同じく完了にしない。
    if (await isBroadcastStopped(db, broadcastId) ||
        await isOperationCapabilityStopped(db, broadcastAccountId, 'broadcast_dispatch')) {
      return (await getBroadcastById(db, broadcastId))!;
    }
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcastId, 'sent', { totalCount, successCount });
  } catch (err) {
    // 再試行できるよう、失敗時は下書きへ戻す。
    await updateBroadcastStatus(db, broadcastId, 'draft');
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

/**
 * 予約配信を送る直前に、残りの送信枠を確かめる（設計 `Bw0zt`、台帳）。
 *
 * **止めるのは「足りないと分かったとき」だけ。** 枠が読めないときは通す
 * ——LINE の口が落ちているだけで予約を潰すと、送れるはずの配信が届かない。
 *
 * 止めたときは通知センターへ理由を残す。**運用者が結果画面で読める**
 * ようにするため（何通足りないか、次に何をすればよいか）。
 */
// 即時送信の直前再確認でも使うため公開する。中身と通知は予約経路と同じ。
// REJECT対応: reserveBroadcastId を渡すと、枠内と分かった時点でその分を予約台帳に
// 積む。別配信と残枠を同時に読んでも、台帳の合計で残枠を超えない。
export async function guardScheduledBroadcastQuota(
  db: D1Database,
  broadcast: Broadcast,
  accountId: string | null,
  opts?: { reserveBroadcastId?: string; confirmedRecipientCount?: number },
): Promise<{ blocked: boolean; message?: string; recipientLimitCount?: number }> {
  if (storedDeliveryLimit(broadcast)) {
    try {
      const plan = await limitedDeliveryPlan(db, broadcast, { requireConfirmation: opts?.confirmedRecipientCount === undefined });
      const count = Math.min(plan!.recipientCount, opts?.confirmedRecipientCount ?? plan!.recipientCount);
      if (count <= 0) throw new LimitedBroadcastError('送れる人数が0人です。対象と送信枠を確かめてください。');
      if (!plan!.quota.unlimited) {
        const { tryReserveQuotaSlot } = await import('./broadcast-quota-guard.js');
        if (!await tryReserveQuotaSlot(db, accountId!, opts?.reserveBroadcastId ?? broadcast.id, count, plan!.quota.used!, plan!.quota.limit!, {replaceOwn:true})) {
          throw new LimitedBroadcastError('ほかの送信が枠を使っています。少し待って確かめ直してください。');
        }
      }
      return { blocked: false, recipientLimitCount: count };
    } catch (error) {
      return { blocked: true, message: error instanceof Error ? error.message : '送る人数と送信枠を確かめ直してください。' };
    }
  }
  if (!accountId) return { blocked: false };

  const { getLineAccountById } = await import('@line-crm/db');
  const account = await getLineAccountById(db, accountId);
  if (!account) return { blocked: false };

  /*
    これから送る通数。**下書きに数えた `total_count` ではなく、いま数え直す。**
    予約してから友だちが増減するので、古い数で枠を見ても意味がない。
  */
  const planned = await countScheduledRecipients(db, broadcast, accountId);
  if (planned === null || planned === 0) return { blocked: false };

  const check = evaluateQuota(await fetchQuota(account.channel_access_token), planned);
  if (check.state !== 'short') {
    if (opts?.reserveBroadcastId && check.state === 'ok') {
      const { tryReserveQuotaSlot } = await import('./broadcast-quota-guard.js');
      const reserved = await tryReserveQuotaSlot(
        db, accountId, opts.reserveBroadcastId, planned, check.used, check.limit,
      );
      if (!reserved) {
        return { blocked: true, message: 'ほかの送信が枠を使っています。少し待って送り直してください' };
      }
    }
    return { blocked: false };
  }

  const shortfall = shortfallMessage(check, planned);
  const { createNotification } = await import('@line-crm/db');
  await createNotification(db, {
    eventType: 'broadcast.quota_short',
    title: `「${broadcast.title}」を送れませんでした`,
    body: shortfall,
    // 通知センターが読むのは 'dashboard'。'center' はどの画面も読まず、
    // 「止めた理由」を書いたつもりが誰にも見えない通知になっていた。
    channel: 'dashboard',
    category: 'error',
    lineAccountId: accountId,
    metadata: JSON.stringify({
      broadcastId: broadcast.id,
      planned,
      remaining: check.remaining,
      shortfall: check.shortfall,
    }),
  });
  return { blocked: true, message: shortfall };
}

/** いま同じ条件で数え直した宛先の数。数えられなければ `null`（止めない）。 */
async function countScheduledRecipients(
  db: D1Database,
  broadcast: Broadcast,
  accountId: string,
): Promise<number | null> {
  try {
    const stored = broadcast.segment_conditions;
    if (stored) {
      const conditions = parseStoredConditions(stored);
      if (!conditions) return null;
      const query = buildSegmentQuery(conditions);
      const scoped = await scopeStoredBroadcastSegmentQuery(db, query, accountId);
      const consented = restrictSegmentInput(scoped, DELIVERY_CONSENT_ALLOWED_SQL);
      const row = await db.prepare(`SELECT COUNT(*) AS total FROM (${consented.sql})`)
        .bind(...consented.bindings).first<{ total: number }>();
      const total = Number(row?.total ?? 0);
      return Number.isFinite(total) ? total : null;
    }
    const where: string[] = ['f.is_following = 1', 'f.line_account_id = ?', 'COALESCE(f.is_hidden,0)=0', DELIVERY_CONSENT_ALLOWED_SQL];
    const binds: unknown[] = [accountId];
    if (broadcast.target_type === 'tag' && broadcast.target_tag_id) {
      where.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(broadcast.target_tag_id);
    }
    const row = await db
      .prepare(`SELECT COUNT(*) AS total FROM friends f WHERE ${where.join(' AND ')}`)
      .bind(...binds)
      .first<{ total: number }>();
    const total = Number(row?.total ?? 0);
    return Number.isFinite(total) ? total : null;
  } catch {
    // 数えられないことを 0 と読まない。**分からないものは止める理由にしない。**
    return null;
  }
}

export async function processScheduledBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const sendPermissions: SendPermissionCache = new Map();
  const accountsWithStatus = await listLineAccountsWithTenantStatus(db);
  const tenantStatusByAccount = new Map(
    accountsWithStatus.map((account) => [account.id, account.tenant_status]),
  );
  // アカウントの稼働状態（X-1）。止めているアカウント宛の予約は
  // 「送らなかった」記録にして下書きへ戻す。
  const activeByAccount = new Map(
    accountsWithStatus.map((account) => [account.id, Boolean(account.is_active)]),
  );
  const nowMs = Date.now();
  const scheduled = await getBroadcasts(db, undefined, undefined, {
    status: 'scheduled', dueAt: new Date(nowMs).toISOString(),
  });

  /*
   * 二者承認。予約時刻を過ぎても承認されなかった依頼は、
   * 先に期限切れにして送らない（依頼主に知らせる）。
   */
  try {
    const { sweepBroadcastApprovalExpiry } = await import('./broadcast-approval.js');
    await sweepBroadcastApprovalExpiry(db, nowMs);
  } catch (sweepError) {
    logger.error("services_broadcast_failed");
  }

  for (const broadcast of scheduled) {
    if(await processBroadcastSimulation(db,broadcast.id))continue;
    try {
      const ownerAccountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
      if (ownerAccountId && isStoppedTenantStatus(tenantStatusByAccount.get(ownerAccountId))) {
        // 統括の復旧時に停止中の期限切れ配信が届かないよう、内容は残して自動予約だけを解除する。
        await db.prepare(
          `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'`,
        ).bind(broadcast.id).run();
        continue;
      }
      /*
       * アカウント停止中（X-1、-33 §10-1）。予約 job は消さず、
       * 「止めていたので送らなかった」として一覧に残し、内容は下書きへ
       * 戻す。再開しても自動では送り直さない。
       */
      if (ownerAccountId && activeByAccount.get(ownerAccountId) === false) {
        try {
          await recordSkippedDelivery(db, {
            lineAccountId: ownerAccountId,
            kind: 'broadcast',
            refId: broadcast.id,
            title: broadcast.title ?? null,
          });
        } catch (skipError) {
          logger.error("services_broadcast_failed");
        }
        await db.prepare(
          `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'`,
        ).bind(broadcast.id).run();
        continue;
      }
      // 機能オフ中はclaimせず予約のまま残す。再オンで再開する。
      if (ownerAccountId && !await featureJobCanRun(db, { accountId: ownerAccountId, featureId: 'broadcasts', job: 'broadcast deliveries' })) {
        continue;
      }
      // 緊急停止 : broadcast_dispatch が止まっている統括は claim せず
      // 予約のまま残す。停止中に時刻を過ぎた分は、復旧の検査
      // (holdExpiredBroadcasts) が下書きへ戻し、まとめて追い送りしない。
      if (await isOperationCapabilityStopped(db, ownerAccountId, 'broadcast_dispatch')) {
        continue;
      }
      /*
       * 二者承認。承認が要る人数なのに承認済みでなければ送らない。
       * 期限切れの走査は上で済ませてある。数えられないときは送らず残す。
       */
      try {
        const { checkScheduledBroadcastApproval } = await import('./broadcast-approval.js');
        const approvalCheck = await checkScheduledBroadcastApproval(db, broadcast);
        if (!approvalCheck.sendable) continue;
      } catch (approvalError) {
        if (approvalError instanceof LimitedBroadcastError) { await holdLimitedBroadcast(db,broadcast,approvalError.message); continue; }
        logger.error("services_broadcast_failed");
        continue;
      }
      // 重複実行を防ぐため、scheduled から sending への変更で実行権を取る。
      const lockResult = await db
        .prepare(`UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'scheduled' ${BROADCAST_DEFINITION_GUARD_SQL}`)
        .bind(broadcast.id, ...broadcastDefinitionGuardArgs(broadcast))
        .run();
      if (!lockResult.meta.changes || lockResult.meta.changes === 0) continue;
      // 予約の自動送信も記録に残す。誰の操作でもないので担当者は空＝「自動」。
      try {
        await recordBroadcastLifecycleEvent(db, {
          broadcastId: broadcast.id,
          actorStaffId: null,
          action: 'send_started',
          detail: { fromStatus: 'scheduled', trigger: 'schedule' },
        });
      } catch (lifecycleError) {
        logger.error("services_broadcast_failed");
      }

      // 別アカウントから送らないよう、配信の送信元に対応する LINE クライアントを解決する。
      let deliveryClient = lineClient;
      const accountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(db, accountId);
        if (account) {
          const { LineClient: LC } = await import('@line-crm/line-sdk');
          deliveryClient = new LC(account.channel_access_token);
        } else {
          recordLineTokenDefaultFallback({ accountId, context: 'broadcast.scheduled' });
        }
      } else {
        recordLineTokenDefaultFallback({ accountId: null, context: 'broadcast.scheduled' });
      }

      /*
        **送る直前に、残りの送信枠を確かめる**（設計 `Bw0zt`、台帳）。
        予約したあとに枠を使い切ると、**予約は実行されるが途中で失敗する**。
        送った人と送れなかった人が混ざり、運用者は結果を見るまで気づけない。

        **取れないときは止めない。** LINE の口が落ちているだけで予約を潰すと、
        送れるはずの配信が届かなくなる。
      */
      // 課金の状態（トライアル終了・解約）で配信が止まっている統括は送らない。
      // 下書きへ戻し、予約は消す。プランを選べば送り直せる。
      const permission = await getSendPermissionForAccount(db, accountId, sendPermissions);
      if (!permission.allowed) {
        logger.warn("services_broadcast_warn");
        await db.prepare(
          `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'sending' AND stopped_at IS NULL AND lock_version=?`,
        ).bind(broadcast.id,broadcast.lock_version ?? 1).run();
        continue;
      }

      const guard = await guardScheduledBroadcastQuota(db, broadcast, accountId);
      if (guard.blocked) {
        if (storedDeliveryLimit(broadcast)) await holdLimitedBroadcast(db, broadcast, guard.message ?? '送る人数と送信枠を確かめ直してください。');
        // 下書きへ戻す。**内容は消さない**ので、相手を減らして予約し直せる。
        await db.prepare(
          `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'sending' AND stopped_at IS NULL AND lock_version=?`,
        ).bind(broadcast.id,broadcast.lock_version ?? 1).run();
        continue;
      }

      await processBroadcastSend(db, deliveryClient, broadcast.id, workerUrl, guard.recipientLimitCount === undefined ? undefined : { recipientLimitCount: guard.recipientLimitCount },broadcast.lock_version ?? 1);
    } catch (err) {
      // 分析の一時対象者が期限切れ・消滅している予約は毎tick再試行しても
      // 届かない。下書きへ戻して予約を消す（内容は残るので作り直せる）。
      if (err instanceof LimitedBroadcastError) {
        await holdLimitedBroadcast(db, broadcast, err.message);
        continue;
      }
      if (err instanceof BroadcastAudienceError) {
        logger.warn("services_broadcast_warn");
        try {
          await db.prepare(
            `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'sending' AND stopped_at IS NULL AND lock_version=?`,
          ).bind(broadcast.id,broadcast.lock_version ?? 1).run();
        } catch (demoteErr) {
          logger.error("services_broadcast_failed");
        }
        continue;
      }
      logger.error("services_broadcast_failed");
      // 次の cron で再試行できるよう、scheduled へ戻す。
      try {
        await db.prepare(`UPDATE broadcasts SET status = 'scheduled' WHERE id = ? AND status = 'sending' AND stopped_at IS NULL AND lock_version=?`)
          .bind(broadcast.id,broadcast.lock_version ?? 1).run();
      } catch (resetErr) {
        logger.error("services_broadcast_failed");
      }
    }
  }
}


/**
 * 1回のCron実行で送る人数の上限。
 *
 * stealth_spread_minutes は「何分かけて配りきるか」。既定の 0 は
 * 一気に送る（従来どおり）。
 *
 * Cron は1分ごとなので、全体を分数で割った人数を1回ぶんにする。
 * 途中で止めても batch_offset がそこに残り、次の tick が続きから送る。
 * この再開のしくみは元からあるもので、新しく二重送信の危険は増えない。
 *
 * 下限を1バッチにしているのは、0人になると永久に進まなくなるため。
 */
export function stealthChunkSize(
  total: number,
  spreadMinutes: number,
  batchSize: number,
): number {
  if (spreadMinutes <= 0) return total;
  const perMinute = Math.ceil(total / spreadMinutes);
  return Math.max(batchSize, perMinute);
}

/**
 * Cronから呼ばれるキュー処理。status='queued' のブロードキャストを
 * batch_offset から500人ずつ処理する。1回のCron実行で全バッチを処理可能。
 */
function parseStoredConditions(stored: unknown): SegmentCondition | null {
  if (typeof stored !== 'string' || stored === '') return null;
  try {
    const parsed = JSON.parse(stored) as SegmentCondition;
    return parsed && Array.isArray(parsed.rules) ? parsed : null;
  } catch {
    return null;
  }
}

export async function processQueuedBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const queued = await getQueuedBroadcasts(db);
  const sendPermissions: SendPermissionCache = new Map();
  const tenantStatusByAccount = new Map(
    (await listLineAccountsWithTenantStatus(db)).map((account) => [account.id, account.tenant_status]),
  );
  for (const broadcast of queued) {
    if(await processBroadcastSimulation(db,broadcast.id))continue;
    // 機能オフ中は送信中の続きも止める。行は残るため再オンで再開する。
    const ownerAccountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    if (ownerAccountId && isStoppedTenantStatus(tenantStatusByAccount.get(ownerAccountId))) {
      await db.prepare(
        `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL, batch_lock_at = NULL
          WHERE id = ? AND status IN ('sending', 'scheduled') AND lock_version=?`,
      ).bind(broadcast.id,broadcast.lock_version ?? 1).run();
      continue;
    }
    if (ownerAccountId && !await featureJobCanRun(db, { accountId: ownerAccountId, featureId: 'broadcasts', job: 'broadcast deliveries' })) {
      continue;
    }
    // 緊急停止 : broadcast_dispatch 停止中はロックを取らず、
    // 送信中の続きも送らない。行は残るため復旧後に続きから送れる。
    if (await isOperationCapabilityStopped(db, ownerAccountId, 'broadcast_dispatch')) {
      continue;
    }
    // アカウント別のlineClientを解決
    const accountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    // 送っている途中でトライアルが終わった統括は、残りを送らずに待つ（プランを選べば続きから送れる）。
    const permission = await getSendPermissionForAccount(db, accountId, sendPermissions);
    if (!permission.allowed) {
      logger.warn("services_broadcast_warn");
      continue;
    }
    /*
     * 分析の一時対象者は送信開始の直前にも所属・期限を確かめ直す。
     * まだ誰にも送っていない（batch_offset=0）ものは下書きへ戻す。
     * 途中まで送った配信は、条件のSQL側が期限を評価ごとに確かめるので
     * 残りは誰にも一致せず自然に終わる。ここで戻すと再送が二重になる。
     */
    const queuedRaw = broadcast as unknown as Record<string, unknown>;
    if (((queuedRaw.batch_offset as number) || 0) === 0) {
      const storedConditions = parseStoredConditions(queuedRaw.segment_conditions);
      if (storedConditions) {
        try {
          await assertAnalyticsAudiencesUsable(db, storedConditions, accountId);
        } catch (audienceError) {
          if (!(audienceError instanceof BroadcastAudienceError)) throw audienceError;
          logger.warn("services_broadcast_warn");
          await db.prepare(
            `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'sending' AND batch_offset = 0 AND stopped_at IS NULL AND lock_version=?`,
          ).bind(broadcast.id,broadcast.lock_version ?? 1).run();
          continue;
        }
      }
    }
    let client = lineClient;
    if (accountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, accountId);
      if (account) client = new (await import('@line-crm/line-sdk')).LineClient(account.channel_access_token);
      else recordLineTokenDefaultFallback({ accountId, context: 'broadcast.queued' });
    } else {
      recordLineTokenDefaultFallback({ accountId: null, context: 'broadcast.queued' });
    }

    try {
      await processQueuedBroadcastBatches(db, client, broadcast, workerUrl);
    } catch (err) {
      logger.error("services_broadcast_failed");
    }
  }
}

async function processQueuedBroadcastBatches(
  db: D1Database,
  lineClient: LineClient,
  broadcast: import('@line-crm/db').Broadcast,
  workerUrl?: string,
): Promise<void> {
  const raw = broadcast as unknown as Record<string, unknown>;
  const lockVersion = Number(raw.lock_version ?? 1);
  const segmentConditionsStr = raw.segment_conditions as string | null;
  const batchOffset = (raw.batch_offset as number) || 0;
  const storedParts = parseBroadcastMessageParts({
    messageType: broadcast.message_type,
    messageContent: broadcast.message_content,
    messageBubblesJson: broadcast.message_bubbles_json,
    messageOptionsJson: broadcast.message_options_json,
    altText: broadcast.alt_text,
  });
  const commonVarSnapshot = await prepareBroadcastCommonVarSnapshot(
    db,
    broadcast,
    combinedMessageContent(storedParts),
  );

  // 排他ロック: batch_offset を -1 に設定して他のCronが拾わないようにする
  // WHERE batch_offset = ? で楽観ロック（既に他が処理中なら更新0行→スキップ）
  // batch_lock_at は recoverStalledBroadcasts が「ロック取得後 N 分経過」を判定する
  // ためのタイムスタンプ。created_at だと draft 作成時刻基準で本物の lock age と
  // ずれて Worker 並走 race を引き起こすため別カラムで管理する。
  // 重要: 値は SQL の strftime で生成する。jstNow の '+09:00' suffix は SQLite で
  // UTC 正規化されて見かけ 9 時間古くなり、recover 側 (julianday('now','+9 hours'))
  // と比較すると即座に「stale」扱いされて lock 取得直後に解除される。created_at
  // 列の DEFAULT と同じ式を使って naive JST に揃える。
  //
  // `stopped_at IS NULL` は  の停止。**運用者が停止を押した後は、
  // 新しい送信権をここで取らせない。**停止を受け付ける UPDATE と、この
  // ロック取得の UPDATE は同じ行の条件付き更新なので、どちらが先でも
  // 「停止が勝てばロックは取れず、ロックが勝てば停止はループ内の確認で効く」
  // のどちらかに決まる。両方が進む状態にはならない。
  const lockResult = await db.prepare(
    `UPDATE broadcasts SET batch_offset = -1, batch_lock_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = ? AND batch_offset = ? AND stopped_at IS NULL AND status='sending' AND COALESCE(send_attempt_no,1)=? AND lock_version=?`,
  ).bind(broadcast.id, batchOffset, Number(raw.send_attempt_no ?? 1),lockVersion).run();
  if (!lockResult.meta.changes || lockResult.meta.changes === 0) {
    // 他のCron実行が既に処理中、または停止済み → スキップ
    return;
  }
  const releaseStopped = async (offset=0) => {
    await db.prepare(`UPDATE broadcasts SET batch_offset=?,batch_lock_at=NULL,
      success_count=MAX(success_count,(SELECT COUNT(*) FROM broadcast_send_claims WHERE broadcast_id=? AND state='sent'))
      WHERE id=? AND stopped_at IS NOT NULL AND batch_offset=-1 AND lock_version=?`)
      .bind(offset,broadcast.id,broadcast.id,lockVersion+1).run();
  };
  const releaseProgress = async (offset:number) => {
    const result=await db.prepare(`UPDATE broadcasts SET batch_offset=?,batch_lock_at=NULL
      WHERE id=? AND lock_version=? AND batch_offset=-1`).bind(offset,broadcast.id,lockVersion).run();
    if(!result.meta.changes)await releaseStopped(offset);
  };

  // 旧1通では初回の追跡結果を message_content へ保存する。複数通は画面が編集に使う
  // message_bubbles_json を上書きせず、各tickで変換する。autoTrackContent はURLと
  // アカウントが同じなら同じ追跡リンクを再利用するため、再開してもリンクは増えない。
  const isDedupContinuation =
    broadcast.target_type === 'multi-account-dedup' && !!broadcast.dedup_progress;
  let finalParts = await autoTrackMessageParts(
    db,
    storedParts,
    workerUrl,
    (raw.line_account_id as string | null) ?? null,
    broadcast.track_links !== 0,
    broadcast.id,
  );
  // 旧1通だけは従来どおり追跡後の中身を保存する。複数通は編集用の
  // message_bubbles_json を保ち、各tickで既存の追跡リンクを再利用する。
  if (!broadcast.message_bubbles_json && batchOffset === 0 && !isDedupContinuation) {
    const tracked = finalParts[0];
    if (tracked.messageType !== broadcast.message_type || tracked.messageContent !== broadcast.message_content) {
      await db.prepare('UPDATE broadcasts SET message_type = ?, message_content = ? WHERE id = ? AND lock_version=? AND batch_offset=-1 AND stopped_at IS NULL')
        .bind(tracked.messageType, tracked.messageContent, broadcast.id,lockVersion).run();
    }
  }

  // 配信全体で決まる差し込み（{{liff_id}} / {{var.…}} / {{date…}}）を先に置き換える。
  // single account 経路のみ; multi は dedup 側で per-account に置換する。
  const queuedAccountId = raw.line_account_id as string | null;
  if (broadcast.target_type !== 'multi-account-dedup') {
    const wide = await broadcastWideContext(
      db,
      queuedAccountId,
      combinedMessageContent(finalParts),
      commonVarValuesForAccount(commonVarSnapshot, queuedAccountId),
      broadcast.id,
    );
    finalParts = renderMessageParts(finalParts, wide);
  }
  const messages = buildMessages(finalParts);

  // 複数アカウントの重複除外は専用処理へ委ねる。内部でアカウント別に LIFF ID と本文を組み立てるため、計測リンク化済みの message_type/message_content を渡して変換結果を失わないようにする。
  if (broadcast.target_type === 'multi-account-dedup') {
    const { processMultiAccountDedupBroadcast } = await import('../../services/dedup-broadcast.js');
    const broadcastForDedup = {
      ...broadcast,
      messageParts: finalParts,
      common_var_snapshot: commonVarSnapshot ? JSON.stringify(commonVarSnapshot) : null,
    };
    const result = await processMultiAccountDedupBroadcast(db, broadcastForDedup);
    if (!result.complete) {
      // 時間バジェットに達して途中で yield した。status='sending' のまま batch_offset を
      // -1(ロック) → 0 に戻し、次の cron tick が getQueuedBroadcasts で拾って続きを送る。
      // 進捗 (dedup_progress / success_count) は batch ごとに永続化済みなので、
      // success_count は加算しない (第4引数 0)。これで 5000 人配信でも 1 実行が短く終わり、
      // Worker 時間制限に当たって stall することが無くなる (= 分割送信)。
      await updateBroadcastBatchProgress(db, broadcast.id, 0, 0);
      return;
    }
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcast.id, 'sent', {
      totalCount: result.totalCount,
      successCount: result.successCount,
    });
    return;
  }

  // 宛先は最初の送信前に、既存の台帳へ一括で固定する。
  // 再開・失敗分再送で条件を評価し直さない。offset は表示用だけ。
  const accountId = raw.line_account_id as string | null;
  let fixedHqAudience: ReturnType<typeof confirmedHqAudience>;
  try { fixedHqAudience=confirmedHqAudience(broadcast); }
  catch { await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:1,known:0,started:true,expectedLockVersion:lockVersion,requireBatchLock:true});return; }
  const hasAudience = await db.prepare('SELECT 1 FROM broadcast_send_claims WHERE broadcast_id = ? LIMIT 1')
    .bind(broadcast.id).first();
  const previousAudience = await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?')
    .bind(broadcast.id).first<{n:number}>();
  if (await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:Number(raw.total_count ?? 0),
    known:Number(previousAudience?.n ?? 0),started:!!fixedHqAudience || !!hasAudience || Number(raw.success_count ?? 0)>0 || batchOffset>0 || Number(raw.send_attempt_no ?? 1)>1,expectedLockVersion:lockVersion,requireBatchLock:true})) return;
  if (!hasAudience && storedDeliveryLimit(broadcast)) {
    await holdLimitedBroadcast(db, broadcast, '固定した宛先を確認できません。選び直さず送信を止めました。');
    return;
  }
  const filterAll = broadcast.target_type === 'all' && await hasSuppressedDeliveryRecipients(db,accountId);
  if (!hasAudience && (segmentConditionsStr || broadcast.target_tag_id || filterAll)) {
    const conditions = segmentConditionsStr ? JSON.parse(segmentConditionsStr)
      : { operator: 'AND', rules: broadcast.target_tag_id
          ? [{ type: 'tag_exists', value: broadcast.target_tag_id }]
          : [{ type: 'is_following', value: true }] };
    const query = buildSegmentQuery(conditions);
    const { sql, bindings } = await scopeStoredBroadcastSegmentQuery(db, query, accountId);
    await db.batch([
      db.prepare(`INSERT INTO broadcast_send_claims
        (broadcast_id,friend_id,line_account_id,attempt_no,state)
        SELECT ?,q.id,?,?,'claimed' FROM (${sql}) q
        WHERE NOT EXISTS (SELECT 1 FROM broadcast_send_claims WHERE broadcast_id = ?)
          AND EXISTS (SELECT 1 FROM broadcasts WHERE id=? AND lock_version=? AND batch_offset=-1 AND stopped_at IS NULL)`)
        .bind(broadcast.id,accountId,Number(raw.send_attempt_no ?? 1),...bindings,broadcast.id,broadcast.id,lockVersion),
      db.prepare(`UPDATE broadcasts SET total_count =
        (SELECT COUNT(*) FROM broadcast_send_claims WHERE broadcast_id = ?) WHERE id = ? AND lock_version=? AND batch_offset=-1`)
        .bind(broadcast.id,broadcast.id,lockVersion),
    ]);
  } else if (!hasAudience) {
    // target_type='all' でキューに入ることはないが、念のため
    const retryKey = await createBroadcastRetryKey(
      broadcast.id,
      'queued-broadcast',
      JSON.stringify(messages),
    );
    if (await hasSuppressedDeliveryRecipients(db,accountId)) {
      await updateBroadcastBatchProgress(db,broadcast.id,0,0);
      return;
    }
    if (storedDeliveryLimit(broadcast)) throw new LimitedBroadcastError('上限付きの配信の宛先を確認できません。全員へは送りません。');
      const { requestId } = await lineClient.broadcast(messages, retryKey);
    await updateBroadcastLineRequestId(db, broadcast.id, requestId, null);
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcast.id, 'sent', { totalCount: 0, successCount: 0 });
    return;
  }
  // 前の実行が外部呼出しの途中で失われた行は、送達不明として残す。
  await db.prepare(`UPDATE broadcast_send_claims SET state='unknown',error_code='interrupted_dispatch'
    WHERE broadcast_id=? AND state='claimed' AND dispatched_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=? AND batch_offset=-1 AND stopped_at IS NULL)`).bind(broadcast.id,broadcast.id,lockVersion).run();
  // 固定済みの宛先も、現在の所属・表示状態だけは送信直前に確認する。元の条件は再評価しない。
  const currentRecipients = await scopeStoredBroadcastSegmentQuery(db, {
    sql: `SELECT f.id, f.line_user_id, f.display_name FROM friends f WHERE f.is_following = 1 AND COALESCE(f.is_hidden,0)=0${fixedHqAudience ? ` AND (${DELIVERY_CONSENT_ALLOWED_SQL})` : ''}`,
    bindings: [],
  }, accountId);
  const unavailable=await db.prepare(`UPDATE broadcast_send_claims SET state='failed',error_code='recipient_unavailable'
    WHERE broadcast_id=? AND (
      (state='claimed' AND dispatched_at IS NULL)
      OR (state='failed' AND error_code IN ('line_http_429','stopped_before_dispatch') AND attempt_no=?))
      AND NOT EXISTS (SELECT 1 FROM (${currentRecipients.sql}) f WHERE f.id=friend_id)
      AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=? AND batch_offset=-1 AND stopped_at IS NULL)`)
    .bind(broadcast.id,Number(raw.send_attempt_no ?? 1),...currentRecipients.bindings,broadcast.id,lockVersion).run();
  if(fixedHqAudience&&Number(unavailable.meta?.changes??0)>0){await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:fixedHqAudience.count,known:0,started:true,expectedLockVersion:lockVersion,requireBatchLock:true});return;}
  const pending = await db.prepare(`SELECT f.id,f.line_user_id,f.display_name,c.state,c.attempt_no,c.dispatched_at,c.error_code
    FROM broadcast_send_claims c JOIN (${currentRecipients.sql}) f ON f.id=c.friend_id
    WHERE c.broadcast_id=? ${fixedHqAudience?'':`AND (
      (c.state='claimed' AND c.dispatched_at IS NULL)
      OR (c.state='failed' AND c.error_code IN ('line_http_429','stopped_before_dispatch') AND c.attempt_no=?))`}
    ORDER BY c.friend_id`).bind(...currentRecipients.bindings,broadcast.id,...(fixedHqAudience?[]:[Number(raw.send_attempt_no ?? 1)])).all<{
      id:string; line_user_id:string; display_name:string|null;state:string;attempt_no:number;dispatched_at:string|null;error_code:string|null;
    }>();
  if(fixedHqAudience&&(!accountId||pending.results.length!==fixedHqAudience.count||await broadcastAudienceToken(accountId,pending.results)!==fixedHqAudience.recipientToken)){
    await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:fixedHqAudience.count,known:0,started:true,expectedLockVersion:lockVersion,requireBatchLock:true});return;
  }
  const friends = fixedHqAudience?pending.results.filter(row=>(row.state==='claimed'&&row.dispatched_at===null)||(row.state==='failed'&&['line_http_429','stopped_before_dispatch'].includes(row.error_code??'')&&row.attempt_no===Number(raw.send_attempt_no??1))):pending.results;
  const audienceCount = await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?')
    .bind(broadcast.id).first<{n:number}>();
  const progressBase = Number(audienceCount?.n ?? 0) - friends.length;

  const now = jstNow();
  // 開封数を取らない配信では null。集計ユニットは月1,000の上限がある。
  const unit = aggregationUnitFor(broadcast);
  /*
   * 送達台帳。
   *
   * `blocked` は**もう送ってはいけない相手**——送達済み（sent）と
   * 送達不明（unknown）。この tick の始めに1回だけ引く。相手の id を
   * 並べて `IN (...)` で引くと D1 のバインド上限（100）に当たるので、
   * 配信ぶんをまとめて引いてから手元で照合する。
   *
   * `attemptNo` は試行の番号。失敗分の再送で進む。provider へ渡す再送キーに
   * 混ぜるので、同じ試行の中での送り直しは LINE 側で重複が潰れ、試行を
   * またぐ再送は台帳側で成功・送達不明を飛ばす。
   */
  const blocked = await getBlockedRecipientIds(db, broadcast.id);
  const attemptNo = Number(raw.send_attempt_no ?? 1) || 1;
  let currentOffset = 0;
  const tickStartOffset = 0;
  const personalized = hasRecipientVariablesInParts(finalParts);
  const unsupportedVariables = unsupportedMessageVariables(finalParts);
  if (unsupportedVariables.length > 0) {
    await updateBroadcastBatchProgress(db, broadcast.id, batchOffset, 0);
    throw new Error(
      `Unsupported broadcast variables: ${unsupportedVariables.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }
  if (!personalized) {
    try {
      assertMessagePartsResolved(finalParts);
    } catch (err) {
      await updateBroadcastBatchProgress(db, broadcast.id, batchOffset, 0);
      throw err;
    }
  }
  const deliveryBatchSize = personalized ? PERSONALIZED_PUSH_BATCH_SIZE : MULTICAST_BATCH_SIZE;
  const totalBatches = Math.ceil(friends.length / deliveryBatchSize);

  // 時間をかけて配る設定。0（既定）なら一気に送る。
  const spreadMinutes = Number(raw.stealth_spread_minutes ?? 0) || 0;
  const chunkLimit = stealthChunkSize(friends.length, spreadMinutes, deliveryBatchSize);
  const stopAt = Math.min(friends.length, currentOffset + chunkLimit);

  // 1回のCron実行で、上限まで処理する（タイムアウトしない範囲で）
  while (currentOffset < stopAt) {
    /*
     * 停止はここで効く。**次の一束へ進む前に必ず読み直す。**
     *
     * ロックを取ったあとに運用者が停止を押した場合、この tick は自分が
     * 掴んだ束を送り終えている。送り終えた分を取り消すことはできない
     * （相手のトークに残る）ので、**新しい束を始めないことで止める**。
     * 途中まで進んだ位置を書き戻してロックを外し、再開でその続きから送る。
     */
    if (await isBroadcastStopped(db, broadcast.id)) {
      await releaseStopped(progressBase+currentOffset);
      return;
    }
    try { await renewLimitedReservation(db,broadcast,friends.length-currentOffset); } catch (error) {
      await holdLimitedBroadcast(db,broadcast,error instanceof Error?error.message:'送信枠を確認できません。');
      return;
    }
    const batch = friends.slice(currentOffset, currentOffset + deliveryBatchSize);
    const suppressed = await suppressedFriendIds(db,batch.map(f=>f.id));
    await recordSuppressedBroadcastRecipients(db,broadcast.id,[...suppressed]);
    const batchIndex = Math.floor(currentOffset / deliveryBatchSize);

    if (personalized) {
      for (const friend of batch) {
        // 台帳が「送達済み」「送達不明」と覚えている相手は飛ばす。
        // 送達不明を飛ばすのは at-most-once のため——外へ出たかもしれない
        // 相手を送り直すと、相手のトークに2通残って取り消せない。
        if (blocked.has(friend.id)||suppressed.has(friend.id)) {
          currentOffset++;
          continue;
        }
        const alreadyLogged = await db.prepare(
          `SELECT 1 FROM messages_log
            WHERE broadcast_id = ? AND friend_id = ? AND direction = 'outgoing'
              AND COALESCE(delivery_type, '') != 'test'
            LIMIT 1`,
        ).bind(broadcast.id, friend.id).first();
        if (alreadyLogged) {
          currentOffset++;
          continue;
        }

        try {
          // 友だち情報欄は人ごとに違うので、ここで引く。本文で使っていなければ引かない。
          // 共通情報は広域contextで厳格解決済みなので、ここで再解決しない。
          const fields = contentNeedsFriendFields(combinedMessageContent(finalParts))
            ? await getFriendFieldMap(db, friend.id)
            : undefined;
          const renderedParts = renderMessageParts(finalParts, {
            displayName: friend.display_name,
            fields,
          });
          assertMessagePartsResolved(renderedParts);
          const personalizedMessages = buildMessages(renderedParts);
          const retryKey = await createBroadcastRetryKey(
            broadcast.id,
            'personalized-push',
            `attempt:${attemptNo}`,
            friend.id,
            JSON.stringify(personalizedMessages),
          );
          // 外へ出す**直前**に台帳へ「出す」と書く。書いてから送ると、
          // 送信と記録のあいだで Worker が消えても送達不明として残る。
          // 逆にすると「届いたのに台帳は空」になり、次の試行が再送する。
          const dispatched=await markBroadcastRecipientsDispatched(db, {
            broadcastId: broadcast.id,
            attemptNo,
            lineAccountId: accountId,
            friendIds: [friend.id],
            expectedLockVersion: lockVersion,
            expectedRecipients: fixedHqAudience ? [{id:friend.id,lineUserId:friend.line_user_id}] : undefined,
          });
          if(dispatched.length!==1){if(fixedHqAudience)await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:fixedHqAudience.count,known:0,started:true,expectedLockVersion:lockVersion,requireBatchLock:true});else await releaseProgress(progressBase+currentOffset);return;}
          const { requestId: pushRequestId } = await lineClient.pushMessageWithRequestId(friend.line_user_id, personalizedMessages, retryKey, aggregationUnits(unit));

          await db.batch([
            ...renderedParts.map((part) => db.prepare(
              `INSERT INTO messages_log
                (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
            ).bind(
              crypto.randomUUID(),
              friend.id,
              part.messageType,
              part.messageContent,
              broadcast.id,
              accountId,
              now,
            )),
            ...buildBroadcastSettleStatements(db, {
              broadcastId: broadcast.id,
              friendIds: [friend.id],
              state: 'sent',
              lineRequestId: pushRequestId,
            }),
          ]);
          blocked.add(friend.id);
          currentOffset++;
          // 送信後動作: LINEが受け付けたこの宛先にだけ固定版を実行する。
          // 送達は確定済みなので、ここが落ちても送り直さない。取り残しは
          // 定期回収が拾う。
          try {
            await processBroadcastAfterActions(db, { broadcastId: broadcast.id, limit: 5 });
          } catch (afterError) {
            logger.error("services_broadcast_failed");
          }
        } catch (err) {
          logger.error("services_broadcast_failed");
          // 届いていないと断定できたものだけ再送の対象にする。分からない
          // ものは送達不明のまま置き、この tick の残りも飛ばす。
          const outcome = classifyDeliveryFailure(err);
          await settleBroadcastRecipients(db, {
            broadcastId: broadcast.id,
            friendIds: [friend.id],
            state: outcome,
            errorCode: deliveryErrorCode(err),
          });
          if (outcome === 'unknown') blocked.add(friend.id);
          const released=await db.prepare(
            `UPDATE broadcasts
                SET batch_offset = ?, batch_lock_at = NULL,
                    success_count = (
                      SELECT COUNT(DISTINCT friend_id) FROM messages_log
                       WHERE broadcast_id = ? AND direction = 'outgoing'
                         AND COALESCE(delivery_type, '') != 'test'
                    )
              WHERE id = ? AND lock_version = ? AND batch_offset = -1`,
          ).bind(progressBase + currentOffset, broadcast.id, broadcast.id,lockVersion).run();
          if(!released.meta.changes)await releaseStopped(progressBase+currentOffset);
          return;
        }
      }

      const progressUpdate=await db.prepare(
        `UPDATE broadcasts
            SET success_count = (
                  SELECT COUNT(DISTINCT friend_id) FROM messages_log
                   WHERE broadcast_id = ? AND direction = 'outgoing'
                     AND COALESCE(delivery_type, '') != 'test'
                )
          WHERE id = ? AND lock_version = ? AND batch_offset = -1`,
      ).bind(broadcast.id, broadcast.id,lockVersion).run();
      if(!progressUpdate.meta.changes){await releaseStopped(progressBase+currentOffset);return;}
      if (currentOffset >= friends.length) break;
      // subrequest を使い切る手前で切り上げる。次の cron が続きから再開する。
      if (currentOffset - tickStartOffset >= PERSONALIZED_PUSH_PER_TICK) {
        await releaseProgress(progressBase + currentOffset);
        return;
      }
      continue;
    }

    /*
     * 台帳が覚えている相手を束から抜く。
     *
     *   送達済み（sent）   … もう届いている
     *   送達不明（unknown）… 外へ出たかもしれない。送り直さない
     *
     * 抜いた結果が空なら、外の口は**一度も叩かない**で位置だけ進める。
     * 失敗分の再送は先頭から歩き直すので、ここで叩いてしまうと送り終えた
     * 相手へ2通目が出る。
     */
    let sendable = batch.filter((friend) => !blocked.has(friend.id)&&!suppressed.has(friend.id));
    if (sendable.length === 0) {
      currentOffset += batch.length;
      continue;
    }

    // ステルス遅延（最初のバッチ以外）
    if (batchIndex > 0) {
      const delay = calculateStaggerDelay(friends.length, batchIndex, deliveryBatchSize);
      await sleep(delay);
    }

    // テキストメッセージのバリエーションは先頭のテキスト1通だけに付ける。
    const batchMessages = varyTextMessages(messages, batchIndex, totalBatches);

    let sendableIds = sendable.map((f) => f.id);
    // 外へ出す直前に台帳へ「出す」と書く。ここで書いた印が残ったまま決着が
    // 付かなければ、その相手は送達不明として再送の対象から外れる。
    const dispatched=await markBroadcastRecipientsDispatched(db, {
      broadcastId: broadcast.id,
      attemptNo,
      lineAccountId: accountId,
      friendIds: sendableIds,
      expectedLockVersion: lockVersion,
      expectedRecipients: fixedHqAudience ? sendable.map(friend=>({id:friend.id,lineUserId:friend.line_user_id})) : undefined,
    });
    if(dispatched.length!==sendableIds.length && fixedHqAudience){await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:fixedHqAudience.count,known:0,started:true,expectedLockVersion:lockVersion,requireBatchLock:true});return;}
    if(!dispatched.length){await releaseProgress(progressBase+currentOffset);return;}
    const dispatchedSet=new Set(dispatched);
    sendable=sendable.filter(friend=>dispatchedSet.has(friend.id));
    sendableIds=dispatched;
    const lineUserIds=sendable.map(friend=>friend.line_user_id);
    let queuedRequestId: string | null = null;
    try {
      const retryKey = await createBroadcastRetryKey(
        broadcast.id,
        'queued-multicast',
        `attempt:${attemptNo}`,
        ...sendableIds,
        JSON.stringify(batchMessages),
      );
      ({ requestId: queuedRequestId } = await lineClient.multicast(lineUserIds, batchMessages, aggregationUnits(unit), retryKey));
    } catch (err) {
      logger.error("services_broadcast_failed");
      const outcome = classifyDeliveryFailure(err);
      await settleBroadcastRecipients(db, {
        broadcastId: broadcast.id,
        friendIds: sendableIds,
        state: outcome,
        errorCode: deliveryErrorCode(err),
      });
      // 送信失敗: ロック解除 + offsetを保存して次のCronで再開
      await releaseProgress(progressBase + currentOffset);
      return; // batch_offset が currentOffset に戻り、次の cron で再開可能
    }

    // 送信成功後のログ・進捗更新（失敗しても再送しない）
    // line_account_id は queue path lock 時の broadcast.line_account_id を使う
    // (friends.line_account_id ではなく送信元アカウントを固定で記録)。
    const queuedBroadcastAccount = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    const settleSent = () => buildBroadcastSettleStatements(db, {
      broadcastId: broadcast.id,
      friendIds: sendableIds,
      state: 'sent',
      lineRequestId: queuedRequestId,
    });
    try {
      const stmts = [
        ...sendable.flatMap(friend => finalParts.map(part =>
          db.prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
          ).bind(crypto.randomUUID(), friend.id, part.messageType, part.messageContent, broadcast.id, queuedBroadcastAccount, now),
        )),
        // 送達の記録と台帳の決着を**同じ batch** に載せる。分けて流すと、
        // 記録だけ残って台帳が押さえたままの窓ができ、その相手が
        // 「届いたのに送達不明」になる。
        ...settleSent(),
      ];
      await db.batch(stmts);
    } catch (logErr) {
      logger.error("services_broadcast_failed");
      // 記録に失敗しても、外の口は受け取っている。台帳だけは必ず閉じる。
      // 閉じ損ねると次の試行がこの相手を送り直して2通目が出る。
      try {
        await db.batch(settleSent());
      } catch (settleErr) {
        logger.error("services_broadcast_failed");
      }
    }
    for (const friend of sendable) blocked.add(friend.id);
    // 送信後動作: この束で受け付けられた宛先にだけ固定版を実行する。
    // 失敗した束は上の catch で決着済みで、ここには来ない。
    try {
      await processBroadcastAfterActions(db, { broadcastId: broadcast.id, limit: 100 });
    } catch (afterError) {
      logger.error("services_broadcast_failed");
    }

    currentOffset += batch.length;
    // 処理中に別実行が取得しないよう、成功数を更新しても batch_offset=-1 のロックは保つ。
    const progressUpdate=await db.prepare(
      `UPDATE broadcasts SET success_count = success_count + ? WHERE id = ? AND lock_version = ? AND batch_offset = -1`,
    ).bind(sendable.length, broadcast.id,lockVersion).run();
    if(!progressUpdate.meta.changes){await releaseStopped(progressBase+currentOffset);return;}
  }

  // まだ残っている（時間をかけて配る設定で途中まで送った）。
  // ロックだけ外して、次の tick が続きから送る。完了にはしない。
  if (currentOffset < friends.length) {
    await releaseProgress(progressBase + currentOffset);
    return;
  }

  // 全バッチ完了 — ロック解除 + 完了マーク
  await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
  if (storedDeliveryLimit(broadcast) && broadcast.line_account_id) {
    const { releaseQuotaSlot } = await import('./broadcast-quota-guard.js');
    await releaseQuotaSlot(db,broadcast.line_account_id,broadcast.id,{ expectedLockVersion: lockVersion });
  }
  await createBroadcastInsight(db, broadcast.id);
  const finished=await db.prepare(`UPDATE broadcasts SET status='sent',sent_at=?,batch_lock_at=NULL,batch_offset=?
    WHERE id=? AND lock_version=? AND batch_offset=-1 AND stopped_at IS NULL`)
    .bind(jstNow(),progressBase+currentOffset,broadcast.id,lockVersion).run();
  if(!finished.meta.changes)await releaseStopped(progressBase+currentOffset);
}

/*
 * メッセージの組み立ては、シナリオと同じものを使う。
 *
 * ここに別実装を持っていたときは、text / image / flex の3つしか
 * 組み立てられなかった。それ以外の種別を渡すと「テキストに JSON を
 * 入れたもの」に落ちるので、**中身の JSON がそのまま相手のトークに届く**。
 * 呼び出し側が多いので、ここからも取れるようにしておく。
 */
export { buildMessage };
