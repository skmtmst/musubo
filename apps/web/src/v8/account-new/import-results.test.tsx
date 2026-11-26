// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FollowerImportState, LineAccountConnectData } from '@/lib/api'
import Step5Completion from './step5-completion'
import { handoverProgress } from './check-rows'

const state = (over: Partial<FollowerImportState> = {}): FollowerImportState => ({
  version: 1, capability: 'available', phase: 'not_started', eligibilityCheckedAt: null,
  startedAt: null, completedAt: null, updatedAt: '2026-11-01T00:00:00Z',
  received: 0, imported: 0, reactivated: 0, claimedUnassigned: 0, alreadyPresent: 0,
  conflicts: 0, invalid: 0, profilesProcessed: 0, profilesUpdated: 0, profileErrors: 0, lastError: null,
  ...over,
})
function props(value: FollowerImportState | null, fallback: LineAccountConnectData['followerImport'] = { capability: 'unknown', phase: 'not_started' }) {
  const source = value ?? fallback
  return {
    connection: { id: 'mock-account', steps: [], basicId: '@fixture', pictureUrl: null, displayName: '確認用アカウント', followerImport: source, remainingActions: [] } as LineAccountConnectData,
    accountName: '確認用アカウント', createdId: 'mock-account', importFriends: true, importState: value,
    importRunning: source.phase === 'importing_ids' || source.phase === 'hydrating_profiles',
    handover: handoverProgress({ phase: source.phase, received: value?.received ?? 0, imported: value?.imported ?? 0,
      alreadyPresent: value?.alreadyPresent ?? 0, reactivated: value?.reactivated ?? 0, claimedUnassigned: value?.claimedUnassigned ?? 0,
      conflicts: value?.conflicts ?? 0, invalid: value?.invalid ?? 0, profilesUpdated: value?.profilesUpdated ?? 0 }),
    idleSeconds: 0, requestError: false,
  }
}
afterEach(cleanup)

it.each([
  ['available', '友だちの引き継ぎは未開始です'],
  ['unavailable', '友だちの一括引き継ぎを利用できません'],
  ['unknown', '友だちの引き継ぎを確認できません'],
] as const)('未開始・利用可否%sを、取得済み0人と表示しない', (capability, title) => {
  render(<Step5Completion {...props(null, { capability, phase: 'not_started' })} />)
  expect(screen.getByRole('heading', { name: 'LINEアカウントの登録が完了しました' })).toBeTruthy()
  expect(screen.getByText(title)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/LINEで確認した\s*0|0\s*人を取り込みました|新しく\s*0/)
  expect(screen.queryByRole('progressbar')).toBeNull()
})

it('取得済みの状態でも未開始なら、取込完了の実績にしない', () => {
  render(<Step5Completion {...props(state())} />)
  expect(screen.getByText('友だちの引き継ぎは未開始です')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/LINEで確認した\s*0|0\s*人を取り込みました|新しく\s*0/)
})

