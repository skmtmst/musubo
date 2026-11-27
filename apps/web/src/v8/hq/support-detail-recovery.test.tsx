// @vitest-environment happy-dom
/*
 * 統括お問い合わせ詳細の補助取得失敗（履歴・送信者）と詳細再試行の振る舞い。
 * - これまでの問い合わせが取れないとき、読み込み中のまま固まらずに失敗案内と再読み込みを出す
 * - 再読み込みの連打で二重通信にならず、成功すれば履歴へ戻る
 * - 送信者の一部（統括名など）が取れないときも案内と再読み込みを出し、取り直せる
 * - 本体詳細が失敗したときの再読み込みも連打で二重通信にならない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  detail: vi.fn(),
  list: vi.fn(),
  context: vi.fn(),
  tenant: vi.fn(),
  staff: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=req-1'),
  usePathname: () => '/hq/support/detail',
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/shell/page-chrome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shell/page-chrome')>()
  return { ...actual, usePageTitle: () => undefined, usePageCrumbs: () => undefined }
})
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return {
    ...actual,
    useStaffRole: () => 'owner',
    loadStaffIdentity: (...args: unknown[]) => fixture.staff(...args),
  }
})
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      hqSupport: {
        ...actual.api.hqSupport,
        detail: (...args: unknown[]) => fixture.detail(...args),
        list: (...args: unknown[]) => fixture.list(...args),
        context: (...args: unknown[]) => fixture.context(...args),
      },
      tenants: {
        ...actual.api.tenants,
        me: (...args: unknown[]) => fixture.tenant(...args),
      },
    },
  }
})

import HqSupportDetailV8 from './support-detail'

const DETAIL_DATA = {
  id: 'req-1',
  subject: '管理画面の表示について',
  body: '確認をお願いします。',
  status: 'open' as const,
  kind: 'usage',
  kindLabel: '使い方について',
  ticketLabel: '#001',
  lineAccountId: null,
  staffName: '担当 太郎',
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-01T09:00:00Z',
  stageLabel: '',
  messages: [],
  canFollowUp: true,
}

const HISTORY_LIST = [
  {
    id: 'req-1',
    subject: '管理画面の表示について',
    status: 'open' as const,
    kind: 'usage',
    kindLabel: '使い方について',
    ticketLabel: '#001',
    lineAccountId: null,
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
  },
  {
    id: 'req-2',
    subject: '配信予約の確認',
    status: 'answered' as const,
    kind: 'usage',
    kindLabel: '使い方について',
    ticketLabel: '#002',
    lineAccountId: null,
    createdAt: '2026-09-25T09:00:00Z',
    updatedAt: '2026-09-26T09:00:00Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  fixture.detail.mockResolvedValue({ success: true, data: DETAIL_DATA })
  fixture.list.mockResolvedValue({ success: true, data: HISTORY_LIST })
  fixture.context.mockResolvedValue({ success: true, data: { accounts: [] } })
  fixture.tenant.mockResolvedValue({ success: true, data: { name: '然 本部' } })
  fixture.staff.mockResolvedValue({ success: true, data: { id: 's-1', email: 'staff@example.com', name: '担当 太郎', role: 'owner' } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('統括お問い合わせ詳細の失敗表示と再試行', () => {
  it('これまでの問い合わせが失敗しても読み込み中で固まらず、再読み込み連打を抑えて復旧できる', async () => {
    let resolveRetry!: (value: unknown) => void
    fixture.list
      .mockRejectedValueOnce(new Error('history failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<HqSupportDetailV8 />)

    await screen.findByText('これまでの問い合わせを読み込めませんでした。')
    expect(screen.getByText('確認をお願いします。')).toBeTruthy()
    const summaryCard = screen.getByText('これまでの問い合わせ').closest('section')!
    expect(summaryCard.textContent).not.toContain('読み込んでいます')

    const retryBtn = within(summaryCard).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2))

    resolveRetry({ success: true, data: HISTORY_LIST })
    await within(summaryCard).findByText('#002 配信予約の確認')
    expect(summaryCard.textContent).not.toContain('これまでの問い合わせを読み込めませんでした。')
    expect(fixture.list).toHaveBeenCalledTimes(2)
  })

  it('送信者の一部取得が失敗したときも案内と再読み込みを出し、取り直せる', async () => {
    fixture.tenant
      .mockRejectedValueOnce(new Error('tenant failed'))
      .mockResolvedValueOnce({ success: true, data: { name: '復旧した本部' } })

    render(<HqSupportDetailV8 />)

    const senderRegion = await screen.findByRole('region', { name: '送信者' })
    await within(senderRegion).findByText('送信者の一部を読み込めませんでした。')
    fireEvent.click(within(senderRegion).getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => expect(senderRegion.textContent).toContain('統括：復旧した本部'))
    expect(senderRegion.textContent).not.toContain('送信者の一部を読み込めませんでした。')
  })

  it('本体詳細の失敗後に再読み込みを連打しても二重通信にならず、成功でやり取りへ戻る', async () => {
    let resolveDetailRetry!: (value: unknown) => void
    fixture.detail
      .mockRejectedValueOnce(new Error('detail failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveDetailRetry = resolve }))

    render(<HqSupportDetailV8 />)

    await screen.findByText('お問い合わせを読み込めませんでした')
    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(fixture.detail).toHaveBeenCalledTimes(2))

    resolveDetailRetry({ success: true, data: DETAIL_DATA })
    await screen.findByText('確認をお願いします。')
    expect(fixture.detail).toHaveBeenCalledTimes(2)
  })
})
