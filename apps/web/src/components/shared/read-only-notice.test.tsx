// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import ReadOnlyNotice, { ADMIN_LOCK_SUMMARY, READ_ONLY_MESSAGE, READ_ONLY_MESSAGE_HQ } from './read-only-notice'
import { PERMISSION_LOCK_SUMMARY } from './permission-lock'

beforeEach(() => { forgetStaffIdentity(); forgetSessionSnapshot() })
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.unstubAllGlobals() })
const identity = (role: 'viewer' | 'owner') => rememberStaffIdentity({ role } as StaffMember)
const session = (mode: 'read' | 'write') => rememberSessionSnapshot({ impersonation: { mode } } as unknown as Parameters<typeof rememberSessionSnapshot>[0])
const matrix = (['store', 'hq'] as const).flatMap(scope => (['viewer', 'owner'] as const).flatMap(role => [false, true].map(withChildren => ({ scope, role, withChildren }))))

it.each(matrix)('本人未確定では帯を出さず、確定と失効に追従する: %j', ({ scope, role, withChildren }) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const child = withChildren ? <strong>以前から渡している補足</strong> : undefined
  const view = render(<ReadOnlyNotice scope={scope}>{child}</ReadOnlyNotice>)
  expect(view.container.querySelector('[data-read-only-notice]')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  act(() => { identity(role) })
  const expected = scope === 'store' && withChildren ? '以前から渡している補足'
    : role === 'viewer' ? scope === 'hq' ? READ_ONLY_MESSAGE_HQ : READ_ONLY_MESSAGE
      : PERMISSION_LOCK_SUMMARY[scope === 'hq' ? 'tenantWide' : 'feature']
  expect(screen.getByRole('status').textContent).toBe(expected)
  expect(view.container.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
  if (scope === 'store' && withChildren) expect(screen.getByRole('status').querySelector('strong')).not.toBeNull()
  act(() => { forgetStaffIdentity() })
  expect(screen.queryByRole('status')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it.each((['store', 'hq'] as const).flatMap(scope => [false, true].map(withChildren => ({ scope, withChildren }))))('代理閲覧の理由は旧childrenより優先し、書込への切替で戻る: %j', ({ scope, withChildren }) => {
  identity('owner'); session('write')
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  render(<ReadOnlyNotice scope={scope}>{withChildren ? '以前から渡している補足' : undefined}</ReadOnlyNotice>)
  const original = screen.getByRole('status').textContent
  act(() => { session('read') })
  expect(screen.getByRole('status').textContent).toBe(PERMISSION_LOCK_SUMMARY.impersonation)
  expect(screen.getAllByRole('status')).toHaveLength(1)
  act(() => { session('write') })
  expect(screen.getByRole('status').textContent).toBe(original)
  expect(fetch).not.toHaveBeenCalled()
})

it('代理閲覧が分かっていても本人未確定なら拒否帯を出さない', () => {
  session('read')
  render(<ReadOnlyNotice>以前から渡している補足</ReadOnlyNotice>)
  expect(screen.queryByRole('status')).toBeNull()
})
it('必要権限を明示した帯は旧childrenで置き換えない', () => {
  identity('owner')
  render(<ReadOnlyNotice need="owner">以前から渡している補足</ReadOnlyNotice>)
  expect(screen.getByRole('status').textContent).toBe(PERMISSION_LOCK_SUMMARY.owner)
})
it.each(['readOnly', 'view_only'])('閲覧のみの束は元のowner役割より優先する: %s', mode => {
  rememberStaffIdentity({ role: 'owner', readOnly: mode === 'readOnly', roleBundle: mode === 'view_only' ? 'view_only' : undefined } as StaffMember)
  render(<ReadOnlyNotice />)
  expect(screen.getByRole('status').textContent).toBe(READ_ONLY_MESSAGE)
})

// 本線の知らせの印の対照は、本人が確定した実表示で保持する。
it('本人確定後の閲覧帯は青い点で、iと目の印を使わない', () => {
  identity('viewer')
  const view = render(<ReadOnlyNotice />)
  expect(view.container.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
  expect(screen.getByRole('status').textContent).toBe(READ_ONLY_MESSAGE)
  expect(screen.getByRole('status').getAttribute('data-tone')).toBe('info')
  expect(view.container.querySelector('[data-notice-dot="true"]')).not.toBeNull()
  expect(view.container.querySelector('.lucide-info')).toBeNull()
  expect(view.container.querySelector('.lucide-eye')).toBeNull()
})

it('管理者が店の画面で権限不足の帯を見るときはオーナーへ依頼する文にし、担当者は従来の文を保つ', () => {
  rememberStaffIdentity({ role: 'admin' } as StaffMember)
  const { rerender } = render(<ReadOnlyNotice need="feature" />)
  expect(screen.getByRole('status').textContent).toBe(ADMIN_LOCK_SUMMARY)
  expect(screen.getByRole('status').textContent).not.toContain('管理者に頼んでください')

  rerender(<ReadOnlyNotice scope="hq" need="feature" />)
  expect(screen.getByRole('status').textContent).toBe(PERMISSION_LOCK_SUMMARY.tenantWide)

  act(() => { rememberStaffIdentity({ role: 'staff' } as StaffMember) })
  rerender(<ReadOnlyNotice need="feature" />)
  expect(screen.getByRole('status').textContent).toBe(PERMISSION_LOCK_SUMMARY.feature)
})
