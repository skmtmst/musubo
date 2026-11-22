// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { formatDateTime } from '@/components/ops/ops-ui'
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ push, replace: vi.fn() }) }))
import OpsTenants from './tenants'
const tenant = { id: 't1', name: '契約先の正式な名前', status: 'suspended', featurePacks: ['restaurant'], plan_key: 'standard', plan_status: 'past_due', trial_ends_at: '2026-10-01T01:00:00Z', current_period_ends_at: '2026-11-01T02:00:00Z', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', account_count: 1, staff_count: 2, last_login_at: '2026-10-13T03:04:05Z' }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear() })
it('利用と請求・両日付・最終ログインを全文確認し、作成後は一覧の作成行へ戻る', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = path === '/api/ops/me' ? { success: true, data: { id: 'ops', name: '運営', readOnly: false } }
      : init?.method === 'POST' ? (writes.push(JSON.parse(String(init.body))), { success: true, data: { ...tenant, id: 'created-1' } })
        : { success: true, data: [tenant], summary: { active: 0, trialing: 0, suspended: 1, pastDue: 1 } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  render(<OpsTenants />)
  const name = await screen.findByRole('link', { name: tenant.name, exact: true })
  expect(new URL(name.getAttribute('href')!, 'https://fixture.invalid').searchParams.get('id')).toBe('t1')
  expect(screen.queryByRole('columnheader', { name: '飲食店機能' })).toBeNull()
  const row = name.closest('tr, [role="row"]')!
  const titles = [...row.querySelectorAll<HTMLElement>('[title]')].map(node => node.title)
  expect(titles.some(title => title.includes('利用停止') && title.includes('請求'))).toBe(true)
  expect(titles).toContain(`トライアル期限 ${formatDateTime(tenant.trial_ends_at)}・次回請求 ${formatDateTime(tenant.current_period_ends_at)}`)
  expect(titles).toContain(formatDateTime(tenant.last_login_at))
  fireEvent.click(await screen.findByRole('button', { name: '契約先を作る', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '契約先を作る', exact: true })
  expect(within(dialog).queryByText('飲食店機能')).toBeNull()
  fireEvent.change(within(dialog).getByRole('textbox', { name: '統括名（会社名）', exact: true }), { target: { value: '新しい会社' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '作る', exact: true }))
  await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
  const destination = new URL(push.mock.calls[0][0], 'https://fixture.invalid')
  expect(destination.pathname).toBe('/ops/tenants')
  expect([...destination.searchParams.values()]).toContain('created-1')
  expect(writes).toEqual([{ name: '新しい会社' }])
})
