// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ data: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/form-submissions/responses', useSearchParams: () => new URLSearchParams('id=form-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'demo', loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchApi: async (url: string) => ({ success: true, data: url.includes('/submissions') ? { items: fixture.data.map((data, i) => ({ id: String(i), formId: 'form-1', friendId: null, friendName: `見本${i}`, data, destinationWrite: { status: 'succeeded', attempted: 0, succeeded: 0, failed: 0 }, postActions: null, createdAt: '2026-11-27T00:00:00Z' })), total: fixture.data.length, page: 1, limit: 20 } : { id: 'form-1', name: '見本フォーム', fields: [], layout: { version: 2, header: [], sections: [], options: {} }, submitCount: fixture.data.length } }) }))
import FormResponses from './responses'
afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__'])('定義のない回答項目 %s を名前のまま表示する', async (key) => {
  fixture.data = [JSON.parse(`{"${key}":"見本の回答"}`)]
  render(<FormResponses />)
  expect(await screen.findByText(key)).toBeTruthy()
  expect(screen.getByText('見本の回答')).toBeTruthy()
})
