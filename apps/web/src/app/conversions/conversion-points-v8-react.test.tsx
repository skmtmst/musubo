import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { findDetailMenuItem } from '@/test-utils/detail-menu'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import ConversionsPage from '@/app/affiliates/page'

/* : 行から右の詳細へ移り、停止は理由必須の確認窓で実行する。
 * 読み取り権限とAPIへの理由・保存版の受け渡しも守る。 */
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/affiliates',
  useSearchParams: () => new URLSearchParams('tab=points'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a', selectedAccount: null, accounts: [{ id: 'account-a', name: '本店' }], loading: false,
}) }))

let staffRole = 'admin'
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>() as Record<string, unknown>
  return { ...original, useStaffRole: () => staffRole }
})

let root: Root
let host: HTMLDivElement
let posted: string[] = []
let stopBodies: unknown[] = []
const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const pointActive = {
  id: 'cv-buy',
  name: '商品を買った',
  sourceType: 'ec_order_confirmed',
  value: null,
  measureMethod: 'webhook',
  targetUrl: null,
  countRepeat: true,
  attributionDays: 90,
  sourceConfig: {},
  deduplicationMode: 'every',
  deduplicationWindowDays: null,
  valueMode: 'source',
  reversalPolicy: 'source_cancelled',
  lineAccountId: 'account-a',
  status: 'active',
  state: 'active',
  stateReason: null,
  ingest: { configured: true, disabledAt: null },
  version: 3,
  usageCount: 2,
  usageNames: ['ファネル2', 'アフィリエイト1'],
  metrics: {
    recordedCount: 55, netCount: 52, reversedCount: 3, reversedValue: 9000,
    netValue: 412000.9, reversalState: 'available', reversalReason: '純額定義',
    cancellationCount: 0, cancellationValue: 0,
  },
  stoppedAt: null,
  createdAt: '2026-08-01T00:00:00+09:00',
  updatedAt: '2026-09-20T00:00:00+09:00',
}

const pointStopped = {
  ...pointActive,
  id: 'cv-doc',
  name: '資料をダウンロードした',
  sourceType: 'url_reach',
  measureMethod: 'url_reach',
  targetUrl: 'https://example.com/doc',
  deduplicationMode: 'once_per_friend',
  valueMode: 'none',
  status: 'stopped',
  state: 'stopped',
  ingest: { configured: false, disabledAt: null },
  usageCount: 0,
  usageNames: [],
  metrics: {
    recordedCount: 0, netCount: 0, reversedCount: 0, reversedValue: 0,
    netValue: 0, reversalState: 'available', reversalReason: '純額定義',
    cancellationCount: 0, cancellationValue: 0,
  },
  stoppedAt: '2026-09-20T10:00:00+09:00',
}

const listPayload = {
  items: [pointActive, pointStopped],
  stateCounts: { active: 1, draft: 0, stopped: 1, invalid: 0, sourceStopped: 0, unused: 1 },
  range: { from: '2026-09-03', to: '2026-10-02', timeZone: 'Asia/Tokyo' },
  pagination: { total: 2, limit: 100, cursor: '', nextCursor: null },
}

const reportPayload = {
  range: { from: '2026-09-03', to: '2026-10-02', timeZone: 'Asia/Tokyo' },
  previousRange: { from: '2026-08-04', to: '2026-09-02', timeZone: 'Asia/Tokyo' },
  kpis: {
    recordedCount: 55, recordedValue: 421000, reversedCount: 3,
    netCount: 52, netValue: 412000, averageNetValue: 7923,
    previousNetCount: 31, previousNetValue: 200000, countChangeRate: 68,
  },
  byDefinition: [], daily: [], byRoute: [],
}

