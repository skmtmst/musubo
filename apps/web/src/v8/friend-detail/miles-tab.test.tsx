// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ account: 'a', friend: vi.fn(), program: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account }) }))
vi.mock('@/lib/api/helpers/gap3', () => ({ memberRanksApi: { friend: fixture.friend, program: fixture.program } }))
vi.mock('./empty-tab', () => ({ default: () => <div>マイルを確認</div> }))
import MilesTab from './miles-tab'

const history = (id: string) => ({ success: true, data: { history: [{ id, from_tier_id: null, to_tier_id: id, reason: 'manual', at: '2026-11-26' }] } })
const program = { success: true, data: { tiers: [{ id: 'gold', name: 'ゴールド' }, { id: 'silver', name: 'シルバー' }] } }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { fixture.account = 'a'; fixture.friend.mockReset(); fixture.program.mockReset().mockResolvedValue(program) })
afterEach(cleanup)

it('取得失敗を知らせ、再読み込みで履歴を表示する', async () => {
  fixture.friend.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce(history('gold'))
  render(<MilesTab friendId="one" balanceSource="musubo" />)
  await screen.findByText('会員ランクの履歴を読み込めませんでした')
  fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
  await screen.findByText('— → ゴールド')
})

it('友だちやアカウントを切り替えると古い履歴を消し、遅い返事を表示しない', async () => {
  const pending = deferred<ReturnType<typeof history>>()
  fixture.friend.mockResolvedValueOnce(history('gold')).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(history('silver'))
  const view = render(<MilesTab friendId="one" balanceSource="musubo" />)
  await screen.findByText('— → ゴールド')
  view.rerender(<MilesTab friendId="two" balanceSource="musubo" />)
  expect(screen.queryByText('— → ゴールド')).toBeNull()
  fixture.account = 'b'
  view.rerender(<MilesTab friendId="two" balanceSource="musubo" />)
  await screen.findByText('— → シルバー')
  await act(async () => pending.resolve(history('gold')))
  expect(screen.queryByText('— → ゴールド')).toBeNull()
  expect(screen.getByText('— → シルバー')).toBeTruthy()
})
