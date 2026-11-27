// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasReadTerms } from './terms-state'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:9'
})

const termsAgreement = vi.hoisted(() => vi.fn())

vi.mock('@/lib/restaurant-test-api', async (importOriginal: () => Promise<typeof import('@/lib/restaurant-test-api')>) => {
  const actual = await importOriginal()
  return { ...actual, restaurantTestApi: { ...actual.restaurantTestApi, termsAgreement } }
})
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/restaurant-test/stores/new',
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => ({
  ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

import StoreNewV8 from './store-new'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  termsAgreement.mockReset().mockResolvedValue({ success: true, data: { agreedVersion: null, agreedAt: null } })
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

describe('restaurant/store-new/terms-state の未計測・不正スクロール計測ガード', () => {
  it('高さ0以下・負のスクロール・非有限の計測値では読了扱いにせず、正常な計測値は維持する', () => {
    expect(hasReadTerms({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 })).toBe(false)
    expect(hasReadTerms({ scrollTop: 0, clientHeight: 0, scrollHeight: 400 })).toBe(false)
    expect(hasReadTerms({ scrollTop: -10, clientHeight: 300, scrollHeight: 300 })).toBe(false)
    expect(hasReadTerms({ scrollTop: Number.NaN, clientHeight: 300, scrollHeight: 300 })).toBe(false)
    expect(hasReadTerms({ scrollTop: 0, clientHeight: Number.POSITIVE_INFINITY, scrollHeight: 300 })).toBe(false)

    expect(hasReadTerms({ scrollTop: 0, clientHeight: 220, scrollHeight: 1000 })).toBe(false)
    expect(hasReadTerms({ scrollTop: 780, clientHeight: 220, scrollHeight: 1000 })).toBe(true)
    expect(hasReadTerms({ scrollTop: 0, clientHeight: 220, scrollHeight: 225 })).toBe(true)
  })

  it('実画面でレイアウト未計測（高さ0）のまま同意チェックが有効にならない', async () => {
    render(<StoreNewV8 />)
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
  })
})
