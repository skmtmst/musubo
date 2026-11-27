// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ list: vi.fn(), catalog: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {} }), usePathname: () => '/hq/templates/starter-sets', useSearchParams: () => new URLSearchParams() }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle() {}, usePageCrumbs() {} }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', useTenantWideAccess: () => true }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { listStarterSets: net.list, catalog: net.catalog } }))
import Page from './starter-sets'
afterEach(cleanup)
it('未保存の変更があると配れない理由を表示する', async () => {
  net.list.mockResolvedValue({ success: true, data: [{ id: 'set', style: 'restaurant', name: '見本', version: 1, autoInsert: true, definition: { mode: 'catalog', items: [], selections: [] } }] })
  net.catalog.mockResolvedValue({ success: true, data: [] })
  render(<Page />)
  const distribute = await screen.findByRole('button', { name: '使っているアカウントへ配る' }) as HTMLButtonElement
  expect(distribute.disabled).toBe(false)
  fireEvent.click(screen.getByRole('switch'))
  expect(distribute.disabled).toBe(true)
  expect(screen.getByText('変更を保存してから配ってください。')).toBeTruthy()
})
