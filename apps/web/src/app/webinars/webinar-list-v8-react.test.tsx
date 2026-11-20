import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import WebinarsPage from './page'
import type { WebinarListItem } from '@/lib/api'

/*
 * ★V8-B ウェビナー一覧（板 ・状態 ・閲覧のみ ）の契約。
 * V8だけの一覧で、
 * 見本が決めた帯・表・札・押せない形が出ることを実DOMで固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/webinars',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, accounts: [], loading: false,
}) }))

let staffRole: string | null = 'admin'
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...original, useStaffRole: () => staffRole }
})

let root: Root
let host: HTMLDivElement

const available = (value: number) => ({ value, state: 'available' as const, reason: null })
const unavailable = (reason: string) => ({ value: null, state: 'unavailable' as const, reason })

const overviewData = {
  state: 'partial',
  registrationMode: 'people',
  metrics: {
    webinars: available(6),
    activeWebinars: available(3),
    registrations: available(248),
    registrationBookings: available(260),
    viewers: unavailable('実際に見た区間の記録をまだ集計できないため'),
    viewRate: unavailable('視聴人数を取得できないため'),
    averageWatchSeconds: unavailable('集計できないため'),
    ctaUniquePeople: available(23),
    ctaTotalClicks: available(41),
  },
}

function webinar(overrides: Partial<WebinarListItem> = {}): WebinarListItem {
  return {
    id: 'webinar-1',
    accountId: 'account-a',
    title: 'NEN活用スタートセミナー',
    slug: 'nen-start',
    status: 'active',
    videoPrefix: 'videos/nen-start',
    durationSeconds: 872,
    schedule: [],
    cta: null,
    tagOnAttend: null,
    tagOnCtaClick: null,
    folderId: null,
    folderName: null,
    registrationCount: 124,
    viewerCount: 98,
    publicationState: 'always',
    publicationStartsAt: null,
    publicationEndsAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

let listItems: WebinarListItem[] = [webinar()]

const json = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

let fetchCalls: string[] = []

beforeEach(() => {
  window.history.replaceState(null, '', '/webinars')
  listItems = [webinar()]
  staffRole = verifiedStaffRole('admin')
  fetchCalls = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('/overview')) return json({ data: overviewData })
    if (url.includes('/folders')) return json({ success: true, data: [] })
    if (url.includes('/api/webinars')) {
      return json({ data: { items: listItems, total: listItems.length, limit: 20, sort: [] } })
    }
    return json({ data: null }, 404)
  })
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function renderPage() {
  await act(async () => {
    root.render(<WebinarsPage />)
  })
  // 取り直しの非同期が落ち着くまで1回譲る。
  await act(async () => {})
}

test('v8 では UyUMw の一覧（帯・表・視聴の2行）が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="UyUMw"]')
  expect(board).not.toBeNull()
  expect(board?.textContent).toContain('ウェビナー')
  // 数の帯：口にある数だけ出す（申込 248人・CTA 41回。視聴は未集計で—）。
  expect(board?.textContent).toContain('248')
  expect(board?.textContent).toContain('41')
  // 表の見出しと行：状態の札・視聴の2行・公開期間。
  expect(board?.textContent).toContain('視聴開始 98人')
  expect(board?.textContent).toContain('視聴完了 —')
  expect(board?.textContent).toContain('公開中')
  expect(Array.from(board!.querySelectorAll('button')).some((button) => button.textContent?.trim() === '編集')).toBe(false)
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label^="ウェビナー「"][aria-label$="の操作"]')!.click() })
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('編集する')
})

/* 公開期間が終わった行の札は、一覧の絵（・・）どおり「非公開」。 */
test('v8 の公開予定・非公開の札が出る', async () => {
  listItems = [
    webinar({ id: 'w-future', title: 'EC連携実践講座', publicationState: 'scheduled' }),
    webinar({ id: 'w-ended', title: '旧機能説明会', publicationState: 'ended' }),
  ]
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="UyUMw"]')
  expect(board?.textContent).toContain('公開予定')
  expect(board?.textContent).toContain('非公開')
})

test('v8 で何も無いときは eAQ3t の「まだ無い」が出る', async () => {
  listItems = []
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="UyUMw"]')
  expect(board?.textContent).toContain('まだウェビナーがありません')
})

test('v8 の閲覧のみは作る操作を理由付きで拒否し、編集は出さない', async () => {
  staffRole = verifiedStaffRole('staff')
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const board = host.querySelector('[data-design-node="UyUMw"]')
  expect(board).not.toBeNull()
  const texts = [...board!.querySelectorAll('button, a')].map((el) => el.textContent ?? '')
  const create = [...board!.querySelectorAll('button')].filter(button => button.textContent?.includes('ウェビナーを作る'))
  expect(create.length).toBeGreaterThan(0)
  for (const button of create) await expectPermissionLocked(button)
  expect(board!.querySelector('a[href="/webinars/new"]')).toBeNull()
  expect(texts.some((t) => t === '編集')).toBe(false)
  expect(board?.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
})

/* V8「サクサク感」C①・D・E：行→詳細パネル・右クリック・つながる移り変わり。
 * 共通パネルは最上層へ描画されるため、パネル内の操作は文書全体から探す。 */
function detailButton(title: string): HTMLAnchorElement {
  const found = [...host.querySelectorAll('a')].find(
    (button) => button.getAttribute('aria-label') === `「${title}」の詳細を見る`,
  )
  if (!found) throw new Error(`detail button not found: ${title}`)
  return found as HTMLAnchorElement
}

test('v8 で行を押すと右の詳細パネルが開き↑↓で次の行へ移る', async () => {
  listItems = [webinar(), webinar({ id: 'webinar-2', title: '2つ目のセミナー', slug: 'second' })]
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  await act(async () => { (detailButton('NEN活用スタートセミナー').closest('tr') as HTMLElement).click() })
  const panel = document.querySelector('[data-design-part="detail-panel"]')
  expect(panel).not.toBeNull()
  expect(panel?.textContent).toContain('NEN活用スタートセミナー')
  const next = [...panel!.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '次の行')
  expect(next).toBeTruthy()
  await act(async () => { (next as HTMLButtonElement).click() })
  const moved = document.querySelector('[data-design-part="detail-panel"]')
  expect(moved?.textContent).toContain('2つ目のセミナー')
})

test('v8 で行を右クリックすると「…」と同じ操作が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const button = detailButton('NEN活用スタートセミナー')
  await act(async () => {
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 120 }))
  })
  const menu = document.body.querySelector('[data-context-menu]')
  expect(menu).not.toBeNull()
  expect(menu?.textContent).toContain('参加者を見る')
  expect(menu?.textContent).toContain('アーカイブする')
})

