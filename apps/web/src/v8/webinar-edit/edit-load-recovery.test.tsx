// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ search: 'id=webinar-1&pane=comments' }))
const net = vi.hoisted(() => ({
  get: vi.fn(),
  editor: vi.fn(),
  analytics: vi.fn(),
  comments: vi.fn(),
  userComments: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/webinars/edit',
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店', liffId: 'liff-1' }], loading: false }),
}))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => 'owner',
}))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    webinarApi: {
      ...actual.webinarApi,
      get: (...args: unknown[]) => net.get(...args),
      editor: (...args: unknown[]) => net.editor(...args),
      analytics: (...args: unknown[]) => net.analytics(...args),
      comments: (...args: unknown[]) => net.comments(...args),
      userComments: (...args: unknown[]) => net.userComments(...args),
    },
  }
})

import WebinarEditV8 from './edit'

const WEBINAR = {
  id: 'webinar-1',
  accountId: 'account-a',
  title: 'NEN活用スタートセミナー',
  slug: 'nen-start',
  status: 'active',
  videoPrefix: 'webinars/nen-start.mp4',
  durationSeconds: 872,
  schedule: [{ type: 'daily', time: '10:00' }],
  cta: null,
  tagOnAttend: null,
  tagOnCtaClick: null,
  publicationState: 'always',
  publicationStartsAt: null,
  publicationEndsAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const EDITOR = {
  version: 3,
  deliveryKind: 'on_demand',
  ctaCount: 1,
  viewingCondition: { kind: 'registered', label: '申込者向け' },
  publicDescription: '15分で使い方がわかる',
  registrationFormId: null,
  notificationMessages: { dayBefore: '明日からです' },
  notificationTest: null,
  actionPolicy: { templateBody: 'ありがとうございました', missingResultPolicy: 'escalate' },
  publicPage: { liffId: 'liff-1', url: 'https://liff.line.me/liff-1/webinar/nen-start', unavailableReason: null, description: '', test: null, form: null },
  publication: { status: 'active', draftVersion: 3, publishedVersion: 3, publishedAt: null },
  monitoring: { notificationFailures: 0, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}

const ANALYTICS = {
  summary: { reservations: 124, viewers: 100, registeredAndJoined: 100, watched5m: 90, watched15m: 80, completed: 71, avgWatchedSeconds: 372, ctaClicks: 23, formSubmissions: 9 },
  daily: [],
  participants: [],
  sessions: [],
  dropoff: [],
  viewSegments: [],
  retention: { bucketSeconds: 60, started: 100, points: [] },
  heartbeatRejects: 0,
  ctaAtSeconds: 300,
  measurement: { state: 'available', reason: null },
  formFunnel: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  nav.search = 'id=webinar-1&pane=comments'
  net.get.mockResolvedValue({ data: WEBINAR })
  net.editor.mockResolvedValue({ data: EDITOR })
  net.analytics.mockResolvedValue({ data: ANALYTICS })
  net.comments.mockResolvedValue({ data: [] })
  net.userComments.mockResolvedValue({ data: [] })
})

afterEach(() => {
  cleanup()
})

describe('ウェビナー編集：読み込み中表示・エラー帯トーン・再読み込み連打防止', () => {
  it('初期読み込み中は共通の ListState ローディングを出し、失敗時の再読み込みボタン連打で重複送信しない', async () => {
    let resolveSecondGet: ((value: { data: typeof WEBINAR }) => void) | null = null
    net.get
      .mockRejectedValueOnce(new Error('一時障害'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondGet = resolve }))

    const { container } = render(<WebinarEditV8 />)
    expect(container.querySelector('[data-list-state="loading"]')).toBeTruthy()

    const retryButton = await screen.findByRole('button', { name: 'もう一度読み込む' })
    expect(net.get).toHaveBeenCalledTimes(1)

    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    await waitFor(() => expect(net.get).toHaveBeenCalledTimes(2))

    resolveSecondGet!({ data: WEBINAR })
    expect(await screen.findByText('NEN活用スタートセミナー')).toBeTruthy()
  })

  it('コメント演出の集計取得失敗を危険トーン（role=alert）で示し、再読み込みで回復できる', async () => {
    net.analytics
      .mockRejectedValueOnce(new Error('集計エラー'))
      .mockResolvedValueOnce({ data: ANALYTICS })

    render(<WebinarEditV8 />)

    const note = await screen.findByText('視聴の集計を読み込めませんでした。コメントの入力は続けられます。')
    const notice = note.closest('[data-design-part="notice"]')
    expect(notice?.getAttribute('role')).toBe('alert')

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.getByText('124')).toBeTruthy())
    expect(screen.queryByText('視聴の集計を読み込めませんでした。コメントの入力は続けられます。')).toBeNull()
  })
})
