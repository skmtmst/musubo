// @vitest-environment happy-dom
/*
 * V8 自動応答一覧の、押して確かめる動き。
 * 削除の窓（名前・失敗の理由・権限・処理中・アカウント切替）、止める理由と確認キー、再開、
 * 停止の記録、未取得を 0 にしない、重なりの数、権限で読めない時、遅れた返事、テンプレートの名前、
 * 評価順の上下キー、行の詳細パネル。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const net = vi.hoisted(() => ({
  list: vi.fn(),
  templates: vi.fn(),
  summary: vi.fn(),
  folders: vi.fn(),
  update: vi.fn(),
  stop: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
}))
const accountState = vi.hoisted(() => ({
  selectedAccountId: 'account-a' as string | null,
  accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '二号店' }],
  loading: false,
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: {
        ...actual.api.autoReplies,
        list: net.list,
        summary: net.summary,
        update: net.update,
        stop: net.stop,
        delete: net.remove,
        create: net.create,
      },
      templates: { ...actual.api.templates, list: net.templates },
      folders: { ...actual.api.folders, list: net.folders },
    },
  }
})
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => accountState }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner', canManageRole: () => true }
})

import { ApiError } from '@/lib/api'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import AutoRepliesListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ruleA = {
  id: 'ar-1', name: '営業時間外の自動返信', keyword: '営業時間', matchType: 'contains', keywords: null, respondToAll: false,
  isActive: true, confirmationRevision: 1, lifecycleStatus: 'published', hits: { period: 5, total: 20 } as { period: number; total: number } | undefined,
  responseContent: '営業時間外です', responseType: 'text', templateId: null as string | null, keywordMatchMode: 'any',
  activeFrom: null, activeUntil: null, responseWeekdays: null, responseHolidayRule: null, cooldownMinutes: null,
  skipWhenOperatorActive: false, oncePerFriend: false, messageKinds: null, friendConditions: null, folderId: null,
  priority: 0, lineAccountId: 'account-a', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}
const ruleB = { ...ruleA, id: 'ar-2', name: '予約変更のお問い合わせ', keyword: '予約', isActive: false, lifecycleStatus: 'stopped', priority: 1 }

let host: HTMLDivElement
const onCleanup: Array<() => void> = []
let root: Root

function renderList() {
  act(() => { root.render(<><AutoRepliesListV8 /><ToastHost /></>) })
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

function stubWideViewport() {
  const real = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }),
    configurable: true,
  })
  return () => { Object.defineProperty(window, 'matchMedia', { value: real, configurable: true }) }
}

function openMenu(name: string, item: string) {
  const more = host.querySelector(`button[aria-label="自動応答「${name}」の操作"]`) as HTMLButtonElement
  expect(more, `「${name}」の「…」がありません`).toBeTruthy()
  act(() => { more.click() })
  fireEvent.click(within(document.querySelector('[role="menu"]') as HTMLElement).getByText(item))
}

function kpiNumbers() {
  return [...host.querySelectorAll('[data-kpi-number]')].map((node) => node.textContent)
}

beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  window.history.replaceState(null, '', '/auto-replies')
  document.documentElement.dataset.theme = 'v8'
  accountState.selectedAccountId = 'account-a'
  net.list.mockImplementation(async () => ({ success: true, data: [ruleA, ruleB] }))
  net.templates.mockImplementation(async () => ({ success: true, data: [] }))
  net.summary.mockImplementation(async () => ({ success: true, data: { conflictCount: 0 } }))
  net.folders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 0 }))
  net.update.mockImplementation(async () => ({ success: true, data: null }))
  net.stop.mockImplementation(async () => ({ success: true, data: null }))
  net.remove.mockImplementation(async () => ({ success: true, data: null }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  forgetStaffIdentity(); forgetSessionSnapshot()
  onCleanup.splice(0).forEach((restore) => restore())
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('複製の結果に番号が無ければ成功と見せず、再試行でも同じキーを使う', async () => {
  net.create.mockResolvedValue({ success: true, data: {} })
  renderList(); await flush()
  openMenu(ruleA.name, '複製する'); await flush()
  expect(host.textContent).toContain('複製できたか確認できません。一覧を読み直してください。')
  expect(host.textContent).not.toContain('複製しました')
  openMenu(ruleA.name, '複製する'); await flush()
  expect(net.create).toHaveBeenCalledTimes(2)
  expect(net.create.mock.calls[1][1]).toBe(net.create.mock.calls[0][1])
})
