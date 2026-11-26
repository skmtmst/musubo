// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
const fixture = vi.hoisted(() => ({ account: 'a', push: vi.fn(), create: vi.fn(), templates: vi.fn(), list: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/automations', useSearchParams: () => new URLSearchParams('tab=templates') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, automations: { ...actual.api.automations, templates: fixture.templates, list: fixture.list, createDraftFromTemplate: fixture.create } } } })
import AutomationTemplates from './templates'
beforeEach(() => { verifiedStaffRole('owner'); fixture.account = 'a'; fixture.push.mockReset(); fixture.create.mockReset(); fixture.templates.mockResolvedValue({ success: true, data: [{ key: 'sample', name: '見本', description: '', triggerLabel: '友だちになったとき', actionLabel: '返信する' }] }); fixture.list.mockResolvedValue({ success: true, data: [] }) })
afterEach(() => { cleanup(); clearToastsForTest() })
async function open() { const view = render(<><AutomationTemplates /><ToastHost /></>); await screen.findByRole('button', { name: 'この見本で下書きを作る' }); return view }
it('見本から下書きを作ると完了を知らせて進む', async () => {
 fixture.create.mockResolvedValueOnce({ success: true, data: { id: 'draft' } }); await open()
 await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'この見本で下書きを作る' })) })
 expect(await screen.findByText('見本から下書きを作りました。')).toBeTruthy(); expect(fixture.push).toHaveBeenCalledWith('/automations/drafts?id=draft')
})
it('下書きの作成に失敗したら完了を知らせず画面に残る', async () => {
 fixture.create.mockResolvedValueOnce({ success: false, error: '失敗' }); await open()
 await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'この見本で下書きを作る' })) })
 expect(screen.queryByText('見本から下書きを作りました。')).toBeNull(); expect(fixture.push).not.toHaveBeenCalled(); expect(screen.getByText('見本')).toBeTruthy()
})
it('アカウント切替後の古い作成結果で通知や遷移をしない', async () => {
 let resolve!: (v: unknown) => void; fixture.create.mockImplementationOnce(() => new Promise(done => { resolve = done })); const view = await open()
 fireEvent.click(screen.getByRole('button', { name: 'この見本で下書きを作る' })); fixture.account = 'b'; view.rerender(<><AutomationTemplates /><ToastHost /></>)
 await act(async () => { resolve({ success: true, data: { id: 'draft' } }) })
 expect(screen.queryByText('見本から下書きを作りました。')).toBeNull(); expect(fixture.push).not.toHaveBeenCalled()
})
