// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  outgoingList: vi.fn(),
  incomingList: vi.fn(),
  interactionsList: vi.fn(),
  foldersList: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [{ id: 'acc-1', name: '本店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('./write-access', () => ({
  useWebhookWriteAccess: () => ({ allowed: true, known: true, reason: undefined }),
  canManageWebhooksNow: () => true,
  captureWebhookWriteAccess: () => () => true,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: (...args: unknown[]) => net.foldersList(...args) },
      webhooks: {
        ...actual.api.webhooks,
        outgoing: { ...actual.api.webhooks.outgoing, list: (...args: unknown[]) => net.outgoingList(...args) },
        incoming: { ...actual.api.webhooks.incoming, list: (...args: unknown[]) => net.incomingList(...args) },
        interactions: { ...actual.api.webhooks.interactions, list: (...args: unknown[]) => net.interactionsList(...args) },
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import WebhooksOutgoingV8 from './outgoing'

const SAMPLE_OUTGOING = {
  id: 'wh-1',
  name: 'Slack 通知',
  url: 'https://hooks.example.test/slack',
  eventTypes: ['friend_added'],
  isActive: true,
  hasSecret: true,
  folderId: null,
  version: 1,
  confirmationRevision: 1,
  deliverySummary: { total: 10, failed: 0, pending: 0, canRetry: false, lastResult: null },
}

const SAMPLE_SUMMARY = { outgoing: 42, outgoingFailed: 2, failed: 2, incoming: 15 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  net.outgoingList.mockReset().mockResolvedValue({ success: true, data: [SAMPLE_OUTGOING] })
  net.incomingList.mockReset().mockResolvedValue({ success: true, data: [] })
  net.interactionsList.mockReset().mockResolvedValue({ success: true, data: { items: [], summary: SAMPLE_SUMMARY } })
  net.foldersList.mockReset().mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
})

describe('WebhooksOutgoingV8 / WebhookBand の KPI 読み込み中・集計失敗再読み込み', () => {
  it('初回読み込み中は KPI に「読み込めませんでした」を出さず読み込み中表示にする', async () => {
    const pendingOutgoing = deferred<{ success: true; data: typeof SAMPLE_OUTGOING[] }>()
    const pendingIncoming = deferred<{ success: true; data: unknown[] }>()
    const pendingSummary = deferred<{ success: true; data: { items: unknown[]; summary: typeof SAMPLE_SUMMARY } }>()
    net.outgoingList.mockReturnValueOnce(pendingOutgoing.promise)
    net.incomingList.mockReturnValueOnce(pendingIncoming.promise)
    net.interactionsList.mockReturnValueOnce(pendingSummary.promise)

    render(<WebhooksOutgoingV8 />)

    const band = screen.getByLabelText('外部連携の数の帯')
    expect(band.textContent).not.toContain('読み込めませんでした')
    expect(band.textContent).not.toContain('集計を読み込めませんでした')

    await act(async () => {
      pendingOutgoing.resolve({ success: true, data: [SAMPLE_OUTGOING] })
      pendingIncoming.resolve({ success: true, data: [] })
      pendingSummary.resolve({ success: true, data: { items: [], summary: SAMPLE_SUMMARY } })
    })

    await waitFor(() => expect(within(band).getByText('42')).toBeTruthy())
  })

  it('やり取り集計だけ失敗したとき、その場から集計を再読み込みして KPI を回復できる', async () => {
    net.interactionsList
      .mockRejectedValueOnce(new ApiError(500, 'summary failed'))
      .mockResolvedValueOnce({ success: true, data: { items: [], summary: SAMPLE_SUMMARY } })

    render(<WebhooksOutgoingV8 />)

    await screen.findByText('Slack 通知')
    await screen.findByText(/直近30日のやり取り集計を読み込めませんでした/)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    const band = screen.getByLabelText('外部連携の数の帯')
    await waitFor(() => expect(within(band).getByText('42')).toBeTruthy())
    expect(screen.queryByText(/直近30日のやり取り集計を読み込めませんでした/)).toBeNull()
    expect(net.interactionsList).toHaveBeenCalledTimes(2)
  })
})
