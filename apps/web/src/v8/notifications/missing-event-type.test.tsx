// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ eventType: null as unknown, mark: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'demo', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/api', () => ({ api: { notifications: { center: { list: async () => ({ success:true, data:{items:[{id:'n1',eventType:state.eventType,category:'update',title:'見本の通知',body:'見本',metadata:null,isRead:false,createdAt:'2026-11-27T00:00:00Z'}],counts:{all:1,error:0,update:1,unread:1},unreadCount:1} }), markRead:state.mark, markAllRead:vi.fn() } } } }))
import Notifications from './list'
afterEach(() => { cleanup(); vi.clearAllMocks() })
it.each([null, undefined, 42])('種類が確認できない通知 %s も表示して開ける', async eventType => {
  state.eventType = eventType
  state.mark.mockResolvedValue({success:true})
  render(<Notifications />)
  const title = await screen.findByText('見本の通知')
  const link = title.closest('a')!
  expect(link.getAttribute('href')).toBe('/updates')
  expect(link.textContent).toContain('詳細を見る')
  fireEvent.click(link)
  await waitFor(() => expect(state.mark).toHaveBeenCalled())
})
