
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import FormsListV8 from './list'
import { formQuestionCount, type Form } from './model'
import { fieldsToLayout } from '@line-crm/shared'

;
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 回答フォーム一覧（src/v8/forms）の動きの試験。BEHAVIOR.md の「今までと変えたところ」を守る。
 * 未分類の件数・閲覧のみの帯と押せない「フォルダを追加」・行の「…」の読み上げ名・1152 で保存先を出さない・表示件数 10/20/50。
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
});

const fetchApi = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const unarchive = vi.hoisted(() => vi.fn())
const deleteImpact = vi.hoisted(() => vi.fn())
const listStats = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const narrow = vi.hoisted(() => ({ value: false }))
const account = vi.hoisted(() => ({ id: 'account-a' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    fetchApi,
    api: { ...api, forms: { ...api.forms, unarchive, deleteImpact }, folders: { ...api.folders, list: listFolders }, listStats: { get: listStats } },
  }
});

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { id: account.id, liffId: 'liff-a' }, loading: false }),
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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const baseForm = {
  description: '来店後に感想を聞く',
  fields: [],
  layout: { version: 2, header: [], sections: [], options: {} },
  onSubmitTagId: null,
  isActive: true,
  status: 'active',
  revision: 1,
  submitCount: 12,
  monthlySubmitCount: 3,
  monthlyCompletionRate: 50,
  createdAt: '2026-08-01',
  updatedAt: '2026-08-02',
  lastSubmittedAt: null,
  usedByAccounts: [],
  destinationSummary: { friendFieldCount: 3, tagCount: 0 },
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mount() {
  await act(async () => { root.render(<FormsListV8 />) })
  await flush()
}

beforeEach(() => {
  account.id = 'account-a'
  window.history.replaceState(null, '', '/form-submissions')
  forgetStaffIdentity()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role.value = verifiedStaffRole('owner')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  window.localStorage.setItem('lh_staff_role', 'owner')
  narrow.value = false
  deleteImpact.mockReset()
  unarchive.mockReset()
  unarchive.mockResolvedValue({ success: true, data: { status: 'active', revision: 2, isActive: false } })
  fetchApi.mockReset()
  fetchApi.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/forms?')) {
      return { success: true, data: { items: [{ ...baseForm, id: 'f-1', name: '来店アンケート', folderId: null }], total: 1, all_total: 1, page: 1, limit: 20 } }
    }
    return { success: true, data: {} }
  })
  listFolders.mockReset()
  listFolders.mockResolvedValue({ success: true, data: [{ id: 'fol-1', kind: 'form', name: '来店・予約', itemCount: 6, displayOrder: 0, color: null }], unfiledCount: 3 })
  listStats.mockReset()
  listStats.mockResolvedValue({ success: true, data: { forms: { published: 5, draft: 2, monthlySubmits: 712, prevMonthSubmits: 640, monthlyCompletionRate: 74, pendingPostActions: 2 } } })
});

afterEach(() => {
  act(() => root.unmount())
  host.remove()
});

describe('回答フォームの応答異常', () => {
  it('通常一覧の応答に一覧が無いときは画面を壊さず再試行を案内する', async () => {
    fetchApi.mockImplementation(async (path: string) => path.startsWith('/api/forms?')
      ? { success: true, data: {} } : { success: true, data: {} })
    await mount()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    expect(screen.queryByText('担当未割り当てのフォームはありません')).toBeNull()
  })
})
