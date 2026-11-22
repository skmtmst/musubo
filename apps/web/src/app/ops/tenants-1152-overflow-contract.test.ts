// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import OpsTenantsV8 from '@/v8/ops/tenants'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/ops/tenants' }))
vi.mock('@/v8/ops/use-ops-read-only', () => ({ useOpsReadOnly: () => false, useOpsReadOnlyState: () => 'writer' as const }))
vi.mock('@/lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: { ops: { tenants: async () => ({ success: true, summary: { active: 1, trialing: 0, suspended: 0, pastDue: 0 }, data: [{
    id: 'tenant', name: '検証商事', status: 'active', plan_status: 'active', plan_key: 'standard',
    account_count: 2, staff_count: 5, created_at: '2026-04-01T00:00:00Z', last_login_at: '2026-10-01T00:00:00Z',
    current_period_ends_at: '2026-11-01T00:00:00Z', trial_ends_at: null, featurePacks: ['restaurant'],
  }] }) } },
}))
afterEach(cleanup)

it('名前と詳細への入口を保ち、狭幅の補助列を見出しと本文で同じように指定する', async () => {
  render(React.createElement(OpsTenantsV8))
  const name = await screen.findByRole('link', { name: '検証商事' })
  expect(name.getAttribute('href')).toBe('/ops/tenants/detail?id=tenant')
  expect(name.getAttribute('title')).toBe('検証商事')
  const row = name.closest('tr')!
  for (const label of ['店舗', '権限者', '契約日']) {
    const head = screen.getByRole('columnheader', { name: label })
    const index = [...head.parentElement!.children].indexOf(head)
    expect(head.getAttribute('data-cell-collapse')).toBe('narrow')
    expect(row.children[index].getAttribute('data-cell-collapse')).toBe('narrow')
  }
  expect(screen.queryByRole('columnheader', { name: '飲食店機能' })).toBeNull()
  expect(row.querySelector('[data-list-number]')?.textContent).toBe('2')
})
