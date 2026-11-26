import { logger } from '@line-crm/shared/server';
import { parseProgress } from './dedup-broadcast-progress.js';
import type { DedupPreviewPerAccount, DedupPreviewResult, DedupProgress } from './dedup-broadcast-progress.js';
export type { DedupPreviewPerAccount, DedupPreviewResult } from './dedup-broadcast-progress.js';
import { recordSuppressedBroadcastRecipients, suppressedFriendIds } from '@line-crm/db/src/friend-delivery-consents.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { holdMissingBroadcastAudience } from '../features/broadcasts/broadcast-audience-snapshot/index.js';
import { URL_TOKEN_SQL } from '../lib/url-token.js';

interface RankedRow {
  friend_id: string;
  line_user_id: string;
  line_account_id: string;
  ident_key: string;
  display_name: string | null;
}

/** プレビューと送信で同じ計算法を使い、送信時の実データで対象を再計算する。DB の ROW_NUMBER で本人ごとに優先アカウント・作成順から1件を選び、JS はアカウント別の集計だけを行う。フォロー中で所属のある友だちだけを対象にする。 */
export async function computeDedupBroadcastPreview(
  db: D1Database,
  accountIds: string[],
  dedupPriority: string[],
  targetTagId?: string | null,
): Promise<DedupPreviewResult> {
  if (accountIds.length === 0) {
    return { totalSelected: 0, uniqueRecipients: 0, reduction: 0, reductionRate: 0, perAccount: [] };
  }

  const priority = dedupPriority.filter((id) => accountIds.includes(id));

  const inPlaceholders = sqlIdSet(accountIds).sql;

  const caseExpr = priority.length === 0
    ? '999'
    : `COALESCE((SELECT CAST(key AS INTEGER) FROM json_each(?)
        WHERE value = line_account_id ORDER BY CAST(key AS INTEGER) LIMIT 1), 999)`;

  // 分母と重複除外後の母集団がずれないよう、タグ条件を両方の問い合わせへ同じく適用する。空指定は制限なし。
  const hasTagFilter = !!targetTagId;
  const tagJoinForSelectedCount = hasTagFilter
    ? `AND EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = friends.id AND ft.tag_id = ?)`
    : '';
  const tagJoinForRanked = hasTagFilter
    ? `AND EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`
    : '';


  const selectedCountSql = `
    SELECT line_account_id, COUNT(*) AS cnt
    FROM friends
    WHERE is_following = 1
      AND line_account_id IN (${inPlaceholders})
      AND line_account_id IS NOT NULL
      ${tagJoinForSelectedCount}
    GROUP BY line_account_id
  `;
  const selectedCountBinds = hasTagFilter
    ? [...sqlIdSet(accountIds).binds, targetTagId]
    : [...sqlIdSet(accountIds).binds];
  const selectedCounts = await db
    .prepare(selectedCountSql)
    .bind(...selectedCountBinds)
    .all<{ line_account_id: string; cnt: number }>();

  const selectedCountByAccount = new Map<string, number>();
  for (const row of selectedCounts.results ?? []) {
    selectedCountByAccount.set(row.line_account_id, row.cnt);
  }
  const totalSelected = (selectedCounts.results ?? []).reduce((sum, r) => sum + r.cnt, 0);


  const rankedSql = `
    WITH selected AS (
      SELECT
        f.id            AS friend_id,
        f.line_platform_user_id AS line_user_id,
        f.display_name,
        f.line_account_id,
        f.created_at,
        COALESCE(${URL_TOKEN_SQL}, 'uid:'||f.user_id, 'solo:'||f.id) AS ident_key
      FROM friends f
      WHERE f.is_following = 1
        AND f.line_account_id IN (${inPlaceholders})
        AND f.line_account_id IS NOT NULL
        ${tagJoinForRanked}
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY ident_key
          ORDER BY ${caseExpr}, created_at ASC
        ) AS rn
      FROM selected
    )
    SELECT friend_id, line_user_id, line_account_id, ident_key, display_name
    FROM ranked
    WHERE rn = 1
    ORDER BY line_account_id, created_at
  `;
  // SQL の出現順に、対象アカウント、タグ条件、優先順 JSON をバインドする。
  const rankedBinds = hasTagFilter
    ? [...sqlIdSet(accountIds).binds, targetTagId, ...(priority.length ? [JSON.stringify(priority)] : [])]
    : [...sqlIdSet(accountIds).binds, ...(priority.length ? [JSON.stringify(priority)] : [])];
  const rankedRows = await db
    .prepare(rankedSql)
    .bind(...rankedBinds)
    .all<RankedRow>();


  const sendCountByAccount = new Map<string, RankedRow[]>();
  for (const row of rankedRows.results ?? []) {
    const list = sendCountByAccount.get(row.line_account_id) ?? [];
    list.push(row);
    sendCountByAccount.set(row.line_account_id, list);
  }

  const uniqueRecipients = (rankedRows.results ?? []).length;
  const reduction = totalSelected - uniqueRecipients;
  const reductionRate = totalSelected > 0 ? reduction / totalSelected : 0;


  const accountMetaSql = `SELECT id, name, country FROM line_accounts WHERE id IN (${inPlaceholders})`;
  const metaRows = await db
    .prepare(accountMetaSql)
    .bind(...sqlIdSet(accountIds).binds)
    .all<{ id: string; name: string; country: string | null }>();
  const metaByAccount = new Map<string, { name: string; country: string | null }>();
  for (const r of metaRows.results ?? []) {
    metaByAccount.set(r.id, { name: r.name, country: r.country });
  }

  const perAccount: DedupPreviewPerAccount[] = accountIds.map((id) => {
    const selectedCount = selectedCountByAccount.get(id) ?? 0;
    const winners = sendCountByAccount.get(id) ?? [];
    const sendCount = winners.length;
    const meta = metaByAccount.get(id) ?? { name: id, country: null };
    return {
      accountId: id,
      accountName: meta.name,
      accountCountry: meta.country,
      selectedCount,
      sendCount,
      excludedToHigherPriority: selectedCount - sendCount,
      recipients: winners.map((w) => ({
        friendId: w.friend_id,
        lineUserId: w.line_user_id,
        identKey: w.ident_key,
        displayName: w.display_name ?? null,
      })),
    };
  });

  return { totalSelected, uniqueRecipients, reduction, reductionRate, perAccount };
}

