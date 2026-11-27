// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReservationBoardEntry } from '@line-crm/shared'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
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

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  forgetSessionSnapshot()
})

const ROWS = [
  reservation('r-live', { customer_name: '田中太郎', status: 'confirmed' }),
  reservation('r-cancelled', { customer_name: '佐藤花子', status: 'cancelled' }),
]

describe('予約台帳一覧の操作ガードと閲覧のみ表示', () => {
  it('処理中は変更・取消・有効に戻す・手動予約・受信データ試しを押し止め、コールバック側でも実行しない', () => {
    verifiedStaffRole('owner')
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

    fireEvent.click(screen.getByRole('button', { name: '田中太郎のその他操作' }))
    const editItem = screen.getByRole('menuitem', { name: '変更' }) as HTMLButtonElement
    const cancelItem = screen.getByRole('menuitem', { name: '取消' }) as HTMLButtonElement
    expect(editItem.disabled).toBe(true)
    expect(cancelItem.disabled).toBe(true)
    fireEvent.click(editItem)
    fireEvent.click(cancelItem)
    expect(onEdit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: '詳細を見る' }))
    expect(onOpen).toHaveBeenCalledWith('r-live')

    fireEvent.click(screen.getByRole('button', { name: '佐藤花子のその他操作' }))
    const restoreItem = screen.getByRole('menuitem', { name: '予約を有効に戻す' }) as HTMLButtonElement
    expect(restoreItem.disabled).toBe(true)
    fireEvent.click(restoreItem)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('閲覧のみのときは行操作を隠さず押せない形で出し、理由の吹き出しを表示して実行を止める', () => {
    verifiedStaffRole('viewer')
    const onEdit = vi.fn()
    const onCancel = vi.fn()
    const onRestore = vi.fn()
    const onOpen = vi.fn()

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
        onEdit={onEdit}
        onOpen={onOpen}
        onCancel={onCancel}
        onRestore={onRestore}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '田中太郎のその他操作' }))
    const editItem = screen.getByRole('menuitem', { name: '変更' })
    const cancelItem = screen.getByRole('menuitem', { name: '取消' })
    expect(editItem.getAttribute('aria-disabled')).toBe('true')
    expect(editItem.hasAttribute('data-permission-locked')).toBe(true)
    expect(cancelItem.getAttribute('aria-disabled')).toBe('true')
    expect(cancelItem.hasAttribute('data-permission-locked')).toBe(true)

    act(() => { (editItem as HTMLElement).focus() })
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.viewer)
    fireEvent.pointerEnter(cancelItem, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.viewer)

    fireEvent.click(editItem)
    fireEvent.click(cancelItem)
    expect(onEdit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: '詳細を見る' }))
    expect(onOpen).toHaveBeenCalledWith('r-live')

    fireEvent.click(screen.getByRole('button', { name: '佐藤花子のその他操作' }))
    const restoreItem = screen.getByRole('menuitem', { name: '予約を有効に戻す' })
    expect(restoreItem.getAttribute('aria-disabled')).toBe('true')
    expect(restoreItem.hasAttribute('data-permission-locked')).toBe(true)
    fireEvent.pointerEnter(restoreItem, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.viewer)
    fireEvent.click(restoreItem)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('書き込み可能かつ待機中のときは各操作をそのまま実行する', () => {
    verifiedStaffRole('owner')
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

    fireEvent.click(screen.getByRole('button', { name: '田中太郎のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '変更' }))

    fireEvent.click(screen.getByRole('button', { name: '田中太郎のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '佐藤花子のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '予約を有効に戻す' }))

    fireEvent.click(screen.getByRole('button', { name: '佐藤花子のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '詳細を見る' }))

    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith('r-live')
    expect(onCancel).toHaveBeenCalledWith('r-live')
    expect(onRestore).toHaveBeenCalledWith('r-cancelled')
    expect(onOpen).toHaveBeenCalledWith('r-cancelled')
  })
})
