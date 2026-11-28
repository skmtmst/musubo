// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import TableRowActions from './table-row-actions'

vi.mock('@/components/shared/row-actions', () => ({
  RowActions: ({
    edit,
    menuItems,
  }: {
    edit?: { label?: string; disabled?: boolean; lockedReason?: string; onClick?: () => void }
    menuItems?: Array<{ id: string; label: string; disabled?: boolean; lockedReason?: string; onSelect?: () => void }>
  }) => (
    <div>
      {edit ? (
        <button
          type="button"
          data-locked-reason={edit.lockedReason ?? ''}
          onClick={() => edit.onClick?.()}
        >
          {edit.label ?? '編集'}
        </button>
      ) : null}
      {(menuItems ?? []).map((item) => (
        <button
          key={item.id}
          type="button"
          data-locked-reason={item.lockedReason ?? ''}
          onClick={() => item.onSelect?.()}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}))

const ACTIVE_TABLE = {
  id: 't-1',
  code: 'T1',
  label: '窓際4名席',
  is_active: 1,
} as unknown as RestaurantTable

const STOPPED_TABLE = {
  id: 't-2',
  code: 'T2',
  label: '個室6名席',
  is_active: 0,
} as unknown as RestaurantTable

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  forgetSessionSnapshot()
})

describe('TableRowActions のコールバック側ガード', () => {
  it('閲覧のみのときは全操作を理由付きで残しつつ、コールバック側でも実行を止める', () => {
    verifiedStaffRole('viewer')
    const onEdit = vi.fn()
    const onDuplicate = vi.fn()
    const onStop = vi.fn()
    const onResume = vi.fn()
    const onDelete = vi.fn()

    render(
      <TableRowActions
        table={ACTIVE_TABLE}
        canEdit={false}
        busy={false}
        pendingAccount={false}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onStop={onStop}
        onResume={onResume}
        onDelete={onDelete}
      />,
    )

    for (const name of ['変更', '複製', '停止', '削除']) {
      const btn = screen.getByRole('button', { name })
      expect(btn.getAttribute('data-locked-reason')).toBe(PERMISSION_LOCK_REASON.viewer)
      fireEvent.click(btn)
    }

    expect(onEdit).not.toHaveBeenCalled()
    expect(onDuplicate).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('処理中とアカウント切替中はコールバック側でも全操作を止める', () => {
    verifiedStaffRole('owner')
    const onEdit = vi.fn()
    const onDuplicate = vi.fn()
    const onStop = vi.fn()
    const onResume = vi.fn()
    const onDelete = vi.fn()

    const { rerender } = render(
      <TableRowActions
        table={ACTIVE_TABLE}
        canEdit
        busy
        pendingAccount={false}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onStop={onStop}
        onResume={onResume}
        onDelete={onDelete}
      />,
    )

    for (const name of ['変更', '複製', '停止', '削除']) {
      fireEvent.click(screen.getByRole('button', { name }))
    }

    rerender(
      <TableRowActions
        table={STOPPED_TABLE}
        canEdit
        busy={false}
        pendingAccount
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onStop={onStop}
        onResume={onResume}
        onDelete={onDelete}
      />,
    )

    for (const name of ['変更', '複製', '再開', '削除']) {
      fireEvent.click(screen.getByRole('button', { name }))
    }

    expect(onEdit).not.toHaveBeenCalled()
    expect(onDuplicate).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(onResume).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('編集可能かつ待機中のときは5操作すべて対象テーブルで実行する', () => {
    verifiedStaffRole('owner')
    const onEdit = vi.fn()
    const onDuplicate = vi.fn()
    const onStop = vi.fn()
    const onResume = vi.fn()
    const onDelete = vi.fn()

    const { rerender } = render(
      <TableRowActions
        table={ACTIVE_TABLE}
        canEdit
        busy={false}
        pendingAccount={false}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onStop={onStop}
        onResume={onResume}
        onDelete={onDelete}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '変更' }))
    fireEvent.click(screen.getByRole('button', { name: '複製' }))
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    rerender(
      <TableRowActions
        table={STOPPED_TABLE}
        canEdit
        busy={false}
        pendingAccount={false}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onStop={onStop}
        onResume={onResume}
        onDelete={onDelete}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '再開' }))

    expect(onEdit).toHaveBeenCalledWith(ACTIVE_TABLE)
    expect(onDuplicate).toHaveBeenCalledWith(ACTIVE_TABLE)
    expect(onStop).toHaveBeenCalledWith(ACTIVE_TABLE)
    expect(onDelete).toHaveBeenCalledWith(ACTIVE_TABLE)
    expect(onResume).toHaveBeenCalledWith(STOPPED_TABLE)
  })
})
