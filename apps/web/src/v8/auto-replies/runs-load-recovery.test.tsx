// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runs: vi.fn(),
  get: vi.fn(),
  stop: vi.fn(),
  staffMe: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: { ...actual.api.autoReplies, runs: mocks.runs, get: mocks.get, stop: mocks.stop, retryRun: vi.fn() },
      staff: { ...actual.api.staff, me: mocks.staffMe },
    },
  }
})
vi.mock('next/navigation', () => ({
  usePathname: () => '/auto-replies/runs',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=rule-1'),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))

import { flushListUrlState } from '@/components/shared/list-url-state'
import AutoReplyRunsV8 from './runs'

const SUCCESS_RESPONSE = {
  success: true,
  data: {
    rule: { id: 'rule-1', name: '予約問い合わせ', isActive: true, priorityPosition: 1 },
    summary: { monthHits: 12, totalHits: 34, handovers: 2, errors: 0, lastRunAt: '2026-11-20T01:00:00.000Z', averageResponseMs: 1200 },
    handovers: { waiting: 1, inProgress: 0, completed: 1 },
    triggerBreakdown: [{ trigger: '予約', count: 12, share: 1 }],
    items: [],
    pagination: { total: 0, limit: 20, offset: 0 },
  },
}

beforeEach(() => {
  window.history.replaceState(null, '', '/auto-replies/runs?id=rule-1')
  flushListUrlState()
  mocks.staffMe.mockResolvedValue({ success: true, data: { role: 'owner' } })
  mocks.runs.mockResolvedValue(SUCCESS_RESPONSE)
  mocks.get.mockResolvedValue({ success: true, data: { id: 'rule-1', lineAccountId: 'acc-1', confirmationRevision: 2 } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('自動応答の実行結果の読み込み・失敗表示と一時停止確認の再取得', () => {
  it('初回読み込み中は4つのKPIカードすべてを読み込み中表示にする', async () => {
    mocks.runs.mockReturnValueOnce(new Promise(() => {}))
    const { container } = render(<AutoReplyRunsV8 />)
    const cards = [...container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
    expect(cards).toHaveLength(4)
    expect(cards.every((card) => card.getAttribute('aria-busy') === 'true')).toBe(true)
    expect(cards.every((card) => (card.textContent ?? '').includes('読み込んでいます'))).toBe(true)
  })

  it('取得失敗時は4つのKPIカードすべてに「読み込めませんでした」を出し、言葉ごとの内訳を空表示と混ぜない', async () => {
    mocks.runs.mockRejectedValueOnce(new Error('runs down'))
    const { container } = render(<AutoReplyRunsV8 />)
    await screen.findByText(/実行結果を読み込めませんでした/)

    const cards = [...container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
    expect(cards).toHaveLength(4)
    expect(cards.every((card) => (card.textContent ?? '').includes('読み込めませんでした'))).toBe(true)
    expect(screen.getByText('内訳を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('内訳はまだありません')).toBeNull()
  })

  it('一時停止の確認窓で対象情報の取得に失敗したら案内と再読み込みを出し、回復後に一時停止を押せる', async () => {
    mocks.get.mockRejectedValueOnce(new Error('get down'))
    render(<AutoReplyRunsV8 />)

    const stopButton = await screen.findByRole('button', { name: '一時停止する' })
    await waitFor(() => expect((stopButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(stopButton)

    const dialog = await screen.findByRole('alertdialog')
    expect(await within(dialog).findByText(/確認する内容を読み込めませんでした/)).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: '一時停止する' }) as HTMLButtonElement).disabled).toBe(true)

    let resolveGet!: (value: { success: true; data: { id: string; lineAccountId: string; confirmationRevision: number } }) => void
    mocks.get.mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve }))

    const retryButton = within(dialog).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(mocks.get).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveGet({ success: true, data: { id: 'rule-1', lineAccountId: 'acc-1', confirmationRevision: 2 } })
    })
    await waitFor(() => expect(within(dialog).queryByText(/確認する内容を読み込めませんでした/)).toBeNull())
    expect((within(dialog).getByRole('button', { name: '一時停止する' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
