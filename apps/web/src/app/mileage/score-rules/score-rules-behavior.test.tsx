// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ rules: vi.fn(), testRules: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', loading: false }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, actionScores: { ...actual.api.actionScores, rules: state.rules, testRules: state.testRules } } }
})
import ActionScoreRulesPage from '@/v8/mileage/score-rules'

const version = { id: 'draft-1', versionNumber: 1, status: 'draft', createdAt: '2026-01-01', publishedAt: null, bands: { min: 0, max: 100, normalMin: 10, highMin: 30 }, rules: [{ id: 'rule-1', name: '来店', eventType: 'booking_created', source: 'booking', operation: 'delta', value: 1, frequency: { kind: 'per_day', limit: 1 }, enabled: true }] }
const configuration = { configured: true, status: 'published', currentDraftVersionId: 'draft-1', currentPublishedVersionId: 'published-1', editableVersion: version, publishedVersion: version }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T03:00:00Z'))
  state.rules.mockResolvedValue({ success: true, data: configuration })
  state.testRules.mockResolvedValue({ success: true, data: { scoreBefore: 30, scoreAfter: 31, matched: [{ ruleName: '来店' }] } })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers() })

async function openTest() {
  render(<ActionScoreRulesPage />)
  fireEvent.click(await screen.findByRole('button', { name: '1人で試す' }))
  return screen.findByRole('dialog', { name: '1人でスコアのルールを試す' })
}
async function openEditor() {
  render(<ActionScoreRulesPage />)
  fireEvent.click(await screen.findByRole('button', { name: '来店を編集' }))
  return screen.findByRole('dialog', { name: 'できごとの設定を直す' })
}

it('空欄と範囲外は送信せず欄に理由を出し、直すと理由が消える', async () => {
  const dialog = await openTest()
  const score = within(dialog).getByLabelText('テスト前の点数')
  fireEvent.change(score, { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'この条件をテスト' }))
  expect(within(dialog).getByText('テストする点数を入力してください')).toBeTruthy()
  expect(state.testRules).not.toHaveBeenCalled()
  fireEvent.change(score, { target: { value: '101' } })
  expect(within(dialog).queryByText('テストする点数を入力してください')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この条件をテスト' }))
  expect(within(dialog).getByText('テストする点数は0〜100の整数で入力してください')).toBeTruthy()
  expect(state.testRules).not.toHaveBeenCalled()
  fireEvent.change(score, { target: { value: '30' } })
  expect(within(dialog).queryByText('テストする点数は0〜100の整数で入力してください')).toBeNull()
})

it('点数の上限と下限が変われば欄の案内もその範囲になる', async () => {
  const customVersion = { ...version, bands: { min: 10, max: 75, normalMin: 20, highMin: 50 } }
  state.rules.mockResolvedValue({ success: true, data: { ...configuration, editableVersion: customVersion } })
  const dialog = await openTest()
  fireEvent.change(within(dialog).getByLabelText('テスト前の点数'), { target: { value: '9' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'この条件をテスト' }))
  expect(within(dialog).getByText('テストする点数は10〜75の整数で入力してください')).toBeTruthy()
  expect(state.testRules).not.toHaveBeenCalled()
})

it('成功した結果は点数・行動を変更したら消える', async () => {
  const dialog = await openTest()
  const run = within(dialog).getByRole('button', { name: 'この条件をテスト' })
  fireEvent.click(run)
  expect(await within(dialog).findByText('30点 → 31点')).toBeTruthy()
  fireEvent.change(within(dialog).getByLabelText('テスト前の点数'), { target: { value: '31' } })
  expect(within(dialog).queryByText('30点 → 31点')).toBeNull()
  fireEvent.click(run)
  expect(await within(dialog).findByText('30点 → 31点')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'テストする行動' }))
  fireEvent.click(within(await screen.findByRole('option', { name: '友だちになった' })).getByRole('button'))
  expect(within(dialog).queryByText('30点 → 31点')).toBeNull()
})