it.each([false, true])('完了で人数未取得・取得失敗%sは、確認中と失敗を分けて0に補わない', failed => {
  const refresh = vi.fn()
  render(<Step5Completion {...props(null, { capability: 'available', phase: 'completed' })} requestError={failed} onRefresh={refresh} />)
  expect(screen.getByText(failed ? '引き継ぎの人数を確認できません' : '引き継ぎの人数を確認しています')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/対象0人|0人の友だちを引き継ぎました|0\s*人を取り込みました/)
  expect(screen.queryByRole('progressbar')).toBeNull()
  if (failed) {
    fireEvent.click(screen.getByRole('button', { name: '状態を再確認' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  } else expect(screen.queryByRole('button', { name: '状態を再確認' })).toBeNull()
})

it('進行状態だけ届いて人数が未取得なら、人数は確認中とする', () => {
  render(<Step5Completion {...props(null, { capability: 'available', phase: 'importing_ids' })} />)
  expect(screen.getByRole('heading', { name: '友だちを確認しています' })).toBeTruthy()
  expect(screen.getByText('引き継いだ友だち').parentElement!.textContent).toContain('確認中')
  expect(screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' }).childElementCount).toBe(0)
  expect(document.body.textContent).not.toMatch(/0人の友だちを引き継ぎました/)
})

it('対象人数を取得して完了した0人は、そのまま0人・100%で表示する', () => {
  render(<Step5Completion {...props(state({ phase: 'completed', completedAt: '2026-11-01T00:00:00Z' }))} />)
  expect(screen.getByRole('heading', { name: '友だちの引き継ぎが完了しました' })).toBeTruthy()
  expect(screen.getByText('対象0人を確認しました。')).toBeTruthy()
  expect(screen.getByRole('link', { name: '登録したアカウントを見る' }).getAttribute('href')).toContain('mock-account')
  const bar = screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' })
  expect(bar.getAttribute('aria-valuemax')).toBe('1'); expect(bar.getAttribute('aria-valuenow')).toBe('1')
  expect(screen.getByText('0人の友だちを引き継ぎました')).toBeTruthy()
})

it('部分成功の完了は、取得した人数と確認が必要な件数を残す', () => {
  render(<Step5Completion {...props(state({ phase: 'completed', received: 10, imported: 6, alreadyPresent: 2, conflicts: 2, profileErrors: 1 }))} />)
  expect(screen.getByText('対象10人を確認しました。')).toBeTruthy()
  expect(screen.getByText('引き継いだ友だち').parentElement!.textContent).toContain('8 人')
  expect(screen.getByText('2件は取り込めず、確認が必要です。')).toBeTruthy()
  expect(screen.getByText('一部のプロフィールを読み込めませんでした。友だち一覧で確認してください。')).toBeTruthy()
  expect(screen.getByText(/8 \/ 10人 · 80%/)).toBeTruthy()
  expect(document.body.textContent).not.toContain('対象10人を確認・反映しました')
})

it('進行中の取得失敗でも、直近の取得済み人数を消さない', () => {
  render(<Step5Completion {...props(state({ phase: 'hydrating_profiles', received: 10, imported: 3, lastError: 'LINE request failed' }))} requestError />)
  expect(screen.getByRole('heading', { name: '進み具合を確認できません' })).toBeTruthy()
  expect(screen.getByText('引き継いだ友だち').parentElement!.textContent).toContain('3 人')
  expect(screen.getByText('現在の対象人数').parentElement!.textContent).toContain('10 人')
  expect(document.body.textContent).not.toContain('LINE request failed')
})

it('未開始の応答に取得済みの記録があれば、完了と言わず記録を残す', () => {
  render(<Step5Completion {...props(state({ received: 5, imported: 3, conflicts: 1 }))} />)
  expect(screen.getByText('友だちの引き継ぎは未開始です')).toBeTruthy()
  expect(screen.getByText(/これまでに確認できた友だち.*5/)).toBeTruthy()
  expect(screen.getByText('1件は取り込めず、確認が必要です。')).toBeTruthy()
  expect(document.body.textContent).not.toContain('取り込みました')
})

it('状態の再確認に失敗したときは、再確認だけを呼び、処理を勝手に始めない', () => {
  const refresh = vi.fn()
  const view = render(<Step5Completion {...props(null)} requestError onRefresh={refresh} refreshing={false} />)
  expect(screen.getByText('友だちの引き継ぎを確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '状態を再確認' }))
  expect(refresh).toHaveBeenCalledTimes(1)
  view.rerender(<Step5Completion {...props(null)} requestError onRefresh={refresh} refreshing />)
  fireEvent.click(screen.getByRole('button', { name: '確認中…' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('引き継ぎを選ばなかった場合は、オフの案内や次の操作一覧を表示しない', () => {
  render(<Step5Completion {...props(null)} importFriends={false} />)
  expect(screen.queryByText(/いまの友だちの引き継ぎはオフ/)).toBeNull()
  expect(screen.queryByText('次にすること')).toBeNull()
  expect(screen.queryAllByRole('link')).toHaveLength(0)
  expect(screen.getByText('確認用アカウント')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/LINEで確認した\s*0|0人の友だちを引き継ぎました/)
})

it.each([[59, '59秒'], [60, '1分'], [3599, '59分'], [3600, '1時間'], [86399, '23時間'], [86400, '1日'], [4362240, '50日']] as const)(
  '更新から%d秒の経過時間を読みやすく表示する', (seconds, elapsed) => {
    render(<Step5Completion {...props(state({ phase: 'importing_ids' }))} idleSeconds={seconds} />)
    expect(screen.getByText(`最終更新：${elapsed}前`)).toBeTruthy()
    if (seconds >= 60) expect(screen.getByText(`${elapsed}${seconds < 3600 || seconds >= 86400 ? '間' : ''}、引き継ぎの状態が更新されていません`)).toBeTruthy()
  },
)
