// @vitest-environment happy-dom
/*
 * 友だち詳細の行き先・タブ・情報欄・回答・履歴の続きを、描いて押して確かめる。
 *
 * - 受信箱への口は `?friend=` に符号化した ID で渡す（受信箱は `?friend=` だけ読む）
 * - 概要の「詳細を見る」「すべて見る」は、この友だちのマイル・履歴タブへつながる
 * - 4 つのタブ（概要・履歴・回答フォーム・情報欄）を URL の tab で切り替えられる
 * - 情報欄の分類はリンクで切り替え、消えた分類は「見つかりません」と出す（FRIEND-21）
 * - 項目名と入力欄が結び付く（FRIEND-22）
 * - 権限で隠れた項目と「項目なし」を分ける（FRIEND-23）
 * - 回答は質問の label を見出しにし、定義に無いキーは原キーを残す（FRIEND-24）
 * - 履歴の続きの取り損ねは末尾だけに出す（FRIEND-26）
 * - 準備中タブは説明と代わりの操作を出す（FRIEND-27）
 *
 * 差し替えるのは api / fetchApi（サーバーとの境界）と next/navigation・next/link だけ。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fx = vi.hoisted(() => ({
  role: 'owner' as string | null,
  params: new URLSearchParams('id=friend-1'),
  pushed: [] as string[],
  getFriend: vi.fn(),
  fetchApi: vi.fn(),
  forFriend: vi.fn(),
  folders: vi.fn(),
  formSubmissions: vi.fn(),
  scenarios: vi.fn(),
  disabledFeatures: [] as string[],
  featureStatus: 'ready' as 'ready' | 'loading' | 'error',
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: fx.fetchApi,
    api: {
      ...actual.api,
      friends: {
        ...actual.api.friends,
        get: fx.getFriend,
        upcoming: async () => ({ success: true, data: { nextBooking: null, nextBookingError: false, nextAutoDelivery: null, nextAutoDeliveryError: false } }),
        mileage: async () => ({
          success: true,
          data: { summary: { programId: 'p', programName: 'p', available: 10, pending: 0, lifetimeEarned: 0, spent: 0 }, history: [], insights: { accountCount: 1 }, connections: [] },
        }),
        richMenu: async () => ({ success: true, data: { name: null, isDefault: true } }),
        formSubmissions: fx.formSubmissions,
      },
      friendFields: { ...actual.api.friendFields, forFriend: fx.forFriend, saveForFriend: async () => ({ success: true, data: { updated: 1 } }) },
      folders: { ...actual.api.folders, list: fx.folders },
      scenarios: { ...actual.api.scenarios, list: fx.scenarios },
      tags: { ...actual.api.tags, list: async () => ({ success: true, data: [{ id: 't1', name: 'VIP' }] }) },
      staff: { ...actual.api.staff, me: async () => ({ success: true, data: { role: fx.role } }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', rest, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => { fx.pushed.push(href) }, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => fx.params,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [], loading: false }),
}))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: fx.featureStatus, enabled: (key: string) => fx.featureStatus === 'ready' && !fx.disabledFeatures.includes(key) }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => fx.role }
})

import FriendDetailPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const friend = (id: string) => ({
  id,
  lineUserId: 'U1',
  displayName: '見本 143',
  pictureUrl: null,
  statusMessage: null,
  isFollowing: true,
  createdAt: '2025-04-03T00:00:00.000Z',
  updatedAt: '2025-04-03T00:00:00.000Z',
  tags: [],
  formSubmissions: [],
  formSubmissionTotal: 0,
  support: null,
})

const timeline = [
  { id: 'a', type: 'message_received', summary: '『秋の新商品はいつ届きますか？』', status: null, source: { kind: 'message', id: 'm1', parentId: null, url: null }, occurredAt: '2026-10-01T10:12:00+09:00', lineAccount: { id: 'x', name: '本店' } },
  { id: 'b', type: 'tag_change', summary: 'タグ『VIP』が付いた', status: null, source: null, occurredAt: '2026-09-26T12:40:00+09:00', lineAccount: { id: 'x', name: '本店' } },
]

const field = (id: string, name: string, value: string | null, extra: Record<string, unknown> = {}) => ({
  id, folderId: null, name, fieldKey: id, type: 'text', options: null, defaultValue: null, source: 'manual',
  ecFieldPath: null, ecIsMaster: false, isPersonal: false, isStarred: false, displayOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', value, ...extra,
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fx.role = 'owner'
  fx.disabledFeatures = []
  fx.featureStatus = 'ready'
  fx.params = new URLSearchParams('id=friend-1')
  fx.pushed.length = 0
  fx.getFriend.mockReset().mockImplementation(async (id: string) => ({ success: true, data: friend(id) }))
  fx.fetchApi.mockReset().mockImplementation(async (path: string) => ({
    success: true,
    data: { items: path.includes('cursor=') ? [] : timeline, nextCursor: null },
  }))
  fx.forFriend.mockReset().mockResolvedValue({ success: true, data: { items: [field('f-dog', '犬の名前', 'こむぎ')], hiddenPersonalCount: 0 } })
  fx.folders.mockReset().mockResolvedValue({ success: true, data: [] })
  fx.formSubmissions.mockReset().mockResolvedValue({ success: true, data: { items: [], total: 0, nextCursor: null } })
  fx.scenarios.mockReset().mockResolvedValue({ success: true, data: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

async function open(query: string) {
  fx.params = new URLSearchParams(query)
  act(() => { root.render(<FriendDetailPage />) })
  await flush()
}

const byText = (selector: string, text: string) =>
  [...host.querySelectorAll<HTMLElement>(selector)].filter((el) => el.textContent?.trim() === text)
const hrefOf = (text: string) => byText('a', text)[0]?.getAttribute('href')

describe('受信箱への口', () => {
  it('受信箱とテンプレートは符号化したIDへ移り、タグはその場で編集する', async () => {
    fx.getFriend.mockImplementation(async (id: string) => ({ success: true, data: { ...friend(id), tags: [{ id: 't1', name: 'VIP', color: '#000', createdAt: '2025-04-03T00:00:00.000Z' }] } }))
    await open('id=a b/c')
    const expected = '/chats?friend=a%20b%2Fc'
    expect(hrefOf('受信箱で開く')).toBe(expected)
    const inboxLinks = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((href) => href.startsWith('/chats'))
    expect(inboxLinks.length).toBeGreaterThanOrEqual(2)
    expect(new Set(inboxLinks)).toEqual(new Set([expected]))

    const editTags = host.querySelector<HTMLButtonElement>('[data-customer-info-panel] section[aria-label="タグ"] button')!
    act(() => { editTags.click() })
    await flush()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('タグを編集')
    expect(fx.pushed).toEqual([])
    act(() => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'キャンセル')!.click() })
    await flush()

    act(() => { byText('button', '個別操作')[0].click() })
    await flush()
    const template = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes('テンプレートを送る'))!
    act(() => { template.click() })
    expect(fx.pushed).toEqual([expected])
  })
})

describe('概要の行き先リンク', () => {
  it('この友だちのリマインダを開く入口を示す', async () => {
    await open('id=a b/c')
    expect(hrefOf('この友だちのリマインダを見る')).toBe('/friends/detail?id=a%20b%2Fc&tab=reminders')
  })
  it('マイルの「詳細を見る」はこの友だちのマイル詳細、「すべて見る」は履歴タブへつながる', async () => {
    await open('id=a b')
    expect(hrefOf('詳細を見る')).toBe('/mileage/friends/detail?id=a%20b')
    expect(hrefOf('すべて見る')).toBe('/friends/detail?id=a%20b&tab=history')
    expect(hrefOf('すべてを見る')).toBe('/friends/detail?id=a%20b&tab=scenario')
  })
})

describe('タブの切り替え（Q5F2QE）', () => {
  it('予約機能がオフなら回数券タブを隠し、直接URLではオフの案内を出す', async () => {
    fx.disabledFeatures = ['booking']
    await open('id=friend-1')
    expect(byText('[role="tab"]', '回数券・月謝')).toHaveLength(0)
    await open('id=friend-1&tab=orders')
    expect(host.querySelector('[data-feature-disabled="booking"]')).toBeTruthy()
    expect(host.textContent).not.toContain('回数券・月謝は、データの準備が済むと')
  })

  it('情報欄がオフなら情報欄タブを隠す', async () => {
    fx.disabledFeatures = ['friend_fields']
    await open('id=friend-1')
    expect(byText('[role="tab"]', '情報欄')).toHaveLength(0)
    expect(byText('[role="tab"]', '回数券・月謝')).toHaveLength(1)
  })

  it.each([['loading', '機能の設定を確認しています'], ['error', '機能の設定を確認できませんでした']] as const)(
    '機能設定が%sの時は直接URLで券を表示しない', async (status, message) => {
      fx.featureStatus = status
      await open('id=friend-1&tab=orders')
      if (status === 'loading') {
        expect(host.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe(message)
      } else {
        expect(host.textContent).toContain(message)
      }
      expect(host.querySelector('[data-feature-disabled="booking"]')).toBeNull()
      expect(byText('[role="tab"]', '回数券・月謝')).toHaveLength(0)
    },
  )
  it('通常のタブは内容のあるものに絞り、回数券・月謝を内容に合う名前で出す', async () => {
    await open('id=friend-1')
    const labels = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
    expect(labels).toEqual(['概要', '履歴', '情報欄', '回答フォーム', '回数券・月謝', 'マイル'])
    expect(hrefOf('回数券・月謝')).toBe('/friends/detail?id=friend-1&tab=orders')
  })

  it('案内をURLから直接開いたときは内容と選択中のタブを表示する', async () => {
    await open('id=friend-1&tab=scenario')
    const selected = [...host.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.textContent?.trim())
    expect(selected).toEqual(['配信・シナリオ'])
    const labels = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
    expect(labels.at(-1)).toBe('配信・シナリオ')
    expect(hrefOf('シナリオ一覧を見る ↗')).toBe('/scenarios')
  })

  it('板の印を付け、URL の tab ごとに概要・履歴・回答フォーム・情報欄の中身を出す', async () => {
    fx.fetchApi.mockImplementation(async (path: string) => ({
      success: true,
      data: { items: path.includes('cursor=') ? [] : timeline, nextCursor: path.includes('cursor=') ? null : 'next-1' },
    }))
    const cases: Array<[string, string, string]> = [
      ['', '概要', '進行中の配信・自動処理'],
      ['&tab=history', '履歴', 'さらに読み込む'],
      ['&tab=forms', '回答フォーム', 'フォームの回答はまだありません。'],
      ['&tab=info', '情報欄', '犬の名前'],
    ]
    for (const [query, label, content] of cases) {
      act(() => root.unmount())
      root = createRoot(host)
      await open(`id=friend-1${query}`)
      expect(host.querySelector('[data-design-node="Q5F2QE"]')).toBeTruthy()
      const selected = [...host.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.textContent?.trim())
      expect(selected).toEqual([label])
      expect(host.textContent).toContain(content)
    }
    const historyTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === '履歴')
    expect(historyTab?.getAttribute('href')).toBe('/friends/detail?id=friend-1&tab=history')
  })
})

describe('情報欄の分類（FRIEND-21）', () => {
  beforeEach(() => {
    fx.folders.mockResolvedValue({ success: true, data: [{ id: 'fd-1', name: '好み', type: 'friend_field' }] })
    fx.forFriend.mockResolvedValue({
      success: true,
      data: {
        items: [
          field('fixed-name', '名前', '見本 143', { fixedKey: 'name', isPersonal: true }),
          field('f-dog', '犬の名前', 'こむぎ', { folderId: 'fd-1' }),
        ],
        hiddenPersonalCount: 0,
      },
    })
  })

  const chips = () => [...host.querySelectorAll<HTMLAnchorElement>('[aria-label="情報欄の分類"] a')]

  it('「すべて」「基本」「フォルダ」を件数つきのリンクで出し、今の分類に印を付ける', async () => {
    await open('id=friend-1&tab=info')
    expect(chips().map((a) => a.textContent)).toEqual(['すべて 2', '基本 1', '好み 1'])
    expect(chips().map((a) => a.getAttribute('href'))).toEqual([
      '/friends/detail?id=friend-1&tab=info',
      '/friends/detail?id=friend-1&tab=info&group=basic',
      '/friends/detail?id=friend-1&tab=info&group=fd-1',
    ])
    expect(chips().map((a) => a.getAttribute('aria-current'))).toEqual(['true', null, null])
    expect(host.querySelector('#ff-fixed-name')).toBeTruthy()
    expect(host.querySelector('#ff-f-dog')).toBeTruthy()
  })

  it('フォルダで開くとその分類の項目だけを出す', async () => {
    await open('id=friend-1&tab=info&group=fd-1')
    expect(chips().map((a) => a.getAttribute('aria-current'))).toEqual([null, null, 'true'])
    expect(host.querySelector('#ff-f-dog')).toBeTruthy()
    expect(host.querySelector('#ff-fixed-name')).toBeNull()
  })

  it('消えた分類は「見つかりません」と出し、基本の項目へ戻る口を置く', async () => {
    await open('id=friend-1&tab=info&group=gone')
    expect(host.textContent).toContain('この分類は削除されたか、見つかりません')
    expect(hrefOf('基本の項目を見る')).toBe('/friends/detail?id=friend-1&tab=info')
    expect(host.querySelector('#ff-f-dog')).toBeNull()
  })
})

describe('情報欄の項目名と入力欄（FRIEND-22）', () => {
  it('項目名のラベルが入力欄を指し、複数選択の欄は項目名へ戻る', async () => {
    fx.forFriend.mockResolvedValue({
      success: true,
      data: { items: [field('f-dog', '犬の名前', 'こむぎ'), field('f-multi', '好きなおやつ', 'ささみ,ガム', { type: 'multi_select' })], hiddenPersonalCount: 0 },
    })
    await open('id=friend-1&tab=info')
    const label = host.querySelector<HTMLLabelElement>('label[for="ff-f-dog"]')!
    expect(label.id).toBe('ff-f-dog-label')
    expect(label.textContent).toContain('犬の名前')
    expect(host.querySelector('#ff-f-dog')?.tagName).toBe('INPUT')
    const multi = host.querySelector('[aria-labelledby="ff-f-multi-label"]')!
    expect(multi.textContent).toContain('ささみ')
    expect(document.getElementById('ff-f-multi-label')?.textContent).toContain('好きなおやつ')
  })
})

describe('隠れた項目と項目なし（FRIEND-23）', () => {
  it('権限で隠れているだけのときは理由を出し、「項目を作る」を勧めない', async () => {
    fx.forFriend.mockResolvedValue({ success: true, data: { items: [], hiddenPersonalCount: 2 } })
    await open('id=friend-1&tab=info')
    expect(host.textContent).toContain('個人情報の項目が 2 件あります。表示には個人情報の閲覧権限が要ります。')
    expect(host.textContent).not.toContain('情報欄の項目がまだありません。')
    expect(byText('a', '項目を作る')).toHaveLength(0)
  })

  it('本当に項目が無いときは「まだありません」と出し、管理者には作る口を置く', async () => {
    fx.forFriend.mockResolvedValue({ success: true, data: { items: [], hiddenPersonalCount: 0 } })
    await open('id=friend-1&tab=info')
    expect(host.textContent).toContain('情報欄の項目がまだありません。')
    expect(host.textContent).not.toContain('閲覧権限が要ります')
    expect(byText('a', '項目を作る')).toHaveLength(1)
  })
})

describe('回答フォームの見出し（FRIEND-24）', () => {
  it('質問の label を見出しにし、定義に無いキーは原キーに「使われていない項目」を添える', async () => {
    fx.formSubmissions.mockResolvedValue({
      success: true,
      data: {
        items: [{
          id: 's1', formId: 'form-1', formName: '問診票', createdAt: '2026-10-01T10:00:00+09:00',
          fields: [{ name: 'q_dog', label: '犬の名前', type: 'text' }],
          data: { q_dog: 'こむぎ', old_q: '前の答え' },
        }],
        total: 1,
        nextCursor: null,
      },
    })
    await open('id=friend-1&tab=forms')
    const headings = [...host.querySelectorAll('dt')].map((dt) => dt.textContent)
    expect(headings).toEqual(['犬の名前', 'old_q（現在は使われていない項目）'])
    expect(host.textContent).toContain('こむぎ')
    expect(host.textContent).toContain('前の答え')
  })
})

describe('履歴の続きの取り損ね（FRIEND-26）', () => {
  it('続きの失敗は末尾だけに出し、読めた行を残して同じ所から試し直せる', async () => {
    let failMore = true
    fx.fetchApi.mockImplementation(async (path: string) => {
      if (!path.includes('cursor=')) return { success: true, data: { items: timeline, nextCursor: 'next-1' } }
      if (failMore) throw new Error('offline')
      return { success: true, data: { items: [{ ...timeline[1], id: 'c', summary: '続きの記録' }], nextCursor: null } }
    })
    await open('id=friend-1&tab=history')
    act(() => { byText('button', 'さらに読み込む')[0].click() })
    await flush()
    expect(host.textContent).toContain('続きを読み込めませんでした')
    expect(host.textContent).toContain('『秋の新商品はいつ届きますか？』')
    expect(host.textContent).not.toContain('履歴を読み込めませんでした')
    expect(byText('button', 'さらに読み込む')).toHaveLength(0)

    failMore = false
    act(() => { byText('button', 'もう一度試す')[0].click() })
    await flush()
    expect(fx.fetchApi).toHaveBeenLastCalledWith(expect.stringContaining('cursor=next-1'), expect.anything())
    expect(host.textContent).toContain('続きの記録')
    expect(host.textContent).not.toContain('続きを読み込めませんでした')
  })
})

describe('準備中タブの代わりの操作（FRIEND-27）', () => {
  it('配信・シナリオタブは説明と、登録の操作・一覧への行き先を出す', async () => {
    await open('id=friend-1&tab=scenario')
    expect(host.textContent).toContain('この友だちをシナリオへ登録する操作はここからできます。')
    expect(hrefOf('シナリオ一覧を見る ↗')).toBe('/scenarios')
    act(() => { byText('button', 'この友だちをシナリオに登録する')[0].click() })
    await flush()
    expect(document.querySelector('[data-scenario-picker]')).toBeTruthy()
    expect(fx.scenarios).toHaveBeenCalled()
  })

  it('登録できない人には登録の操作を置かず、一覧への行き先は残す', async () => {
    fx.role = 'staff'
    await open('id=friend-1&tab=scenario')
    expect(byText('button', 'この友だちをシナリオに登録する')).toHaveLength(0)
    expect(hrefOf('シナリオ一覧を見る ↗')).toBe('/scenarios')
  })

  it('アクションタブは同じ記録が並ぶ履歴タブへつなぐ', async () => {
    await open('id=friend-1&tab=actions')
    expect(hrefOf('履歴タブを見る')).toBe('/friends/detail?id=friend-1&tab=history')
  })
})

describe('履歴の種類・状態・元情報（IDEA-03）', () => {
  it('種類と状態を言葉で出し、行き先のある種類だけに元情報のリンクを付ける', async () => {
    const items = [
      { id: 'o1', type: 'ec_order', summary: '注文 3,000円', status: 'refunded', source: { kind: 'ec_order', id: 'o1', parentId: null, url: 'https://shop.example/orders/1' }, occurredAt: '2026-10-01T09:00:00+09:00', lineAccount: null },
      { id: 'b1', type: 'booking', summary: 'トリミングの予約', status: 'confirmed', source: { kind: 'booking', id: 'b1', parentId: null, url: null }, occurredAt: '2026-10-01T08:00:00+09:00', lineAccount: null },
      { id: 'p1', type: 'photo_submitted', summary: '写真を送った', status: 'pending', source: { kind: 'photo', id: 'p1', parentId: null, url: null }, occurredAt: '2026-10-01T07:00:00+09:00', lineAccount: null },
      { id: 'f1', type: 'form_submitted', summary: '問診に答えた', status: null, source: { kind: 'form_submission', id: 'f1', parentId: null, url: null }, occurredAt: '2026-10-01T06:00:00+09:00', lineAccount: null },
    ]
    fx.fetchApi.mockResolvedValue({ success: true, data: { items, nextCursor: null } })
    await open('id=friend-1&tab=history')
    const rowOf = (summary: string) => [...host.querySelectorAll('[role="row"]')].find((row) => row.textContent?.includes(summary))!
    expect(rowOf('注文 3,000円').textContent).toContain('注文')
    expect(rowOf('注文 3,000円').textContent).toContain('返金済み')
    expect(rowOf('注文 3,000円').querySelector('a')?.getAttribute('href')).toBe('https://shop.example/orders/1')
    expect(rowOf('トリミングの予約').textContent).toContain('確定')
    expect(rowOf('トリミングの予約').querySelector('a')?.getAttribute('href')).toBe('/booking/bookings/detail?id=b1')
    expect(rowOf('写真を送った').textContent).toContain('写真投稿')
    expect(rowOf('写真を送った').textContent).toContain('確認待ち')
    // 行き先の無い種類・親の分からない回答には、黙ってリンクを付けない。
    expect(rowOf('写真を送った').querySelector('a')).toBeNull()
    expect(rowOf('問診に答えた').querySelector('a')).toBeNull()
  })

  it('続きを読んだとき、同じ元の行は二重に足さない', async () => {
    const first = { id: 'm1', type: 'message_received', summary: '最初のメッセージ', status: null, source: { kind: 'message', id: 'm1', parentId: null, url: null }, occurredAt: '2026-10-01T10:00:00+09:00', lineAccount: null }
    fx.fetchApi.mockImplementation(async (path: string) => path.includes('cursor=')
      ? { success: true, data: { items: [first, { ...first, id: 'm2', summary: '続きのメッセージ' }], nextCursor: null } }
      : { success: true, data: { items: [first], nextCursor: 'next-1' } })
    await open('id=friend-1&tab=history')
    act(() => { byText('button', 'さらに読み込む')[0].click() })
    await flush()
    expect(host.textContent).toContain('続きのメッセージ')
    expect(host.textContent?.split('最初のメッセージ').length).toBe(2)
  })
})

describe('友だちを切り替えた後の遅い履歴', () => {
  it('前の友だちの履歴が遅れて届いても、今の友だちの履歴に混ぜない', async () => {
    let finishOld!: (value: unknown) => void
    fx.fetchApi.mockImplementation((path: string) => path.includes('/friend-1/')
      ? new Promise((resolve) => { finishOld = resolve })
      : Promise.resolve({ success: true, data: { items: [{ ...timeline[1], id: 'new', summary: '今の友だちの記録' }], nextCursor: null } }))
    await open('id=friend-1&tab=history')
    fx.params = new URLSearchParams('id=friend-2&tab=history')
    act(() => { root.render(<FriendDetailPage />) })
    await flush()
    expect(host.textContent).toContain('今の友だちの記録')
    await act(async () => { finishOld({ success: true, data: { items: [{ ...timeline[1], id: 'old', summary: '前の友だちの記録' }], nextCursor: null } }) })
    await flush()
    expect(host.textContent).toContain('今の友だちの記録')
    expect(host.textContent).not.toContain('前の友だちの記録')
  })
})
