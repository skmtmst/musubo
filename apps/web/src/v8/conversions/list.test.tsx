import { expectPermissionLocked, expectLockedFolderMenu } from '@/test-utils/permission-locked-control'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
import { READ_ONLY_MESSAGE } from '@/components/shared/read-only-notice'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 コンバージョンの一覧（src/v8/conversions/list.tsx）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 状態の札と件数・行の「…」（変える操作は権限のある人だけ）・止める小窓（理由が無いと止められない）・
 * 閲覧のみの帯と押せないボタンを置かないこと・1152 の板は札2つ。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const narrow = vi.hoisted(() => ({ value: false }))
const push = vi.hoisted(() => vi.fn())
const search = vi.hoisted(() => ({ value: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/conversions',
  useSearchParams: () => new URLSearchParams(search.value),
}));


vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}));


vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}));


vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}));


vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
});


vi.mock('@/lib/use-narrow-viewport', () => ({
  useNarrowViewport: () => narrow.value,
}));


import ConversionListV8 from './list'
import { originInfoOf } from './origin-labels'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function point(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name, sourceType: 'ec_order_confirmed', value: null, measureMethod: 'webhook', targetUrl: null, countRepeat: true,
    attributionDays: 90, sourceConfig: {}, deduplicationMode: 'every', deduplicationWindowDays: null, valueMode: 'source',
    reversalPolicy: 'source_cancelled', lineAccountId: 'account-a', status: 'active', state: 'active', stateReason: null,
    ingest: { configured: true, disabledAt: null }, version: 3, usageCount: 2, usageNames: ['ファネル 1', 'アフィリエイト 1'],
    metrics: { recordedCount: 52, netCount: 52, reversedCount: null, reversedValue: null, netValue: 412000, reversalState: 'unavailable', reversalReason: '', cancellationCount: null, cancellationValue: null },
    stoppedAt: null, createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  }
}

const items = [
  point('cp-1', '商品を買った', { folderId: 'f-ec' }),
  point('cp-6', '資料をダウンロードした', { sourceType: 'url_reach', measureMethod: 'url_reach', targetUrl: 'https://example.com/dl', deduplicationMode: 'once_per_friend', valueMode: 'none', status: 'stopped', state: 'stopped', usageCount: 0, usageNames: [], stoppedAt: '2026-09-20T09:00:00.000Z' }),
]

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const calls: string[] = []

