/**
 * はじめにやることガイドの進行状態（ユーザー×アカウント）。
 *
 * 承認済み Pen 枠 14 (orKSi) のノード L3lP08 どおり、
 * 「有効/一時停止・現在ステップ・現在手順」をサーバーに置く。
 * ブラウザ保存は控えで、端末を変えても離脱しても同じ所から再開できるようにする。
 */
export type OnboardingGuidePhase = 'idle' | 'active' | 'paused' | 'done';

export interface OnboardingGuideProgressRow {
  staff_id: string;
  line_account_id: string;
  phase: OnboardingGuidePhase;
  step_key: string | null;
  procedure_index: number;
  created_at: string;
  updated_at: string;
}

export async function getOnboardingGuideProgress(
  db: D1Database,
  staffId: string,
  lineAccountId: string,
): Promise<OnboardingGuideProgressRow | null> {
  return db.prepare(
    `SELECT staff_id, line_account_id, phase, step_key, procedure_index, created_at, updated_at
       FROM onboarding_guide_progress
      WHERE staff_id = ? AND line_account_id = ?`,
  ).bind(staffId, lineAccountId).first<OnboardingGuideProgressRow>();
}

/**
 * 進行状態を書き込む。
 *
 * ガイドは同じ人が1画面で進めるものなので版の競合解決は置かず、最後の操作を残す。
 * 代わりに updated_at を必ず更新し、どちらが新しいかを後から追える状態にする。
 */
export async function saveOnboardingGuideProgress(
  db: D1Database,
  input: { staffId: string; lineAccountId: string; phase: OnboardingGuidePhase; stepKey: string | null; procedureIndex: number },
): Promise<OnboardingGuideProgressRow> {
  const procedureIndex = Number.isInteger(input.procedureIndex) && input.procedureIndex >= 1 ? input.procedureIndex : 1;
  await db.prepare(
    `INSERT INTO onboarding_guide_progress (staff_id, line_account_id, phase, step_key, procedure_index)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (staff_id, line_account_id) DO UPDATE SET
       phase = excluded.phase,
       step_key = excluded.step_key,
       procedure_index = excluded.procedure_index,
       updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
  ).bind(input.staffId, input.lineAccountId, input.phase, input.stepKey, procedureIndex).run();
  const row = await getOnboardingGuideProgress(db, input.staffId, input.lineAccountId);
  if (!row) throw new Error('onboarding guide progress save did not produce a row');
  return row;
}

/** ウェルカムを見た記録を作る。別画面で始まった案内の進行はそのまま残す。 */
export async function acknowledgeOnboardingWelcome(
  db: D1Database,
  staffId: string,
  lineAccountId: string,
): Promise<OnboardingGuideProgressRow | null> {
  await db.prepare(
    `INSERT INTO onboarding_guide_progress (staff_id, line_account_id, phase, procedure_index)
     VALUES (?, ?, 'idle', 1) ON CONFLICT (staff_id, line_account_id) DO NOTHING`,
  ).bind(staffId, lineAccountId).run();
  return getOnboardingGuideProgress(db, staffId, lineAccountId);
}

export async function deleteOnboardingGuideProgress(
  db: D1Database,
  staffId: string,
  lineAccountId: string,
): Promise<void> {
  await db.prepare(
    'DELETE FROM onboarding_guide_progress WHERE staff_id = ? AND line_account_id = ?',
  ).bind(staffId, lineAccountId).run();
}
