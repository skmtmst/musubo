import { describe, expect, it } from 'vitest';
import { decideRedistribution, type RedistributionState } from './redistribution-decision.js';

const state: RedistributionState = {
  bindingTemplateId: 'hq', bindingVersionId: 'v1', originTemplateId: 'hq', originVersionId: 'v1',
  appliedVersion: 1, candidateVersion: 2, pendingVersion: null, dismissedVersion: null,
  targetExists: true, targetActive: true, appliedHash: 'same', currentHash: 'same',
  publishedReward: false, previousRequiredMiles: null, nextRequiredMiles: null,
};
describe('店舗への再配布の判定', () => {
  it('未編集の対応先だけ更新する', () => {
    expect(decideRedistribution(state)).toBe('apply');
    expect(decideRedistribution({ ...state, currentHash: 'edited' })).toBe('pending');
    expect(decideRedistribution({ ...state, originTemplateId: 'other' })).toBe('conflict');
    expect(decideRedistribution({ ...state, targetExists: false })).toBe('missing');
  });
  it('既存または保留・維持より古い版を適用しない', () => {
    expect(decideRedistribution({ ...state, appliedVersion: 3 })).toBe('unchanged');
    expect(decideRedistribution({ ...state, pendingVersion: 3 })).toBe('unchanged');
    expect(decideRedistribution({ ...state, dismissedVersion: 2 })).toBe('unchanged');
    expect(decideRedistribution({ ...state, dismissedVersion: 2, candidateVersion: 3, currentHash: 'edited' })).toBe('pending');
  });
  it('公開中の景品で必要マイルが増える場合は店の判断を待つ', () => {
    expect(decideRedistribution({ ...state, publishedReward: true, previousRequiredMiles: 100, nextRequiredMiles: 150 })).toBe('pending');
    expect(decideRedistribution({ ...state, publishedReward: true, previousRequiredMiles: 100, nextRequiredMiles: 50 })).toBe('apply');
  });
});
