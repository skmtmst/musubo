// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ status: 'unknown' }))
vi.mock('@/lib/api', () => ({ api: { ops: { applications: { list: async () => ({ success: true, data: [{ id: 'sample', company_name: '見本の会社', contact_name: '見本', email: 'sample@example.invalid', phone: '', referral_source: '見本', created_at: '2026-11-01T00:00:00Z', status: state.status }] }) } } } }))
import OpsApplications from './applications'
afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__', 'future'])('未対応の申込状態 %s を確認できないと表示する', async status => {
  state.status = status
  render(<OpsApplications />)
  const row = (await screen.findByRole('link', { name: '見本の会社' })).closest('tr')!
  expect(within(row).getByText('状態不明')).toBeTruthy()
})
