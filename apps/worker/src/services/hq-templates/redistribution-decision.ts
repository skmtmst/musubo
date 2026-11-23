/** Pure decision only; writes must recheck the source, target and lease in the same batch. */
export type RedistributionDecision = 'apply' | 'pending' | 'unchanged' | 'conflict' | 'missing';

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
}

export function decideRedistribution(state: RedistributionState): RedistributionDecision {
  if (!state.targetExists || !state.targetActive) return 'missing';
  // The binding is authoritative; legacy origin columns only detect divergence.
  if (state.originTemplateId !== state.bindingTemplateId || state.originVersionId !== state.bindingVersionId) return 'conflict';
  if (state.candidateVersion <= Math.max(state.appliedVersion, state.pendingVersion ?? 0, state.dismissedVersion ?? 0)) return 'unchanged';
  const increasedMiles = state.publishedReward && state.previousRequiredMiles !== null && state.nextRequiredMiles !== null && state.nextRequiredMiles > state.previousRequiredMiles;
  return state.appliedHash !== state.currentHash || increasedMiles ? 'pending' : 'apply';
}