let root: Root
let host: HTMLDivElement

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mount() {
  await act(async () => { root.render(<ConversionListV8 accountId="account-a" />) })
  await flush()
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role.value = verifiedStaffRole('owner')
  narrow.value = false
  window.history.replaceState(null, '', '/conversions')
  push.mockReset()
  search.value = ''
  calls.length = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/api/conversions/definitions') {
      return json({ success: true, data: { items, stateCounts: { active: 1, draft: 0, stopped: 1, invalid: 0, sourceStopped: 0, unused: 1 }, range: {}, pagination: { total: 2, limit: 100, cursor: '0', nextCursor: null } } })
    }
    if (url.pathname === '/api/conversions/report') {
      return json({ success: true, data: { kpis: { netCount: 52, previousNetCount: 40, netValue: 412000 }, byDefinition: [] } })
    }
    if (url.pathname === '/api/folders') {
      return json({ success: true, data: [{ id: 'f-ec', kind: 'conversion', name: '通販', parentId: null, displayOrder: 0, color: '#16a34a', createdAt: '', updatedAt: '', itemCount: 1 }], unfiledCount: 1 })
    }
    if (url.pathname.endsWith('/delete-impact')) {
      return json({ success: true, data: { definition: { ...items[0], version: 3 }, usages: [], eventCount: 52, canDelete: false, stopImpact: { affectedUsageCount: 2, preservesPastEvents: true, preservesUsages: true }, replacementCandidates: [] } })
    }
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('V8 コンバージョンの一覧', () => {
  it('並びの3択を受け口へ渡し、名前の検索で表示を絞る', async () => {
    const base = globalThis.fetch
    const sorts: Array<string | null> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname !== '/api/conversions/definitions') return base(input, init)
      sorts.push(url.searchParams.get('sort'))
      const response = await base(input, init)
      const body = await response.json()
      const query = url.searchParams.get('q') ?? ''
      const matched = body.data.items.filter((point: { name: string }) => point.name.includes(query))
      return json({ ...body, data: { ...body.data, items: matched, pagination: { ...body.data.pagination, total: matched.length } } })
    })
    await mount()
    expect(sorts[0]).toBe('count_desc')
    fireEvent.click(screen.getByRole('button', { name: '並び' }))
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['件数が多い順', '金額が多い順', '名前順'])
    fireEvent.click(within(screen.getByRole('option', { name: '金額が多い順' })).getByRole('button'))
    await flush()
    await waitFor(() => expect(sorts).toContain('value_desc'))
    fireEvent.click(screen.getByRole('button', { name: '並び' }))
    fireEvent.click(within(screen.getByRole('option', { name: '名前順' })).getByRole('button'))
    await flush()
    await waitFor(() => expect(sorts).toContain('name_asc'))
    fireEvent.change(screen.getByLabelText('成果地点の名前で探す'), { target: { value: '資料' } })
    await waitFor(() => {
      expect(screen.queryByText('商品を買った')).toBeNull()
      expect(screen.getByText('資料をダウンロードした')).toBeTruthy()
    })
  })

  it('行の詳細を右パネルとURLへ残し、再表示・閉じるを同期する', async () => {
    await mount()
    fireEvent.click(screen.getByText('商品を買った'))
    await flush()
    expect(new URLSearchParams(window.location.search).get('point')).toBe('cp-1')
    expect(screen.getByRole('dialog', { name: '商品を買った' })).toBeTruthy()
    act(() => root.unmount())
    root = createRoot(host)
    await mount()
    const panel = screen.getByRole('dialog', { name: '商品を買った' })
    fireEvent.click(within(panel).getByRole('button', { name: '閉じる' }))
    await flush()
    expect(new URLSearchParams(window.location.search).get('point')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '商品を買った' })).toBeNull()
  })

  it('一覧の読み込みが失敗しても空とは扱わず、読み直すと成果地点を表示する', async () => {
    const base = globalThis.fetch
    let failed = true
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failed && new URL(String(input)).pathname === '/api/conversions/definitions') {
        return json({ success: false, error: 'unavailable' }, 503)
      }
      return base(input, init)
    })
    await mount()
    expect(screen.getByText('成果地点を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('まだ成果地点がありません')).toBeNull()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await flush()
    expect(screen.getByText('商品を買った')).toBeTruthy()
    expect(screen.queryByText('成果地点を読み込めませんでした')).toBeNull()
  })
  it('編集で名前が空なら、その欄で理由を知らせ、欄へ移り、更新しない', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '成果地点「商品を買った」の操作' }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
    await flush()
    expect(push).toHaveBeenCalledWith('/conversions/edit?id=cp-1')
    await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
    await flush()
    const input = screen.getByLabelText('成果地点の名前') as HTMLInputElement
    const scroll = vi.fn()
    input.scrollIntoView = scroll
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    await flush()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    const error = screen.getByRole('alert')
    expect(error.textContent).toBe('名前を入れてください')
    expect(input.getAttribute('aria-describedby')?.split(/\s+/)).toContain(error.id)
    expect(screen.getAllByText('名前を入れてください')).toHaveLength(1)
    expect(calls.some((call) => call.startsWith('POST '))).toBe(false)
  })

  it('状態の札に口の件数を出し、行に数え方と使われている場所を出す', async () => {
    await mount()
    expect(screen.getByRole('button', { name: /有効 1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /どこからも使われていない 1/ })).toBeTruthy()
    expect(screen.getByText('注文が確定したとき')).toBeTruthy()
    expect(screen.getByText('1回ごと・取り消しは引く')).toBeTruthy()
    expect(screen.getByText('1人1回・止めた日 09/20')).toBeTruthy()
    expect(screen.getByText('ファネル 1')).toBeTruthy()
    expect(screen.getByText('アフィリエイト 1')).toBeTruthy()
  })

  it('管理できる人：作る・使う場所を足すがあり、「…」から止めると確認画面が開く（理由が無いと止められない）', async () => {
    await mount()
    expect(screen.getAllByRole('link', { name: /成果地点を作る/ }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: '使う場所を足す' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '成果地点「商品を買った」の操作' }))
    await flush()
    expect(screen.getByRole('menuitem', { name: '使う場所を足す' }).getAttribute('href'))
      .toBe(`/analytics?tab=funnel&conversionPointId=cp-1&conversionPointName=${encodeURIComponent('商品を買った')}`)
    expect(screen.getByRole('menuitem', { name: '編集する' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '複製する' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
    await flush()
    expect(calls).toContain('GET /api/conversions/definitions/cp-1/delete-impact')
    const card = screen.getByRole('dialog', { name: '「商品を買った」を止めますか？' })
    expect(card.textContent).toContain('2か所で使われています。どうしますか。')
    expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toContain('2か所で使われています。どうしますか。')
    const stop = (Array.from(card.querySelectorAll('button')).find((button) => button.textContent === '止める') ?? querySupplementaryPageAction('止める')) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    expect(stop.getAttribute('aria-description')).toContain('止める理由を入力してください')
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '計測の仕方を変えるため' } })
    expect(stop.disabled).toBe(false)
  })

  it('閲覧のみ：帯を出し、作る・使う場所を足す・変える操作は置かない（見る操作は残す）', async () => {
    role.value = verifiedStaffRole('staff')
    await mount()
    expect(screen.getByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /成果地点を作る/ })).toBeNull()
    expect(screen.queryByRole('link', { name: '使う場所を足す' })).toBeNull()
    // 1ページでは移動を置かず、閲覧のみの変更操作も隠す。
    const disabled = Array.from(document.querySelectorAll('button')).filter((button) => button.disabled)
    expect(disabled.filter((button) => !button.closest('[data-pagination]'))).toEqual([])
    expect(disabled).toEqual([])
    expect(screen.queryByRole('button', { name: '次のページ' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '成果地点「商品を買った」の操作' }))
    await flush()
    expect(screen.getByRole('menuitem', { name: '成果地点の詳細を見る' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '使う場所を見る' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '編集する' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '止める' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '複製する' })).toBeNull()
  })

  it('下書きと停止中が混じるとき、それぞれの数を帯と絞り込みに表示する', async () => {
    const base = fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init)
      if (new URL(String(input)).pathname !== '/api/conversions/definitions') return response
      const body = await response.json()
      body.data.items.push(point('cp-draft', '架空の下書き', { status: 'draft', state: 'draft' }))
      body.data.stateCounts.draft = 1
      body.data.pagination.total = 3
      return json(body)
    })
    await mount()
    expect(screen.getByText('有効 1・下書き 1・停止中 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: '下書き 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止中 1' })).toBeTruthy()
  })

  it('1152 の板：札は「動いている」「止めている」の2つだけ（ほかはよく使う絞り込みから）', async () => {
    narrow.value = true
    await mount()
    expect(screen.getByRole('button', { name: /有効 1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /停止中 1/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /下書き 0/ })).toBeNull()
    expect(screen.getByText('使われていない')).toBeTruthy()
  })

  it('受け口を止めると押した瞬間に「止まっています」になり、保存に失敗したら元に戻す（触り心地 5 回目）', async () => {
    let finish: (response: Response) => void = () => {}
    const base = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/ingest-disable')) {
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
        return new Promise<Response>((resolve) => { finish = resolve })
      }
      return base(input, init)
    })
    await mount()
    fireEvent.click(screen.getByText('商品を買った'))
    await flush()
    const panel = screen.getByRole('dialog', { name: '商品を買った' })
    expect(panel.textContent).toContain('（動いています）')
    fireEvent.click(screen.getByRole('button', { name: '詳細「商品を買った」のその他の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '受け口を止める' }))
    await flush()
    expect(calls).toContain('POST /api/conversions/definitions/cp-1/ingest-disable')
    // 返事を待たずに変わっている
    expect(screen.getByRole('dialog', { name: '商品を買った' }).textContent).toContain('（止まっています）')
    await act(async () => { finish(json({ success: false, error: 'conflict' }, 409)) })
    await flush()
    expect(screen.getByRole('dialog', { name: '商品を買った' }).textContent).toContain('（動いています）')
    expect(calls.filter((call) => call === 'GET /api/conversions/definitions')).toHaveLength(1)
  })

  it('札で絞ると、その状態の行だけになる', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /停止中 1/ }))
    await flush()
    expect(screen.queryByText('商品を買った')).toBeNull()
    expect(screen.getByText('資料をダウンロードした')).toBeTruthy()
  })

  it('左のフォルダの列（共通・種類 conversion）：すべて・通販・未分類で絞り、名前の前にフォルダの色の丸。閲覧のみは追加・「…」の変更を理由付きで拒否する', async () => {
    await mount()
    expect(calls).toContain('GET /api/folders')
    const folderNav = screen.getByRole('navigation', { name: 'フォルダ' })
    expect([...folderNav.querySelectorAll('button[title]')].map((b) => b.getAttribute('title')).filter((t) => !t?.startsWith('フォルダ「'))).toEqual(['すべて', '通販', '未分類'])
    expect(screen.getByRole('button', { name: /フォルダを追加/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'フォルダ「通販」の操作' })).toBeTruthy()
    expect(host.querySelector('tr[data-row-id="cp-1"] [aria-label="フォルダ：通販"]')).not.toBeNull()
    expect(host.querySelector('tr[data-row-id="cp-6"] [data-folder-dot]')?.getAttribute('data-folder-dot')).toBe('unfiled')
    fireEvent.click(folderNav.querySelector('button[title="通販"]')!)
    await flush()
    expect(screen.getByText('商品を買った')).toBeTruthy()
    expect(screen.queryByText('資料をダウンロードした')).toBeNull()
    fireEvent.click(folderNav.querySelector('button[title="未分類"]')!)
    await flush()
    expect(screen.queryByText('商品を買った')).toBeNull()
    expect(screen.getByText('資料をダウンロードした')).toBeTruthy()
    fireEvent.click(folderNav.querySelector('button[title="すべて"]')!)
    await flush()

    act(() => root.unmount())
    root = createRoot(host)
    role.value = verifiedStaffRole('viewer')
    await mount()
    await expectPermissionLocked(screen.getByRole('button', { name: /フォルダを追加/ }))
    await expectLockedFolderMenu(screen.getByRole('button', { name: 'フォルダ「通販」の操作' }))
  })
})

