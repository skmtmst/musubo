// @vitest-environment happy-dom
/*
 * ウェビナー参加者の読み込み失敗・読み込み中表示と再試行の振る舞い。
 * - 集計が取れないとき、4枚の数字カードすべてに「読み込めませんでした」を出し、取り直しを押せる
 * - 集計を読み込んでいる間は、4枚の数字カードが読み込み中の姿になる
 * - 参加者一覧の取得に失敗したとき、再試行ボタンの連打で通信が二重に走らず、成功で一覧へ戻る
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webinarDetailChrome, webinarEditContext } from '@/test-utils/webinar-edit'
import type { Webinar, WebinarEditor } from '@/lib/api'

const apiMocks = vi.hoisted(() => ({
  participants: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    webinarApi: {
      ...actual.webinarApi,
      participants: apiMocks.participants,
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/webinars/edit',
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

import ParticipantsPane from './participants'

const WEBINAR = { id: 'webinar-1', title: 'ウェビナー', durationSeconds: 900 } as Webinar
const EDITOR = { version: 2 } as WebinarEditor
const PARTICIPANT_ITEM = {
  friendId: 'friend-1',
  friendName: '山田 花子',
  pictureUrl: null,
  sessions: 1,
  firstJoinedAt: '2026-10-01T10:00:00+09:00',
  latestJoinedAt: '2026-10-01T10:12:00+09:00',
  maxWatchedSeconds: 872,
  ctaClickedAt: null,
  registered: true,
  formSubmittedAt: null,
  actionStatus: null,
  errorDetail: null,
  staffIntegrationStatus: 'completed',
  classification: 'completed',
  liveSessions: 1,
  replaySessions: 0,
}

beforeEach(() => {
  window.history.replaceState(null, '', '/webinars/edit?id=webinar-1&pane=participants')
  window.dispatchEvent(new PopStateEvent('popstate'))
  apiMocks.participants.mockResolvedValue({
    data: { items: [PARTICIPANT_ITEM], nextCursor: null, rule: null, measurement: { state: 'available', reason: null } },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ウェビナー参加者の失敗表示と再試行', () => {
  it('集計が失敗したとき4枚のKPIすべてに「読み込めませんでした」を出し、取り直しを押せる', async () => {
    const retryAnalytics = vi.fn()
    const { container } = render(
      <ParticipantsPane
        ctx={webinarEditContext(WEBINAR, EDITOR, { analytics: null, analyticsState: 'error', retryAnalytics })}
        chrome={webinarDetailChrome}
      />,
    )

    await screen.findByText('山田 花子')
    const cards = [...container.querySelectorAll('[data-kpi-strip] > [data-design-version]')]
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.textContent).toContain('読み込めませんでした')
    }
    expect(container.textContent).not.toContain('平均離脱時間 —')
    expect(container.textContent).not.toContain('見逃し案内の対象')

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(retryAnalytics).toHaveBeenCalledTimes(1)
  })

  it('集計の読み込み中は4枚のKPIが読み込み中表示になる', async () => {
    const { container } = render(
      <ParticipantsPane
        ctx={webinarEditContext(WEBINAR, EDITOR, { analytics: null, analyticsState: 'loading' })}
        chrome={webinarDetailChrome}
      />,
    )

    await screen.findByText('山田 花子')
    const cards = [...container.querySelectorAll('[data-kpi-strip] > [data-design-version]')]
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.textContent).toContain('読み込んでいます')
      expect(card.getAttribute('aria-busy')).toBe('true')
    }
  })

  it('参加者一覧の失敗後に再試行を連打しても二重通信にならず、成功で一覧へ戻る', async () => {
    let resolveRetry!: (value: unknown) => void
    apiMocks.participants
      .mockRejectedValueOnce(new Error('network error'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(
      <ParticipantsPane
        ctx={webinarEditContext(WEBINAR, EDITOR, { analytics: null, analyticsState: 'ready' })}
        chrome={webinarDetailChrome}
      />,
    )

    await screen.findByText('参加者の一覧を読み込めませんでした')
    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(apiMocks.participants).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('参加者の一覧を読み込めませんでした')).toBeNull()

    resolveRetry({
      data: { items: [PARTICIPANT_ITEM], nextCursor: null, rule: null, measurement: { state: 'available', reason: null } },
    })
    await screen.findByText('山田 花子')
    expect(apiMocks.participants).toHaveBeenCalledTimes(2)
  })
})
