// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { ConversionDefinitionPreview } from '@/lib/api'

const state = vi.hoisted(() => ({
  previewCalls: 0,
  previewResults: [] as Array<{ ok: boolean; data?: ConversionDefinitionPreview }>,
  funnelsCalls: 0,
  funnelsFailFirst: false,
}))

vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/conversions/new',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => verifiedStaffRole('owner') }
})

import ConversionCreateV8 from './create'

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const SAMPLE_PREVIEW: ConversionDefinitionPreview = {
  range: { from: '2026-09-01', to: '2026-09-30', timeZone: 'Asia/Tokyo' },
  matchedCount: 40,
  estimatedCount: 38,
  estimatedValue: 320000,
  duplicateExcludedCount: 1,
  cancellationCount: 1,
  excludedReasons: [],
  missingValueCount: 0,
  dailyAverage: 1,
  deduplicationWindowDays: null,
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  state.previewCalls = 0
  state.previewResults = []
  state.funnelsCalls = 0
  state.funnelsFailFirst = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/conversions/points') {
      return json({ success: true, data: [] })
    }
    if (url.pathname === '/api/conversions/definitions/preview') {
      state.previewCalls += 1
      const next = state.previewResults.shift() ?? { ok: true, data: SAMPLE_PREVIEW }
      if (!next.ok) return json({ success: false, error: 'temporary failure' }, 500)
      return json({ success: true, data: next.data ?? SAMPLE_PREVIEW })
    }
    if (url.pathname === '/api/analytics/funnels') {
      state.funnelsCalls += 1
      if (state.funnelsFailFirst && state.funnelsCalls === 1) {
        return json({ success: false, error: 'funnels down' }, 500)
      }
      return json({
        success: true,
        data: [{ id: 'fn-1', name: '初回購入ファネル', windowDays: 30, createdAt: '', status: 'active', currentVersion: { id: 'fv-1', versionNumber: 1, createdAt: '' }, migrationState: 'ready' }],
      })
    }
    return json({ success: true, data: [] })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  verifiedStaffRole(null)
  delete document.documentElement.dataset.theme
})

describe('ConversionCreateV8 の試算・使う場所の読み込み失敗と再読み込み', () => {
  it('試算の読み込みに失敗したとき、その場から再読み込みして見込み件数を回復できる', async () => {
    state.previewResults = [{ ok: false }, { ok: true, data: SAMPLE_PREVIEW }]

    render(<ConversionCreateV8 />)

    const card = document.querySelector<HTMLElement>('[aria-labelledby="cv-new-preview"]')!
    await within(card).findByText(/試算を読み込めませんでした/)

    fireEvent.click(within(card).getByRole('button', { name: 'もう一度読み込む' }))

    await within(card).findByText('38件')
    expect(within(card).queryByText(/試算を読み込めませんでした/)).toBeNull()
    expect(state.previewCalls).toBe(2)
  })

  it('条件を変えて次の試算が失敗したとき、古い試算の数字を残さない', async () => {
    state.previewResults = [{ ok: true, data: SAMPLE_PREVIEW }, { ok: false }]

    render(<ConversionCreateV8 />)

    const card = document.querySelector<HTMLElement>('[aria-labelledby="cv-new-preview"]')!
    await within(card).findByText('38件')

    fireEvent.click(screen.getByRole('radio', { name: /何回でも/ }))

    await within(card).findByText(/試算を読み込めませんでした/)
    expect(within(card).queryByText('38件')).toBeNull()
  })

  it('「使う場所を足す」窓の中でも読み込み失敗した候補をその場で再読み込みできる', async () => {
    state.funnelsFailFirst = true

    render(<ConversionCreateV8 />)

    await waitFor(() => expect(state.funnelsCalls).toBe(1))
    fireEvent.click(screen.getAllByRole('button', { name: /使う場所を足す/ })[0])

    const dialog = await screen.findByRole('dialog', { name: '使う場所を足す' })
    await within(dialog).findByText(/使える分析（ファネル・レポート）を読み込めませんでした/)

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度読み込む' }))

    await within(dialog).findByText('初回購入ファネル')
    expect(state.funnelsCalls).toBe(2)
  })
})