/* 口の返事を1つだけ差し替える（ほかは上の既定のまま）。 */
function overrideFetch(handler: (url: URL, init?: RequestInit) => Promise<Response> | Response | null) {
  const base = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const response = await handler(url, init)
    if (response) {
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return response
    }
    return base(input, init)
  })
}

const listBody = (list: unknown[], pagination: Record<string, unknown> = {}) => ({
  success: true,
  data: { items: list, stateCounts: { active: list.length, draft: 0, stopped: 0, invalid: 0, sourceStopped: 0, unused: 0 }, range: {}, pagination: { total: list.length, limit: 100, cursor: '0', nextCursor: null, ...pagination } },
})

const stopDialog = () => screen.getByRole('dialog', { name: '「商品を買った」を止めますか？' })
/* 確定のボタンは「キャンセル」の隣（処理中は文字が変わるため、文字では探さない）。 */
const confirmButton = () => {
  const buttons = Array.from(stopDialog().querySelectorAll('button'))
  return buttons[buttons.findIndex((button) => button.textContent === 'キャンセル') + 1] as HTMLButtonElement
}

async function openStopDialog() {
  fireEvent.click(screen.getByRole('button', { name: '成果地点「商品を買った」の操作' }))
  await flush()
  fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
  await flush()
}

describe('V8 コンバージョンの一覧：読み込みの扱い', () => {
  it('続きの頁を cursor で読み足し、全部の行を出す', async () => {
    const cursors: Array<string | null> = []
    overrideFetch((url) => {
      if (url.pathname !== '/api/conversions/definitions') return null
      const cursor = url.searchParams.get('cursor')
      cursors.push(cursor)
      return cursor === 'next-1' ? json(listBody([items[1]])) : json(listBody([items[0]], { nextCursor: 'next-1' }))
    })
    await mount()
    expect(cursors).toEqual([null, 'next-1'])
    expect(screen.getByText('商品を買った')).toBeTruthy()
    expect(screen.getByText('資料をダウンロードした')).toBeTruthy()
    expect(screen.queryByText(/先頭5000個まで/)).toBeNull()
  })

  it('50頁で読むのを止め、切れたことを帯と数の帯で知らせる', async () => {
    let requests = 0
    overrideFetch((url) => {
      if (url.pathname !== '/api/conversions/definitions') return null
      requests += 1
      return json(listBody([point(`cp-page-${requests}`, `成果${requests}`)], { nextCursor: `next-${requests}` }))
    })
    await mount()
    expect(requests).toBe(50)
    expect(screen.getByText(/一覧は先頭5000個までを表示しています/)).toBeTruthy()
    expect(screen.getByText('直近5000件までの合計です')).toBeTruthy()
  })

  it('一覧の形でない返事は成功と扱わず、前の行も残さない', async () => {
    let broken = false
    overrideFetch((url) => {
      if (url.pathname !== '/api/conversions/definitions' || !broken) return null
      return json({ success: true, data: { items: null, pagination: { total: 0, nextCursor: null } } })
    })
    await mount()
    expect(screen.getByText('商品を買った')).toBeTruthy()
    broken = true
    fireEvent.change(screen.getByLabelText('成果地点の名前で探す'), { target: { value: '商品' } })
    await flush()
    await waitFor(() => expect(screen.getByText('成果地点を読み込めませんでした')).toBeTruthy())
    expect(screen.queryByText('商品を買った')).toBeNull()
    expect(screen.queryByText('まだ成果地点がありません')).toBeNull()
  })

  it('読み込み中は骨組みを出し、0件なら作るボタンと同じ名前で案内する', async () => {
    let release: (response: Response) => void = () => {}
    overrideFetch((url) => (url.pathname === '/api/conversions/definitions'
      ? new Promise<Response>((resolve) => { release = resolve })
      : null))
    await act(async () => { root.render(<ConversionListV8 accountId="account-a" />) })
    expect(screen.getByText('成果地点を読み込んでいます')).toBeTruthy()
    await act(async () => { release(json(listBody([]))) })
    await flush()
    expect(screen.getByText('まだ成果地点がありません')).toBeTruthy()
    const create = screen.getByRole('link', { name: '最初の成果地点を作る' })
    expect(create.getAttribute('href')).toBe('/conversions/new')
  })

  it('アカウントを切り替えたら、遅れて届いた前のアカウントの一覧で上書きしない', async () => {
    let releaseA: (response: Response) => void = () => {}
    overrideFetch((url) => {
      if (url.pathname !== '/api/conversions/definitions') return null
      if (url.searchParams.get('lineAccountId') === 'account-a') return new Promise<Response>((resolve) => { releaseA = resolve })
      return json(listBody([point('cp-b', 'B店の成果', { lineAccountId: 'account-b' })]))
    })
    await act(async () => { root.render(<ConversionListV8 accountId="account-a" />) })
    await act(async () => { root.render(<ConversionListV8 accountId="account-b" />) })
    await flush()
    expect(screen.getByText('B店の成果')).toBeTruthy()
    await act(async () => { releaseA(json(listBody([point('cp-a', 'A店の成果')]))) })
    await flush()
    expect(screen.getByText('B店の成果')).toBeTruthy()
    expect(screen.queryByText('A店の成果')).toBeNull()
  })

  it('行に件数を出し、切れる文言は title で全文を読める', async () => {
    await mount()
    const urlRow = host.querySelector('tr[data-row-id="cp-6"]')!
    expect(urlRow.querySelector('[title="サイトの「https://example.com/dl」に到達"]')?.textContent).toBe('ページのURLを開いたとき')
    const orderRow = host.querySelector('tr[data-row-id="cp-1"]')!
    expect(orderRow.querySelector('[title="ファネル 1・アフィリエイト 1"]')).not.toBeNull()
    expect(Array.from(orderRow.querySelectorAll('td'), (cell) => cell.textContent)).toContain('52 件')
  })

  it('表は共通の表に列の寸法を渡し、見出し行は共通の見出し行を使う', async () => {
    await mount()
    const frame = host.querySelector('[data-shared-part="list-table"][data-column-layout]') as HTMLElement
    expect(frame.style.getPropertyValue('--table-column-padding')).toBe('0 var(--tpl-list-inset)')
    expect(frame.querySelector('thead tr[data-shared-part="list-head"]')).not.toBeNull()
    expect(frame.querySelectorAll('tbody tr[data-shared-part="list-row"]')).toHaveLength(2)
  })

  it('作って戻った行を ?highlight= で色を付けて見せ、そこまで送り、保存したことを知らせる', async () => {
    search.value = 'highlight=cp-6'
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    await mount()
    expect(screen.getByText('「資料をダウンロードした」を保存しました。色の付いた行です。')).toBeTruthy()
    const row = host.querySelector('tr[data-row-id="cp-6"]') as HTMLElement
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('tr[data-row-id="cp-1"]')?.getAttribute('aria-selected')).toBe('false')
    expect(scroll.mock.contexts).toContain(row)
    scroll.mockRestore()
  })

  it('CSV は1回だけ書き出し、失敗したら理由を出す', async () => {
    const created = vi.fn(() => 'blob:points')
    const revoked = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: created, revokeObjectURL: revoked }))
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    let fail = false
    overrideFetch((url) => (url.pathname === '/api/conversions/export'
      ? fail ? json({ success: false, error: 'forbidden' }, 403) : new Response('name\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })
      : null))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /CSVで書き出す/ }))
    await flush()
    expect(calls.filter((call) => call === 'GET /api/conversions/export')).toHaveLength(1)
    expect(created).toHaveBeenCalledTimes(1)
    expect(clicked).toHaveBeenCalledTimes(1)
    expect((clicked.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/^成果地点.*\.csv$/)
    expect(revoked).toHaveBeenCalledWith('blob:points')
    fail = true
    fireEvent.click(screen.getByRole('button', { name: /CSVで書き出す/ }))
    await flush()
    expect(screen.getByText('CSVを書き出せませんでした。権限を確認して、もう一度お試しください。')).toBeTruthy()
    expect(created).toHaveBeenCalledTimes(1)
    clicked.mockRestore()
  })
})

