// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/nen-members', useSearchParams: () => new URLSearchParams('') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'demo', accounts: [], loading: false }) }))
import PhotoReview from './review'
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://worker.test').pathname
    const data = path.endsWith('/review-metrics') ? { pendingCount: 0, reviewedCount: 0, averageReviewMinutes: null, oldestPendingAt: null, attentionCount: 0 } : path.endsWith('/publications') ? { summary: { publishedCount: 0 }, items: [], pendingWithdrawals: [], withdrawnItems: [] } : []
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it.each(['constructor', '__proto__'])('URLの未知の状態 %s は審査待ちで開く', async value => {
  window.history.replaceState(null, '', `/nen-members?tab=photos&status=${value}`)
  render(<PhotoReview accountId="demo" />)
  const tab = await screen.findByRole('tab', { name: /審査待ち/ })
  expect(tab.getAttribute('aria-selected')).toBe('true')
})