function base(url: URL, init?: RequestInit) {
  if (url.pathname === '/api/conversions/definitions') {
    return response({ success: true, data: listPayload })
  }
  if (url.pathname === '/api/conversions/report') {
    return response({ success: true, data: reportPayload })
  }
  if (url.pathname === '/api/staff/me') {
    return response({ success: true, data: { id: 'staff-1', role: staffRole } })
  }
  if (url.pathname === '/api/conversions/definitions/cv-buy/delete-impact') {
    return response({
      success: true,
      data: {
        definition: { id: 'cv-buy', version: 3 },
        usages: [{ id: 'u-1', usageName: 'ファネル2' }],
        eventCount: 52,
        canDelete: false,
        stopImpact: { affectedUsageCount: 1, preservesPastEvents: true, preservesUsages: true },
        replacementCandidates: [{ id: 'cv-doc', name: '資料をダウンロードした', version: 1 }],
      },
    })
  }
  if (url.pathname === '/api/conversions/definitions/cv-buy/stop' && init?.method === 'POST') {
    posted.push(url.pathname)
    stopBodies.push(JSON.parse(String(init.body)))
    return response({ success: true, data: { id: 'cv-buy', status: 'stopped', version: 4, stoppedAt: '2026-10-03T00:00:00+09:00' } })
  }
  return response({ success: false, error: 'not mocked', data: null })
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 8000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

function typeInto(input: HTMLInputElement, value: string) {
  input.focus()
  // React の onChange に届くよう native setter で入れる。
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  staffRole = verifiedStaffRole('admin')
  posted = []
  stopBodies = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return base(url, init)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  verifiedStaffRole(null)
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

test('v8 の下では Pencil r6dJFy の新しい一覧に切り替わる', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<ConversionsPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="r6dJFy"]')).toBeTruthy()
  })
  // 見出しと右のボタン
  expect(host.textContent).toContain('コンバージョン')
  expect(host.textContent).toContain("CSVで書き出す")
  // 数の帯は表の行の合計（52件・¥412,000）と一致する
  expect(host.textContent).toContain('この30日の成果')
  expect(host.textContent).toContain('52')
  expect(host.textContent).toContain('¥412,000')
  // 狭い試験環境では 1152 の板の言葉「使われていない」になる
  expect(host.textContent).toContain('使われていない')
  // 行の中身（名前・状態・数・金額・使う場所・操作）
  expect(host.textContent).toContain('商品を買った')
  expect(host.textContent).toMatch(/有効 [\d,]+・下書き [\d,]+・停止中 [\d,]+/)
  // ：使う場所を足す操作は行の「…」に残す。
  const menu = host.querySelector<HTMLButtonElement>('[aria-label="成果地点「商品を買った」の操作"]')
  expect(Array.from(menu!.closest('tr')!.querySelectorAll('td'), cell => cell.textContent)).toContain('¥412,000')
  await act(async () => menu!.click())
  await settle()
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('使う場所を足す')
})

test('行から右の詳細を開き、停止の確認では理由を必須にする', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<ConversionsPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="r6dJFy"]')).toBeTruthy()
  })
  // 行の名前を押すと右の詳細が出る
  const nameButton = ([...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('商品を買った')) ?? querySupplementaryPageAction('商品を買った'))
  expect(nameButton).toBeTruthy()
  await act(async () => { nameButton!.click() })
  expect(await findDetailMenuItem('鍵を発行する')).toBeTruthy()
  // 操作帯の「止める」から、同じ理由必須の確認へ進む。
  const stopButton = await findDetailMenuItem('止める')
  expect(stopButton).toBeTruthy()
  await act(async () => { stopButton!.click() })
  await eventually(() => {
    expect(([...document.querySelectorAll('[role="dialog"]')].find(el => el.textContent?.includes('「商品を買った」を止めますか？')) ?? querySupplementaryPageAction('「商品を買った」を止めますか？'))).toBeTruthy()
  })
  expect(document.body.textContent).toContain('理由必須')
  // 理由が空のままは止められない（右の詳細の「止める」と区別する）
  const stopPanel = ([...document.querySelectorAll('[role="dialog"]')].find(el => el.textContent?.includes('「商品を買った」を止めますか？')) ?? querySupplementaryPageAction('「商品を買った」を止めますか？'))
  expect(stopPanel).toBeTruthy()
  const confirmButton = ([...stopPanel!.querySelectorAll('button')].find((button) =>
    button.textContent === '止める') ?? querySupplementaryPageAction('止める'))
  expect(confirmButton?.hasAttribute('disabled')).toBe(true)
  expect(posted).toEqual([])
  const reason = document.querySelector('input[aria-label="止める理由"]') as HTMLInputElement
  expect(reason).toBeTruthy()
  await act(async () => { typeInto(reason, '計測の仕方を変えるため') })
  await eventually(() => {
    expect(confirmButton?.hasAttribute('disabled')).toBe(false)
  })
  await act(async () => { confirmButton!.click() })
  await eventually(() => {
    expect(posted).toContain('/api/conversions/definitions/cv-buy/stop')
  })
  expect(stopBodies).toEqual([expect.objectContaining({ reason: '計測の仕方を変えるため', expectedVersion: 3 })])
})

test('v8 の閲覧のみでは帯が出て、作る操作は置かない（押せない形でも置かない・2026-10-06 オーナー）', async () => {
  staffRole = verifiedStaffRole('viewer')
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<ConversionsPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="r6dJFy"]')).toBeTruthy()
  })
  await eventually(() => {
    expect(host.textContent).toContain('閲覧のみで見ています')
  })
  const createLinks = [...host.querySelectorAll('a, button')].filter((element) => element.textContent?.includes('成果地点を作る'))
  expect(createLinks).toEqual([])
  expect(host.querySelector('button[disabled][title="この操作にはオーナーか管理者の権限が要ります"]')).toBeNull()
  expect(posted).toEqual([])
})
