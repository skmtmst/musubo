// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listReplies = vi.hoisted(() => vi.fn())
const listTemplates = vi.hoisted(() => vi.fn())
const summary = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: { ...actual.api.autoReplies, list: listReplies, summary },
      templates: { ...actual.api.templates, list: listTemplates },
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

const account = vi.hoisted(() => ({ id: 'account-a' as string | null }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner', canManageRole: () => true }
})

import AutoRepliesListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ruleA = {
  id: 'ar-1',
  name: '営業時間外の自動返信',
  keyword: '営業時間',
  matchType: 'contains',
  keywords: null,
  respondToAll: false,
  isActive: true,
  lifecycleStatus: 'published',
  hits: { period: 5, total: 20 },
  actionExecutionCount: 2,
  responseContent: '営業時間外です',
  responseType: 'text',
  keywordMatchMode: 'any',
  activeFrom: null,
  activeUntil: null,
  responseWeekdays: null,
  responseHolidayRule: null,
  cooldownMinutes: null,
  skipWhenOperatorActive: false,
  oncePerFriend: false,
  messageKinds: null,
  friendConditions: null,
  folderId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  verifiedStaffRole('owner')
  forgetSessionSnapshot()
  account.id = 'account-a'
  window.history.replaceState(null, '', '/auto-replies')
  document.documentElement.dataset.theme = 'v8'
  listReplies.mockReset().mockResolvedValue({ success: true, data: [ruleA] })
  listTemplates.mockReset().mockResolvedValue({ success: true, data: [] })
  summary.mockReset().mockResolvedValue({ success: true, data: { conflictCount: 0, dispatchStopped: false } })
  listFolders.mockReset().mockResolvedValue({ success: true, data: [], unfiledCount: 0 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  forgetStaffIdentity()
  forgetSessionSnapshot()
  host.remove()
  delete document.documentElement.dataset.theme
})

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('V8 自動応答一覧の補助取得失敗からの復帰と数の帯読み込み', () => {
  it('初回読み込み中は数の帯に読み込み骨格を出し、完了後に数値へ切り替える', async () => {
    let resolveList!: (value: unknown) => void
    listReplies.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    act(() => { root.render(<AutoRepliesListV8 />) })
    await flush()

    const kpis = host.querySelector('[data-design="KPIs"]')!
    expect(kpis.querySelectorAll('[data-kpi-skeleton]').length).toBe(4)

    await act(async () => { resolveList({ success: true, data: [ruleA] }) })
    await flush()

    expect(kpis.querySelectorAll('[data-kpi-skeleton]').length).toBe(0)
    expect(host.textContent).toContain('営業時間外の自動返信')
  })

  it('テンプレート一覧の取得が失敗してもルール一覧を表示し続ける', async () => {
    listTemplates.mockRejectedValueOnce(new Error('templates service down'))
    act(() => { root.render(<AutoRepliesListV8 />) })
    await flush()

    expect(host.textContent).toContain('営業時間外の自動返信')
    expect(host.textContent).not.toContain('自動応答を読み込めませんでした')
  })

  it('重なり・送信状態の集計だけ失敗したときに再確認でき、一覧を読み直さず復帰する', async () => {
    summary
      .mockRejectedValueOnce(new Error('summary timeout'))
      .mockResolvedValueOnce({ success: true, data: { conflictCount: 2, dispatchStopped: false } })

    act(() => { root.render(<AutoRepliesListV8 />) })
    await flush()

    expect(host.textContent).toContain('営業時間外の自動返信')
    const stats = host.querySelector('[data-template-region="stats"]') as HTMLElement
    expect(stats.textContent).toContain('自動応答全体の送信状態を確認できません。')
    expect(stats.textContent).toContain('重なりを確認できませんでした')
    const noticeRetry = within(stats).getByRole('button', { name: '状態を確認し直す' })
    const kpiRetry = within(stats).getByRole('button', { name: 'もう一度読み込む' })
    expect(noticeRetry).toBeTruthy()
    expect(kpiRetry).toBeTruthy()

    const listCallsBefore = listReplies.mock.calls.length
    await act(async () => { kpiRetry.click() })
    await flush()

    expect(summary).toHaveBeenCalledTimes(2)
    expect(listReplies).toHaveBeenCalledTimes(listCallsBefore)
    expect(stats.textContent).toContain('確認できる自動応答に、有効なルールがあります。')
    expect(stats.textContent).toContain('2')
    expect(stats.textContent).not.toContain('重なりを確認できませんでした')
  })
})
