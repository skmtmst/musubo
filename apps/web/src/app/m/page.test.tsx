// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ replace: vi.fn(), style: 'restaurant', status: 'ready', stylePending: false, tabs: [{ href: '/m/today' }, { href: '/m/chats' }, { href: '/m/todo' }] }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fixture.replace }) }))
vi.mock('@/components/mobile/mobile-screen', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock('@/components/mobile/mobile-shell', () => ({ useMobileShell: () => ({ tabs: fixture.tabs, ready: true, stylePending: fixture.stylePending }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: fixture.status, data: { style: fixture.style }, stale: false }) }))
import MobileHomePage from './page'
beforeEach(() => { fixture.replace.mockClear(); fixture.style = 'restaurant'; fixture.status = 'ready'; fixture.stylePending = false; fixture.tabs = [{ href: '/m/today' }, { href: '/m/chats' }, { href: '/m/todo' }] })
afterEach(cleanup)
it('飲食店は今日から、その他はトークから開く', async () => {
 const view = render(<MobileHomePage />)
 await waitFor(() => expect(fixture.replace).toHaveBeenCalledWith('/m/today'))
 view.unmount(); fixture.replace.mockClear(); fixture.style = 'salon'
 render(<MobileHomePage />)
 await waitFor(() => expect(fixture.replace).toHaveBeenCalledWith('/m/chats'))
})
it('業種確認中は移動せず、優先タブの権限が無ければ利用可能なタブへ', async () => {
 fixture.status = 'loading'; const view = render(<MobileHomePage />)
 expect(fixture.replace).not.toHaveBeenCalled()
 fixture.status = 'ready'; fixture.stylePending = false; fixture.tabs = [{ href: '/m/todo' }]; view.rerender(<MobileHomePage />)
 await waitFor(() => expect(fixture.replace).toHaveBeenCalledWith('/m/todo'))
})

it('外枠が業種を確認中は、優先タブの判定を待つ', () => {
 fixture.stylePending = true
 render(<MobileHomePage />)
 expect(fixture.replace).not.toHaveBeenCalled()
})
