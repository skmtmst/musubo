import { type MileageRewardSummary, type MileageRewardDraftInput } from './rewards-types.js';
import { MileageRewardError, validateMileageRewardDraft } from './rewards-validation.js';
import { requirePublishedActionVersion, getMileageReward } from './rewards-definitions-reads.js';


export async function createMileageRewardDraft(
  db: D1Database,
  input: { lineAccountId: string; programId?: string; createdBy?: string | null; draft: MileageRewardDraftInput },
): Promise<MileageRewardSummary> {
  const draft = validateMileageRewardDraft(input.draft);
  await requirePublishedActionVersion(db, input.lineAccountId, draft.commonActionVersionId);
  const rewardId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO mileage_rewards
         (id, line_account_id, program_id, name, description, image_url, reward_kind,
          status, current_draft_version_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    ).bind(
      rewardId, input.lineAccountId, input.programId ?? 'default', draft.name,
      draft.description, draft.imageUrl, draft.rewardKind === 'handgift' ? 'tag' : draft.rewardKind, versionId,
      input.createdBy ?? null, now, now,
    ),
    ...(draft.rewardKind === 'handgift' ? [db.prepare('INSERT INTO mileage_handgift_rewards(reward_id) VALUES (?)').bind(rewardId)] : []),
    db.prepare(
      `INSERT INTO mileage_reward_versions
         (id, reward_id, version_number, status, required_miles, stock_limit,
          per_friend_limit, starts_at, ends_at, benefit_expires_days,
          common_action_version_id, target_conditions, failure_policy, customer_message, created_by, created_at)
       VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId, rewardId, draft.requiredMiles, draft.stockLimit, draft.perFriendLimit,
      draft.startsAt, draft.endsAt, draft.benefitExpiresDays, draft.commonActionVersionId,
      draft.targetConditions ? JSON.stringify(draft.targetConditions) : null,
      draft.failurePolicy, draft.customerMessage, input.createdBy ?? null, now,
    ),
  ]);
  const created = await getMileageReward(db, { id: rewardId, lineAccountId: input.lineAccountId });
  if (!created) throw new MileageRewardError('create_failed', '使い道を作成できませんでした', 500);
  return created;
}

export async function updateMileageRewardDraft(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedVersionId: string;
    expectedRevision?: number | null;
    updatedBy?: string | null;
    draft: MileageRewardDraftInput;
  },
): Promise<MileageRewardSummary> {
  const draft = validateMileageRewardDraft(input.draft);
  await requirePublishedActionVersion(db, input.lineAccountId, draft.commonActionVersionId);
  const existingReward = await getMileageReward(db, { id: input.id, lineAccountId: input.lineAccountId });
  if (existingReward && ((existingReward.rewardKind === 'handgift') !== (draft.rewardKind === 'handgift'))) {
    throw new MileageRewardError('invalid_kind_change', '手渡し景品の種類は変更できません。新しい使い道を作ってください', 409);
  }
  // 書く前に所属と版IDを照合する。版のUPDATEだけ所属を見ない形にしない。
  // 読み込んだ更新番号と一致する保存だけ通す。
  const current = await db.prepare(
    `SELECT r.current_draft_version_id AS draft_version_id, v.revision AS revision
       FROM mileage_rewards r
       LEFT JOIN mileage_reward_versions v ON v.id = r.current_draft_version_id
      WHERE r.id = ? AND r.line_account_id = ?`,
  ).bind(input.id, input.lineAccountId).first<{ draft_version_id: string | null; revision: number | null }>();
  if (!current || current.draft_version_id !== input.expectedVersionId) {
    if (!current) throw new MileageRewardError('not_found', '使い道が見つかりません', 404);
    throw new MileageRewardError('version_conflict', 'ほかの人が先に変更しました。読み直してください', 409);
  }
  if (input.expectedRevision != null && current.revision !== input.expectedRevision) {
    throw new MileageRewardError('version_conflict', 'ほかの人が先に変更しました。読み直してください', 409);
  }
  const now = new Date().toISOString();
  // 両方のUPDATEに同じ所属・版・更新番号の条件を付け、片方だけ
  // 書き換わる部分更新を残さない。通るたびに更新番号を1つ増やす。
  const revisionGuard = input.expectedRevision != null ? ' AND v.revision = ?' : '';
  const revisionBinds: unknown[] = input.expectedRevision != null ? [input.expectedRevision] : [];
  const results = await db.batch([
    db.prepare(
      `UPDATE mileage_rewards
          SET name = ?, description = ?, image_url = ?, reward_kind = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND current_draft_version_id = ?
          AND EXISTS (
            SELECT 1 FROM mileage_reward_versions v
             WHERE v.id = ? AND v.reward_id = mileage_rewards.id AND v.status = 'draft'
             ${revisionGuard}
          )`,
    ).bind(
      draft.name, draft.description, draft.imageUrl, draft.rewardKind === 'handgift' ? 'tag' : draft.rewardKind, now,
      input.id, input.lineAccountId, input.expectedVersionId,
      input.expectedVersionId, ...revisionBinds,
    ),
    db.prepare(
      `UPDATE mileage_reward_versions
          SET required_miles = ?, stock_limit = ?, per_friend_limit = ?, starts_at = ?,
              ends_at = ?, benefit_expires_days = ?, common_action_version_id = ?,
              target_conditions = ?, failure_policy = ?, customer_message = ?, created_by = ?,
              revision = revision + 1
        WHERE id = ? AND reward_id = ? AND status = 'draft'
          ${input.expectedRevision != null ? ' AND revision = ?' : ''}
          AND EXISTS (
            SELECT 1 FROM mileage_rewards r
             WHERE r.id = mileage_reward_versions.reward_id AND r.line_account_id = ?
          )`,
    ).bind(
      draft.requiredMiles, draft.stockLimit, draft.perFriendLimit, draft.startsAt,
      draft.endsAt, draft.benefitExpiresDays, draft.commonActionVersionId,
      draft.targetConditions ? JSON.stringify(draft.targetConditions) : null,
      draft.failurePolicy, draft.customerMessage, input.updatedBy ?? null,
      input.expectedVersionId, input.id, ...revisionBinds, input.lineAccountId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new MileageRewardError('version_conflict', 'ほかの人が先に変更しました。読み直してください', 409);
  }
  const updated = await getMileageReward(db, { id: input.id, lineAccountId: input.lineAccountId });
  if (!updated) throw new MileageRewardError('not_found', '使い道が見つかりません', 404);
  return updated;
}

export async function createMileageRewardDraftFromPublished(
  db: D1Database,
  input: { id: string; lineAccountId: string; createdBy?: string | null },
): Promise<MileageRewardSummary> {
  const reward = await getMileageReward(db, input);
  if (!reward?.currentPublishedVersionId) throw new MileageRewardError('not_found', '公開中の使い道が見つかりません', 404);
  if (reward.currentDraftVersionId) return reward;
  const published = await db.prepare(
    `SELECT * FROM mileage_reward_versions WHERE id = ? AND status = 'published'`,
  ).bind(reward.currentPublishedVersionId).first<Record<string, unknown>>();
  if (!published) throw new MileageRewardError('published_version_missing', '公開中の版を読み込めませんでした', 409);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO mileage_reward_versions
           (id, reward_id, version_number, status, required_miles, stock_limit,
            per_friend_limit, starts_at, ends_at, benefit_expires_days,
            common_action_version_id, target_conditions, failure_policy, customer_message, created_by, created_at)
         SELECT ?, reward_id, version_number + 1, 'draft', required_miles, stock_limit,
                per_friend_limit, starts_at, ends_at, benefit_expires_days,
                common_action_version_id, target_conditions, failure_policy, customer_message, ?, ?
           FROM mileage_reward_versions WHERE id = ? AND status = 'published'`,
      ).bind(versionId, input.createdBy ?? null, now, reward.currentPublishedVersionId),
      db.prepare(
        `UPDATE mileage_rewards SET current_draft_version_id = ?, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND current_draft_version_id IS NULL`,
      ).bind(versionId, now, input.id, input.lineAccountId),
    ]);
  } catch (error) {
    // 同時に作った片方は版番号の一意制約に当たる。共同編集の正常な
    // 競合なので、一般的なサーバーエラーにせず読み直しを案内する。
    if (error instanceof Error && /unique|UNIQUE/i.test(error.message)) {
      throw new MileageRewardError('draft_exists', 'ほかの担当者が下書きを作成済みです。読み直してください', 409);
    }
    throw error;
  }
  const created = await getMileageReward(db, input);
  if (!created) throw new MileageRewardError('not_found', '使い道が見つかりません', 404);
  if (created.currentDraftVersionId !== versionId) {
    // 競合に勝った相手の下書きが付いた。作り直さず読み直しを案内する。
    throw new MileageRewardError('draft_exists', 'ほかの担当者が下書きを作成済みです。読み直してください', 409);
  }
  return created;
}

