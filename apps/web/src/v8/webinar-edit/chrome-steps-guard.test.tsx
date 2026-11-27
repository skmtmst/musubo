// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailHead } from './chrome'
import WebinarEditV8 from './edit'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const nav = vi.hoisted(() => ({ search: 'id=webinar-1&pane=basic' }))
const routerReplace = vi.hoisted(() => vi.fn((href: string) => {
  const query = href.includes('?') ? href.split('?')[1] : ''
  nav.search = query
  window.history.replaceState(null, '', href)
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/webinars/edit',
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: '本店' },
    accounts: [{ id: 'account-a', name: '本店', liffId: 'liff-1' }],
    loading: false,
  }),
}))
vi.mock('@/lib/use-running-version', () => ({
  useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const incompleteWebinar = {
  id: 'webinar-1',
  accountId: 'account-a',
  title: 'テストウェビナー',
  slug: 'test-webinar',
  status: 'draft',
  videoPrefix: '',
  durationSeconds: 0,
  schedule: [],
  cta: null,
  tagOnAttend: null,
  tagOnCtaClick: null,
  publicationState: 'unset',
  publicationStartsAt: null,
  publicationEndsAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const editorData = {
  version: 1,
  deliveryKind: 'on_demand',
  ctaCount: 0,
  viewingCondition: { kind: 'registered', label: '申込者向け' },
  publicDescription: '',
  registrationFormId: null,
  notificationMessages: {},
  notificationTest: null,
  actionPolicy: { templateBody: '', missingResultPolicy: 'escalate' },
  publicPage: { liffId: 'liff-1', url: null, unavailableReason: null, description: '', test: null, form: null },
  publication: { status: 'draft', draftVersion: 1, publishedVersion: null, publishedAt: null },
  monitoring: { notificationFailures: 0, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}

beforeEach(() => {
  nav.search = 'id=webinar-1&pane=basic'
  routerReplace.mockClear()
  window.history.replaceState(null, '', '/webinars/edit?id=webinar-1&pane=basic')
  document.documentElement.dataset.theme = 'v8'
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/webinars/webinar-1') return json({ data: incompleteWebinar })
    if (path.endsWith('/editor')) return json({ data: editorData })
    if (path.endsWith('/analytics')) return json({ data: { summary: { reservations: 0 }, daily: [], participants: [], sessions: [], dropoff: [], viewSegments: [], retention: { bucketSeconds: 60, started: 0, points: [] }, heartbeatRejects: 0, ctaAtSeconds: null, measurement: { state: 'available', reason: null }, formFunnel: null } })
    if (path.endsWith('/ctas')) return json({ data: [] })
    if (path.endsWith('/video-asset')) return json({ data: { asset: null } })
    if (path.endsWith('/notifications')) return json({ data: { settings: null, overview: null } })
    if (path.endsWith('/actions')) return json({ data: [] })
    if (path.endsWith('/publish-validation')) return json({ data: { version: 1, checks: [], blockers: [], warnings: [] } })
    if (path === '/api/forms') return json({ success: true, data: [] })
    if (path.includes('/folders')) return json({ success: true, data: [] })
    return json({ data: null })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

describe('webinar-edit/chrome の編集手順移動と参加者数ガード', () => {
  it('実際の編集画面で未設定（todo）の動画ステップへ手順帯から直接移れる', async () => {
    render(<WebinarEditV8 />)

    const stepsNav = await screen.findByRole('navigation', { name: 'ウェビナーを作る進み方' })
    const videoStep = within(stepsNav).getByRole('button', { name: /動画/ })
    expect(videoStep.hasAttribute('disabled')).toBe(false)

    fireEvent.click(videoStep)

    await waitFor(() => {
      expect(window.location.search).toContain('pane=video')
    })
  })

  it('DetailHead は参加者数が NaN や Infinity のときに不正な文字列を出さない', () => {
    const { rerender } = render(
      <DetailHead
        title="セミナー"
        subtitle="説明"
        current="basic"
        participantsCount={Number.NaN}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('tab', { name: '参加者' })).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()

    rerender(
      <DetailHead
        title="セミナー"
        subtitle="説明"
        current="basic"
        participantsCount={Number.POSITIVE_INFINITY}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('tab', { name: '参加者' })).toBeTruthy()
    expect(screen.queryByText(/Infinity/)).toBeNull()

    rerender(
      <DetailHead
        title="セミナー"
        subtitle="説明"
        current="basic"
        participantsCount={12}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('tab', { name: '参加者 12' })).toBeTruthy()
  })
})
