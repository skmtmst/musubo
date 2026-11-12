// @vitest-environment happy-dom
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import RemindersPage from './page'

/*
 * ★V8 一覧（Pencil ）の契約。V8 だけを出す。
 * 見本が決めた文言・帯・行の操作が出ることを実DOMで固定する。
 */
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push, replace() {}, prefetch() {} }),
  usePathname: () => '/reminders',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, loading: false,
}) }))

let root: Root
let host: HTMLDivElement
let handler: (url: URL) => Promise<Response> | Response
const response = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json', ...(headers ?? {}) } },
)

const reminder = {
  id: 'r-1',
  name: '契約終了の前に知らせる',
  description: null,
  isActive: true,
  lifecycleStatus: 'published',
  triggerType: 'friend_field',
  deliveryMode: 'time',
  triggerOffsetMinutes: 0,
  sendAtTime: '09:00',
  folderId: null,
  stepCount: 2,
  timingSummary: '基準日の 3日前 09:00',
  hasFailure: false,
  plannedDeliveries: 5,
  failedCount: 0,
  nextScheduledAt: '2026-10-10 09:00',
  displayOrder: 0,
  createdAt: '2026-09-01 00:00',
  updatedAt: '2026-09-02 00:00',
}

function base(url: URL) {
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'admin' } })
  if (url.pathname === '/api/folders') return response({ success: true, data: [], unfiledCount: 0 })
  if (url.pathname === '/api/list-stats') {
    return response({
      success: true,
      data: {
        tags: {}, marks: {}, searches: {}, templates: {}, scenarios: {},
        reminders: { total: 3, active: 2, waiting: 8, sentThisMonth: 42, failed: 1 },
      },
    })
  }
  if (url.pathname === '/api/reminders') {
    return response({ success: true, data: { items: [reminder], total: 1, limit: 20 } })
  }
  return response({ success: true, data: {} })
}
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 3000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}
beforeEach(() => {
  handler = base
  const values = new Map<string, string>()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return handler(url)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

test('フォルダの未分類件数も一覧と同じ店舗の範囲で読む', async () => {
  document.documentElement.dataset.theme = 'v8'
  const folderScopes: Array<string | null> = []
  handler = (url) => {
    if (url.pathname === '/api/folders') {
      const accountId = url.searchParams.get('account_id')
      folderScopes.push(accountId)
      return response({ success: true, data: [], unfiledCount: accountId === 'account-a' ? 0 : 7 })
    }
    return base(url)
  }
  await act(async () => root.render(<RemindersPage />))
  await eventually(() => {
    expect(folderScopes).toEqual(['account-a'])
    expect(host.querySelector('button[title="未分類"]')?.textContent).toBe('未分類0')
  })
})

test('v8 の下では Pencil apLqS の新しい一覧に切り替わる', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<RemindersPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="apLqS"], [data-design-node="Iffil"]')).toBeTruthy()
  })
  const folderColumn = host.querySelector('aside[data-template-region="folders"][data-shared-part="folder-column"]')
  expect(folderColumn, '共通のフォルダ領域に接続されている').not.toBeNull()
  expect(folderColumn?.closest('[data-list-folders]')?.getAttribute('data-list-folders')).toBe('true')
  const folderPanel = folderColumn!.querySelector('aside[aria-label="フォルダ"]')
  expect(folderPanel?.closest('[data-shared-part="folder-column"]')).toBe(folderColumn)
  expect(folderPanel?.querySelector('button[data-folder-select][title="未分類"]')?.textContent).toBe('未分類0')
  // 見本が決めた帯と見出し
  expect(host.textContent).toContain('リマインダを作る')
  const createLinks = [...host.querySelectorAll('a')].filter(link => link.textContent?.trim() === '＋ リマインダを作る')
  expect(createLinks.length).toBeGreaterThan(0)
  expect(createLinks.map(link => link.getAttribute('href'))).toEqual(createLinks.map(() => '/reminders/new'))
  expect(host.textContent).toContain('有効')
  expect(host.textContent).toContain('これから送る')
  expect(host.textContent).toContain('今月送った')
  expect(host.textContent).toContain('送れなかった')
  expect(host.textContent).toContain('次に送る')
  expect(host.textContent).toContain('並び')
  expect(host.textContent).toContain('20件表示')
  // KPI は API の実値
  expect(host.querySelector('[data-design="KPIs"]')?.textContent).toContain('2')
  expect(host.querySelector('[data-design="KPIs"]')?.textContent).toContain('8')
  expect(host.querySelector('[data-design="KPIs"]')?.textContent).toContain('42')
  expect(host.querySelector('[data-design="KPIs"]')?.textContent).toContain('1')
  // : 名前は1行。状態の札、予定・次回の実値は専用の列へ
  expect(host.textContent).toContain('契約終了の前に知らせる')
  expect(host.querySelector('[data-list-name]')?.textContent).not.toContain('基準日の 3日前 09:00')
  expect(host.textContent).toContain('5通')
  expect(host.textContent).toContain('10/10')
  const band = host.querySelector('[data-design="KPIs"]')!
  const failureActions = Array.from(band.querySelectorAll('button')).filter(button => button.textContent === '失敗を見る')
  expect(failureActions).toHaveLength(1)
  expect(band.textContent).not.toContain('理由を見る')
  const requestedStatuses: Array<string | null> = []
  handler = url => {
    if (url.pathname === '/api/reminders') requestedStatuses.push(url.searchParams.get('status'))
    return base(url)
  }
  await act(async () => { failureActions[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await eventually(() => expect(requestedStatuses).toContain('failed'))
})

test('v8 の一覧で失敗のある行は「失敗 N」の札を出す', async () => {
  document.documentElement.dataset.theme = 'v8'
  handler = (url) => {
    if (url.pathname === '/api/reminders') {
      return response({
        success: true,
        data: { items: [{ ...reminder, hasFailure: true, failedCount: 2 }], total: 1, limit: 20 },
      })
    }
    return base(url)
  }
  await act(async () => root.render(<RemindersPage />))
  await settle()
  await eventually(() => {
    expect(host.textContent).toContain('失敗 2')
  })
})

test('v8 の行の操作は見本の並びを持つ', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<RemindersPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="apLqS"], [data-design-node="Iffil"]')).toBeTruthy()
  })
  const trigger = [...host.querySelectorAll('button')]
    .find((item) => item.getAttribute('aria-label') === 'リマインダ「契約終了の前に知らせる」の操作')
  expect(trigger).toBeTruthy()
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await eventually(() => {
    const menu = document.querySelector('[role="menu"]')
    expect(menu).toBeTruthy()
    const labels = [...menu!.querySelectorAll('[role="menuitem"]')]
      .map((item) => item.textContent?.trim())
    expect(labels).toEqual([
      'リマインダの詳細を見る', '配信予定を見る', '実行結果を見る', '登録者を管理',
      '編集する', '複製する', 'フォルダへ移す', '一時停止する', '削除する',
    ])
    // 板 ：行の「…」を開いた印
    expect(host.querySelector('[data-design-node="SkY9V"]')).toBeTruthy()
  })
})