import { LineClient } from '@line-crm/line-sdk';
import {
  getLineAccountById,
  jstNow,
  updateBroadcastLineRequestId,
  getBlockedRecipientIds,
  markBroadcastRecipientsDispatched,
  buildBroadcastSettleStatements,
  settleBroadcastRecipients,
  isBroadcastStopped,
  isOperationCapabilityStopped,
} from '@line-crm/db';
import { calculateStaggerDelay, sleep } from './stealth.js';
import { createBroadcastRetryKey } from '../features/broadcasts/broadcast-retry-key/index.js';
import { processBroadcastAfterActions } from '../features/broadcasts/broadcast-after-actions/index.js';
import { classifyDeliveryFailure, deliveryErrorCode } from '../features/broadcasts/broadcast-delivery-outcome/index.js';
import {
  assertMessagePartsResolved,
  buildMessages,
  combinedMessageContent,
  hasRecipientVariablesInParts,
  parseBroadcastMessageParts,
  renderMessageParts,
  varyTextMessages,
  type BroadcastMessagePart,
} from '../features/broadcasts/broadcast-message-set/index.js';
import {
  commonVarValuesForAccount,
  parseBroadcastCommonVarSnapshot,
} from './common-var-snapshot.js';

// LINE の multicast は 1 リクエストで最大 500 人まで宛先に取れる（LINE の仕様）。
// これ以上に増やすことはできない。
const MULTICAST_BATCH_SIZE = 500;
// 差し込み（{{name}} など）があると本文が人ごとに変わるので multicast が使えず、
// push を 1 人ずつ送る。この数はレート制限ではなく **区切りの単位**で、
// 「ここまで送ったら時間を見る／少し待つ」という判断をこの粒度で行う。
// 小さいほど中断したときの取りこぼしが減り、大きいほど待ちの回数が減る。
const PERSONALIZED_PUSH_BATCH_SIZE = 10;

