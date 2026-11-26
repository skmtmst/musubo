// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Webinar, WebinarAnalytics, WebinarEditor } from '@/lib/api'
import type { DetailChrome, EditContext } from './types'

const webinarApiMock = vi.hoisted(() => ({
  participants: vi.fn(),
  userComments: vi.fn(),
  participantsCsvUrl: vi.fn(() => '/api/webinars/webinar-1/participants.csv'),
}))

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  webinarApi: webinarApiMock,
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

const { default: AnalyticsPane } = await import('./analytics')

const WEBINAR = { id: 'webinar-1', title: '春のオンライン相談セミナー', durationSeconds: 1800 } as Webinar
const EDITOR = { version: 2 } as WebinarEditor
const CHROME: DetailChrome = {
  title: 'ウェビナーの詳細',
  subtitle: '参加者・分析・コメント演出',
  participantsCount: null,
  onSelect: vi.fn(),
}

function makeCtx(overrides: Partial<EditContext> = {}): EditContext {
  return {
    webinar: WEBINAR,
    editor: EDITOR,
    readOnly: false,
    publicUrl: null,
    canOpenPublicPage: false,
    publicPageReason: '公開してから確認できます。',
    ctaCount: 0,
    analytics: null,
    analyticsState: 'loading',
    onEditorChange: vi.fn(),
    onWebinarSaved: vi.fn(),
    onCtasReport: vi.fn(),
    onPublished: vi.fn(),
    goStep: vi.fn(),
    retryAnalytics: vi.fn(),
    ...overrides,
  }
}

const SAMPLE_ANALYTICS = {
  summary: {
    reservations: 120,
    viewers: 84,
    registeredAndJoined: 70,
    watched5m: 60,
    watched15m: 48,
    completed: 36,
    avgWatchedSeconds: 900,
    ctaClicks: 24,
    formSubmissions: 12,
  },
  sessions: [],
  daily: [],
  retention: { bucketSeconds: 60, started: 84, points: [] },
} as WebinarAnalytics

beforeEach(() => {
  webinarApiMock.participants.mockResolvedValue({ data: { items: [] } })
  webinarApiMock.userComments.mockResolvedValue({ data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ウェビナー分析の読み込み中・失敗・再試行', () => {
  it('分析の読み込み中は4つのKPIカードを読み込み中表示にし、共通の読み込み状態を見せる', async () => {
    const { container } = render(<AnalyticsPane ctx={makeCtx({ analytics: null, analyticsState: 'loading' })} chrome={CHROME} />)
    const cards = [...container.querySelectorAll('[data-template-region="stats"] [data-kpi-presentation="band"] [data-kpi-presentation="band"]')]
    expect(cards.length).toBe(4)
    expect(cards.every((card) => card.getAttribute('aria-busy') === 'true')).toBe(true)
    expect(cards.every((card) => (card.textContent ?? '').includes('読み込んでいます'))).toBe(true)
    expect(container.querySelector('[data-list-state="loading"]')).not.toBeNull()
  })

  it('分析の取得に失敗したときは4つのKPIカードに「読み込めませんでした」を出し、再読み込みを押せる', async () => {
    const retryAnalytics = vi.fn()
    const { container } = render(<AnalyticsPane ctx={makeCtx({ analytics: null, analyticsState: 'error', retryAnalytics })} chrome={CHROME} />)
    const cards = [...container.querySelectorAll('[data-template-region="stats"] [data-kpi-presentation="band"] [data-kpi-presentation="band"]')]
    expect(cards.length).toBe(4)
    expect(cards.every((card) => (card.textContent ?? '').includes('読み込めませんでした'))).toBe(true)
    expect(cards.every((card) => card.getAttribute('aria-busy') !== 'true')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(retryAnalytics).toHaveBeenCalledTimes(1)
  })

  it('視聴者コメントの取得に失敗したときは見出しの補足に失敗を示し、再試行中は二重送信しない', async () => {
    webinarApiMock.userComments.mockRejectedValueOnce(new Error('comments failed'))
    render(<AnalyticsPane ctx={makeCtx({ analytics: SAMPLE_ANALYTICS, analyticsState: 'ready' })} chrome={CHROME} />)

    expect(await screen.findByText('視聴者コメントを読み込めませんでした。')).toBeTruthy()
    const summary = screen.getByText('視聴者コメント').closest('summary')
    expect(summary?.textContent).toContain('読み込めませんでした')

    let resolveRetry!: (value: { data: unknown[] }) => void
    webinarApiMock.userComments.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRetry = resolve }),
    )

    const retryButton = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(webinarApiMock.userComments).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveRetry({ data: [{ id: 'c1', friendId: 'f1', friendName: '田中', pictureUrl: null, sessionStartAt: 1, atSeconds: 65, body: '参考になりました', createdAt: '' }] })
    })
    await waitFor(() => expect(screen.getByText('参考になりました')).toBeTruthy())
    expect(summary?.textContent).toContain('1件')
  })
})