// 監査 WEB-013：登録者・配信予定・実行結果は、詳細のそのタブ（?tab=）を開く。概要へ落とさない。
test('v8 の行の「登録者を管理」「配信予定を見る」「実行結果を見る」は詳細のそのタブを開く', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<RemindersPage />))
  await settle()
  await eventually(() => {
    expect(host.textContent).toContain('契約終了の前に知らせる')
  })
  const expected: Array<[string, string]> = [
    ['登録者を管理', '/reminders/detail?id=r-1&tab=registrants'],
    ['配信予定を見る', '/reminders/detail?id=r-1&tab=schedule&status=planned'],
    ['実行結果を見る', '/reminders/detail?id=r-1&tab=runs'],
  ]
  for (const [label, href] of expected) {
    navigation.push.mockClear()
    const trigger = [...host.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === 'リマインダ「契約終了の前に知らせる」の操作')
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    let item: HTMLElement | undefined
    await eventually(() => {
      item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((el) => el.textContent?.trim() === label)
      expect(item).toBeTruthy()
    })
    await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await eventually(() => { expect(navigation.push).toHaveBeenCalledWith(href) })
  }
})

// 2026-10-06 オーナー決定：閲覧のみには押せないボタン・項目を置かずに隠す（帯は出す）。板 。
test('v8 の閲覧のみ（a5C1p）は選択と作成を隠し、フォルダ追加は理由付きで拒否する', async () => {
  document.documentElement.dataset.theme = 'v8'
  handler = (url) => {
    if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'viewer' } })
    return base(url)
  }
  await act(async () => root.render(<RemindersPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="a5C1p"]')?.textContent).toContain('閲覧のみで見ています')
    expect(host.textContent).toContain('契約終了の前に知らせる')
  })
  const actionTexts = [...host.querySelectorAll('button, a')].map((el) => el.textContent ?? '')
  expect(actionTexts.some((text) => text.includes('リマインダを作る'))).toBe(false)
  await expectPermissionLocked([...host.querySelectorAll('button')].find(button => button.textContent?.includes('フォルダを追加')))
  const selections = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(selections).toHaveLength(0)
  const trigger = [...host.querySelectorAll('button')]
    .find((item) => item.getAttribute('aria-label') === 'リマインダ「契約終了の前に知らせる」の操作')
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await eventually(() => {
    const labels = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(labels).toEqual(['リマインダの詳細を見る', '配信予定を見る', '実行結果を見る', '登録者を管理'])
  })
})

