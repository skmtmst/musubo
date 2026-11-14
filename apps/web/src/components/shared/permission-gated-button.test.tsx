// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { PERMISSION_LOCK_REASON } from './permission-lock'
import PermissionGatedButton from './permission-gated-button'

afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })

it('権限があれば押せて、押した処理が動く', () => {
  verifiedStaffRole('owner')
  const onClick = vi.fn()
  render(<PermissionGatedButton allowed onClick={onClick}>つなぐ</PermissionGatedButton>)
  const button = screen.getByRole('button', { name: 'つなぐ' })
  expect(button.getAttribute('aria-disabled')).toBeNull()
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledTimes(1)
})

it('権限が無くても隠さず灰色で出し、理由をつなぎ、押しても処理が動かない', () => {
  verifiedStaffRole('viewer')
  const onClick = vi.fn()
  render(<PermissionGatedButton allowed={false} onClick={onClick}>つなぐ</PermissionGatedButton>)
  const button = screen.getByRole('button', { name: 'つなぐ' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.body.textContent).toContain(PERMISSION_LOCK_REASON.viewer)
  fireEvent.click(button)
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(onClick).not.toHaveBeenCalled()
})

it('権限が無いリンクは行き先を残さない', () => {
  verifiedStaffRole('viewer')
  render(<PermissionGatedButton allowed={false} href="/broadcasts/new">配信を作る</PermissionGatedButton>)
  expect(document.querySelector('a[href="/broadcasts/new"]')).toBeNull()
  expect(screen.getByRole('button', { name: '配信を作る' }).getAttribute('aria-disabled')).toBe('true')
})

it('役割が読めるまでは理由を出さず、押せないだけにする', () => {
  forgetStaffIdentity()
  const onClick = vi.fn()
  render(<PermissionGatedButton allowed={false} onClick={onClick}>つなぐ</PermissionGatedButton>)
  const button = screen.getByRole('button', { name: 'つなぐ' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()
})
