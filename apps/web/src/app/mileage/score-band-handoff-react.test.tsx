// @vitest-environment happy-dom
/*
 * R300: 帯の引き継ぎは点数がついている人だけ（行動スコアのタブ側）。
 *
 * スコア一覧の帯は「点数がついている人」だけを数えているのに、検索・配信へ
 * 点数範囲だけを渡すと未採点の0点まで拾う。帯を選んだときに出る
 * ［この帯の人に送る］と［この帯の友だちを見る］が、点数範囲と一緒に
 * `scoredOnly=1` を渡し、そのことを言葉でも示すかを本物の React で確かめる。
 *
 * 受け取る側は次の試験が見る。
 *   - 友だち一覧：v8/friends/list/scored-only-handoff-react.test.tsx
 *   - 一斉配信の作成：app/broadcasts/new/score-band-condition-react.test.tsx
 *   - 一覧→配信の条件：lib/friends-broadcast-condition.test.ts（R300）
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MileageShell } from '@/v8/mileage/frame'
import V8ScoreTab from '@/v8/mileage/score'

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.ComponentProps<'a'>) => <a href={String(href)} {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

function stubFetch() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/action-scores/friends')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          summary: { scoredFriends: 2, high: 1, normal: 0, low: 1, decreased30d: 0, highMin: 30, normalMin: 10 },
          items: [{
            friendId: 'friend-1', displayName: '見本 189', pictureUrl: null, currentScore: 5, band: 'low',
            change30d: 0, lastReason: null, lastChangedAt: null,
          }],
          pagination: { total: 1, limit: 20, offset: 0 },
        },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
  }) as typeof globalThis.fetch
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  stubFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  window.history.replaceState(null, '', '/')
})

async function renderWith(search: string) {
  window.history.replaceState(null, '', `/mileage${search}`)
  window.dispatchEvent(new Event('popstate'))
  await act(async () => {
    root.render(
      <MileageShell.Provider value={{ tab: 'score', readonly: false, narrow: false, counts: {}, setCount: () => {} }}>
        <V8ScoreTab />
      </MileageShell.Provider>,
    )
  })
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve() })
}

function link(text: string): HTMLAnchorElement | undefined {
  return [...document.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes(text)) as HTMLAnchorElement | undefined
}

function queryOf(anchor: HTMLAnchorElement | undefined): URLSearchParams {
  return new URL(anchor?.getAttribute('href') ?? '', 'https://admin.test').searchParams
}

async function openHelp() {
  const toggle = container.querySelector('button[aria-label="この画面の説明"]') as HTMLButtonElement | null
  if (toggle) await act(async () => { toggle.click() })
}

describe('R300: 帯の引き継ぎは点数がついている人だけ', () => {
  it.each([
    ['low', { scoreMin: null, scoreMax: '9' }],
    ['normal', { scoreMin: '10', scoreMax: '29' }],
    ['high', { scoreMin: '30', scoreMax: null }],
  ] as const)('帯 %s を選ぶと、配信へ点数範囲と scoredOnly を渡し、そのことを示す', async (band, range) => {
    await renderWith(`?tab=score&filter=${band}`)

    const send = link('この帯の人に送る')
    expect(new URL(send?.getAttribute('href') ?? '', 'https://admin.test').pathname).toBe('/broadcasts/new')
    const query = queryOf(send)
    expect(query.get('scoredOnly')).toBe('1')
    expect(query.get('scoreMin')).toBe(range.scoreMin)
    expect(query.get('scoreMax')).toBe(range.scoreMax)
    expect(send?.closest('[title]')?.getAttribute('title') ?? send?.getAttribute('title')).toBe('点数がついている人のみ')
  })

  it('帯を選ぶと、友だち一覧へも点数がついている人だけを渡す', async () => {
    await renderWith('?tab=score&filter=low')
    await openHelp()

    const friends = link('この帯の友だちを見る（点数がついている人のみ）')
    expect(new URL(friends?.getAttribute('href') ?? '', 'https://admin.test').pathname).toBe('/friends')
    expect(queryOf(friends).get('scoredOnly')).toBe('1')
    expect(queryOf(friends).get('scoreMax')).toBe('9')
  })

  it('帯を選んでいないときは、点数の条件を付けずに配信の作成へ進む', async () => {
    await renderWith('?tab=score')
    await openHelp()

    const send = link('この帯の人に送る')
    expect(send?.getAttribute('href')).toBe('/broadcasts/new')
    expect(link('この帯の友だちを見る')).toBeUndefined()
  })
})
