import { describe, expect, it } from 'vitest';
import { decideRedistribution, redistributionNotices, type RedistributionState } from './redistribution-decision.js';

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
    expect(decideRedistribution({ ...state, customized: true })).toBe('pending');
    expect(decideRedistribution({ ...state, originTemplateId: 'other' })).toBe('conflict');
    expect(decideRedistribution({ ...state, originVersionId: 'v0' })).toBe('conflict');
    expect(decideRedistribution({ ...state, targetExists: false })).toBe('missing');
    expect(decideRedistribution({ ...state, targetActive: false })).toBe('missing');
  });
  it('手渡しの景品は書き換えず競合にする', () => {
    expect(decideRedistribution({ ...state, protectedTarget: true })).toBe('conflict');
  });
  it('既存または保留・維持より古い版を適用しない', () => {
    expect(decideRedistribution({ ...state, appliedVersion: 3 })).toBe('unchanged');
    expect(decideRedistribution({ ...state, pendingVersion: 3 })).toBe('unchanged');
    expect(decideRedistribution({ ...state, dismissedVersion: 2 })).toBe('unchanged');
    expect(decideRedistribution({ ...state, dismissedVersion: 2, candidateVersion: 3, currentHash: 'edited' })).toBe('pending');
    // 版は文字ではなく数で比べる（"10" < "9" の取り違えをしない）。
    expect(decideRedistribution({ ...state, appliedVersion: 9, candidateVersion: 10 })).toBe('apply');
  });
  it('公開中の景品は必要マイルの増減にかかわらず店の判断を待ち、増える時はその理由も知らせる', () => {
    const raised = { ...state, publishedReward: true, previousRequiredMiles: 100, nextRequiredMiles: 150 };
    expect(decideRedistribution(raised)).toBe('pending');
    expect(redistributionNotices(raised)).toEqual(['published_reward', 'required_miles_increase']);
    const lowered = { ...state, publishedReward: true, previousRequiredMiles: 100, nextRequiredMiles: 50 };
    expect(decideRedistribution(lowered)).toBe('pending');
    expect(redistributionNotices(lowered)).toEqual(['published_reward']);
  });
  it('下書きの景品は必要マイルが増えても店の画面に出ていないので更新する', () => {
    expect(decideRedistribution({ ...state, previousRequiredMiles: 100, nextRequiredMiles: 150 })).toBe('apply');
    expect(redistributionNotices({ ...state, currentHash: 'edited' })).toEqual(['store_edited']);
  });
});
