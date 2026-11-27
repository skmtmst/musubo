import { currentListLocation, flushListUrlState } from '@/components/shared/list-url-state'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 テンプレートの一覧（src/v8）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 行が出る・公開の札・閲覧のみの帯（サーバの役割で決まる）・
 * 使っていない（0か所）ものは窓なしで外して5秒は元に戻せる・数が分からないものは削除の確認、使っているものは削除できない窓。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listTemplates = vi.hoisted(() => vi.fn())
const folderList = vi.hoisted(() => ({ value: { success: true, data: [] as unknown[], unfiledCount: 2 }, list: null as null | ((...args: unknown[]) => unknown) }))
const usages = vi.hoisted(() => vi.fn())
const folderRemove = vi.hoisted(() => vi.fn(async () => ({ success: true })))
const heldFolder = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && typeof props.description === 'string' && props.description.includes('中のテンプレートは未分類') && props.onConfirm) heldFolder.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})
const removeTemplate = vi.hoisted(() => vi.fn())
const removeTemplates = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const account = vi.hoisted(() => ({ id: 'account-1' }))
const push = vi.hoisted(() => vi.fn())
const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('next/link', () => ({
  default: ({ children, href, className, title }: { children: React.ReactNode; href: string; className?: string; title?: string }) => (
    <a href={typeof href === 'string' ? href : '#'} className={className} title={title}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/templates',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [{ id: 'account-1', name: '本店' }, { id: 'account-2', name: '別アカウント' }], selectedAccountId: account.id, loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: account.id }),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => role.value,
  canManageRole: (r: string | null | undefined) => r === 'owner' || r === 'admin',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
const viewport = vi.hoisted(() => ({ narrow: false }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => viewport.narrow }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 0
  },
  fetchApi,
  api: {
    templates: { list: listTemplates, usages, delete: removeTemplate, bulkDelete: removeTemplates },
    friendFields: { list: () => Promise.resolve({ success: true, data: [{ fieldKey: 'pet_name', name: 'ペットの名前' }] }) },
    commonVars: { list: () => Promise.resolve({ success: true, data: [{ varKey: 'business_hours', name: '営業時間' }] }) },
    broadcastMessageAssets: { counts: () => Promise.resolve({ success: true, data: { card_message: 4 } }), list: () => Promise.resolve({ success: true, data: [] }), folders: { list: () => Promise.resolve({ success: true, data: [] }) } },
    folders: { list: (...args: unknown[]) => Promise.resolve(folderList.list ? folderList.list(...args) : folderList.value), delete: folderRemove },
  },
}))

import TemplatesListV8 from './list'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  confirmationRevision: 3,
  category: '',
  messageType: 'text',
  folderId: null,
  question: null,
  questionStatus: 'published',
  tapCount: 0,
  monthlySendCount: 10,
  totalSendCount: 20,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}
const used = { ...base, id: 't-used', name: '予約前日のご案内', messageContent: '明日のご予約です', usageCount: 11, publishedAt: '2026-08-01T00:00:00.000Z', hasDraft: true }
const unused = { ...base, id: 't-unused', accountId: 'account-2', name: '秋の新商品（画像）', messageType: 'image', messageContent: '{"originalContentUrl":"https://example.com/a.jpg"}', monthlySendCount: 0, totalSendCount: 0, usageCount: 0, publishedAt: null, hasDraft: true }

async function renderList() {
  await act(async () => {
    render(<TemplatesListV8 />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function openMenuAndDelete(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `テンプレート「${name}」の操作` }))
  fireEvent.click(screen.getByText('削除する'))
}

beforeEach(() => {
  account.id = 'account-1'
  flushListUrlState()
  window.history.replaceState(null, '', '/templates')
  window.dispatchEvent(new PopStateEvent('popstate'))
  document.documentElement.dataset.theme = 'v8'
  role.value = verifiedStaffRole('owner')
  listTemplates.mockResolvedValue({ success: true, data: [used, unused] })
  usages.mockResolvedValue({
    success: true,
    data: {
      broadcasts: [{ broadcastId: 'b1', title: '9月の予約リマインド', status: 'scheduled', scheduledAt: null, templateVersionNumber: 2, referenceMode: 'fixed' }],
      autoReplies: [{ id: 'a1', keyword: '予約変更のお問い合わせ', lineAccountId: null, templateVersion: null }],
      scenarioSteps: [{ scenarioId: 's1', scenarioName: '予約フォロー', stepId: 'st1', stepOrder: 1, templateVersion: null }],
    },
  })
  removeTemplate.mockResolvedValue({ success: true })
  removeTemplates.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  folderList.value = { success: true, data: [], unfiledCount: 2 }
  folderList.list = null
  clearToastsForTest()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('未対応のテンプレートの種類', () => {
  it.each(['toString', 'constructor', '__proto__'])('%s でも一覧を表示する', async (messageType) => {
    viewport.narrow = true
    listTemplates.mockResolvedValue({ success: true, data: [{ ...used, name: '見本のテンプレート', messageType }] })
    await renderList()
    expect(await screen.findByText('見本のテンプレート')).toBeTruthy()
    expect(screen.getByLabelText('種類：その他')).toBeTruthy()
  })
})