export interface ProcessMultiAccountDedupResult {
  totalCount: number;
  successCount: number;
  failedAccountIds: string[];
  // false = この実行は時間バジェットに達して途中で yield した (まだ未送の人が残る)。
  // caller は status='sent' にせず batch_offset=0 に戻して次の cron tick に継続させる。
  // true = 全 account を送り切った (= 完了)。caller が status='sent' にする。
  complete: boolean;
  // 運用者が停止を押したので束の切れ目で降りた。complete=false と同じく
  // caller は status='sent' にしない。再開するまで queue は拾わない。
  stopped: boolean;
}

// 1 回の cron 実行でこの時間 (ms) を超えたら、残りは次の tick に回して yield する。
// これにより 1 実行が常に短く終わり、Cloudflare Worker の時間制限に達して stall する
// ことが構造的に無くなる (5000 人でも数 tick に分割されて淡々と進む)。stagger sleep も
// この経過時間に含まれる。判定は次 batch の sleep+multicast の「前」に行うため、超過判定
// 時点から更に 1 batch 分 (最大 ~5s sleep + multicast) はみ出し得る。それを見込んで Worker
// CPU 制限 (約30s) に対し十分な余裕を取った 10s に設定する (実効ロック保持は最大 ~15-18s)。
const MAX_RUN_MS = 10_000;

