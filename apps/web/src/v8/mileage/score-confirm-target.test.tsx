// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ account: 'account-a', rules: vi.fn(), friends: vi.fn(), publish: vi.fn(), stop: vi.fn(), save: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, loading: false }) }))
vi.mock('./frame', async (original) => ({ ...await original<typeof import('./frame')>(), useMileageShell: () => ({ readonly: false, narrow: false }) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, actionScores: { ...actual.api.actionScores, friends: state.friends, rules: state.rules, publishRules: state.publish, stopRules: state.stop, saveDraft: state.save } } }
})
import ScoreTab from './score'
const version = { id: 'draft-1', versionNumber: 1, status: 'draft', createdAt: '2026-01-01', publishedAt: null, bands: { min: 0, max: 100, normalMin: 10, highMin: 30 }, rules: [{ id: 'rule-1', name: '来店', eventType: 'booking_created', source: 'booking', operation: 'delta', value: 1, frequency: { kind: 'per_day', limit: 1 }, enabled: true }] }
const configuration = { configured: true, status: 'published', currentDraftVersionId: 'draft-1', currentPublishedVersionId: 'published-1', editableVersion: version, publishedVersion: version }
beforeEach(() => { state.account = 'account-a'; state.rules.mockResolvedValue({ success: true, data: configuration }); state.friends.mockResolvedValue({ success: true, data: { items: [], total: 0, summary: {} } }) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks() })
async function open(kind: 'publish' | 'stop' | 'remove') {
  if (kind === 'publish') fireEvent.click(await screen.findByRole('button', { name: 'スコアのルールを公開' }))
  else {
    fireEvent.click(await screen.findByRole('button', { name: /できごとの決めごと/ }))
    fireEvent.click(await screen.findByRole('button', { name: kind === 'stop' ? '公開中のルールの操作' : '来店の操作' }))
    fireEvent.click(await screen.findByText(kind === 'stop' ? '公開中のルールを止める' : '外す'))
  }
  return screen.findByRole('alertdialog')
}
it.each(['publish', 'stop', 'remove'] as const)('%s の確認に操作対象を表示する', async kind => {
 render(<ScoreTab />)
 const dialog = await open(kind)
 expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
 expect(within(dialog).getByText('環境')).toBeTruthy()
})
it.each(['publish', 'stop', 'remove'] as const)('%s は切り替えた古い確認から操作しない', async kind => {
 const view = render(<ScoreTab />)
 const dialog = await open(kind)
 const label = kind === 'publish' ? '公開する' : kind === 'stop' ? '止める' : '外す'
 const button = within(dialog).getByRole('button', { name: label })
 const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
 const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
 state.account = 'account-b'; view.rerender(<ScoreTab />)
 state.account = 'account-a'; view.rerender(<ScoreTab />)
 await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
 expect(state.publish).not.toHaveBeenCalled(); expect(state.stop).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled()
})


it('知らない行動スコアの帯もCSVに確認できないと出す', async () => {
  state.friends.mockResolvedValue({ success: true, data: { items: [{ friendId: 'f1', displayName: '確認用', currentScore: 12, band: '__proto__', change30d: 0, lastReason: null, lastChangedAt: null }], total: 1, pagination: { total: 1, limit: 20, offset: 0 }, summary: {} } })
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:score')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<ScoreTab />)
  expect(await screen.findByText('状態を確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /この頁の行動スコアをCSVで書き出す/ }))
  const csv = await (createUrl.mock.calls[0][0] as Blob).text()
  expect(csv).toContain('状態を確認できません')
  expect(csv).not.toContain('[object Object]')
})
