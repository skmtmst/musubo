// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { FollowerImportState, LineAccountConnectData } from '@/lib/api'
import { handoverProgress } from './check-rows'
import Step5Completion from './step5-completion'

const job = (phase: FollowerImportState['phase']): FollowerImportState => ({
  version: 1, capability: 'available', phase, eligibilityCheckedAt: null,
  startedAt: null, completedAt: phase === 'completed' ? '2026-11-01T00:00:00Z' : null,
  updatedAt: '2026-11-01T00:00:00Z', received: 20, imported: 12, reactivated: 1,
  claimedUnassigned: 0, alreadyPresent: 0, conflicts: 7, invalid: 0,
  profilesProcessed: 13, profilesUpdated: 13, profileErrors: 0, lastError: null,
})
function show(phase: FollowerImportState['phase']) {
  const state = job(phase)
  render(<Step5Completion
    connection={{ id: 'fixture-account', steps: [], pictureUrl: null, basicId: '@fixture',
      followerImport: { capability: state.capability, phase }, remainingActions: [] } as LineAccountConnectData}
    accountName="確認用アカウント" createdId="fixture-account" importFriends importState={state}
    importRunning={phase !== 'completed'} handover={handoverProgress(state)} idleSeconds={0} requestError={false}
  />)
}
afterEach(cleanup)

it('処理が終わっても競合があれば、全員を反映できたとは表示しない', () => {
  show('completed')
  expect(document.body.textContent).not.toContain('対象20人を確認・反映しました')
  expect(screen.getByText('引き継いだ友だち').parentElement!.textContent).toContain('13 人')
  expect(screen.getByText('7件は取り込めず、確認が必要です。')).toBeTruthy()
})

it('処理終了後の未反映は、処理中の残り人数と表示しない', () => {
  show('completed')
  expect(document.body.textContent).not.toMatch(/残り\s*7\s*人/)
  expect(screen.getByText('13 / 20人 · 65% · 未反映7件')).toBeTruthy()
  expect(screen.getByText('7件は取り込めず、確認が必要です。')).toBeTruthy()
})

it('進行中なら、取得済みの人数と残り人数の説明を保つ', () => {
  show('hydrating_profiles')
  expect(screen.getByText('20人のうち13人を引き継ぎました。残り7人を処理中です。')).toBeTruthy()
  const bar = screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' })
  expect(bar.getAttribute('aria-valuenow')).toBe('13')
  expect(bar.getAttribute('aria-valuemax')).toBe('20')
})
