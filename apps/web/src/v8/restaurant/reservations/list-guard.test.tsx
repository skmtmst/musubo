// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReservationBoardEntry } from '@line-crm/shared'
import ListView from './list'
import { reservation } from '../booking-kit/test-data'

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))

vi.mock('@/lib/api/helpers/reservation-board', () => ({
  reservationBoardApi: { floors: async () => ({ data: [] }) },
  allBoardPages: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/components/shared/reservation-board', () => ({
  default: ({
    entries,
    actions,
    trailingToolbar,
  }: {
    entries: ReservationBoardEntry[]
    actions?: (entry: ReservationBoardEntry) => ReactNode
    trailingToolbar?: ReactNode
  }) => (
    <div>
      <div data-testid="trailing-toolbar">{trailingToolbar}</div>
      <div data-testid="board-rows">
        {entries.map((entry) => (
          <div key={entry.id} data-testid={`row-${entry.id}`}>
            {actions ? actions(entry) : null}
          </div>
        ))}
      </div>
    </div>
  ),
}))

vi.mock('@/components/shared/row-actions', () => ({
  RowActions: ({
    subjectName,
    edit,
    menuItems,
  }: {
    subjectName: string
    edit?: { label: string; disabled?: boolean; onClick: () => void }
    menuItems?: Array<{ id: string; label: string; disabled?: boolean; onSelect?: () => void }>
  }) => (
    <div>
      {edit ? (
        <button
          type="button"
          data-disabled-prop={String(Boolean(edit.disabled))}
          onClick={edit.onClick}
        >
          {`${subjectName}:${edit.label}`}
        </button>
      ) : null}
      {(menuItems ?? []).map((item) => (
        <button
          key={item.id}
          type="button"
          data-disabled-prop={String(Boolean(item.disabled))}
          onClick={() => item.onSelect?.()}
        >
          {`${subjectName}:${item.label}`}
        </button>
      ))}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
})

const ROWS = [
  reservation('r-live', { customer_name: '田中太郎', status: 'confirmed' }),
  reservation('r-cancelled', { customer_name: '佐藤花子', status: 'cancelled' }),
]

describe('予約台帳一覧の操作ガード', () => {
  it('処理中は変更・取消・有効に戻す・手動予約・受信データ試しを無効かつコールバック側でも止める', () => {
    const onImport = vi.fn()
    const onCreate = vi.fn()
    const onEdit = vi.fn()
    const onOpen = vi.fn()
    const onCancel = vi.fn()
    const onRestore = vi.fn()

    render(
      <ListView
        view="list"
        rows={ROWS as never}
        total={2}
        tables={[]}
        page={1}
        period="all"
        status="all"
        busy
        canWrite
        canImport
        day={new Date('2026-10-14T03:00:00Z')}
        onDay={vi.fn()}
        storeId="store-1"
        storeName="試験店"
        onView={vi.fn()}
        onPeriod={vi.fn()}
        onStatus={vi.fn()}
        onPage={vi.fn()}
        onImport={onImport}
        onCreate={onCreate}
        onEdit={onEdit}
        onOpen={onOpen}
        onCancel={onCancel}
        onRestore={onRestore}
      />,
    )

    const importBtn = screen.getByRole('button', { name: '受信データを試す' }) as HTMLButtonElement
    expect(importBtn.disabled).toBe(true)
    importBtn.removeAttribute('disabled')
    fireEvent.click(importBtn)
    expect(onImport).not.toHaveBeenCalled()

    const createBtn = screen.getByRole('button', { name: '手動で予約を作る' }) as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)
    createBtn.removeAttribute('disabled')
    fireEvent.click(createBtn)
    expect(onCreate).not.toHaveBeenCalled()

    const editBtn = screen.getByRole('button', { name: '田中太郎:変更' })
    expect(editBtn.getAttribute('data-disabled-prop')).toBe('true')
    fireEvent.click(editBtn)
    expect(onEdit).not.toHaveBeenCalled()

    const cancelBtn = screen.getByRole('button', { name: '田中太郎:取消' })
    expect(cancelBtn.getAttribute('data-disabled-prop')).toBe('true')
    fireEvent.click(cancelBtn)
    expect(onCancel).not.toHaveBeenCalled()

    const restoreBtn = screen.getByRole('button', { name: '佐藤花子:予約を有効に戻す' })
    expect(restoreBtn.getAttribute('data-disabled-prop')).toBe('true')
    fireEvent.click(restoreBtn)
    expect(onRestore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '田中太郎:詳細を見る' }))
    expect(onOpen).toHaveBeenCalledWith('r-live')
  })

  it('閲覧のみのときは書き込み系の行アクションを出さず、詳細を見るだけ残す', () => {
    render(
      <ListView
        view="list"
        rows={ROWS as never}
        total={2}
        tables={[]}
        page={1}
        period="all"
        status="all"
        busy={false}
        canWrite={false}
        canImport={false}
        day={new Date('2026-10-14T03:00:00Z')}
        onDay={vi.fn()}
        storeId="store-1"
        storeName="試験店"
        onView={vi.fn()}
        onPeriod={vi.fn()}
        onStatus={vi.fn()}
        onPage={vi.fn()}
        onImport={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onOpen={vi.fn()}
        onCancel={vi.fn()}
        onRestore={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: '田中太郎:変更' })).toBeNull()
    expect(screen.queryByRole('button', { name: '田中太郎:取消' })).toBeNull()
    expect(screen.queryByRole('button', { name: '佐藤花子:予約を有効に戻す' })).toBeNull()
    expect(screen.getByRole('button', { name: '田中太郎:詳細を見る' })).toBeTruthy()
  })

  it('書き込み可能かつ待機中のときは各操作をそのまま実行する', () => {
    const onImport = vi.fn()
    const onCreate = vi.fn()
    const onEdit = vi.fn()
    const onOpen = vi.fn()
    const onCancel = vi.fn()
    const onRestore = vi.fn()

    render(
      <ListView
        view="list"
        rows={ROWS as never}
        total={2}
        tables={[]}
        page={1}
        period="all"
        status="all"
        busy={false}
        canWrite
        canImport
        day={new Date('2026-10-14T03:00:00Z')}
        onDay={vi.fn()}
        storeId="store-1"
        storeName="試験店"
        onView={vi.fn()}
        onPeriod={vi.fn()}
        onStatus={vi.fn()}
        onPage={vi.fn()}
        onImport={onImport}
        onCreate={onCreate}
        onEdit={onEdit}
        onOpen={onOpen}
        onCancel={onCancel}
        onRestore={onRestore}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '受信データを試す' }))
    fireEvent.click(screen.getByRole('button', { name: '手動で予約を作る' }))
    fireEvent.click(screen.getByRole('button', { name: '田中太郎:変更' }))
    fireEvent.click(screen.getByRole('button', { name: '田中太郎:取消' }))
    fireEvent.click(screen.getByRole('button', { name: '佐藤花子:予約を有効に戻す' }))
    fireEvent.click(screen.getByRole('button', { name: '佐藤花子:詳細を見る' }))

    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith('r-live')
    expect(onCancel).toHaveBeenCalledWith('r-live')
    expect(onRestore).toHaveBeenCalledWith('r-cancelled')
    expect(onOpen).toHaveBeenCalledWith('r-cancelled')
  })
})
