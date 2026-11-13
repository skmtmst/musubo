import { hasConversionApprovalRevision } from './conversion-approval-revision.js';
import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from './id-queries.js';
import { readFolderAssignment } from './folder-assignment.js';
import { dbTableExists, jstNow } from './utils.js';
import {
  ensureConversionRewardSnapshot,
  resolveApprovalRewardBasis,
  restoreSettledRewardOnReapproval,
  reverseSettledRewardOnRejection,
  type ApprovalRewardBasis,
} from './affiliate-settlements.js';
import { createAffiliateLink } from './affiliate-links.js';
import type { AffiliateLink } from './affiliate-links.js';
import { ensureDefaultMileageProgram } from './mileage/index.js';
// =============================================================================
// Affiliate Offers (案件) — ASP Phase 2
// =============================================================================
//
// An "offer" is a fixed-reward campaign an affiliate can join. Joining ("enroll")
// issues an offer-scoped affiliate_link (idempotent per affiliate×offer). The
// offer may carry a tag + scenario applied to friends who arrive via its links.

export interface AffiliateOffer {
  folder_id?: string | null;
  id: string;
  name: string;
  description: string | null;
  reward_amount: number;
  reward_miles: number;
  mileage_program_id: string;
  line_account_id: string | null;
  tag_id: string | null;
  scenario_id: string | null;
  is_active: number;
  created_at: string;
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export interface CreateAffiliateOfferInput {
  folderId?: string | null;
  name: string;
  description?: string | null;
  /** Fixed reward per conversion, in yen. Defaults to 0. */
  rewardAmount?: number;
  /** Harness miles granted when the conversion is approved. Defaults to 0. */
  rewardMiles?: number;
  mileageProgramId?: string;
  lineAccountId?: string | null;
  tagId?: string | null;
  scenarioId?: string | null;
  /**
   * 下書き（非公開）で作るときは false。未指定は従来どおり公開(1)。
   * 「作成→別APIで停止」の2段階にすると、途中失敗・通信断で有効な案件が
   * 残るため、最初のINSERTから指定した状態で入れる（DRAFT-01）。
   */
  isActive?: boolean;
  /**
   * Stable per-attempt UUID from the client. When the create commits
   * but the response is lost, the client retries with the SAME operationId;
   * this lets the retry recover the original row instead of creating a
   * duplicate offer.
   */
  operationId?: string | null;
}

/** Look up a prior create by its client-supplied operation UUID (idempotent replay). */
async function findAffiliateOfferByOperationId(
  db: D1Database,
  lineAccountId: string | null,
  operationId: string,
): Promise<AffiliateOffer | null> {
  return db
    .prepare(
      `SELECT * FROM affiliate_offers WHERE line_account_id IS ? AND operation_id = ?`,
    )
    .bind(lineAccountId, operationId)
    .first<AffiliateOffer>();
}

function isOperationIdConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /affiliate_offers\.operation_id/i.test(msg);
}