test('v8 の削除の窓（VsSyu）は危ない操作を左端に離し、動いている行には「代わりに一時停止」を出す', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<RemindersPage />))
  await settle()
  await eventually(() => {
    expect(host.textContent).toContain('契約終了の前に知らせる')
  })
  const trigger = [...host.querySelectorAll('button')]
    .find((item) => item.getAttribute('aria-label') === 'リマインダ「契約終了の前に知らせる」の操作')
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const remove = await (async () => {
    let found: HTMLElement | undefined
    await eventually(() => {
      found = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === '削除する') as HTMLElement | undefined
      expect(found).toBeTruthy()
    })
    return found!
  })()
  await act(async () => { remove.click() })
  await eventually(() => {
    const dialog = document.querySelector('[data-design-node="VsSyu"]')
    expect(dialog?.textContent).toContain('「契約終了の前に知らせる」を削除しますか？')
    expect(dialog?.textContent).toContain('削除は元に戻せません。')
    expect(dialog?.textContent).toContain('しばらく使わないだけなら「一時停止する」を使ってください。')
    const buttons = [...dialog!.querySelectorAll('button')].map((button) => button.textContent?.trim())
    // 閉じる印のあと、削除・取消・代わりの操作を同じ段へ置く。
    expect(buttons.filter(Boolean)).toEqual(['削除する', 'キャンセル', '代わりに一時停止'])
    const panel = dialog!.querySelector('[role="alertdialog"]') as HTMLElement
    expect(panel.style.getPropertyValue('--dialog-design-width')).toBe('480px')
    expect(panel.querySelector('[data-dialog-actions]')?.querySelectorAll('button')).toHaveLength(3)
  })
})

