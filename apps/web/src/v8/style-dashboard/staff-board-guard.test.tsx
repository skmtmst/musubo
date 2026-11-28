// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StyleBoard } from './model'
import { StaffBoard } from './staff-board'

const board: StyleBoard = {
  from: '10:00',
  to: '13:00',
  columns: [
    { id: 'staff-1', name: '担当A', initial: 'A', tone: 'blue', count: 2, next: '12:00' },
  ],
  entries: [
    { id: 'b-1', columnId: 'staff-1', start: '10:00', end: '11:00', name: '佐藤', menu: 'カット', state: 'booked', stateLabel: '予約済み' },
    { id: 'b-2', columnId: 'staff-1', start: '11:00', end: '12:00', name: '鈴木', menu: 'カラー', state: 'booked', stateLabel: '予約済み' },
  ],
  free: [],
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('台帳の盤の検索絞り込み時の操作メニュー閉じ制御', () => {
  it('予約の操作メニューを開いたあと検索でその予約が消えるとメニューも閉じ、検索を戻しても再表示しない', () => {
    const props = {
      board,
      onSearch: vi.fn(),
      canWrite: true,
      entryItems: (entry: StyleBoard['entries'][number]) => [
        { id: 'detail', label: `${entry.name}の詳細を開く`, onSelect: vi.fn() },
      ],
      onSlot: vi.fn(),
    }

    const view = render(<StaffBoard {...props} search="" />)

    const satoBlock = screen.getByRole('button', { name: /佐藤/ })
    fireEvent.click(satoBlock)
    expect(screen.getByRole('menu', { name: '佐藤の操作' })).toBeTruthy()

    // 検索で佐藤を画面から隠すと操作メニューも即座に閉じる
    view.rerender(<StaffBoard {...props} search="鈴木" />)
    expect(screen.queryByRole('menu', { name: '佐藤の操作' })).toBeNull()

    // 検索を解除しても以前のメニューが勝手に開き直さない
    view.rerender(<StaffBoard {...props} search="" />)
    expect(screen.queryByRole('menu', { name: '佐藤の操作' })).toBeNull()
  })
})
