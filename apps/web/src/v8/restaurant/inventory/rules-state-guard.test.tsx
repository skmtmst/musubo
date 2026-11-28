// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantInventoryRuleState } from '@line-crm/shared'
import { RulesState } from './rules-state'

afterEach(cleanup)

describe('RulesState の履歴ラベルと空欄フォールバック', () => {
  it('配分に変化がない履歴を「停止」と誤表示せず「変更なし」と「—」で表示する', () => {
    const state = {
      stoppedTotal: 1,
      stopped: [
        {
          slotId: 'slot-1',
          startsAt: '2026-11-27T09:00:00Z',
          lineOriginal: null,
          sameDayOriginal: null,
          remainingSeats: 2,
          threshold: 4,
        },
      ],
      historyTotal: 1,
      history: [
        {
          id: 'hist-1',
          createdAt: '2026-11-27T08:00:00Z',
          startsAt: '2026-11-27T09:00:00Z',
          beforeLine: 2,
          afterLine: 2,
          beforeSameDay: 1,
          afterSameDay: 1,
          cause: 'unknown_cause',
        },
      ],
    } as unknown as RestaurantInventoryRuleState

    render(<RulesState state={state} error="" onRetry={vi.fn()} timezone="Asia/Tokyo" />)

    const stoppedTable = screen.getByRole('table', { name: '自動停止中の枠' })
    const stoppedCells = within(within(stoppedTable).getAllByRole('row')[1]).getAllByRole('cell')
    expect(stoppedCells[1].textContent).toBe('—')
    expect(stoppedCells[3].textContent).toBe('—')

    const historyTable = screen.getByRole('table', { name: '停止・復元の記録' })
    const historyCells = within(within(historyTable).getAllByRole('row')[1]).getAllByRole('cell')
    expect(historyCells[2].textContent).toBe('変更なし')
    expect(historyCells[2].textContent).not.toBe('停止')
    expect(historyCells[3].textContent).toBe('—')
    expect(historyCells[4].textContent).toBe('—')
  })

  it('読み込み中（state=null・error空）は再試行ボタンを出さず、エラー時だけ出す', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<RulesState state={null} error="" onRetry={onRetry} />)
    expect(screen.queryByRole('button')).toBeNull()

    rerender(<RulesState state={null} error="取得できませんでした" onRetry={onRetry} />)
    expect(screen.getByRole('button')).toBeTruthy()
  })
})