export async function createAffiliateOffer(
  db: D1Database,
  input: CreateAffiliateOfferInput,
): Promise<AffiliateOffer> {
  const lineAccountId = input.lineAccountId ?? null;
  if (input.operationId) {
    const existing = await findAffiliateOfferByOperationId(db, lineAccountId, input.operationId);
    if (existing) return existing;
  }

  const folderId=await readFolderAssignment(db,'affiliate_offer',lineAccountId,input.folderId);
  const id = crypto.randomUUID();
  const now = jstNow();
  if (!input.mileageProgramId || input.mileageProgramId === 'default') {
    await ensureDefaultMileageProgram(db);
  }

  try {
    await db
      .prepare(
        `INSERT INTO affiliate_offers
           (id, name, description, reward_amount, reward_miles, mileage_program_id,
            line_account_id, tag_id, scenario_id, is_active, created_at, operation_id, folder_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name,
        input.description ?? null,
        input.rewardAmount ?? 0,
        input.rewardMiles ?? 0,
        input.mileageProgramId ?? 'default',
        lineAccountId,
        input.tagId ?? null,
        input.scenarioId ?? null,
        input.isActive === false ? 0 : 1,
        now,
        input.operationId ?? null,
        folderId ?? null,
      )
      .run();
  } catch (err) {
    // A concurrent retry of the same operationId won the race; recover its row.
    if (input.operationId && isOperationIdConflict(err)) {
      const winner = await findAffiliateOfferByOperationId(db, lineAccountId, input.operationId);
      if (winner) return winner;
    }
    throw err;
  }

  return (await getAffiliateOfferById(db, id))!;
}

export async function getAffiliateOfferById(
  db: D1Database,
  id: string,
): Promise<AffiliateOffer | null> {
  return db
    .prepare(`SELECT * FROM affiliate_offers WHERE id = ?`)
    .bind(id)
    .first<AffiliateOffer>();
}

export async function listAffiliateOffers(
  db: D1Database,
  opts: {
    activeOnly?: boolean;
    lineAccountIds?: string[];
    includeUnassigned?: boolean;
  } = {},
): Promise<AffiliateOffer[]> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (opts.activeOnly) conditions.push('is_active = 1');
  if (opts.lineAccountIds) {
    const accountParts: string[] = [];
    if (opts.lineAccountIds.length > 0) {
      accountParts.push(`line_account_id IN (${sqlIdSet(opts.lineAccountIds).sql})`);
      binds.push(...(opts.lineAccountIds.length ? sqlIdSet(opts.lineAccountIds).binds : []));
    }
    if (opts.includeUnassigned) accountParts.push('line_account_id IS NULL');
    conditions.push(`(${accountParts.join(' OR ') || '0 = 1'})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM affiliate_offers ${where} ORDER BY created_at DESC`)
    .bind(...binds)
    .all<AffiliateOffer>();
  return result.results;
}

export type UpdateAffiliateOfferInput = Partial<
  Pick<
    AffiliateOffer,
    | 'name'
    | 'description'
    | 'reward_amount'
    | 'reward_miles'
    | 'mileage_program_id'
    | 'line_account_id'
    | 'tag_id'
    | 'scenario_id'
    | 'is_active'
    | 'folder_id'
  >
>;

export async function updateAffiliateOffer(
  db: D1Database,
  id: string,
  updates: UpdateAffiliateOfferInput,
): Promise<AffiliateOffer | null> {
  const current=await getAffiliateOfferById(db,id);if(!current)return null;
  const folderId=await readFolderAssignment(db,'affiliate_offer',updates.line_account_id===undefined?current.line_account_id:updates.line_account_id,updates.folder_id===undefined?current.folder_id:updates.folder_id);
  if(updates.folder_id!==undefined)updates={...updates,folder_id:folderId};
  const fields: string[] = [];
  const values: unknown[] = [];

  const set = (col: keyof UpdateAffiliateOfferInput) => {
    if (updates[col] !== undefined) {
      fields.push(`${col} = ?`);
      values.push(updates[col]);
    }
  };
  set('folder_id');
  set('name');
  set('description');
  set('reward_amount');
  set('reward_miles');
  set('mileage_program_id');
  set('line_account_id');
  set('tag_id');
  set('scenario_id');
  set('is_active');

  if (fields.length === 0) return getAffiliateOfferById(db, id);

  values.push(id);
  await db
    .prepare(`UPDATE affiliate_offers SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return getAffiliateOfferById(db, id);
}

// ── enroll (idempotent per affiliate×offer) ────────────────────────────────

export interface EnrollAffiliateInOfferInput {
  affiliateId: string;
  offerId: string;
}

/**
 * Enroll an affiliate in an offer, returning their offer-scoped link.
 *
 * Idempotent: if the affiliate already has a link for this offer, that link is
 * returned unchanged (`existing: true`). Otherwise a fresh link is issued with
 * offer_id set and label = offer.name (`existing: false`).
 *
 * There is no (affiliate_id, offer_id) UNIQUE constraint, so this uses the same
 * read-then-create + re-check pattern as the self-register endpoint (single LIFF
 * user operating on their own affiliate, so concurrent double-enroll is not a
 * concern in practice). The post-create re-check collapses a rare race to the
 * earliest-created row.
 */
export async function enrollAffiliateInOffer(
  db: D1Database,
  input: EnrollAffiliateInOfferInput,
): Promise<{ link: AffiliateLink; existing: boolean }> {
  const offer = await getAffiliateOfferById(db, input.offerId);
  if (!offer) throw new Error('offer not found');
  const affiliate = await db.prepare(`SELECT line_account_id FROM affiliates WHERE id = ?`)
    .bind(input.affiliateId)
    .first<{ line_account_id: string | null }>();
  if (!affiliate || affiliate.line_account_id !== offer.line_account_id) {
    throw new Error('affiliate offer account mismatch');
  }
  const existing = await findOfferLink(
    db,
    input.affiliateId,
    input.offerId,
    affiliate.line_account_id,
  );
  if (existing) return { link: existing, existing: true };

  const created = await createAffiliateLink(db, {
    affiliateId: input.affiliateId,
    label: offer.name,
    lineAccountId: offer.line_account_id ?? null,
    offerId: input.offerId,
  });

  // Re-check for the earliest link in case a concurrent enroll created one first.
  const winner = await findOfferLink(
    db,
    input.affiliateId,
    input.offerId,
    affiliate.line_account_id,
  );
  if (winner && winner.id !== created.id) {
    return { link: winner, existing: true };
  }
  return { link: created, existing: false };
}

async function findOfferLink(
  db: D1Database,
  affiliateId: string,
  offerId: string,
  lineAccountId: string | null,
): Promise<AffiliateLink | null> {
  return db
    .prepare(
      `SELECT * FROM affiliate_links
        WHERE affiliate_id = ? AND offer_id = ? AND line_account_id IS ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    )
    .bind(affiliateId, offerId, lineAccountId)
    .first<AffiliateLink>();
}

// ── approval ───────────────────────────────────────────────────────────────

/**
 * Approve or reject an affiliate-attributed conversion event.
 *
 * Only affiliate-attributed rows (affiliate_id IS NOT NULL) are meaningful; the
 * UPDATE is guarded on that so non-attributed rows never gain a status. Stamps
 * approved_at with the decision time (for both approve and reject).
 *
 * The WHERE clause includes `approval_status IS NULL OR approval_status != ?`
 * so re-setting the same status is a no-op (changes = 0) — this prevents
 * double-approval notifications when an admin double-clicks.
 *
 * @returns
 *   - `true`          — row was updated (status changed)
 *   - `'already_set'` — row exists and attributed but status was already this value
 *   - `false`         — row not found or not affiliate-attributed
 */
export async function setConversionApproval(
  db: D1Database,
  eventId: string,
  status: 'approved' | 'rejected',
): Promise<boolean | 'already_set'> {
  const now = jstNow();
  // 版管理下の案件なのに記録時刻の版が無い成果を
  // 承認すると現在額で固まるため、状態を変えずに拒む（false）。通すときは
  // 判断時の根拠を凍結・計算へそのまま渡し、間の割り込みでずらさない。
  // 承認済みの再送による修復は従来どおり通す。
  let flipBasis: ApprovalRewardBasis | null | undefined;
  if (status === 'approved') {
    const current = await db
      .prepare(
        `SELECT approval_status FROM conversion_events WHERE id = ? AND affiliate_id IS NOT NULL`,
      )
      .bind(eventId)
      .first<{ approval_status: string | null }>();
    if (current && current.approval_status !== 'approved') {
      flipBasis = await resolveApprovalRewardBasis(db, eventId);
      if (flipBasis === null) return false;
    }
  }
  const hasRevision = await hasConversionApprovalRevision(db);
  const result = await db
    .prepare(
      `UPDATE conversion_events
          SET approval_status = ?, approved_at = ?${hasRevision ? ', approval_revision = approval_revision + 1' : ''}
        WHERE id = ? AND affiliate_id IS NOT NULL
          AND (approval_status IS NULL OR approval_status != ?)`,
    )
    .bind(status, now, eventId, status)
    .run();
  if ((result.meta?.changes ?? 0) > 0) {
    // 承認が通ったら計算根拠の版を作る。承認後・締め前の設定編集で
    // 金額/条件/対象が変わらないようにする。曖昧な行は版を作らずnullで
    // 終える(版が無い行は締め・支払い・レポートで0として扱う)。
    // 版の書き込みが落ちた場合は再試行(already_set側)で修復する。
    // 版より先に承認時の金額・マイルを凍結する。
    // 締め後の却下→再承認では取り消し済みの確定を戻す。
    // 判断時の根拠をそのまま渡し、間の割り込みでずらさない。
    if (status === 'approved') await freezeConversionApproval(db, eventId, flipBasis);
    if (status === 'approved') await ensureConversionRewardSnapshot(db, eventId, now, flipBasis);
    if (status === 'approved') await restoreSettledRewardOnReapproval(db, eventId);
    // 確定済みの成果を取り消したときは、確定を消さずに同額の反対仕訳を起こす。
    // 締めの記録はそのまま残し、支払いの確定済みだけが相殺される。
    if (status === 'rejected') await reverseSettledRewardOnRejection(db, eventId, now);
    return true;
  }

  // Distinguish no-op (same status already set) from truly missing/non-attributed.
  const existing = await db
    .prepare(
      `SELECT 1 FROM conversion_events WHERE id = ? AND affiliate_id IS NOT NULL AND approval_status = ?`,
    )
    .bind(eventId, status)
    .first<{ 1: number }>();
  if (!existing) return false;
  // 二重押しの再試行は承認済みの修復にも使う: 承認だけ通って版が無い
  // 行があればここで作る(締めは版優先のため、版が無いと後編集で金額が動く)。
  // 凍結が無ければここで埋め直し、版の修復は凍結値を優先する。
  // 復活の戻し忘れもここで修復する（再送では何も起きない）。
  if (status === 'approved') await freezeConversionApproval(db, eventId);
  if (status === 'approved') await ensureConversionRewardSnapshot(db, eventId, now);
  if (status === 'approved') await restoreSettledRewardOnReapproval(db, eventId);
  // 取消の再試行も同じく修復に使う: 取消だけ通って反対仕訳が無い行を起票する。
  if (status === 'rejected') await reverseSettledRewardOnRejection(db, eventId, now);
  return 'already_set';
}

/**
 * 承認した時点の金額・マイルの凍結。
 *
 * 承認の UPDATE が通った直後に、その時点で見える計算入力（率/基準額/
 * 固定額・版の固定を優先）とマイル数を conversion_events の列へ写す。
 * 列は初回だけ埋める（COALESCE の先勝ち）。再試行・締め・通知は凍結値を
 * 優先するため、承認後の設定変更で過去の承認額が動かない。
 * 却下では凍結しない（却下→再承認は新しい承認としてその時点で凍結する）。
 */
export interface ApprovalFreezeInputs {
  formula: 'rate' | 'fixed';
  commissionRate: number | null;
  baseAmount: number | null;
  fixedReward: number | null;
  amountMinor: number;
  rewardMiles: number;
}

async function readApprovalFreezeInputs(
  db: D1Database,
  eventId: string,
  /**
   * 承認判断時に確定した根拠。渡されたときは再解決せず同じ値を使う
   * 省略時はその場で確かめ直す。
   */
  basisOverride?: ApprovalRewardBasis | null,
): Promise<ApprovalFreezeInputs | null> {
  const hasVersionTables = (await dbTableExists(db, 'affiliate_offer_versions'))
    && (await dbTableExists(db, 'affiliate_attribution_decisions'));
  const versionRewardSelect = hasVersionTables
    ? 'ov.reward_amount AS version_reward, ov.reward_miles AS version_miles'
    : 'NULL AS version_reward, NULL AS version_miles';
  const versionJoins = hasVersionTables
    ? `LEFT JOIN affiliate_attribution_decisions dad
         ON dad.conversion_event_id = ce.id
       LEFT JOIN affiliate_offer_versions ov ON ov.id = dad.offer_version_id`
    : '';
  const row = await db.prepare(
    `SELECT a.commission_rate AS commission_rate,
            a.reward_mode AS reward_mode,
            ce.value_snapshot AS value_snapshot,
            cp.value AS point_value,
            ${versionRewardSelect},
            off.reward_amount AS offer_reward,
            off.reward_miles AS offer_miles
       FROM conversion_events ce
       JOIN affiliates a ON a.id = ce.affiliate_id
       LEFT JOIN conversion_points cp ON cp.id = ce.conversion_point_id
       LEFT JOIN affiliate_links al
         ON al.ref_code = ce.attributed_ref_code
        AND al.affiliate_id = a.id
       LEFT JOIN affiliate_offers off ON off.id = al.offer_id
       ${versionJoins}
      WHERE ce.id = ?
        AND ce.affiliate_id IS NOT NULL
        AND COALESCE(ce.approval_status, 'pending') = 'approved'`,
  ).bind(eventId).first<{
    commission_rate: number | null;
    reward_mode: 'none' | 'fixed' | 'rate' | null;
    value_snapshot: number | null;
    point_value: number | null;
    version_reward: number | null;
    version_miles: number | null;
    offer_reward: number | null;
    offer_miles: number | null;
  }>();
  if (!row) return null;
  // 固定額・マイルの出どころ。判断の版があればその値。判断が無い行は
  // 記録時刻の版で旧額を保つ。版管理下で記録時刻の版が無いときは凍結
  // しない（null で返し、呼び出し側は承認自体を拒む）。
  if (row.reward_mode === 'none') {
    return { formula: 'fixed', commissionRate: null, baseAmount: null, fixedReward: 0, amountMinor: 0, rewardMiles: 0 };
  }
  let fixedSource: number;
  let milesSource: number;
  if (hasVersionTables
    && row.version_reward !== null && row.version_reward !== undefined) {
    fixedSource = Number(row.version_reward);
    milesSource = Number(row.version_miles ?? 0);
  } else if (!hasVersionTables) {
    fixedSource = Number(row.offer_reward ?? 0);
    milesSource = Number(row.offer_miles ?? 0);
  } else {
    const basis = basisOverride !== undefined
      ? basisOverride
      : await resolveApprovalRewardBasis(db, eventId);
    if (basis === null) return null;
    if (basis.kind === 'version') {
      fixedSource = basis.version.rewardAmount;
      milesSource = basis.version.rewardMiles;
    } else {
      fixedSource = Number(basis.rewardAmount ?? row.offer_reward ?? 0);
      milesSource = Number(basis.rewardMiles ?? row.offer_miles ?? 0);
    }
  }
  const rate = row.commission_rate === null ? 0 : Number(row.commission_rate);
  const formula: 'rate' | 'fixed' = row.reward_mode === 'rate' || (row.reward_mode == null && rate > 0) ? 'rate' : 'fixed';
  const baseAmount = formula === 'rate' ? Number(row.value_snapshot ?? row.point_value ?? 0) : null;
  const fixedReward = formula === 'fixed' ? Math.round(fixedSource) : null;
  return {
    formula,
    commissionRate: formula === 'rate' ? rate : null,
    baseAmount,
    fixedReward,
    amountMinor: formula === 'rate' ? Math.round(baseAmount! * rate / 100) : fixedReward!,
    rewardMiles: Math.max(0, Math.round(milesSource)),
  };
}

/**
 * 承認時の金額・マイルを成果行へ凍結する。列が埋まっていれば何もしない
 * （初回承認の値が正本）。凍結に失敗しても承認自体は通す — 呼び出し側で
 * 投げ直さないこと（再試行の already_set 側で埋め直す）。
 */
export async function freezeConversionApproval(
  db: D1Database,
  eventId: string,
  basisOverride?: ApprovalRewardBasis | null,
): Promise<void> {
  try {
    const inputs = await readApprovalFreezeInputs(db, eventId, basisOverride);
    if (!inputs) return;
    await db.prepare(
      `UPDATE conversion_events
          SET approval_amount_minor = COALESCE(approval_amount_minor, ?),
              approval_formula = COALESCE(approval_formula, ?),
              approval_commission_rate = COALESCE(approval_commission_rate, ?),
              approval_base_amount = COALESCE(approval_base_amount, ?),
              approval_fixed_reward = COALESCE(approval_fixed_reward, ?),
              approval_reward_miles = COALESCE(approval_reward_miles, ?)
        WHERE id = ?`,
    ).bind(
      inputs.amountMinor, inputs.formula, inputs.commissionRate, inputs.baseAmount,
      inputs.fixedReward, inputs.rewardMiles, eventId,
    ).run();
  } catch (error) {
    logger.error("src_affiliate_offers_failed");
  }
}

/**
 * 承認通知の送信記録。
 *
 * 承認状態（updated/already_set）と通知の送信状態を分ける。同じ承認世代
 * （approved_at）の通知は1回だけ送り、再試行の修復で欠けた通知だけ送る。
 */
export interface ApprovalNotificationState {
  /** この承認世代の通知を送ってよいか。 */
  send: boolean;
  /** 現在の承認世代。未承認の行は null。 */
  approvedAt: string | null;
}

export async function getApprovalNotificationState(
  db: D1Database,
  eventId: string,
): Promise<ApprovalNotificationState> {
  const row = await db.prepare(
    `SELECT approved_at, approval_notified_generation
       FROM conversion_events WHERE id = ?`,
  ).bind(eventId).first<{ approved_at: string | null; approval_notified_generation: string | null }>();
  if (!row || !row.approved_at) return { send: false, approvedAt: row?.approved_at ?? null };
  return { send: row.approval_notified_generation !== row.approved_at, approvedAt: row.approved_at };
}

/**
 * 通知を送った記録を残す。別の走者が先に記録していたら false を返す
 * （送った側だけが true。二重送信の抑止に使う）。
 */
export async function markApprovalNotified(
  db: D1Database,
  eventId: string,
  approvedAt: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE conversion_events
        SET approval_notified_generation = ?
      WHERE id = ?
        AND approved_at IS ?
        AND (approval_notified_generation IS NULL OR approval_notified_generation != ?)`,
  ).bind(approvedAt, eventId, approvedAt, approvedAt).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 送信権の解放。送信の途中で落ちたとき、同じ承認世代の
 * 記録だけを NULL に戻し、再試行で送り直せるようにする（欠落防止）。
 * 世代が変わっていたら（却下→再承認の新しい世代）何もしない。
 */
export async function releaseApprovalNotification(
  db: D1Database,
  eventId: string,
  approvedAt: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE conversion_events
        SET approval_notified_generation = NULL
      WHERE id = ?
        AND approved_at IS ?
        AND approval_notified_generation IS ?`,
  ).bind(eventId, approvedAt, approvedAt).run();
  return (result.meta?.changes ?? 0) > 0;
}

export type ApprovalDecisionStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalDecisionResult {
  outcome: 'updated' | 'already_set' | 'conflict' | 'not_found' | 'unbillable';
  /** 判断時点の状態。NULLは未判断(pending)として返す。 */
  currentStatus: ApprovalDecisionStatus;
}

/**
 * 期待した状態付きで成果を承認・却下する。
 *
 * conversion_eventsに版列は無いため、版の代わりに「いま見えている状態」
 * そのものをCASの比較対象にする。UPDATEのWHEREへ期待状態を埋め込むので、
 * 同じ未判断を見た2主体の同時承認・同時却下は片方だけが通り、もう片方は
 * 上書きせずconflictになる。同じ判断の再送はalready_setで冪等に扱う。
 */
export async function decideConversionApproval(
  db: D1Database,
  eventId: string,
  status: 'approved' | 'rejected',
  expectedStatus: ApprovalDecisionStatus,
): Promise<ApprovalDecisionResult> {
  const now = jstNow();
  // 期待状態と求める判断が同じときは書き換えが無いのでUPDATEを撃たない。
  // 読み直し側でalready_set（修復付き）かconflictに振り分ける。こうしないと
  // 同じ判断の再送が「変更1件」になり、反対仕訳などを二重に起こしてしまう。
  if (expectedStatus !== status) {
    // 版管理下の案件なのに記録時刻の版が無い成果は、
    // 承認すると現在額で固まるため、状態を変えず unbillable で返す。通す
    // ときは判断時の根拠を凍結・計算へそのまま渡し、間の割り込みでずらさ
    // ない。却下は金額を固めないので従来どおり通す。
    let flipBasis: ApprovalRewardBasis | null | undefined;
    if (status === 'approved') {
      flipBasis = await resolveApprovalRewardBasis(db, eventId);
      if (flipBasis === null) {
        const currentRow = await db
          .prepare(
            `SELECT approval_status FROM conversion_events WHERE id = ? AND affiliate_id IS NOT NULL`,
          )
          .bind(eventId)
          .first<{ approval_status: string | null }>();
        const unbillableCurrent: ApprovalDecisionStatus = currentRow?.approval_status === 'approved'
          || currentRow?.approval_status === 'rejected'
          ? currentRow.approval_status
          : 'pending';
        return { outcome: 'unbillable', currentStatus: unbillableCurrent };
      }
    }
    const expectedSql = expectedStatus === 'pending'
      ? `(approval_status IS NULL OR approval_status = 'pending')`
      : `approval_status = ?`;
    const expectedBinds = expectedStatus === 'pending' ? [] : [expectedStatus];
    const hasRevision = await hasConversionApprovalRevision(db);
    const result = await db
      .prepare(
        `UPDATE conversion_events
            SET approval_status = ?, approved_at = ?${hasRevision ? ', approval_revision = approval_revision + 1' : ''}
          WHERE id = ? AND affiliate_id IS NOT NULL AND ${expectedSql}`,
      )
      .bind(status, now, eventId, ...expectedBinds)
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      // 版より先に承認時の金額・マイルを凍結する。
      // 判断時の根拠をそのまま渡し、間の割り込みでずらさない。
      if (status === 'approved') await freezeConversionApproval(db, eventId, flipBasis);
      if (status === 'approved') await ensureConversionRewardSnapshot(db, eventId, now, flipBasis);
      // 締め後の却下→再承認では取り消し済みの確定を戻す。
      if (status === 'approved') await restoreSettledRewardOnReapproval(db, eventId);
      if (status === 'rejected') await reverseSettledRewardOnRejection(db, eventId, now);
      return { outcome: 'updated', currentStatus: status };
    }
  }

  const row = await db
    .prepare(
      `SELECT approval_status FROM conversion_events WHERE id = ? AND affiliate_id IS NOT NULL`,
    )
    .bind(eventId)
    .first<{ approval_status: string | null }>();
  if (!row) return { outcome: 'not_found', currentStatus: 'pending' };
  const current: ApprovalDecisionStatus = row.approval_status === 'approved' || row.approval_status === 'rejected'
    ? row.approval_status
    : 'pending';
  if (current === status) {
    // 同じ判断の再送は冪等成功にし、版・反対仕訳の欠落だけ修復する。
    // 凍結が無ければここで埋め直し、版の修復は凍結値を優先する。
    // 復活の戻し忘れもここで修復する（再送では何も起きない）。
    if (status === 'approved') await freezeConversionApproval(db, eventId);
    if (status === 'approved') await ensureConversionRewardSnapshot(db, eventId, now);
    if (status === 'approved') await restoreSettledRewardOnReapproval(db, eventId);
    if (status === 'rejected') await reverseSettledRewardOnRejection(db, eventId, now);
    return { outcome: 'already_set', currentStatus: current };
  }
  return { outcome: 'conflict', currentStatus: current };
}

/**
 * 承認確定時に走らせる案件の動作（タグ付与・シナリオ開始）の実行計画。
 *
 * 案件に設定された参照は「案件と同じLINEアカウントで、いま有効なもの」だけを
 * 実行してよい。保存時の検査 (offerReferenceError) をすり抜けた古い参照や、
 * あとから停止・アーカイブ・削除された参照が残っていることがあるため、
 * 実行時にもここで同じ条件を掛け直す。案件の所属が NULL の古い行は
 * 「どのアカウントのものか」を確認できないので、どの参照も実行しない。
 */
export interface ConversionOfferActionPlan {
  eventId: string;
  /** 成果を出した友だち。タグ・シナリオはこの人へ効く。 */
  friendId: string;
  offerId: string;
  offerName: string;
  offerAccountId: string | null;
  /** 案件に設定されたタグID。未設定は null。 */
  tagId: string | null;
  /** tagId が実行してよい参照か（存在・同じアカウント・active）。 */
  tagExecutable: boolean;
  /** 案件に設定されたシナリオID。未設定は null。 */
  scenarioId: string | null;
  /** scenarioId が実行してよい参照か（存在・同じアカウント・有効）。 */
  scenarioExecutable: boolean;
}

/**
 * 帰属成果が通ったリンクの案件を引き、設定された動作の実行可否まで返す。
 *
 * リンクの紐づけは attributed_ref_code に加えて affiliate_id も条件に入れる
 * （ref_code はグローバル UNIQUE だが、帰属した紹介者本人のリンク以外の
 * 案件を誤って拾わないための二重の守り）。
 *
 * 成果が無い・帰属でない・案件を結んでいないリンク経由のときは null。
 * 停止中(is_active=0)の案件も null を返す — 承認自体は「すでに起きた成果」への
 * 判断として通すが、止めた案件の付帯動作は新たに実行しない。案件を動かし
 * 直したあとに承認を再送すれば、already_set 経路で動作だけを走り直せる。
 */
export async function getConversionOfferActionPlan(
  db: D1Database,
  eventId: string,
): Promise<ConversionOfferActionPlan | null> {
  const row = await db
    .prepare(
      `SELECT ce.id AS event_id,
              ce.friend_id AS friend_id,
              off.id AS offer_id,
              off.name AS offer_name,
              off.line_account_id AS offer_account_id,
              off.tag_id AS tag_id,
              off.scenario_id AS scenario_id,
              CASE WHEN off.tag_id IS NOT NULL AND t.id IS NOT NULL
                    AND t.status = 'active' AND t.line_account_id = off.line_account_id
                   THEN 1 ELSE 0 END AS tag_executable,
              CASE WHEN off.scenario_id IS NOT NULL AND s.id IS NOT NULL
                    AND s.is_active = 1 AND s.line_account_id = off.line_account_id
                   THEN 1 ELSE 0 END AS scenario_executable
         FROM conversion_events ce
         JOIN affiliate_links al
           ON al.ref_code = ce.attributed_ref_code
          AND al.affiliate_id = ce.affiliate_id
         JOIN affiliate_offers off ON off.id = al.offer_id
         LEFT JOIN tags t ON t.id = off.tag_id
         LEFT JOIN scenarios s ON s.id = off.scenario_id
        WHERE ce.id = ? AND ce.affiliate_id IS NOT NULL
          AND off.is_active = 1`,
    )
    .bind(eventId)
    .first<{
      event_id: string;
      friend_id: string;
      offer_id: string;
      offer_name: string;
      offer_account_id: string | null;
      tag_id: string | null;
      scenario_id: string | null;
      tag_executable: number;
      scenario_executable: number;
    }>();
  if (!row) return null;
  return {
    eventId: row.event_id,
    friendId: row.friend_id,
    offerId: row.offer_id,
    offerName: row.offer_name,
    offerAccountId: row.offer_account_id,
    tagId: row.tag_id,
    tagExecutable: row.tag_executable === 1,
    scenarioId: row.scenario_id,
    scenarioExecutable: row.scenario_executable === 1,
  };
}

/** Resolved attribution detail for an affiliate-attributed conversion event. */
export interface ConversionApprovalNotifyInfo {
  affiliateId: string;
  /** Offer name resolved via attributed_ref_code → link.offer_id, or null. */
  offerName: string | null;
  /** 確定した報酬額（計算版を優先し、無ければ案件の設定額）。 */
  rewardAmount: number;
  /** 紹介者の「成果の通知を受け取る」設定。false のとき送信しない。 */
  notifyOnConversion: boolean;
}

/**
 * Fetch the info needed to push an approval notification to the attributed
 * affiliate: the affiliate id, and (via attributed_ref_code → affiliate_link →
 * offer) the offer name + fixed reward amount.
 *
 * Returns null when the event is missing or not affiliate-attributed. When the
 * attribution is offer-less (generic link), `offerName` is null and
 * `rewardAmount` is 0.
 */
export async function getConversionApprovalNotifyInfo(
  db: D1Database,
  eventId: string,
): Promise<ConversionApprovalNotifyInfo | null> {
  const row = await db
    .prepare(
      /*
       * - 紹介者の通知設定(notify_on_conversion)を一緒に取る。呼び出し側は
       *   0 のとき送信処理へ進まない。
       * - 通知の額は案件の設定額ではなく、承認時に固定された計算版の
       *   報酬額を優先する(率の案件で設定額を見せないため)。
       */
      `SELECT ce.affiliate_id AS affiliate_id,
              off.name AS offer_name,
              ce.approval_amount_minor AS frozen_reward_amount,
              off.reward_amount AS offer_reward_amount,
              (SELECT calc.amount_minor
                 FROM affiliate_reward_calculations calc
                WHERE calc.conversion_event_id = ce.id
                  AND calc.affiliate_id = ce.affiliate_id
                  AND calc.formula IN ('rate', 'fixed')
                ORDER BY calc.id DESC LIMIT 1) AS calculated_reward_amount,
              (SELECT a.notify_on_conversion
                 FROM affiliates a WHERE a.id = ce.affiliate_id) AS notify_on_conversion
         FROM conversion_events ce
         LEFT JOIN affiliate_links al ON al.ref_code = ce.attributed_ref_code
         LEFT JOIN affiliate_offers off ON off.id = al.offer_id
        WHERE ce.id = ? AND ce.affiliate_id IS NOT NULL`,
    )
    .bind(eventId)
    .first<{
      affiliate_id: string;
      offer_name: string | null;
      frozen_reward_amount: number | null;
      offer_reward_amount: number | null;
      calculated_reward_amount: number | null;
      notify_on_conversion: number | null;
    }>();
  if (!row) return null;
  return {
    affiliateId: row.affiliate_id,
    offerName: row.offer_name,
    // 版が無い(保存失敗後)ときは凍結した承認時金額を使い、
    // 変更後の案件額を見せない。凍結も無ければ従来どおり案件額。
    rewardAmount: row.calculated_reward_amount
      ?? (row.frozen_reward_amount === null || row.frozen_reward_amount === undefined
        ? row.offer_reward_amount
        : Number(row.frozen_reward_amount))
      ?? 0,
    notifyOnConversion: row.notify_on_conversion !== 0,
  };
}

// =============================================================================
// Affiliate Offer Versions — 案件の決まりの版
// =============================================================================
//
// 保存するたびに1行足す。前の版は変えない。「この版に戻す」は中身で新しい版を作る。
// 数える期間の既定は 30 日。上限・受付の期間を持つ。

/** 案件の版に持つ数える期間の既定(日)。汎用リンクの 90 日(legacy)とは別。 */
export const OFFER_ATTRIBUTION_WINDOW_DEFAULT = 30;

export interface AffiliateOfferVersion {
  id: string;
  offer_id: string;
  version_number: number;
  reward_amount: number;
  reward_miles: number;
  window_days: number;
  cap_total: number | null;
  cap_monthly_per_affiliate: number | null;
  reception_from: string | null;
  reception_to: string | null;
  effective_from: string | null;
  created_by_staff_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface CreateOfferVersionInput {
  offerId: string;
  rewardAmount?: number;
  rewardMiles?: number;
  /** 1〜365。省略時は前の版を引き継ぎ、初版は 30。 */
  windowDays?: number;
  /** 正の整数または null(上限なし)。 */
  capTotal?: number | null;
  capMonthlyPerAffiliate?: number | null;
  receptionFrom?: string | null;
  receptionTo?: string | null;
  effectiveFrom?: string | null;
  createdBy?: string | null;
  /** 同じ確認キーの再送では版を増やさない。 */
  idempotencyKey?: string | null;
}

function isValidWindowDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365;
}

function isValidCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** その案件の今の版(番号が最大の行)。版が無い古い案件は null。 */
export async function getCurrentOfferVersion(
  db: D1Database,
  offerId: string,
): Promise<AffiliateOfferVersion | null> {
  return db
    .prepare(
      `SELECT * FROM affiliate_offer_versions WHERE offer_id = ? ORDER BY version_number DESC LIMIT 1`,
    )
    .bind(offerId)
    .first<AffiliateOfferVersion>();
}

export async function listOfferVersions(
  db: D1Database,
  offerId: string,
): Promise<AffiliateOfferVersion[]> {
  const result = await db
    .prepare(
      `SELECT * FROM affiliate_offer_versions WHERE offer_id = ? ORDER BY version_number DESC`,
    )
    .bind(offerId)
    .all<AffiliateOfferVersion>();
  return result.results;
}

async function findOfferVersionByIdempotencyKey(
  db: D1Database,
  offerId: string,
  idempotencyKey: string,
): Promise<AffiliateOfferVersion | null> {
  return db
    .prepare(
      `SELECT * FROM affiliate_offer_versions WHERE offer_id = ? AND idempotency_key = ?`,
    )
    .bind(offerId, idempotencyKey)
    .first<AffiliateOfferVersion>();
}

/**
 * 案件の決まりの新しい版を作る。前の版は変えない。
 * 同じ確認キーの再送は最初の版を返す(二重に版を増やさない)。
 */
export async function createOfferVersion(
  db: D1Database,
  input: CreateOfferVersionInput,
): Promise<AffiliateOfferVersion> {
  if (input.idempotencyKey) {
    const existing = await findOfferVersionByIdempotencyKey(db, input.offerId, input.idempotencyKey);
    if (existing) return existing;
  }
  const offer = await getAffiliateOfferById(db, input.offerId);
  if (!offer) throw new Error('offer not found');
  if (input.windowDays !== undefined && !isValidWindowDays(input.windowDays)) {
    throw new Error('windowDays must be an integer between 1 and 365');
  }
  for (const cap of [input.capTotal, input.capMonthlyPerAffiliate]) {
    if (cap !== undefined && cap !== null && !isValidCap(cap)) {
      throw new Error('cap must be a positive integer or null');
    }
  }
  const current = await getCurrentOfferVersion(db, input.offerId);
  const id = crypto.randomUUID();
  const now = jstNow();
  const row: AffiliateOfferVersion = {
    id,
    offer_id: input.offerId,
    version_number: (current?.version_number ?? 0) + 1,
    reward_amount: input.rewardAmount ?? current?.reward_amount ?? offer.reward_amount,
    reward_miles: input.rewardMiles ?? current?.reward_miles ?? offer.reward_miles,
    window_days: input.windowDays
      ?? current?.window_days
      ?? OFFER_ATTRIBUTION_WINDOW_DEFAULT,
    cap_total: input.capTotal !== undefined ? input.capTotal : (current?.cap_total ?? null),
    cap_monthly_per_affiliate: input.capMonthlyPerAffiliate !== undefined
      ? input.capMonthlyPerAffiliate
      : (current?.cap_monthly_per_affiliate ?? null),
    reception_from: input.receptionFrom !== undefined ? input.receptionFrom : (current?.reception_from ?? null),
    reception_to: input.receptionTo !== undefined ? input.receptionTo : (current?.reception_to ?? null),
    effective_from: input.effectiveFrom !== undefined ? input.effectiveFrom : null,
    created_by_staff_id: input.createdBy ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    created_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO affiliate_offer_versions
           (id, offer_id, version_number, reward_amount, reward_miles, window_days,
            cap_total, cap_monthly_per_affiliate, reception_from, reception_to,
            effective_from, created_by_staff_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id, row.offer_id, row.version_number, row.reward_amount, row.reward_miles,
        row.window_days, row.cap_total, row.cap_monthly_per_affiliate,
        row.reception_from, row.reception_to, row.effective_from,
        row.created_by_staff_id, row.idempotency_key, row.created_at,
      )
      .run();
  } catch (err) {
    // 同じ確認キーの同時再送は片方だけが通り、もう片方は最初の版を拾う。
    if (input.idempotencyKey) {
      const winner = await findOfferVersionByIdempotencyKey(db, input.offerId, input.idempotencyKey);
      if (winner) return winner;
    }
    throw err;
  }
  return row;
}

// ── 上限の使用状況 ─────────────────────────────────────────────────────────

/**
 * 日本時間の月の区切りを ISO 文字列で返す。SQLite 側は julianday で
 * 時刻として比べる(文字列の形に依存しないため。affiliate-attribution 参照)。
 */
export function jstMonthRange(at?: string): { start: string; end: string } {
  const base = at ? new Date(at) : new Date();
  const jst = japanCalendar(base);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${year}-${pad(month + 1)}-01T00:00:00+09:00`;
  const next = new Date(Date.UTC(year, month + 1, 1) - 9 * 60 * 60 * 1000);
  const end = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T00:00:00+09:00`;
  return { start, end };
}

export interface OfferCapStatus {
  /** 上限に達して受付が止まっているか。 */
  capped: boolean;
  /** 案件全体の上限・使用数・残り。空は「上限なし」。 */
  capTotal: number | null;
  totalUsed: number;
  totalRemaining: number | null;
  /** 1人あたり月の上限・その人の今月の使用数・残り。空は「上限なし」。 */
  capMonthlyPerAffiliate: number | null;
  monthlyUsed: number;
  monthlyRemaining: number | null;
}

/**
 * 案件の上限の使用状況。上限に達したら受付を自動で止める判断に使う。
 * 数えるのは、その案件のリンクに付いた成果(conversion_events)の件数。
 */
export async function getOfferCapStatus(
  db: D1Database,
  offerId: string,
  opts?: { affiliateId?: string; at?: string },
): Promise<OfferCapStatus> {
  const version = await getCurrentOfferVersion(db, offerId);
  const capTotal = version?.cap_total ?? null;
  const capMonthly = version?.cap_monthly_per_affiliate ?? null;
  const at = opts?.at ?? jstNow();
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS used
         FROM conversion_events ce
         JOIN affiliate_links al ON al.ref_code = ce.attributed_ref_code
        WHERE al.offer_id = ? AND ce.affiliate_id IS NOT NULL`,
    )
    .bind(offerId)
    .first<{ used: number }>();
  const totalUsed = totalRow?.used ?? 0;
  let monthlyUsed = 0;
  if (opts?.affiliateId) {
    const { start, end } = jstMonthRange(at);
    const monthlyRow = await db
      .prepare(
        `SELECT COUNT(*) AS used
           FROM conversion_events ce
           JOIN affiliate_links al ON al.ref_code = ce.attributed_ref_code
          WHERE al.offer_id = ? AND ce.affiliate_id = ?
            AND julianday(ce.created_at) >= julianday(?)
            AND julianday(ce.created_at) < julianday(?)`,
      )
      .bind(offerId, opts.affiliateId, start, end)
      .first<{ used: number }>();
    monthlyUsed = monthlyRow?.used ?? 0;
  }
  const totalRemaining = capTotal == null ? null : Math.max(0, capTotal - totalUsed);
  const monthlyRemaining = capMonthly == null ? null : Math.max(0, capMonthly - monthlyUsed);
  return {
    capped: (totalRemaining !== null && totalRemaining <= 0)
      || (monthlyRemaining !== null && monthlyRemaining <= 0),
    capTotal,
    totalUsed,
    totalRemaining,
    capMonthlyPerAffiliate: capMonthly,
    monthlyUsed,
    monthlyRemaining,
  };
}
