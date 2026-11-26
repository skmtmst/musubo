// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', selectedAccount: { name: '架空の店' } }) }))
vi.mock('@/lib/staff-role', () => ({ canManageRole: () => true, useStaffRole: () => 'owner' }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: () => undefined }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: async () => ({ success: true, data: { style: 'restaurant', styleSelected: true } }) } }))
import StyleEntry from './style-entry'
afterEach(cleanup)
it('設定の入口は閉じた後の戻り先を渡す', async () => {
  render(<StyleEntry />)
  const link = await screen.findByRole('link', { name: 'スタイルを変更する' })
  const url = new URL(link.getAttribute('href')!, 'http://localhost')
  expect(url.pathname).toBe('/')
  expect(url.searchParams.get('setup')).toBe('0')
  expect(url.searchParams.get('setupReturn')).toBe('accounts')
})
