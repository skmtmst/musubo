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

describe('参加者管理のV8（uNsEy）', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/webinars/edit?id=webinar-1')
    window.dispatchEvent(new PopStateEvent('popstate'))
    apiMocks.participants.mockResolvedValue({
      data: { items: ITEMS, nextCursor: null, rule: null, measurement: { state: 'available', reason: null } },
    })
  })

  afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('板IDと4枚の札・一覧・詳細への導線を描く', async () => {
    const host = render()
    await act(async () => undefined)
    await act(async () => undefined)
    expect(host.querySelector('[data-design-node="uNsEy"]')).not.toBeNull()
    for (const label of ['申込', '視聴完了', '途中で離れた', '見ていない']) {
      expect(host.textContent).toContain(label)
    }
    expect(host.textContent).toContain('Demo Person')
    // 行の右端は「…」（決まり：ボタンを並べない）。開くと「チャットを見る」でトークへ行ける。
    await act(async () => { (host.querySelector('button[aria-label="Demo Personの操作"]') as HTMLButtonElement).click() })
    const detail = document.querySelector('a[href="/chats?friend=friend-1"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('チャットを見る')
  })

  it('分類の札を押すとその分類で取り直す', async () => {
    const host = render()
    await act(async () => undefined)
    await act(async () => undefined)
    const chip = [...host.querySelectorAll('button')].find((el) => el.textContent?.includes('視聴完了') && el.hasAttribute('aria-pressed'))
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const last = apiMocks.participants.mock.calls.at(-1) as unknown[]
    expect(last?.[3]).toBe('completed')
  })
  it('続きを待つ間に分類を変えても、古い参加者を混ぜない', async () => {
    let resolveMore!: (value: unknown) => void
    apiMocks.participants.mockImplementation((_id, cursor, _limit, filter) => {
      if (cursor) return new Promise((resolve) => { resolveMore = resolve })
      return Promise.resolve({ data: { items: filter ? [ITEMS[1]] : [ITEMS[0]], nextCursor: filter ? null : 'next' } })
    })
    const host = render()
    await act(async () => undefined)
    await act(async () => { [...host.querySelectorAll('button')].find((el) => el.textContent === '続きを読み込む')!.click() })
    await act(async () => { [...host.querySelectorAll('button')].find((el) => el.textContent?.includes('視聴完了') && el.hasAttribute('aria-pressed'))!.click() })
    await act(async () => { resolveMore({ data: { items: [{ ...ITEMS[0], friendId: 'old', friendName: '古い条件の参加者' }], nextCursor: null } }) })
    expect(host.textContent).toContain('見本 141')
    expect(host.textContent).not.toContain('古い条件の参加者')
    expect(host.textContent).not.toContain('Demo Person')
  })

})