it('入力が変わった後に古い試算が返っても結果を表示しない', async () => {
  let finish!: (value: { success: true; data: { scoreBefore: number; scoreAfter: number; matched: { ruleName: string }[] } }) => void
  state.testRules.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const dialog = await openTest()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この条件をテスト' }))
  fireEvent.change(within(dialog).getByLabelText('テスト前の点数'), { target: { value: '40' } })
  await act(async () => finish({ success: true, data: { scoreBefore: 30, scoreAfter: 31, matched: [] } }))
  expect(within(dialog).queryByText('30点 → 31点')).toBeNull()
})

it('表示名が空なら設定を反映せず、欄の下に理由を出して窓を残す', async () => {
  const dialog = await openEditor()
  const name = within(dialog).getByLabelText('表示名')
  fireEvent.change(name, { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '設定を反映' }))
  const error = within(dialog).getByText('表示名を入力してください')
  expect(error.id).toBeTruthy()
  expect(name.getAttribute('aria-describedby')).toContain(error.id)
  expect(screen.getByRole('dialog', { name: 'できごとの設定を直す' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '来店を編集' })).toBeTruthy()
})

it('窓の変更は反映まで一覧に出ず、閉じると破棄される', async () => {
  const dialog = await openEditor()
  expect(within(dialog).getByText(/「設定を反映」を押すまで、一覧の内容は変わりません/)).toBeTruthy()
  fireEvent.change(within(dialog).getByLabelText('表示名'), { target: { value: '新しい名前' } })
  expect(screen.getByRole('button', { name: '来店を編集' })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  expect(screen.getByRole('button', { name: '来店を編集' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '来店を編集' }))
  expect((within(await screen.findByRole('dialog', { name: 'できごとの設定を直す' })).getByLabelText('表示名') as HTMLInputElement).value).toBe('来店')
})

it('設定を反映したときだけ新しい名前が一覧に出る', async () => {
  const dialog = await openEditor()
  fireEvent.change(within(dialog).getByLabelText('表示名'), { target: { value: '新しい名前' } })
  expect(screen.queryByRole('button', { name: '新しい名前を編集' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '設定を反映' }))
  expect(screen.queryByRole('dialog', { name: 'できごとの設定を直す' })).toBeNull()
  expect(screen.getByRole('button', { name: '新しい名前を編集' })).toBeTruthy()
})

it('試算の通信失敗は窓を開いたまま理由を出す', async () => {
  state.testRules.mockRejectedValueOnce(new Error('network'))
  const dialog = await openTest()
  fireEvent.click(within(dialog).getByRole('button', { name: 'この条件をテスト' }))
  expect(await within(dialog).findByText('通信に失敗しました。接続を確認してもう一度お試しください。')).toBeTruthy()
  expect(screen.getByRole('dialog', { name: '1人でスコアのルールを試す' })).toBeTruthy()
})

async function openRuleDelete() {
  const trigger = await screen.findByRole('button', { name: /来店.*操作/ })
  expect(trigger.closest('[data-row-actions]')).not.toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('menuitem', { name: '削除する' }))
  return screen.findByRole('alertdialog', { name: '「来店」を削除しますか？' })
}

it('削除を選ぶだけでは消えず、取り消すとルールが残る', async () => {
  render(<ActionScoreRulesPage />)
  expect(await screen.findByRole('button', { name: '来店を編集' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '削除する' })).toBeNull()
  expect(screen.queryByRole('button', { name: '来店を削除' })).toBeNull()
  const dialog = await openRuleDelete()
  expect(within(dialog).getByText(/公開中の版と友だちの点数は変わりません/)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: '削除する' }).getAttribute('data-dialog-action')).toBe('danger')
  expect(screen.getByRole('button', { name: '来店を編集' })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByRole('button', { name: '来店を編集' })).toBeTruthy()
})

it('確認してから削除すると該当ルールが一覧から消える', async () => {
  render(<ActionScoreRulesPage />)
  const dialog = await openRuleDelete()
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
  expect(screen.queryByRole('button', { name: '来店を編集' })).toBeNull()
})