/* V8「サクサク感」C②：名前のその場の書き換え。 */
test('v8 で詳細パネルの名前をその場で変えると保存口へ届く', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  await act(async () => { (detailButton('NEN活用スタートセミナー').closest('tr') as HTMLElement).click() })
  const panel = document.querySelector('[data-design-part="detail-panel"]')
  const edit = [...panel!.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'ウェビナー名を変更する')
  expect(edit).toBeTruthy()
  await act(async () => { (edit as HTMLButtonElement).click() })
  const input = document.querySelector('[data-design-part="detail-panel"] input[aria-label="ウェビナー名"]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input!, '改名したセミナー')
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(fetchCalls.some((call) => call.startsWith('PUT') && call.includes('/api/webinars/webinar-1'))).toBe(true)
  expect(host.querySelector('[data-design-node="UyUMw"]')?.textContent).toContain('改名したセミナー')
})

/* フォルダの追加は名前と色を横に並べた共通の窓（FolderEditorDialog・fcolall 2026-10-09）。 */
test('v8 でフォルダの追加を押すと共通の窓で名前と色を入れられる', async () => {
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const add = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('フォルダを追加'))
  expect(add).toBeTruthy()
  await act(async () => { (add as HTMLButtonElement).click() })
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog?.textContent).toContain('フォルダを追加')
  expect(dialog?.querySelector('[data-folder-name-color] input')).not.toBeNull()
  expect(dialog?.querySelector('[data-folder-color-button]')).not.toBeNull()
})

test('v8 の読み込み中は骨組みで場所を取り「読み込み中」の文字は出さない', async () => {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  document.documentElement.dataset.theme = 'v8'
  // 待ちは偽の時計で進める（本物の時間を待たない）。骨組みの 0.3 秒は描いた瞬間から数えるので、描く前に替える。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  await act(async () => {
    root.render(<WebinarsPage />)
  })
  // 場所取り：読み上げは1回だけ、骨組みに読み上げは付けない。
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(host.textContent).toContain('ウェビナーの一覧を読み込んでいます')
  expect(host.textContent).not.toContain('読み込み中')
  // 0.3秒たつと骨組みの5行が出る（見出し＋行の高さは本物と同じ）。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350)
  })
  const skeletons = host.querySelectorAll('[data-skeleton]')
  expect(skeletons.length).toBeGreaterThanOrEqual(5)
})

test('アーカイブ済みを開いて記録を読み、確認してから下書きへ戻せる', async () => {
  const archived = webinar({ status: 'archived', publicationState: 'ended' })
  const requests: Array<{ url: string; method: string; body?: string }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    if (url.includes('/overview')) return json({ data: overviewData })
    if (url.includes('/folders')) return json({ success: true, data: [] })
    if (init?.method === 'PUT') return json({ data: { ...archived, status: 'draft' } })
    if (url.includes('/api/webinars')) {
      const params = new URL(url).searchParams
      const items = params.get('status') === 'archived' ? [archived] : []
      return json({ data: { items, total: items.length, limit: 20, sort: [] } })
    }
    return json({ data: null }, 404)
  })
  await renderPage()
  await act(async () => { (host.querySelector('button[aria-label="よく使う絞り込み"]') as HTMLButtonElement).click() })
  const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent === 'アーカイブ済み') as HTMLElement
  expect(option).toBeTruthy()
  await act(async () => { option.querySelector('button')!.click() })
  expect(requests.some((r) => r.url.includes('status=archived'))).toBe(true)
  const row = host.querySelector('tbody tr')!
  expect(row.textContent).toContain('アーカイブ')
  expect(row.textContent).toContain('124人')
  expect(row.textContent).toContain('視聴開始 98人')
  await act(async () => { (row.querySelector('button[aria-label="ウェビナー「NEN活用スタートセミナー」の操作"]') as HTMLButtonElement).click() })
  const restore = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('下書きに戻す')) as HTMLElement
  await act(async () => { restore.click() })
  expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0)
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('公開するまでは、新しい申込は受け付けません')
  await act(async () => { ([...dialog.querySelectorAll('button')].find((el) => el.textContent === '下書きに戻す') as HTMLButtonElement).click() })
  expect(requests.filter((r) => r.method === 'PUT').map((r) => JSON.parse(r.body!))).toEqual([{ status: 'draft' }])
})

afterEach(() => { verifiedStaffRole(null) })
