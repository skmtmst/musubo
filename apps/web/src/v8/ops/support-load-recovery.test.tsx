// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/support',
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))
vi.mock('./use-ops-read-only', () => ({ useOpsReadOnly: () => false, useOpsReadOnlyState: () => 'writer' as const }))

const net = vi.hoisted(() => ({
  summary: vi.fn(),
  tickets: vi.fn(),
  ticket: vi.fn(),
  tenants: vi.fn(),
}))

const makeTicket = (i: number, stage: 'new' | 'in_progress' = 'new') => ({
  id: `t${i}`,
  ticketNo: i,
  ticketLabel: `#${i}`,
  tenantId: 'ten-1',
  tenantName: '契約先A',
  tenantPlanKey: null,
  tenantPlanStatus: 'active',
  tenantStatus: 'active',
  staffId: null,
  staffName: '担当',
  staffRole: null,
  staffEmailRegistered: true,
  kind: 'usage',
  kindLabel: '使い方',
  subject: `件名${i}`,
  subjectAuto: false,
  body: '本文',
  attachments: [],
  stage,
  stageLabel: stage === 'new' ? '新規' : '対応中',
  priority: 'medium' as const,
  priorityLabel: '中',
  channel: 'admin',
  channelLabel: '管理画面',
  assigneeStaffId: null,
  replyCount: 0,
  firstRepliedAt: null,
  lastMessageAt: '2026-10-01T00:00:00Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
})

const SAMPLE_SUMMARY = {
  byStage: { all: 12, new: 3, in_progress: 4, waiting: 2, resolved: 3, closed: 0 },
  kpis: {
    untouched: 1,
    untouchedFromLine: 0,
    avgFirstReplyMinutes: null,
    prevAvgFirstReplyMinutes: null,
    resolutionRate: null,
    prevResolutionRate: null,
    avgResolutionMinutes: null,
    prevAvgResolutionMinutes: null,
  },
}

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ops: {
        ...actual.api.ops,
        tenants: (...args: unknown[]) => net.tenants(...args),
        support: {
          ...actual.api.ops.support,
          summary: (...args: unknown[]) => net.summary(...args),
          tickets: (...args: unknown[]) => net.tickets(...args),
          ticket: (...args: unknown[]) => net.ticket(...args),
        },
      },
    },
  }
})

import OpsSupportV8 from './support'

beforeEach(() => {
  vi.resetAllMocks()
  net.summary.mockResolvedValue({ success: true, data: SAMPLE_SUMMARY })
  net.tickets.mockResolvedValue({ success: true, data: [makeTicket(1)], total: 1 })
  net.ticket.mockImplementation(async (id: string) => ({
    success: true,
    data: {
      ticket: makeTicket(Number(id.slice(1)) || 1),
      messages: [],
      draft: null,
      tenant: { accountCount: 1, staffCount: 1, staffWithLine: 0, pastTickets: 0, pastOpen: 0 },
    },
  }))
  net.tenants.mockResolvedValue({
    success: true,
    data: [{ id: 'ten-1', name: '契約先A', status: 'active' }],
  })
})

afterEach(() => {
  cleanup()
})

describe('運営のお問い合わせ：集計・一覧再取得・契約先読み込み失敗の回復', () => {
  it('件数集計の読み込み失敗を知らせ、その場の再読み込みで件数を回復し、連打で重複送信しない', async () => {
    let resolveRetry: ((value: { success: true; data: typeof SAMPLE_SUMMARY }) => void) | null = null
    net.summary
      .mockResolvedValueOnce({ success: false, error: '集計サービス停止中' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    const { container } = render(<OpsSupportV8 />)

    expect(await screen.findByText(/件数の集計を読み込めませんでした/)).toBeTruthy()
    expect(screen.getByText('件名1')).toBeTruthy()
    expect([...container.querySelectorAll('[data-kpi-number]')].map((el) => el.textContent)).toEqual(['—', '—', '—', '—'])

    const retryButton = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(net.summary).toHaveBeenCalledTimes(2)

    resolveRetry!({ success: true, data: SAMPLE_SUMMARY })
    await waitFor(() => {
      expect([...container.querySelectorAll('[data-kpi-number]')].map((el) => el.textContent)).toEqual(['3', '4', '2', '3'])
    })
    expect(screen.queryByText(/件数の集計を読み込めませんでした/)).toBeNull()
  })

  it('一覧が既に表示された状態で絞り込み更新が失敗しても、古い一覧のまま黙らずエラーと再読み込みボタンを出す', async () => {
    net.tickets
      .mockResolvedValueOnce({ success: true, data: [makeTicket(1)], total: 1 })
      .mockResolvedValueOnce({ success: false, error: '一覧の取得に失敗しました' })
      .mockResolvedValueOnce({ success: true, data: [makeTicket(2, 'in_progress')], total: 1 })

    render(<OpsSupportV8 />)
    expect(await screen.findByText('件名1')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /状態で絞る/ }))
    const inProgress = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes('対応中')) as HTMLElement
    fireEvent.click(inProgress.querySelector('button') ?? inProgress)

    expect(await screen.findByText(/チケットの一覧を更新できませんでした/)).toBeTruthy()
    const listSection = screen.getByLabelText('チケットの一覧')
    fireEvent.click(within(listSection).getByRole('button', { name: 'もう一度読み込む' }))

    expect(await screen.findByText('件名2')).toBeTruthy()
    expect(screen.queryByText(/チケットの一覧を更新できませんでした/)).toBeNull()
  })

  it('チケット作成ダイアログで契約先一覧の取得に失敗したときに理由と再読み込みボタンを出し、再試行で候補を回復できる', async () => {
    net.tenants
      .mockResolvedValueOnce({ success: false, error: '契約先の取得に失敗しました' })
      .mockResolvedValueOnce({ success: true, data: [{ id: 'ten-1', name: '契約先A', status: 'active' }] })

    render(<OpsSupportV8 />)
    fireEvent.click(await screen.findByRole('button', { name: 'チケット作成' }))

    const dialog = await screen.findByRole('dialog', { name: 'チケット作成' })
    expect(await within(dialog).findByText(/契約先の取得に失敗しました/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect(within(dialog).queryByText(/契約先の取得に失敗しました/)).toBeNull()
    })
    expect(net.tenants).toHaveBeenCalledTimes(2)
  })
})
