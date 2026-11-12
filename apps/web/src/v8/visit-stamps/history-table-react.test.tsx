// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HistoryTable from './history-table'
import type { HistoryRow } from './display'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/visit-stamps', useRouter: () => ({ replace: vi.fn() }) }))
afterEach(cleanup)
const entry: HistoryRow = { id: 'redeem-1', friendId: 'friend&1', at: '2026-10-14T10:00:00Z', count: '−10 個（特典）', why: 'デザート1品を使った', actor: '店員：見本 30（暗証番号）', reversible: true, reversed: false }

it('記録の全文を省略部品のtitleに保ち、再読込の値で更新する', () => {
  const props = { rows: [entry], friendName: () => 'お客さまの名前', canManage: true, onOpenFriend: vi.fn(), onReverse: vi.fn() }
  const view = render(<HistoryTable {...props} />)
  const table = screen.getByRole('table', { name: '押した・使った記録' })
  expect([...table.querySelectorAll('thead th')].map(cell => cell.textContent)).toEqual(['いつ', '誰に', '何個', '何で', '誰が', '操作'])
  for (const value of [entry.actor, entry.why, entry.count, 'お客さまの名前']) expect(screen.getByText(value).title).toBe(value)
  const actor = 'とても長い担当者の名前（承認）'
  view.rerender(<HistoryTable {...props} rows={[{ ...entry, actor }]} />)
  expect(screen.getByText(actor).title).toBe(actor)
  expect(screen.queryByText(entry.actor)).toBeNull()
})

it.each([true, false])('行の友だちへの移動を保ち、取り消す権限=%sを守る', async canManage => {
  const onOpenFriend = vi.fn(), onReverse = vi.fn()
  render(<HistoryTable rows={[entry]} friendName={() => 'お客さま'} canManage={canManage} onOpenFriend={onOpenFriend} onReverse={onReverse} />)
  fireEvent.click(screen.getByRole('button', { name: /の記録のその他操作/ }))
  const friend = await screen.findByRole('menuitem', { name: /友だちの詳細を開く/ })
  expect(friend.getAttribute('href')).toContain('friend%261')
  // 行き先のある項目は共通メニューがリンクで移動する。onSelectは発火しない。
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: /の記録のその他操作/ }))
  const reverse = screen.queryByRole('menuitem', { name: /この記録を取り消す/ })
  if (canManage) { expect(reverse).toBeTruthy(); fireEvent.click(reverse!); expect(onReverse).toHaveBeenCalledWith(entry.id) }
  else { expect(reverse).toBeNull(); expect(onReverse).not.toHaveBeenCalled() }
})

it('取り消し済みの記録は再度取り消す入口を出さない', () => {
  render(<HistoryTable rows={[{ ...entry, reversible: false, reversed: true }]} friendName={() => 'お客さま'} canManage onOpenFriend={vi.fn()} onReverse={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /の記録のその他操作/ }))
  expect(screen.queryByRole('menuitem', { name: /この記録を取り消す/ })).toBeNull()
})
