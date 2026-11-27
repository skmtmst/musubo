// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { ReservationFormRepairNotices } from './setup-card'

const NOTICES = [
  { message: '予約フォームの項目に不備があります。', href: '/forms/edit?id=form-1' },
] as const

afterEach(() => {
  cleanup()
  forgetSessionSnapshot()
})

describe('ReservationFormRepairNotices の権限・代理ログイン表示', () => {
  it('役割が未確認のあいだは誤った権限理由を出さず、押せないボタンだけにする', () => {
    render(<ReservationFormRepairNotices notices={NOTICES} role={null} />)

    const button = screen.getByRole('button', { name: '予約フォームを直す →' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.hasAttribute('data-permission-locked')).toBe(false)
    expect(screen.queryByRole('link', { name: '予約フォームを直す →' })).toBeNull()
    fireEvent.focus(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('閲覧のみのときは隠さず灰色＋理由の吹き出しで出し、遷移リンクを置かない', () => {
    render(<ReservationFormRepairNotices notices={NOTICES} role="viewer" />)

    const button = screen.getByRole('button', { name: '予約フォームを直す →' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('data-permission-locked')).toBe(true)
    expect(screen.queryByRole('link', { name: '予約フォームを直す →' })).toBeNull()
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.viewer)
  })

  it('オーナーでも閲覧の代理ログイン中はリンクを外し、代理ログイン理由の吹き出しで止める', () => {
    render(<ReservationFormRepairNotices notices={NOTICES} role="owner" />)

    expect(screen.getByRole('link', { name: '予約フォームを直す →' }).getAttribute('href')).toBe('/forms/edit?id=form-1')

    act(() => {
      rememberSessionSnapshot({
        impersonation: { id: 'imp-1', tenantId: 't-1', mode: 'read', piiRevealed: false, startedAt: '' },
        unfamiliarAt: null,
        stepUpMethod: 'none',
      })
    })

    expect(screen.queryByRole('link', { name: '予約フォームを直す →' })).toBeNull()
    const locked = screen.getByRole('button', { name: '予約フォームを直す →' })
    expect(locked.getAttribute('aria-disabled')).toBe('true')
    expect(locked.hasAttribute('data-permission-locked')).toBe(true)
    fireEvent.focus(locked)
    expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.impersonation)
  })
})
