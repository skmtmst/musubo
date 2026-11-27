// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ booking: false, key: null as string | null, style: 'restaurant', styleStatus: 'ready', featureStatus: 'ready', stale: false, reload: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/components/mobile/mobile-screen', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: fixture.featureStatus, enabled: () => true }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: fixture.styleStatus, stale: fixture.stale, data: { style: fixture.style }, reload: fixture.reload }) }))
vi.mock('@/components/mobile/mobile-shell', () => ({ useMobileShell: () => ({ canView: (key: string) => key === '/friends' || (fixture.booking && (fixture.key ? key === fixture.key : key === '/booking/bookings' || key === '/restaurant-test/reservations')) }) }))
import MobileMoreScreen from './more-screen'
afterEach(() => { cleanup(); fixture.styleStatus = 'ready'; fixture.featureStatus = 'ready'; fixture.stale = false; fixture.booking = false; fixture.key = null; fixture.reload.mockClear() })
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

it('飲食店の台帳は飲食店の権限がある場合だけ出す', () => {
 fixture.style = 'restaurant'; fixture.booking = true; fixture.key = '/booking/bookings'
 const view = render(<MobileMoreScreen />)
 expect(screen.queryByRole('link', { name: /予約台帳/ })).toBeNull()
 fixture.key = '/restaurant-test/reservations'; view.rerender(<MobileMoreScreen />)
 expect(screen.getByRole('link', { name: /予約台帳/ }).getAttribute('href')).toBe('/restaurant-test/reservations')
 fixture.booking = false; fixture.key = null
})

it('表示設定を読めないときは他の入口を残して読み直せる', () => {
 fixture.booking = true
 fixture.styleStatus = 'error'
 render(<MobileMoreScreen />)
 expect(screen.getByText('予約台帳の表示設定を読み込めませんでした')).toBeTruthy()
 expect(screen.getByRole('link', { name: /友だちを探す/ })).toBeTruthy()
 screen.getByRole('button', { name: /もう一度/ }).click()
 expect(fixture.reload).toHaveBeenCalled()
})

it('前の表示設定しか使えないときも読み直せる', () => {
 fixture.booking = true
 fixture.stale = true
 render(<MobileMoreScreen />)
 expect(screen.getByText('予約台帳の表示設定を読み込めませんでした')).toBeTruthy()
 screen.getByRole('button', { name: /もう一度/ }).click()
 expect(fixture.reload).toHaveBeenCalled()
})

it('利用機能を読めないときは入口を消すだけでなく開き直しを案内する', () => {
 fixture.booking = true
 fixture.featureStatus = 'error'
 render(<MobileMoreScreen />)
 expect(screen.getByText('予約台帳を利用できるか確認できませんでした')).toBeTruthy()
 expect(screen.getByText('画面を開き直してください。')).toBeTruthy()
 expect(screen.getByRole('link', { name: /通知/ })).toBeTruthy()
})

it('予約台帳の権限がない人には読み込み失敗の案内を出さない', () => {
 fixture.booking = false
 fixture.styleStatus = 'error'
 const view = render(<MobileMoreScreen />)
 expect(screen.queryByText('予約台帳の表示設定を読み込めませんでした')).toBeNull()
 fixture.styleStatus = 'ready'; fixture.featureStatus = 'error'
 view.rerender(<MobileMoreScreen />)
 expect(screen.queryByText('予約台帳を利用できるか確認できませんでした')).toBeNull()
 expect(screen.getByRole('link', { name: /通知/ })).toBeTruthy()
})