export async function processMultiAccountDedupBroadcast(
  db: D1Database,
  broadcast: {
    id: string;
    account_ids: string | null;
    dedup_priority: string | null;
    target_tag_id?: string | null;
    message_type: string;
    message_content: string;
    message_bubbles_json?: string | null;
    messageParts?: BroadcastMessagePart[];
    alt_text?: string | null;
    dedup_progress?: string | null;
    aggregation_unit?: string | null;
    /** 送信の試行番号。失敗分の再送で進む。台帳と provider の再送キーに使う。 */
    send_attempt_no?: number | null;
    lock_version?: number | null;
    common_var_snapshot?: string | null;
  },
  lineClientFactory: (token: string) => LineClient = (t) => new LineClient(t),
  opts: { maxRunMs?: number; now?: () => number } = {},
): Promise<ProcessMultiAccountDedupResult> {
  // 時間バジェット制御 (テストでは clock を注入して yield を決定的に再現できる)。
  // 変数名は clock — batch ループ内の `const now = jstNow` (timestamp 文字列) と
  // 衝突させないため。
  const clock = opts.now ?? (() => Date.now());
  const maxRunMs = opts.maxRunMs ?? MAX_RUN_MS;
  const startMs = clock();
  // 1 batch でも送ったら true。時間切れでも最低 1 batch は進めて前進を保証する
  // (毎 tick 必ず success_count が伸びる → 永久に同じ所で足踏みしない)。
  let sentAnyBatch = false;
  let timeExceeded = false;
  // 運用者が停止を押した。束の切れ目で降りる。
  let stopRequested = false;

  const accountIds = (broadcast.account_ids ? JSON.parse(broadcast.account_ids) : []) as string[];
  const dedupPriority = (broadcast.dedup_priority ? JSON.parse(broadcast.dedup_priority) : []) as string[];

  const progress = parseProgress(broadcast.dedup_progress);
  if (!progress.audience) {
    const ledger=await db.prepare('SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=?')
      .bind(broadcast.id).first<{n:number}>();
    if (await holdMissingBroadcastAudience(db,{id:broadcast.id,expected:0,known:0,
      started:progress.sentIdentKeys.length>0 || Number(ledger?.n ?? 0)>0})) {
      return {totalCount:progress.sentIdentKeys.length,successCount:progress.sentIdentKeys.length,
        failedAccountIds:[],complete:false,stopped:true};
    }
  }
  const preview = progress.audience ?? await computeDedupBroadcastPreview(
    db, accountIds, dedupPriority, broadcast.target_tag_id ?? null,
  );
  if (!progress.audience) {
    // 当選した友だちと正規IDを、最初の外部送信より先に固定する。
    progress.audience = preview;
    await db.prepare('UPDATE broadcasts SET dedup_progress=? WHERE id=? AND send_attempt_no=? AND (? IS NULL OR lock_version=?)')
      .bind(JSON.stringify(progress),broadcast.id,Number(broadcast.send_attempt_no ?? 1),broadcast.lock_version ?? null,broadcast.lock_version ?? null).run();
  }

  const sentSet = new Set(progress.sentIdentKeys);

  /*
   * 送達台帳。dedup は identKey で「送った人」を覚えているが、
   * **送れなかった人・外へ出たか分からない人**は覚えていない。台帳の
   * blocked は送達済み(sent)と送達不明(unknown)の friend_id で、停止をまたいだ
   * 再送で送達不明の相手へ2通目が出るのを防ぐ。identKey の集合と役割が
   * 違うので、両方を見る。
   */
  const blocked = await getBlockedRecipientIds(db, broadcast.id);
  // 送り直せない失敗や、すでに送信を始めた相手も次の束から除く。
  // それらを束に含めると原子的な送信直前の照合が束全体を止めてしまう。
  const ineligible = await db.prepare(`SELECT friend_id FROM broadcast_send_claims WHERE broadcast_id=?
    AND ((state='failed' AND COALESCE(error_code,'') NOT IN ('line_http_429','stopped_before_dispatch'))
      OR (state='claimed' AND dispatched_at IS NOT NULL))`)
    .bind(broadcast.id).all<{friend_id:string}>();
  for (const row of ineligible.results ?? []) blocked.add(row.friend_id);
  const attemptNo = Number(broadcast.send_attempt_no ?? 1) || 1;

  // totalCount は「この broadcast の意図した audience 全体」= 既送 identKey ∪
  // active アカウントの preview 当選者 identKey。母集団変動 (unfollow / tag 喪失) で
  // current preview から消えた既送ユーザーも intended audience に含めるための union。
  // これがないと resume 時に success_count > total_count になる事故が起きる。
  // inactive account は実送信されないので集計から除外する (active union のみ)。
  const allIdentKeys = new Set<string>(progress.sentIdentKeys);

  const failedAccountIds: string[] = [];
  // 緊急停止  で止まっているアカウント。失敗とは別に覚え、
  // 残っている間は complete にしない（復旧後に残りを送るため）。
  const heldAccountIds: string[] = [];

  // 単一 broadcast-wide unit を全アカウント multicast で共有する。各 LINE
  // チャネルは独立した unit namespace を持つので「同じ名前で別カウント」が
  // アカウント側に保持される。fetch-insight 側で account_ids をループして
  // それぞれ getUnitInsight → 合算する設計 (routes/broadcasts.ts の dedup 分岐)。
  //
  // LINE customAggregationUnit は alphanumeric + underscore のみ (1-30 chars)。
  // broadcast.id.slice(0, 8) だと id がハイフン含む形 (例: 'bcast-xxxx-...')
  // のとき 'bcast_bcast-xx' と無効値を生成して LINE が 400 を返す。fallback は
  // hex のみに正規化する。`broadcasts.aggregation_unit` カラムが既に有効な
  // unit で埋まっていれば優先採用する (API/UI 経由作成時はそうなる)。
  const fallbackUnit = `bcast_${broadcast.id.slice(0, 8).replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const unit = broadcast.aggregation_unit ?? fallbackUnit;

  for (const accountResult of preview.perAccount) {
    if (timeExceeded) break; // 時間バジェット超過 — 残アカウントは次の cron tick で処理
    if (stopRequested) break; // 停止済み — 新しいアカウントの送信を始めない
    const account = await getLineAccountById(db, accountResult.accountId);
    if (!account || !account.is_active) {
      logger.log("services_dedup_broadcast_log");
      continue;
    }
    // 緊急停止 : broadcast_dispatch が止まっているアカウントの束は
    // 始めない。identKey が未送信のまま残るので、復旧後の tick が続きを送る。
    // 他のアカウントは止まっていなければ送る。
    if (await isOperationCapabilityStopped(db, accountResult.accountId, 'broadcast_dispatch')) {
      heldAccountIds.push(accountResult.accountId);
      continue;
    }

    const recipients = accountResult.recipients;
    // active account の identKey を totalCount union に登録する (inactive は除外済み)。
    for (const r of recipients) allIdentKeys.add(r.identKey);
    if (recipients.length === 0) continue;

    // 既に送信済の identKey を持つ recipient を除外して残差だけ送る。
    // identKey は dedup の意味論的 ID なので、母集団変動や cross-account 遷移が
    // あっても論理重複を完全に防げる。
    // 台帳が送達済み・送達不明と覚えている相手も外す。identKey の集合だけだと
    // 「外へ出たかもしれない」相手が未送扱いで残り、再送で2通目が出る。
    const remaining = recipients.filter(
      (r) => !sentSet.has(r.identKey) && !blocked.has(r.friendId),
    );
    if (remaining.length === 0) continue; // このアカに残作業なし

    const sourceParts = broadcast.messageParts ?? parseBroadcastMessageParts({
      messageType: broadcast.message_type,
      messageContent: broadcast.message_content,
      messageBubblesJson: broadcast.message_bubbles_json,
      altText: broadcast.alt_text,
    });
    // 共通情報 ({{var.*}}) は配信元アカウントごとに解決する。別アカウントの
    // 値を混ぜない — 未定義があればそのアカウントだけ送らず失敗に記録する。
    // 受信者ごとの差し込み ({{name}}) より先に置き換える。
    let accountVars: Record<string, string> | undefined;
    if (sourceParts.some((part) => /\{\{\s*var\./.test(part.messageContent))) {
      try {
        const fixedSnapshot = parseBroadcastCommonVarSnapshot(broadcast.common_var_snapshot);
        if (fixedSnapshot) {
          accountVars = commonVarValuesForAccount(fixedSnapshot, account.id);
        } else {
          // snapshot に乗らない到達経路でも、消えた共通情報を空文字へ落とさず
          // fail-closed にする。失敗は throw で下の catch が失敗台帳側へ回す。
          const { resolveSendCommonVars } = await import('./interpolation-context.js');
          accountVars = await resolveSendCommonVars(
            db, account.id, combinedMessageContent(sourceParts),
            { kind: 'broadcast', id: broadcast.id },
          );
        }
        if (!accountVars) {
          failedAccountIds.push(account.id);
          continue;
        }
      } catch (err) {
        logger.error("dedup_broadcast.resolve_account_variables_failed");
        failedAccountIds.push(account.id);
        continue;
      }
      const missing = new Set<string>();
      for (const part of sourceParts) {
        for (const match of part.messageContent.matchAll(/\{\{\s*var\.([a-z][a-z0-9_]*)\s*\}\}/g)) {
          // `in` は継承プロパティ (constructor 等) も存在扱いにするため使わない。
          // 自前プロパティかつ文字列値のときだけ定義済みとし、旧 NULL 行は
          // 未定義扱い (送信に使わない)。
          const value: unknown = accountVars[match[1]];
          if (!Object.hasOwn(accountVars, match[1]) || typeof value !== 'string') {
            missing.add(match[1]);
          }
        }
      }
      if (missing.size > 0) {
        logger.error("dedup_broadcast.validate_account_variables_failed");
        failedAccountIds.push(account.id);
        continue;
      }
    }
    const client = lineClientFactory(account.channel_access_token);
    const accountParts = renderMessageParts(sourceParts, {
      liffId: (account as unknown as { liff_id?: string | null }).liff_id ?? null,
      ...(accountVars ? { vars: accountVars } : {}),
    });
    const personalized = hasRecipientVariablesInParts(accountParts);
    if (!personalized) assertMessagePartsResolved(accountParts);
    const deliveryBatchSize = personalized ? PERSONALIZED_PUSH_BATCH_SIZE : MULTICAST_BATCH_SIZE;
    const totalBatches = Math.ceil(remaining.length / deliveryBatchSize);

    // Per-account の liff_id でテンプレ変数 ({{liff_id}}) を置換してから
    // buildMessage する。これで 1 broadcast から複数アカへ配信する際、
    // 友だちの所属アカに対応した LIFF URL が届く (events の運用要件)。
    const messages = personalized ? null : buildMessages(accountParts);

    try {
      for (let i = 0; i < remaining.length; i += deliveryBatchSize) {
        if (stopRequested) break;
        const batchIdx = Math.floor(i / deliveryBatchSize);
        const candidates = remaining.slice(i, i + deliveryBatchSize);
        const suppressed = await suppressedFriendIds(db,candidates.map(r=>r.friendId));
        await recordSuppressedBroadcastRecipients(db,broadcast.id,[...suppressed]);
        const batch = candidates.filter(r=>!suppressed.has(r.friendId));
        if(!batch.length) continue;

        // 時間バジェットを超えたら、残りは次の cron tick に回して yield する。
        // ただし最低 1 batch は必ず送る (sentAnyBatch ガード) ことで毎 tick 前進を保証。
        if (sentAnyBatch && clock() - startMs > maxRunMs) {
          timeExceeded = true;
          break;
        }

        // 次の束へ進む前に停止を読み直す。送り終えた束は取り消せない
        // ので、新しい束を始めないことで止める。
        // 緊急停止  も同じ扱い: broadcast_dispatch が止まった
        // アカウントは次の束を始めず、残りは未送信のまま残す。
        if (await isBroadcastStopped(db, broadcast.id) ||
            await isOperationCapabilityStopped(db, account.id, 'broadcast_dispatch')) {
          stopRequested = true;
          break;
        }

        if (batchIdx > 0) {
          await sleep(calculateStaggerDelay(remaining.length, batchIdx, deliveryBatchSize));
        }

        const delivered = [] as Array<{
          recipient: (typeof batch)[number];
          messageType: string;
          content: string;
        }>;
        let batchDeliveryError: unknown = null;
        // 外へ出たかもしれない相手の集合。決着が付かなかったぶんは停止の
        // 受付時に送達不明へ倒れ、再送の対象から外れる。
        const dispatchedIds: string[] = [];
        let failedRecipientIds: string[] = [];
        if (personalized) {
          for (const recipient of batch) {
            try {
              const renderedParts = renderMessageParts(accountParts, {
                displayName: recipient.displayName,
              });
              assertMessagePartsResolved(renderedParts);
              const recipientMessages = buildMessages(renderedParts);
              const retryKey = await createBroadcastRetryKey(
                broadcast.id,
                'dedup-personalized-push',
                `attempt:${attemptNo}`,
                recipient.friendId,
                JSON.stringify(recipientMessages),
              );
              // 外へ出す直前に台帳へ書く。1人ずつ押さえるので、束の途中で
              // 落ちたときに**まだ試していない相手**を送達不明にしない。
              const marked = await markBroadcastRecipientsDispatched(db, {
                guardAttempt: true,
                guardLockVersion: broadcast.lock_version ?? undefined,
                broadcastId: broadcast.id,
                attemptNo,
                lineAccountId: account.id,
                friendIds: [recipient.friendId],
              });
              if (!marked.includes(recipient.friendId)) { stopRequested = true; break; }
              dispatchedIds.push(recipient.friendId);
              await client.pushMessage(recipient.lineUserId, recipientMessages, retryKey, [unit]);
              for (const part of renderedParts) {
                delivered.push({ recipient, messageType: part.messageType, content: part.messageContent });
              }
            } catch (err) {
              batchDeliveryError = err;
              failedRecipientIds = [recipient.friendId];
              break;
            }
          }
        } else {
          const batchMessages = varyTextMessages(messages!, batchIdx, totalBatches);
          const retryKey = await createBroadcastRetryKey(
            broadcast.id,
            'dedup-multicast',
            `attempt:${attemptNo}`,
            account.id,
            ...batch.map((r) => r.identKey),
            JSON.stringify(batchMessages),
          );
          const marked = await markBroadcastRecipientsDispatched(db, {
            guardAttempt: true,
            guardLockVersion: broadcast.lock_version ?? undefined,
            broadcastId: broadcast.id,
            attemptNo,
            lineAccountId: account.id,
            friendIds: batch.map((r) => r.friendId),
          });
          if (marked.length !== batch.length) { stopRequested = true; break; }
          dispatchedIds.push(...batch.map((r) => r.friendId));
          try {
            await client.multicast(batch.map((r) => r.lineUserId), batchMessages, [unit], retryKey);
          } catch (err) {
            // 誰が落ちたかを台帳へ残してから、従来どおりアカウント単位の
            // 失敗として投げ直す。残さないと再送の対象が作れない。
            const outcome = classifyDeliveryFailure(err);
            await settleBroadcastRecipients(db, {
              broadcastId: broadcast.id,
              friendIds: dispatchedIds,
              state: outcome,
              errorCode: deliveryErrorCode(err),
            });
            if (outcome === 'unknown') for (const id of dispatchedIds) blocked.add(id);
            throw err;
          }
          for (const recipient of batch) {
            for (const part of accountParts) {
              delivered.push({ recipient, messageType: part.messageType, content: part.messageContent });
            }
          }
        }

        if (stopRequested && dispatchedIds.length === 0) break;

        // multicast 成功直後に identKey を sent set へ追加。
        for (const { recipient: r } of delivered) {
          if (sentSet.has(r.identKey)) continue;
          progress.sentIdentKeys.push(r.identKey);
          sentSet.add(r.identKey);
        }

        const now = jstNow();
        const deliveredIds = [...new Set(delivered.map(({ recipient }) => recipient.friendId))];
        // messages_log INSERT と progress UPDATE を 1 batch にまとめてアトミックに
        // 永続化する。Worker が multicast 後・batch 完了前に死ぬと「LINE 配信済 +
        // DB 進捗未更新」になって resume 時に同 batch を再送 → 重複配信事故が起きる。
        // db.batch は D1 で transaction として扱われ、まとめて成否が決まる。
        const stmts = [
          ...delivered.map(({ recipient: r, messageType, content }) =>
            db.prepare(
              `INSERT INTO messages_log
                (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
            ).bind(crypto.randomUUID(), r.friendId, messageType, content, broadcast.id, account.id, now),
          ),
          // success_count は absolute (`= ?`) で書いて double-counting を防ぐ。
          db.prepare(
            `UPDATE broadcasts SET dedup_progress = ?, success_count = MAX(success_count, ?)
              WHERE id = ? AND send_attempt_no=? AND (? IS NULL OR lock_version=?)`,
          ).bind(JSON.stringify(progress), progress.sentIdentKeys.length, broadcast.id, attemptNo, broadcast.lock_version ?? null, broadcast.lock_version ?? null),
          // 台帳の決着を**同じ batch** に載せる。分けて流すと、送達の記録だけ
          // 残って台帳が押さえたままの窓ができ、その相手が「届いたのに
          // 送達不明」になる。
          ...buildBroadcastSettleStatements(db, {
            broadcastId: broadcast.id,
            friendIds: deliveredIds,
            state: 'sent',
          }),
        ];
        await db.batch(stmts);
        for (const id of deliveredIds) blocked.add(id);
        // 送信後動作: この束で受け付けられた宛先にだけ固定版を実行する。
        try {
          await processBroadcastAfterActions(db, { broadcastId: broadcast.id, limit: 100 });
        } catch (afterError) {
          logger.error("dedup_broadcast.process_after_actions_failed");
        }
        sentAnyBatch = true; // 1 batch 以上 durable に記録した → 前進保証 & yield 可
        if (batchDeliveryError) {
          // 1人ずつ送る経路で落ちた相手。届いていないと断定できたものだけを
          // 再送の対象にし、分からないものは送達不明のまま置く。
          const outcome = classifyDeliveryFailure(batchDeliveryError);
          await settleBroadcastRecipients(db, {
            broadcastId: broadcast.id,
            friendIds: failedRecipientIds,
            state: outcome,
            errorCode: deliveryErrorCode(batchDeliveryError),
          });
          if (outcome === 'unknown') for (const id of failedRecipientIds) blocked.add(id);
          throw batchDeliveryError;
        }
      }
    } catch (err) {
      logger.error("dedup_broadcast.send_account_batch_failed");
      failedAccountIds.push(account.id);
    }
  }

  // 古い世代が新しい試行の進捗を上書きしない。
  const current = await db.prepare("SELECT send_attempt_no FROM broadcasts WHERE id=?").bind(broadcast.id).first<{send_attempt_no:number}>();
  if (Number(current?.send_attempt_no) !== attemptNo) return {totalCount:allIdentKeys.size,successCount:progress.sentIdentKeys.length,failedAccountIds:[],complete:false,stopped:true};

  // failed_account_ids は常に上書きする。前回 stalled run で残った古い失敗リストを
  // resume 後の成功で上書きしないと「全件成功したのに UI が partial-failure 表示」に
  // なる。今回失敗が無ければ NULL に戻して clean state にする。
  await db.prepare(
    `UPDATE broadcasts SET failed_account_ids = ? WHERE id = ? AND send_attempt_no=? AND (? IS NULL OR lock_version=?)`,
  ).bind(failedAccountIds.length > 0 ? JSON.stringify(failedAccountIds) : null, broadcast.id, attemptNo, broadcast.lock_version ?? null, broadcast.lock_version ?? null).run();

  const ledgerCount = await db.prepare("SELECT COUNT(*) AS n FROM broadcast_send_claims WHERE broadcast_id=? AND state='sent'")
    .bind(broadcast.id).first<{n:number}>();
  const successCount = Math.max(progress.sentIdentKeys.length, Number(ledgerCount?.n ?? 0));
  const totalCount = allIdentKeys.size;

  // aggregation_unit を保存して fetch-insight が LINE Insight API を叩けるようにする。
  // 1 件以上送れたときだけ書く (全件失敗時は insight 取得しても意味ない)。
  if (successCount > 0) {
    await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
  }

  // 完了後も開始時の宛先・既送IDを保持し、失敗した相手の再試行に使う。
  // status='sent' は回復対象外。送信完了の前に落ちても同じ snapshot で再開する。
  //
  // complete=false (timeExceeded) のときは caller が status='sent' にせず batch_offset=0 に
  // 戻し、次の cron tick が getQueuedBroadcasts で拾って残りを送る (= 分割送信)。
  return {
    totalCount,
    successCount,
    failedAccountIds,
    complete: !timeExceeded && !stopRequested && heldAccountIds.length === 0,
    stopped: stopRequested,
  };
}
