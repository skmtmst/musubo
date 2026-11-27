// @vitest-environment happy-dom
/*
 * #635: リマインダ一覧で、存在しない言葉で検索して0件になったとき、
 * 件数が減るだけでなく「この条件に合うリマインダはありません。」と
 * 次にやること（検索語を変える・絞り込みを解除する）を出す。
 *
 * 監査5b_07: 不存在語を入れても明示の空メッセージが本文から特定できなかった。
 * 「まだリマインダがありません」（未登録の空）と「条件に合う…」（絞り込みの空）は
 * 別の出来事なので、言い分けと解除導線を実マウントで固定する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchApi = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' }))
vi.mock('@/lib/staff-role', async (original) => ({ ...(await original<typeof import('@/lib/staff-role')>()), useStaffRole: () => role.value }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => role.value !== 'viewer' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, fetchApi }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/components/shared/list-kpis', () => ({
  default: () => null,
}))

import RemindersPage from './page'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const calls: string[] = []

function reminder(id: string, name: string) {
  return {
    id, name, description: null, isActive: true, folderId: null,
    lifecycleStatus: 'published', stepCount: 1, displayOrder: 0,
    plannedDeliveries: null, lastSentAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function listCalls() {
  return calls.filter((url) => url.startsWith('/api/reminders?'))
}

beforeEach(() => {
  role.value = 'owner'
  calls.length = 0
  fetchApi.mockImplementation(async (url: string) => {
    calls.push(url)
    if (url.startsWith('/api/folders')) {
      return { success: true, data: [], unfiledCount: 0 }
    }
    // 検索語(q)が付いた取り込みは0件を返す。存在しない言葉の再現。
    if (url.startsWith('/api/reminders?') && url.includes('q=')) {
      return { success: true, data: { items: [], total: 0, limit: 20, sort: [] } }
    }
    return { success: true, data: { items: [reminder('r-1', '予約前のお知らせ')], total: 1, limit: 20, sort: [] } }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  forgetStaffIdentity()
  act(() => root.unmount())
  host.remove()
})

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

function typeSearch(value: string) {
  const input = host.querySelector('input[aria-label="名前・内容で探す"]') as HTMLInputElement | null
  expect(input, '検索欄が見つかりません').toBeTruthy()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(text: string): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) ?? null
}

describe('リマインダ一覧の絞り込み0件 (#635)', () => {
  it('存在しない言葉で検索すると、0件の言い方と次にやることを出す', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()
    expect(host.textContent).toContain('予約前のお知らせ')

    typeSearch('存在しない言葉xyz')
    await flush()

    // 「0件」と分かる表示＋次の行動提案（別の言葉・絞り込み解除）。
    expect(host.textContent).toContain('条件に合うものがありません')
    expect(host.textContent).toContain('検索を外すと、すべて出ます')
    expect(host.textContent).not.toContain('まだリマインダがありません')
    expect(buttonByText('条件を外す')).toBeTruthy()
  })

  it('「条件を外す」で検索語を外して一覧へ戻る', async () => {
    await act(async () => { root.render(<RemindersPage />) })
    await flush()

    typeSearch('存在しない言葉xyz')
    await flush()
    expect(host.textContent).toContain('条件に合うものがありません')

    const clear = buttonByText('条件を外す')
    expect(clear).toBeTruthy()
    await act(async () => { clear!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    // 検索欄が空に戻り、q の付かない取り直しで一覧が復活する。
    const input = host.querySelector('input[aria-label="名前・内容で探す"]') as HTMLInputElement
    expect(input.value).toBe('')
    expect(listCalls().at(-1)).not.toContain('q=')
    expect(host.textContent).toContain('予約前のお知らせ')
  })
})

it('登録が0件なら未作成の案内を表示する', async () => {
  fetchApi.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/folders')) return { success: true, data: [], unfiledCount: 0 }
    return { success: true, data: { items: [], total: 0, limit: 20, sort: [] } }
  })
  await act(async () => { root.render(<RemindersPage />) }); await flush()
  expect(host.textContent).toContain('まだリマインダがありません')
  expect(host.textContent).not.toContain('条件に合うものがありません')
  expect(host.textContent).not.toContain('リマインダを読み込めませんでした')
})


it('読み込みが続く間はスケルトンを表示する', async () => {
  fetchApi.mockImplementation(() => new Promise(() => {}))
  await act(async () => { root.render(<RemindersPage />) }); await flush()
  expect(host.querySelector('[data-skeleton]')).not.toBeNull()
  expect(host.textContent).not.toContain('まだリマインダがありません')
})

it('閲覧のみの人には閲覧中の案内を表示する', async () => {
  rememberStaffIdentity({ role: 'owner' } as StaffMember)
  await act(async () => { root.render(<RemindersPage />) }); await flush()
  expect(host.querySelector('[data-design-node="a5C1p"]')).toBeNull()
  role.value = 'viewer'
  rememberStaffIdentity({ role: 'viewer' } as StaffMember)
  await act(async () => { root.render(<RemindersPage />) }); await flush()
  expect(host.querySelector('[data-design-node="a5C1p"]')?.textContent).toContain('閲覧のみで見ています')
})