describe('V8 コンバージョンの一覧：止める・差し替える・削除する', () => {
  it('確認した成果地点のアカウントと環境を示し、アカウント変更後の古い確認では止めない', async () => {
    await mount()
    await openStopDialog()
    expect(stopDialog().textContent).toContain('本店')
    expect(stopDialog().textContent).toContain('環境')
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '変更のため' } })
    await act(async () => { root.render(<ConversionListV8 accountId="account-b" />) })
    await flush()
    expect(screen.queryByRole('dialog', { name: '「商品を買った」を止めますか？' })).toBeNull()
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/stop'))).toBe(false)
  })

  it('アカウントを変えた古い成果地点の確認では停止しない', async () => {
    await mount()
    await openStopDialog()
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '変更のため' } })
    await act(async () => { root.render(<ConversionListV8 accountId="account-b" />) })
    await flush()
    const stale = screen.queryByRole('dialog', { name: '「商品を買った」を止めますか？' })
    if (stale) fireEvent.click(confirmButton())
    await flush()
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/stop'))).toBe(false)
  })

  it('アカウントを戻しても古い確認を復活させない', async () => {
    await mount()
    await openStopDialog()
    await act(async () => { root.render(<ConversionListV8 accountId="account-b" />) })
    await act(async () => { root.render(<ConversionListV8 accountId="account-a" />) })
    await flush()
    expect(screen.queryByRole('dialog', { name: '「商品を買った」を止めますか？' })).toBeNull()
  })

  it('確認を開いた後に成果地点の版が変わっていたら止めない', async () => {
    overrideFetch((url) => url.pathname.endsWith('/delete-impact')
      ? json({ success: true, data: { definition: { ...items[0], version: 4 }, usages: [], eventCount: 0, canDelete: true, stopImpact: { affectedUsageCount: 0 }, replacementCandidates: [] } })
      : null)
    await mount()
    await openStopDialog()
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '変更のため' } })
    fireEvent.click(confirmButton())
    await flush()
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/stop'))).toBe(false)
    expect(stopDialog().textContent).toContain('読み込めませんでした')
  })

  it('影響の読み込み中は確定できず、読めなかったら理由を出して送らない', async () => {
    let release: (response: Response) => void = () => {}
    overrideFetch((url) => (url.pathname.endsWith('/delete-impact')
      ? new Promise<Response>((resolve) => { release = resolve })
      : null))
    await mount()
    await openStopDialog()
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '計測の仕方を変えるため' } })
    expect(confirmButton().disabled).toBe(true)
    await act(async () => { release(json({ success: false, error: 'unavailable' }, 503)) })
    await flush()
    expect(stopDialog().textContent).toContain('利用先と停止の影響を読み込めませんでした。画面を閉じて、もう一度お試しください。')
    fireEvent.click(confirmButton())
    await flush()
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/stop'))).toBe(false)
    // 押したあとも「影響を読めない」のまま。止める処理の失敗と取り違えない。
    expect(stopDialog().textContent).toContain('利用先と停止の影響を読み込めませんでした。画面を閉じて、もう一度お試しください。')
    expect(stopDialog().textContent).not.toContain('計測を止められませんでした')
  })

  it('3つの選び方と過去の記録が残ることを示し、使えない選び方は選べない', async () => {
    await mount()
    await openStopDialog()
    const dialog = stopDialog()
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((radio) => radio.value)).toEqual(['stop', 'replace', 'delete'])
    expect(radios[0].checked).toBe(true)
    expect(within(dialog).getByRole('radio', { name: /止める（使う所の計測も止まる）/ })).toBeTruthy()
    expect((within(dialog).getByRole('radio', { name: /別の成果地点に差し替えてから止める/ }) as HTMLInputElement).disabled).toBe(true)
    expect((within(dialog).getByRole('radio', { name: /削除する/ }) as HTMLInputElement).disabled).toBe(true)
    expect(dialog.textContent).toContain('過去の記録と分析は残します。')
  })

  it('止める操作の失敗は窓の中に業務の言葉で出し、押せる状態へ戻す。二度押しでも1回だけ送る', async () => {
    const stops: unknown[] = []
    let mode: 'conflict' | 'soft' = 'conflict'
    overrideFetch((url, init) => {
      if (!url.pathname.endsWith('/stop')) return null
      stops.push(JSON.parse(String(init?.body ?? '{}')))
      return mode === 'conflict' ? json({ success: false, error: 'version_conflict' }, 409) : json({ success: false, error: 'raw failure code' })
    })
    await mount()
    await openStopDialog()
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '計測の仕方を変えるため' } })
    fireEvent.click(confirmButton())
    fireEvent.click(confirmButton())
    await flush()
    expect(stops).toEqual([{ expectedVersion: 3, reason: '計測の仕方を変えるため' }])
    const message = 'この成果地点の計測を止められませんでした。状態を読み直してから、もう一度お試しください。'
    expect(stopDialog().textContent).toContain(message)
    expect(confirmButton().disabled).toBe(false)
    mode = 'soft'
    fireEvent.click(confirmButton())
    await flush()
    expect(stops).toHaveLength(2)
    expect(stopDialog().textContent).toContain(message)
    expect(stopDialog().textContent).not.toContain('raw failure code')
  })

  it('差し替えは選んだ先と両方の版を送り、削除は削除の口へ送る', async () => {
    const writes: Array<{ call: string; body: unknown }> = []
    overrideFetch((url, init) => {
      if (url.pathname.endsWith('/delete-impact')) {
        return json({ success: true, data: { definition: { ...items[0], version: 3 }, usages: [], eventCount: 0, canDelete: true, stopImpact: { affectedUsageCount: 0, preservesPastEvents: true, preservesUsages: true }, replacementCandidates: [{ ...items[1], id: 'cp-9', name: '新しい購入', version: 2 }] } })
      }
      if (init?.method === 'POST' || init?.method === 'DELETE') {
        writes.push({ call: `${init.method} ${url.pathname}`, body: JSON.parse(String(init.body ?? '{}')) })
        return json({ success: true, data: { id: 'cp-1' } })
      }
      return null
    })
    await mount()
    await openStopDialog()
    fireEvent.click(within(stopDialog()).getByRole('radio', { name: /別の成果地点に差し替えてから止める/ }))
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '新しい成果地点へ移すため' } })
    expect(confirmButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '差し替え先の成果地点' }))
    const picker = screen.getAllByRole('dialog').at(-1)!
    fireEvent.click(within(picker).getByRole('radio', { name: /新しい購入/ }))
    fireEvent.click(within(picker).getByRole('button', { name: '選ぶ' }))
    await flush()
    fireEvent.click(confirmButton())
    await flush()
    expect(writes).toEqual([{ call: 'POST /api/conversions/definitions/cp-1/replace', body: { replacementId: 'cp-9', expectedVersion: 3, replacementExpectedVersion: 2, reason: '新しい成果地点へ移すため' } }])

    await openStopDialog()
    fireEvent.click(within(stopDialog()).getByRole('radio', { name: /削除する/ }))
    fireEvent.change(screen.getByLabelText('止める理由'), { target: { value: '試しに作ったため' } })
    expect(confirmButton().textContent).toBe('削除する')
    fireEvent.click(confirmButton())
    await flush()
    expect(writes[1]).toEqual({ call: 'DELETE /api/conversions/definitions/cp-1', body: { expectedVersion: 3, reason: '試しに作ったため' } })
  })
})

