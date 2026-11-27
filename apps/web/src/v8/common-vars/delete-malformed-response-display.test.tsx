// @vitest-environment happy-dom
/*
 * 共通情報の一覧の削除（行の削除の窓 xxKtW・まとめて削除の確認）を、本物の画面を描いて押して確かめる。
 * 使用先を読んでから進めること、消せないものを消させないこと、失敗や遅れて返った答えで
 * 成功扱いにしないこと、差し替えに確認時の版と世代を渡すことを守る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listVars = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const deleteImpact = vi.hoisted(() => vi.fn())
const deleteVar = vi.hoisted(() => vi.fn())
const replaceVar = vi.hoisted(() => vi.fn())
const replacementCandidates = vi.hoisted(() => vi.fn())
const replacementImpact = vi.hoisted(() => vi.fn())
const listExports = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      commonVars: {
        ...actual.api.commonVars,
        list: listVars,
        deleteImpact,
        delete: deleteVar,
        replace: replaceVar,
        replacementCandidates,
        replacementImpact,
        listExports,
      },
      folders: { ...actual.api.folders, list: listFolders },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

const account = vi.hoisted(() => ({ id: 'account-a' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import { ApiError } from '@/lib/api'
import CommonVarsListV8 from './list'
import { checkedAtText } from './model'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const base = {
  lineAccountId: 'account-a',
  type: 'text',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  nextSchedule: null,
  pendingScheduleCount: 0,
  validFrom: null,
  validUntil: null,
  folderId: null,
}
const company = { ...base, id: 'v-company', name: '会社名', varKey: 'company_name', value: '株式会社NEN', usageCount: 15 }
const contact = { ...base, id: 'v-contact', name: '問い合わせ先', varKey: 'contact', value: '03-0000-0000', usageCount: 0 }
const notice = { ...base, id: 'v-notice', name: '臨時のお知らせ', varKey: 'temp_notice', value: '本日は17時まで', usageCount: 0 }

function impactOf(variable: { id: string; name: string; varKey: string }, over: Record<string, unknown> = {}) {
  return {
    variable,
    total: 0,
    blockingTotal: 0,
    historicalTotal: 0,
    sendingFixedTotal: 0,
    unscopedFormTotal: 0,
    canDelete: true,
    byKind: {},
    items: [],
    unavailableReferences: [],
    checkedAt: '2026-09-07T10:00:00.000+09:00',
    recommendedAction: 'delete',
    ...over,
  }
}

const blockedCompany = impactOf(company, {
  total: 15,
  blockingTotal: 15,
  canDelete: false,
  items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '10月のお知らせ', status: '配信予約中', href: '/broadcasts/edit?id=b1', blocksDeletion: true, currentPreview: '' }],
  recommendedAction: 'review_references',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-a'
  listVars.mockReset().mockImplementation(async () => ({ success: true, data: [company, contact, notice] }))
  listFolders.mockReset().mockImplementation(async () => ({ success: true, data: [], unfiledCount: 3 }))
  listExports.mockReset().mockImplementation(async () => ({ success: true, data: [] }))
  deleteImpact.mockReset().mockImplementation(async (id: string) => ({
    success: true,
    data: id === company.id ? blockedCompany : impactOf([company, contact, notice].find((item) => item.id === id) ?? notice),
  }))
  deleteVar.mockReset().mockImplementation(async () => ({ success: true, data: null }))
  replaceVar.mockReset().mockImplementation(async () => ({ success: true, data: {} }))
  replacementCandidates.mockReset().mockImplementation(async () => ({ success: true, data: { source: { id: company.id, name: company.name, type: 'text', version: 1 }, candidates: [] } }))
  replacementImpact.mockReset().mockImplementation(async () => ({ success: false, error: 'none' }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

async function render() {
  act(() => { root.render(<CommonVarsListV8 />) })
  await flush()
}

function byLabel<T extends HTMLElement = HTMLElement>(label: string): T {
  const found = document.querySelector(`[aria-label="${label}"]`) as T | null
  expect(found, `「${label}」がありません`).toBeTruthy()
  return found as T
}

function findButton(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button, [role="menuitem"]')]
    .find((element) => element.textContent?.trim() === text) as HTMLButtonElement | undefined
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = findButton(text, scope)
  expect(found, `「${text}」がありません`).toBeTruthy()
  return found as HTMLButtonElement
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
  await flush()
}

async function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function openRowDelete(name: string) {
  await click(byLabel(`共通情報「${name}」の操作`))
  await click(button('削除する'))
}

function deleteDialog(): HTMLElement {
  const dialog = document.querySelector('[data-design-node="xxKtW"]') as HTMLElement | null
  expect(dialog, '削除の窓（xxKtW）が開いていません').toBeTruthy()
  return dialog as HTMLElement
}

function inputByPlaceholder(placeholder: string, scope: ParentNode = document): HTMLInputElement {
  const found = scope.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null
  expect(found, `「${placeholder}」の欄がありません`).toBeTruthy()
  return found as HTMLInputElement
}


it('使用先の応答が不正なら確認失敗として削除を止める', async () => {
  deleteImpact.mockResolvedValue({ success: true, data: null })
  await render()
  await openRowDelete('臨時のお知らせ')
  expect(document.body.textContent).toContain('使用先を確認できませんでした')
  expect(findButton('このまま削除')).toBeUndefined()
})

it('差し替え候補が不正なら失敗を知らせる', async () => {
  replacementCandidates.mockResolvedValue({ success: true, data: { candidates: null } })
  await render()
  await openRowDelete('会社名')
  expect(document.body.textContent).toContain('差し替え後の影響を確認できませんでした')
  expect(replacementImpact).not.toHaveBeenCalled()
})
