// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VisitStampEntry } from '@line-crm/shared'
import HistoryTable from './history-table'
import { historyRows } from './display'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/visit-stamps',
  useRouter: () => ({ replace: vi.fn() }),
}))

afterEach(cleanup)

const entry = (
  id: string,
  kind: string,
  delta: number,
  actorId: string | null,
  reason: string,
  createdAt: string,
  originalId: string | null = null,
): VisitStampEntry => ({
  id, cardId: 'card-1', friendId: 'friend-1', accountId: 'acc-1', kind, delta, actorId, reason, createdAt, originalId,
})

describe('来店スタンプ履歴の空理由フォールバック', () => {
  it('特典利用・取り消し・来店の理由が空や空白だけのとき壊れた文や空欄にせず日本語ラベルを表示する', () => {
    const rows = historyRows([
      entry('e-redeem', 'redeem', -5, 's1', '   ', '2026-11-27T02:00:00Z'),
      entry('e-orig', 'manual', 1, 's1', '押し忘れ', '2026-11-27T03:00:00Z'),
      entry('e-rev', 'reverse', -1, 's1', ' ', '2026-11-27T03:05:00Z', 'e-orig'),
      entry('e-visit', 'visit', 1, null, '  ', '2026-11-27T04:00:00Z'),
    ], () => '佐藤')

    render(
      <HistoryTable
        rows={rows}
        friendName={() => '山田太郎'}
        canManage={false}
        onOpenFriend={() => {}}
        onReverse={() => {}}
      />,
    )

    expect(screen.getByText('特典を使った')).toBeTruthy()
    expect(screen.getByText('取り消し')).toBeTruthy()
    expect(screen.getByText('来店')).toBeTruthy()
    expect(document.body.textContent).not.toContain('   を使った')
  })
})
