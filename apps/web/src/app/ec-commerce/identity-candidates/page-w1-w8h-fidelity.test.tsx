// @vitest-environment happy-dom
/*
 * 板 （EC連携 会員のつき合わせ）の絵合わせ。
 * 数の帯は絵の順番・言葉（自動で結びついた→候補が見つかった→
 * 結びついていない→結びついていない注文の金額、単位は人／¥）。
 * 並び順の初期値は「確からしさが高い順」。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  operations: vi.fn(),
  overview: vi.fn(),
  list: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/ec-commerce/identity-candidates',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      ecCommerce: {
        ...actual.api.ecCommerce,
        overview: mocks.overview,
        operationIdentityCandidates: mocks.operations,
      },
      identityCandidates: {
        ...actual.api.identityCandidates,
        list: mocks.list,
      },
    },
  }
})

import EcIdentityCandidatesPage from './page'

const OPERATIONS_OK = {
  success: true,
  data: {
    items: [],
    total: 0,
    summary: {
      unmatched: 24,
      candidates: 6,
      candidateExternalCustomers: 6,
      duplicateSuspicions: 1,
      linked: 1128,
      potentialRevenue: 84300,
    },
  },
}

beforeEach(() => {
  document.documentElement.dataset.theme='v8'; window.history.replaceState({}, '', '/ec-commerce/identity-candidates'); window.dispatchEvent(new Event('popstate'))
  vi.clearAllMocks()
  mocks.overview.mockResolvedValue({ success: true, data: { total: 7, subscriptions: 3 } })
  mocks.operations.mockResolvedValue(OPERATIONS_OK)
  mocks.list.mockResolvedValue({
    success: true,
    data: {
      items: [{
        id: 'ec-cand-1',
        kind: 'ec_member',
        status: 'pending',
        version: 1,
        confidence: { score: 82, label: 'high' },
        left: {
          kind: 'ec_event', id: 'ec-left-1', label: '見本 141', detail: '注文 #1001',
          lineAccountId: 'acc-1', lineAccountName: 'テスト店', shopKey: null,
          attributes: [{ label: 'メールアドレス', valuePreview: 'ya***@example.com', verified: true }],
        },
        right: {
          kind: 'friend', id: 'friend-right-1', label: '山田 たろう', detail: null,
          lineAccountId: 'acc-1', lineAccountName: 'テスト店', shopKey: null,
          attributes: [],
        },
        evidenceSummary: ['メールアドレスが同じ'],
        detectedAt: '2026-09-20T10:00:00.000Z',
        reviewedAt: null,
      }],
      total: 1,
      limit: 20,
      offset: 0,
    },
  })
})

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

describe('w1W8h 会員のつき合わせの絵合わせ', () => {
  test('数の帯は絵の順番・言葉・単位で出す', async () => {
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('自動で結びついた')).toBeTruthy()
    const band = screen.getByText('自動で結びついた').closest('[data-shared-part="kpi-band"]')
    const text = band?.textContent ?? ''
    const order = ['自動で結びついた', '候補が見つかった', '結びついていない', '結びついていない注文の金額']
    let cursor = -1
    for (const title of order) {
      const index = text.indexOf(title, cursor + 1)
      expect(index).toBeGreaterThan(cursor)
      cursor = index
    }
    /* linked=1128人・候補6人・候補なし18人・¥84,300。 */
    expect(text).toContain('1,128')
    expect(text).toContain('メールか電話番号が同じ')
    expect(text).toContain('人が決める（24 件のうち）')
    expect(text).toContain('候補なし')
    expect(text).toContain('¥84,300')
    expect(text).toContain('候補 6 人の注文')
  })

  test('並び順の初期値は確からしさが高い順', async () => {
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('自動で結びついた')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: '並び' })
    expect(trigger.textContent ?? '').toContain('確からしさが高い順')
  })
})

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal) => ({...await importOriginal<typeof import('@/lib/staff-role')>(),useStaffRole: () => 'owner'}))