export async function publishMileageReward(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    publishedBy?: string | null;
    expectedVersionId?: string | null;
    expectedRevision?: number | null;
  },
): Promise<MileageRewardSummary> {
  const reward = await getMileageReward(db, input);
  const draft = reward?.currentVersion?.status === 'draft' ? reward.currentVersion : null;
  if (!reward || !draft || !reward.currentDraftVersionId) {
    throw new MileageRewardError('draft_missing', '公開する下書きがありません', 409);
  }
  // 公開者が確認した版と更新番号を要求に含め、検証から確定まで
  // 同じ内容を保証する。途中で保存されたら公開を止めて確認し直す。
  if (input.expectedVersionId != null && input.expectedVersionId !== draft.id) {
    throw new MileageRewardError('version_conflict', '公開前に内容が変わりました。読み直してください', 409);
  }
  if (input.expectedRevision != null && draft.revision !== input.expectedRevision) {
    throw new MileageRewardError('version_conflict', '公開前に内容が変わりました。読み直してください', 409);
  }
  await requirePublishedActionVersion(db, input.lineAccountId, draft.commonActionVersionId);
  if (reward.rewardKind === 'coupon') {
    const inventory = await db.prepare(
      `SELECT COUNT(*) AS count FROM mileage_reward_codes
        WHERE reward_version_id = ? AND status = 'available'`,
    ).bind(draft.id).first<{ count: number }>();
    if ((inventory?.count ?? 0) < 1) {
      throw new MileageRewardError('coupon_inventory_empty', '交換コードを1件以上登録してから公開してください');
    }
  }
  const now = new Date().toISOString();
  const revisionGuard = input.expectedRevision != null ? ' AND revision = ?' : '';
  const revisionBinds: unknown[] = input.expectedRevision != null ? [input.expectedRevision] : [];
  const results = await db.batch([
    db.prepare(
      `UPDATE mileage_reward_versions
          SET status = 'published', published_at = ?, created_by = COALESCE(?, created_by)
        WHERE id = ? AND reward_id = ? AND status = 'draft'${revisionGuard}`,
    ).bind(now, input.publishedBy ?? null, draft.id, reward.id, ...revisionBinds),
    db.prepare(
      `UPDATE mileage_rewards
          SET status = 'published', current_published_version_id = current_draft_version_id,
              current_draft_version_id = NULL, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND current_draft_version_id = ?
          AND EXISTS (
            SELECT 1 FROM mileage_reward_versions v
             WHERE v.id = ? AND v.reward_id = mileage_rewards.id
             ${revisionGuard.replaceAll('revision', 'v.revision')}
          )`,
    ).bind(now, reward.id, input.lineAccountId, draft.id, draft.id, ...revisionBinds),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new MileageRewardError('version_conflict', '公開前に内容が変わりました。読み直してください', 409);
  }
  const published = await getMileageReward(db, input);
  if (!published) throw new MileageRewardError('not_found', '使い道が見つかりません', 404);
  return published;
}
