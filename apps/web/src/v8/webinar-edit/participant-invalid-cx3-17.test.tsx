// @vitest-environment happy-dom
/*
 * ★V8 参加者管理（）の描画。
 * 差し替えるのは通信だけ。集計の札・分類の札・一覧・友だち詳細への導線が実在する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webinarEditContext, webinarDetailChrome } from '@/test-utils/webinar-edit'
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
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/webinars/edit',
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

import ParticipantsPane from '@/v8/webinar-edit/participants'

const ANALYTICS = {
  summary: {
    reservations: 124,
    viewers: 100,
    completed: 71,
    registeredAndJoined: 90,
    avgWatchedSeconds: 360,
  },
} as unknown as import('@/lib/api').WebinarAnalytics

const ITEMS = [
  {
    friendId: 'friend-1',
    friendName: 'Demo Person',
    pictureUrl: null,
    sessions: 2,
    firstJoinedAt: '2026-09-30T10:00:00+09:00',
    latestJoinedAt: '2026-09-30T10:12:00+09:00',
    maxWatchedSeconds: 872,
    ctaClickedAt: '2026-09-30T10:14:00+09:00',
    registered: true,
    formSubmittedAt: null,
    actionStatus: null,
    errorDetail: null,
    staffIntegrationStatus: 'completed',
    classification: 'completed',
    liveSessions: 2,
    replaySessions: 0,
  },
  {
    friendId: 'friend-2',
    friendName: '見本 141',
    pictureUrl: null,
    sessions: 0,
    firstJoinedAt: null,
    latestJoinedAt: null,
    maxWatchedSeconds: 0,
    ctaClickedAt: null,
    registered: true,
    formSubmittedAt: null,
    actionStatus: null,
    errorDetail: null,
    staffIntegrationStatus: 'pending',
    classification: 'unviewed',
  },
]

const roots: Root[] = []

function render(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(
      <ParticipantsPane
        ctx={webinarEditContext({ id: 'webinar-1', title: 'ウェビナー', durationSeconds: 900 } as Webinar, { version: 2 } as WebinarEditor, { analytics: ANALYTICS, analyticsState: 'ready' })}
        chrome={webinarDetailChrome}
      />,
    )
  })
  return host
}
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = ''; vi.clearAllMocks() })
async function show(item: Record<string, unknown>) {
  apiMocks.participants.mockResolvedValue({ data: { items: [{ ...ITEMS[0], ...item }], nextCursor: null, rule: null, measurement: { state: 'available', reason: null } } })
  const host = render()
  await act(async () => undefined)
  await act(async () => undefined)
  return host
}

it('参加回数が不明なとき申込のみと表示しない', async () => {
  const host = await show({ sessions: null })
  expect(host.querySelector('[title*="参加回数を確認できません"]')).toBeTruthy()
  expect(host.querySelector('[title*="申込のみ"]')).toBeNull()
  await act(async () => { (host.querySelector('button[aria-label="Demo Personの操作"]') as HTMLButtonElement).click() })
  expect(document.querySelector('a[href="/chats?friend=friend-1"]')).toBeTruthy()
})

it('参加経路が不明なとき直接参加と表示しない', async () => {
  const host = await show({ sessions: 2, registered: null })
  expect(host.querySelector('[title*="参加経路を確認できません"]')).toBeTruthy()
  expect(host.querySelector('[title*="直接参加"]')).toBeNull()
  await act(async () => { (host.querySelector('button[aria-label="Demo Personの操作"]') as HTMLButtonElement).click() })
  expect(document.querySelector('a[href="/chats?friend=friend-1"]')).toBeTruthy()
})
