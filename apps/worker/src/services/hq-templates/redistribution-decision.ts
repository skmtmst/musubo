/** Pure decision only; writes must recheck the source, target and lease in the same batch. */
export type RedistributionDecision = 'apply' | 'pending' | 'unchanged' | 'conflict' | 'missing';
/** 店に知らせて判断を待つ理由。 */
export type RedistributionNotice = 'store_edited' | 'published_reward' | 'required_miles_increase';

export interface RedistributionState {
  bindingTemplateId: string;
  bindingVersionId: string;
  originTemplateId: string | null;
  originVersionId: string | null;
  appliedVersion: number;
  candidateVersion: number;
  pendingVersion: number | null;
  dismissedVersion: number | null;
  targetExists: boolean;
  targetActive: boolean;
  appliedHash: string;
  currentHash: string;
  publishedReward: boolean;
  previousRequiredMiles: number | null;
  nextRequiredMiles: number | null;
  /** 店が変えた印（予約メニューの編集の印・公開中の景品の上の下書き）。 */
  customized?: boolean;
  /** 手渡しの景品など、本部の配布で書き換えない店の物。 */
  protectedTarget?: boolean;
}

export function decideRedistribution(state: RedistributionState): RedistributionDecision {
  if (!state.targetExists || !state.targetActive) return 'missing';
  if (state.protectedTarget) return 'conflict';
  // The binding is authoritative; legacy origin columns only detect divergence.
  if (state.originTemplateId !== state.bindingTemplateId || state.originVersionId !== state.bindingVersionId) return 'conflict';
  if (state.candidateVersion <= Math.max(state.appliedVersion, state.pendingVersion ?? 0, state.dismissedVersion ?? 0)) return 'unchanged';
  return redistributionNotices(state).length ? 'pending' : 'apply';
}

/*
 * 店が変えた物は上書きしない。公開中の景品も自動では書き換えない。景品の在庫と引換コードは版ごとに
 * 結びつき、払い戻しは交換した版の必要マイルで計算する。版を書き換えても新しい版を公開しても、
 * そのどれかが崩れるため、店が［取り込む］を選ぶまで待つ。
 */
export function redistributionNotices(state: RedistributionState): RedistributionNotice[] {
  const notices: RedistributionNotice[] = [];
  if (state.appliedHash !== state.currentHash || state.customized) notices.push('store_edited');
  if (state.publishedReward) notices.push('published_reward');
  if (state.publishedReward && state.previousRequiredMiles !== null && state.nextRequiredMiles !== null && state.nextRequiredMiles > state.previousRequiredMiles) notices.push('required_miles_increase');
  return notices;
}