describe('V8 コンバージョンの一覧：中身を見る窓', () => {
  const definitionEvents = [
    { id: 'e1', friendId: 'f1', friendName: '佐藤', status: 'confirmed', approvalStatus: null, cancelled: false, reversed: false, latestReversalId: null, value: 1200, source: null, sourceEventId: null, createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'e2', friendId: 'f2', friendName: '鈴木', status: 'pending', approvalStatus: 'pending', cancelled: false, reversed: false, latestReversalId: null, value: null, source: null, sourceEventId: null, createdAt: '2026-09-02T10:00:00.000Z' },
    { id: 'e3', friendId: 'f3', friendName: '高橋', status: 'rejected', approvalStatus: 'rejected', cancelled: false, reversed: false, latestReversalId: null, value: 500, source: null, sourceEventId: null, createdAt: '2026-09-03T10:00:00.000Z' },
    { id: 'e4', friendId: 'f4', friendName: '田中', status: 'cancelled', approvalStatus: null, cancelled: true, reversed: true, latestReversalId: 'reversal-1', value: 800, source: null, sourceEventId: null, createdAt: '2026-09-04T10:00:00.000Z' },
  ].map(event => ({...event, approvalRevision: 7}))
  const ingest = (id: string, result: string, reason: string | null, isTest: boolean) => ({ id, conversionPointId: 'cp-1', result, reason, isTest, sourceEventId: null, friendId: null, payloadShape: null, signatureSha256: null, createdAt: '2026-09-05T10:00:00.000Z' })
  const ingestEvents = [
    ingest('i1', 'rejected', 'signature_mismatch', false),
    ingest('i2', 'rejected', 'source_event_id_missing', false),
    ingest('i3', 'recorded', null, true),
    ingest('i4', 'rejected', 'signature_missing', true),
  ]
  const eventPaths: string[] = []

  async function openDetail(name: string, eventsOk: boolean | 'soft' = true, withoutRevision = false, sharedEvents?: Array<Omit<(typeof definitionEvents)[number], 'approvalRevision'> & { approvalRevision: number | null }>) {
    eventPaths.length = 0
    overrideFetch((url) => {
      if (url.pathname.endsWith('/events')) {
        eventPaths.push(`${url.pathname}?${url.searchParams}`)
        if (eventsOk === 'soft') return json({ success: false, error: 'unavailable' })
        if (!eventsOk) return json({ success: false, error: 'unavailable' }, 503)
        const response=json({ success: true, data: { items: withoutRevision ? definitionEvents.map(({approvalRevision, ...event}) => event) : definitionEvents } })
        if (sharedEvents) response.json=async()=>({success:true,data:{items:sharedEvents}})
        return response
      }
      if (url.pathname.endsWith('/ingest-events')) {
        eventPaths.push(`${url.pathname}?${url.searchParams}`)
        return json({ success: true, data: { items: ingestEvents } })
      }
      return null
    })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: `成果地点「${name}」の操作` }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '成果地点の詳細を見る' }))
    await flush()
    return screen.getByRole('dialog', { name })
  }

  it('成果取消の確認に友だち・対象アカウント・環境を表示する', async () => {
    const dialog = await openDetail('商品を買った')
    const row = Array.from(dialog.querySelectorAll('li')).find((item) => item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button', { name: '取り消す' }))
    const confirm = screen.getByRole('alertdialog', { name: 'この成果を取り消す' })
    expect(confirm.textContent).toContain('佐藤')
    expect(confirm.textContent).toContain('本店')
    expect(confirm.textContent).toContain('環境')
  })

  it('アカウント変更後の古い成果取消は送らない', async () => {
    const dialog = await openDetail('商品を買った')
    const row = Array.from(dialog.querySelectorAll('li')).find((item) => item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button', { name: '取り消す' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '重複のため' } })
    await act(async () => { root.render(<ConversionListV8 accountId="account-b" />) })
    await flush()
    const stale = screen.queryByRole('alertdialog', { name: 'この成果を取り消す' })
    if (stale) fireEvent.click(within(stale).getByRole('button', { name: '取り消す' }))
    await flush()
    expect(calls.some(call => call === 'POST /api/conversions/events/e1/reversals')).toBe(false)
  })

  it('確認した成果と履歴の版を指定して取り消す', async () => {
    let body: unknown
    const dialog = await openDetail('商品を買った')
    overrideFetch((url, init) => {
      if (url.pathname !== '/api/conversions/events/e1/reversals') return null
      body = JSON.parse(String(init?.body))
      return json({ success: true, data: { id: 'rev-1', kind: 'reverse' } })
    })
    const row = Array.from(dialog.querySelectorAll('li')).find((item) => item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button', { name: '取り消す' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '重複のため' } })
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'この成果を取り消す' })).getByRole('button', { name: '取り消す' }))
    await flush()
    expect(body).toEqual({ kind: 'reverse', reason: '重複のため', expectedReversalId: null, expectedApprovalStatus: null, expectedCancelled: false, expectedApprovalRevision: 7 })
  })

  it('移行前の版なしを明示された成果は従来の確認情報で取り消す', async () => {
    let body: Record<string, unknown> | undefined
    const legacy = definitionEvents.map(event => ({ ...event, approvalRevision: null }))
    const dialog = await openDetail('商品を買った', true, false, legacy)
    overrideFetch((url, init) => {
      if (url.pathname !== '/api/conversions/events/e1/reversals') return null
      body = JSON.parse(String(init?.body))
      return json({ success: true, data: { id: 'rev-1', kind: 'reverse' } })
    })
    const row = Array.from(dialog.querySelectorAll('li')).find(item => item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button', { name: '取り消す' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '重複のため' } })
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'この成果を取り消す' })).getByRole('button', { name: '取り消す' }))
    await flush()
    expect(body).toEqual({ kind: 'reverse', reason: '重複のため', expectedReversalId: null, expectedApprovalStatus: null, expectedCancelled: false })
  })

  it('承認の版が取得できない時は取消を送らない', async () => {
    const dialog = await openDetail('商品を買った', true, true)
    const row = Array.from(dialog.querySelectorAll('li')).find(item => item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button', { name: '取り消す' }))
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '重複のため' } })
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'この成果を取り消す' })).getByRole('button', { name: '取り消す' }))
    await flush()
    expect(calls.some(call => call === 'POST /api/conversions/events/e1/reversals')).toBe(false)
    expect(screen.getByRole('alertdialog').textContent).toContain('確認情報を読み直して')
  })

  it('確認窓を開いた後に一覧の版が変わっても確認時の版を送る', async () => {
    const shared=definitionEvents.map(event=>({...event}));let body:Record<string,unknown>|undefined
    const dialog=await openDetail('商品を買った',true,false,shared)
    const row=Array.from(dialog.querySelectorAll('li')).find(item=>item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button',{name:'取り消す'}));shared[0].approvalRevision=8
    overrideFetch((url,init)=>{if(url.pathname!=='/api/conversions/events/e1/reversals')return null;body=JSON.parse(String(init?.body));return json({success:false,error:'更新されました'},409)})
    fireEvent.change(screen.getByLabelText('理由'),{target:{value:'確認済み'}})
    fireEvent.click(within(screen.getByRole('alertdialog',{name:'この成果を取り消す'})).getByRole('button',{name:'取り消す'}));await flush()
    expect(body?.expectedApprovalRevision).toBe(7)
  })

  it('アカウントを戻しても古い成果取消の確認は復活しない', async () => {
    const dialog = await openDetail('商品を買った')
    const row = Array.from(dialog.querySelectorAll('li')).find((item) => item.textContent?.includes('佐藤'))!
    fireEvent.click(within(row).getByRole('button', { name: '取り消す' }))
    await act(async () => { root.render(<ConversionListV8 accountId="account-b" />) })
    await act(async () => { root.render(<ConversionListV8 accountId="account-a" />) })
    await flush()
    expect(screen.queryByRole('alertdialog', { name: 'この成果を取り消す' })).toBeNull()
  })

  it('成果1件ずつの状態と金額なしを業務の言葉で出す', async () => {
    const dialog = await openDetail('商品を買った')
    expect(eventPaths).toContain('/api/conversions/definitions/cp-1/events?limit=10')
    const rows = Array.from(dialog.querySelectorAll('li'), (row) => row.textContent ?? '')
    expect(rows.find((row) => row.includes('佐藤'))).toContain('確定')
    expect(rows.find((row) => row.includes('鈴木'))).toContain('確認待ち')
    expect(rows.find((row) => row.includes('鈴木'))).toContain('金額なし')
    expect(rows.find((row) => row.includes('高橋'))).toContain('却下')
    expect(rows.find((row) => row.includes('田中'))).toContain('取消')
  })

  it('外部受信の失敗理由は訳して出し、検証の受信は実績と分けて名乗る', async () => {
    const dialog = await openDetail('商品を買った')
    expect(eventPaths).toContain('/api/conversions/definitions/cp-1/ingest-events?limit=5')
    const text = dialog.textContent ?? ''
    expect(text).toContain('受け取れなかった（署名が一致しませんでした。連携先の鍵を確認してください）')
    expect(text).toContain('受け取れなかった（送信側のイベントIDが無いため、重複かどうかを判定できませんでした）')
    expect(text).toContain('検証の受信（実績には数えません）')
    expect(text).toContain('検証の受信（受け取れなかった）（署名のない送信でした）')
    expect(text).not.toContain('signature_mismatch')
  })

  it.each([[false, '通信の失敗'], ['soft', '失敗の返事']] as const)('成果の記録が読めなければ空と言わずに失敗を出す（%s・%s）', async (mode) => {
    const dialog = await openDetail('商品を買った', mode)
    expect(dialog.textContent).toContain('成果の記録を読み込めませんでした')
    expect(dialog.textContent).not.toContain('まだ成果がありません')
  })

  it('対象・金額・数えない条件・数え方を対応表と同じ言葉で出す', async () => {
    const dialog = await openDetail('資料をダウンロードした')
    const term = (label: string) => (Array.from(dialog.querySelectorAll('dt')).find((dt) => dt.textContent?.trim() === label) ?? querySupplementaryPageAction(label))?.nextElementSibling?.textContent
    expect(term('何が起きたら数えるか')).toBe('サイトの「https://example.com/dl」に到達')
    expect(term('対象')).toBe(originInfoOf('url_reach').target)
    expect(term('金額')).toBe('金額を集計しない')
    expect(term('数えない条件')).toBe('除外なし')
    expect(term('数え方')).toBe('1人1回だけ')
  })
})

describe('V8 コンバージョンの一覧：編集の窓', () => {
  it('起点を確かめられ、数え方の選択肢は一覧・詳細と同じ呼び名を使う', async () => {
    await act(async () => { root.render(<ConversionListV8 accountId="account-a" editId="cp-1" />) })
    await flush()
    expect(host.textContent).toContain('起点：EC連携の「注文が確定」／すべての注文。')
    fireEvent.click(screen.getByRole('button', { name: '同じ人を何回数えるか' }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['何回でも数える', '1人1回だけ', '決めた日数に1回まで'])
  })
})

afterEach(() => { verifiedStaffRole(null) })
