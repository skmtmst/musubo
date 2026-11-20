import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import CommonVarsPage from './page'

/*
 * ★V8 共通情報の一覧（板 、閲覧のみ ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい一覧に切り替わり、
 * 数の帯・黄色の帯・行末の「…」が出ること、staff では閲覧のみの帯が
 * 出て作る操作が押せない形になることを実DOMで固定する。
 * 互換経路では従来の一覧が出ることも固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/contents/vars',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a', selectedAccount: null, loading: false,
  }),
}))

const listData = [
  {
    id: 'var-company',
    lineAccountId: 'account-a',
    folderId: null,
    name: '会社名',
    varKey: 'company_name',
    type: 'text',
    value: '株式会社NEN',
    validFrom: null,
    validUntil: null,
    fallbackValue: null,
    expiryBehavior: 'stop',
    status: 'active',
    state: 'active',
    stoppedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    usageCount: 15,
  },
  {
    id: 'var-contact',
    lineAccountId: 'account-a',
    folderId: null,
    name: '問い合わせ先',
    varKey: 'contact',
    type: 'text',
    value: '',
    validFrom: null,
    validUntil: null,
    fallbackValue: null,
    expiryBehavior: 'stop',
    status: 'active',
    state: 'active',
    stoppedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    usageCount: 2,
  },
]

const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

let root: Root | null = null
let host: HTMLDivElement | null = null

/* happy-dom に localStorage が無いときの小さな代替。役割の読み書きだけに使う。 */
function ensureStorage() {
  if (typeof window.localStorage !== 'undefined' && window.localStorage !== null) return
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, String(value)) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
    },
  })
}

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  ensureStorage()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/common-vars/var-company/delete-impact')) {
      return response({
        success: true,
        data: {
          variable: { id: 'var-company', name: '会社名', varKey: 'company_name' },
          total: 1,
          blockingTotal: 1,
          historicalTotal: 0,
          sendingFixedTotal: 0,
          unscopedFormTotal: 0,
          canDelete: true,
          byKind: {},
          items: [
            {
              kind: 'broadcast',
              kindLabel: '一斉配信',
              name: '10月のお知らせ',
              status: '配信予約中',
              href: '/broadcasts/1',
              blocksDeletion: true,
              currentPreview: '',
            },
          ],
          unavailableReferences: [],
          checkedAt: '2026-10-04T00:00:00.000Z',
          recommendedAction: 'review_references',
        },
      })
    }
    if (url.includes('/api/common-vars')) {
      return response({ success: true, data: listData, meta: {} })
    }
    if (url.includes('/api/folders')) {
      return response({ success: true, data: [], unfiledCount: 0 })
    }
    return response({ success: false, error: 'not mocked' }, 500)
  }))
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
  document.documentElement.removeAttribute('data-theme')
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

async function renderPage() {
  await act(async () => {
    root?.render(<CommonVarsPage />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

test('v8 では新しい一覧（FM94M）が出て、管理画面 は出ない', async () => {
  window.localStorage.setItem('lh_staff_role', 'admin'); rememberStaffIdentity({ role: 'admin' } as StaffMember)
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  // 2026-10-06 入口は新しい一覧（src/v8/common-vars）。板の印は幅で （広い）か （1152）のどちらか。
  expect(host?.querySelector('[data-design-node~="FM94M"],[data-design-node~="XIzkJ"]')).not.toBeNull()
  expect(host?.querySelector('[data-design-node="WuKzU"]')).toBeNull()
  expect(host?.textContent).toContain('使っている所')
  expect(host?.textContent).toContain('問い合わせ先')
  expect(host?.querySelector('[data-page-template="list"] [data-template-region="content"]')?.textContent).toContain('問い合わせ先')
})

test('staff では閲覧のみの帯と作る操作の理由が出る', async () => {
  window.localStorage.setItem('lh_staff_role', 'staff'); rememberStaffIdentity({ role: 'staff' } as StaffMember)
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  expect(host?.textContent).toContain('この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。')
  const createButtons = Array.from(host?.querySelectorAll('button, a') ?? [])
    .filter((element) => element.textContent?.includes('共通情報を作る'))
  expect(createButtons.length).toBeGreaterThan(0)
  for (const button of createButtons) await expectPermissionLocked(button)
  expect(host?.querySelector('a[href="/contents/vars/new"]')).toBeNull()
})

test('旧テーマ属性が残っていてもV8の一覧が出る', async () => {
  document.documentElement.dataset.theme = 'v7'
  await renderPage()
  expect(host?.querySelector('[data-design-node="WuKzU"]')).toBeNull()
  expect(host?.querySelector('[data-design-node~="FM94M"],[data-design-node~="XIzkJ"]')).not.toBeNull()
})

test('止める窓は予約中の配信の帯を出す（Hhl9M）', async () => {
  window.localStorage.setItem('lh_staff_role', 'admin'); rememberStaffIdentity({ role: 'admin' } as StaffMember)
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  const trigger = Array.from(host?.querySelectorAll('button') ?? [])
    // 新しい一覧（src/v8/common-vars）の行の右端の「…」。
    .find((button) => button.getAttribute('aria-label') === '共通情報「会社名」の操作')
  expect(trigger).toBeTruthy()
  await act(async () => { trigger!.click() })
  const stopItem = (Array.from(document.body.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'))
    .find((el) => (el.textContent ?? '').trim() === '止める') ?? querySupplementaryPageAction('止める'))
  expect(stopItem).toBeTruthy()
  await act(async () => { (stopItem as HTMLElement).click() })
  await act(async () => { await Promise.resolve() })
  expect(document.body.textContent).toContain('予約中の一斉配信「10月のお知らせ」が送られなくなります。')
})
