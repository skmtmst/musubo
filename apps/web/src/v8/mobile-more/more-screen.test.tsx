// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ booking: false, style: 'restaurant' }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/components/mobile/mobile-screen', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: 'ready', data: { style: fixture.style } }) }))
vi.mock('@/components/mobile/mobile-shell', () => ({ useMobileShell: () => ({ canView: (key: string) => key === '/friends' || (fixture.booking && key === '/booking/bookings') }) }))
import MobileMoreScreen from './more-screen'
afterEach(cleanup)
it('権限がある画面だけへの入口とPC画面で開く案内を出す', () => {
 render(<MobileMoreScreen />)
 expect(screen.getByRole('link', { name: /友だちを探す/ }).getAttribute('href')).toBe('/friends')
 expect(screen.queryByRole('link', { name: /予約台帳/ })).toBeNull()
 expect(screen.getByRole('link', { name: /通知/ }).getAttribute('href')).toBe('/notifications')
 expect(screen.getAllByText('PC の画面で開く')).toHaveLength(2)
})

it('飲食店は飲食の予約台帳、ほかは一般の予約台帳へ移る', () => {
 fixture.booking = true; fixture.style = 'restaurant'
 const view = render(<MobileMoreScreen />)
 expect(screen.getByRole('link', { name: /予約台帳/ }).getAttribute('href')).toBe('/restaurant-test/reservations')
 fixture.style = 'salon'; view.rerender(<MobileMoreScreen />)
 expect(screen.getByRole('link', { name: /予約台帳/ }).getAttribute('href')).toBe('/booking/bookings')
 fixture.booking = false
})