test('下書きの削除も確認前には送信せず、元に戻すで延期しない', async () => {
  document.documentElement.dataset.theme = 'v8'
  handler = url => url.pathname === '/api/reminders'
    ? response({ success: true, data: { items: [{ ...reminder, isActive: false, lifecycleStatus: 'draft', plannedDeliveries: 0 }], total: 1, limit: 20 } })
    : base(url)
  await act(async () => root.render(<RemindersPage />))
  await eventually(() => expect(host.querySelector('tbody tr')).toBeTruthy())
  await act(async () => (host.querySelector('tbody button[aria-label*="操作"]') as HTMLElement).click())
  await eventually(() => expect(document.querySelector('[role="menuitem"]')).toBeTruthy())
  await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === '削除する') as HTMLElement).click())
  await eventually(() => expect(document.querySelector('[data-design-node="VsSyu"]')?.textContent).toContain('削除しますか？'))
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  expect(document.querySelector('[data-design-node="VsSyu"]')?.textContent).not.toContain('代わりに一時停止')
  expect(document.querySelector('[data-design-node="VsSyu"]')?.textContent).not.toContain('「一時停止する」を使ってください。')
  const confirm = [...document.querySelectorAll('[data-design-node="VsSyu"] button')].find(button => button.textContent === '削除する') as HTMLElement
  await act(async () => confirm.click())
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
})

test('停止中のリマインダの再開は確認も延期もせず送る', async () => {
  document.documentElement.dataset.theme = 'v8'
  handler = url => url.pathname === '/api/reminders'
    ? response({ success: true, data: { items: [{ ...reminder, isActive: false, lifecycleStatus: 'stopped' }], total: 1, limit: 20 } })
    : base(url)
  await act(async () => root.render(<RemindersPage />))
  await eventually(() => expect(host.querySelector('tbody tr')).toBeTruthy())
  await act(async () => (host.querySelector('tbody button[aria-label*="操作"]') as HTMLElement).click())
  await eventually(() => expect(document.querySelector('[role="menuitem"]')).toBeTruthy())
  await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === '再開する') as HTMLElement).click())
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).includes('/api/reminders/r-1') && init?.method === 'PUT')).toBe(true)
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
})

test('リマインダの全件選択はページ外の停止対象も確認する', async () => {
  document.documentElement.dataset.theme = 'v8'
  const rows = Array.from({ length: 101 }, (_, i) => ({ ...reminder, id: `r-${i}`, name: `お知らせ${i}` }))
  handler = url => {
    if (url.pathname !== '/api/reminders') return base(url)
    const limit = Number(url.searchParams.get('limit')) || 20
    const page = Number(url.searchParams.get('page')) || 1
    return response({ success: true, data: { items: rows.slice((page - 1) * limit, page * limit), total: rows.length, limit } })
  }
  await act(async () => root.render(<RemindersPage />))
  await eventually(() => expect(host.querySelector('tbody tr')).toBeTruthy())
  await act(async () => (host.querySelector('thead input[type="checkbox"]') as HTMLElement).click())
  const all = [...host.querySelectorAll('button')].find(button => button.textContent === '条件に合う101件すべてを選ぶ') as HTMLElement
  expect(all).toBeTruthy()
  await act(async () => all.click())
  expect(host.textContent).toContain('101件を選択中')
  const stop = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '止める') as HTMLElement
  await act(async () => stop.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('101 件のリマインダを停止しますか？')
})

test('初回読込では空と表示せず、失敗と成功0件を別の案内にする', async () => {
  let finish!: (value: Response) => void
  handler = url => url.pathname === '/api/reminders' ? new Promise(resolve => { finish = resolve }) : base(url)
  await act(async () => root.render(<RemindersPage />))
  expect(host.querySelector('[data-empty-list]')).toBeNull()
  expect(host.querySelector('[data-list-state="error"]')).toBeNull()
  await act(async () => finish(response({ success: false, error: 'down' }, 500)))
  await eventually(() => expect(host.textContent).toContain('リマインダを読み込めませんでした'))
  expect(host.querySelector('[data-empty-list]')).toBeNull()
  handler = url => url.pathname === '/api/reminders' ? response({ success: true, data: { items: [], total: 0, limit: 20 } }) : base(url)
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('もう一度'))!
  await act(async () => retry.click())
  await eventually(() => expect(host.querySelector('[data-empty-list]')).not.toBeNull())
  expect(host.textContent).not.toContain('リマインダを読み込めませんでした')
})
