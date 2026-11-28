// @vitest-environment happy-dom
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { deferImpersonationSnapshot, forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { EmptyBookings } from './empty-bookings'

afterEach(() => {
  cleanup()
  forgetSessionSnapshot()
})

describe('EmptyBookings の権限種別理由と代理ログイン・役割未確認ガード', () => {
  it('担当者に権限が無いときは閲覧のみではなく機能権限の理由を吹き出しで出し、隠さず止める', () => {
    const onBook = vi.fn()

    render(
      <EmptyBookings
        style="salon"
        today={{ rows: [] }}
        canWrite={false}
        role="staff"
        onBook={onBook}
        onCreateClass={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: '予約を入れる' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('data-permission-locked')).toBe(true)
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.feature)
    fireEvent.click(button)
    expect(onBook).not.toHaveBeenCalled()
  })

  it('管理者でも閲覧の代理ログイン中は灰色＋代理ログイン理由で出し、直接のhandlerも止める', () => {
    rememberSessionSnapshot({
      impersonation: { id: 'imp-1', tenantId: 't-1', mode: 'read', piiRevealed: false, startedAt: '' },
      unfamiliarAt: null,
      stepUpMethod: 'none',
    })
    const onBook = vi.fn()
    const onCreateClass = vi.fn()

    const element = EmptyBookings({
      style: 'lesson',
      today: { rows: [] },
      canWrite: true,
      role: 'admin',
      onBook,
      onCreateClass,
    })!
    const action = element.props.action as ReactElement<{ onClick: () => void; lockedReason?: string }>
    expect(action.props.lockedReason).toBe(PERMISSION_LOCK_REASON.impersonation)
    action.props.onClick()
    expect(onCreateClass).not.toHaveBeenCalled()

    render(element)
    const button = screen.getByRole('button', { name: 'クラスを作る' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.impersonation)
    fireEvent.click(button)
    expect(onCreateClass).not.toHaveBeenCalled()
  })

  it('役割が未確認のあいだは canWrite が true でも直接のhandlerを止め、通常の管理者では実行する', () => {
    const onBook = vi.fn()

    const loadingEl = EmptyBookings({
      style: 'consult',
      today: { rows: [] },
      canWrite: true,
      role: null,
      onBook,
      onCreateClass: vi.fn(),
    })!
    const loadingAction = loadingEl.props.action as ReactElement<{ onClick: () => void; disabled: boolean; lockedReason?: string }>
    expect(loadingAction.props.disabled).toBe(true)
    expect(loadingAction.props.lockedReason).toBeUndefined()
    loadingAction.props.onClick()
    expect(onBook).not.toHaveBeenCalled()

    render(
      <EmptyBookings
        style="consult"
        today={{ rows: [] }}
        canWrite
        role="admin"
        onBook={onBook}
        onCreateClass={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '予約を入れる' }))
    expect(onBook).toHaveBeenCalledTimes(1)
  })

  it('表示中に閲覧の代理ログインへ切り替わったら即座に灰色＋理由へ更新し、押しても実行しない', () => {
    const onBook = vi.fn()

    render(
      <EmptyBookings
        style="salon"
        today={{ rows: [] }}
        canWrite
        role="admin"
        onBook={onBook}
        onCreateClass={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: '予約を入れる' })
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(onBook).toHaveBeenCalledTimes(1)

    act(() => {
      deferImpersonationSnapshot({ id: 'imp-live', tenantId: 't-1', mode: 'read', piiRevealed: false, startedAt: '' })
    })

    const lockedButton = screen.getByRole('button', { name: '予約を入れる' })
    expect(lockedButton.getAttribute('aria-disabled')).toBe('true')
    expect(lockedButton.hasAttribute('data-permission-locked')).toBe(true)
    fireEvent.focus(lockedButton)
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.impersonation)
    fireEvent.click(lockedButton)
    expect(onBook).toHaveBeenCalledTimes(1)

    act(() => {
      forgetSessionSnapshot()
    })

    const unlockedButton = screen.getByRole('button', { name: '予約を入れる' })
    expect(unlockedButton.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(unlockedButton)
    expect(onBook).toHaveBeenCalledTimes(2)
  })
})
