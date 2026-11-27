// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/*
 * G2 Q&A タブの動き（要件 AI-02・07・08・20・23）：
 * 自動で答えるのオンはオーナーだけ・確かめの窓（NmTj4）を通す・閲覧のみは隠す・読めないときは読み直しの押し口。
 */
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const account = vi.hoisted(() => ({ id: 'acc-1' }))
const apiMock = vi.hoisted(() => ({
  saveSettings: vi.fn(), listQa: vi.fn(), test: vi.fn(),
  publishQa: vi.fn(), stopQa: vi.fn(), deleteQa: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/auto-replies' }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { id: account.id, name: '渋谷店' }, accounts: [] }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-1', name: '渋谷店' }] })) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffIdentity: () => null, useStaffRole: () => role.value }))
const gap = vi.hoisted(() => ({ settings: vi.fn(), qa: vi.fn() }))
vi.mock('@/lib/api/helpers/gap2', async original => ({ ...await original<typeof import('@/lib/api/helpers/gap2')>(), aiDraftApi: gap }))
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, aiReplyApi: { ...actual.aiReplyApi, ...apiMock } }
})
import QaListV8 from './qa-list'

const QA = { id: 'qa-1', questions: ['駐車場はありますか'], answerText: '店の裏に 3 台あります。', status: 'published', source: 'manual', useCount: 31, version: 1, updatedAt: '2026-10-01T00:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  account.id = 'acc-1'
  role.value = verifiedStaffRole('owner')
  gap.settings.mockResolvedValue({ success: true, data: { mode: 'draft_only', version: 4 } })
  gap.qa.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ success: true, data: [], total: 0, nextOffset: null })
  apiMock.saveSettings.mockResolvedValue({ success: true, data: { mode: 'auto_qa', suspendedReason: null, publishedQaCount: 18, draftQaCount: 1, version: 5 } })
  apiMock.listQa.mockResolvedValue({ success: true, data: { items: [QA], total: 1 } })
})
afterEach(cleanup)

async function open() {
  render(<QaListV8 />)
  await act(async () => {})
}

it('件数が読めない場合は0件にせず、再試行で0件を確認できる', async () => {
  await open()
  expect(screen.getByText('AI の使い方を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText(/公開中の Q&A 0 件/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText(/AI の使い方：返信案だけ/)).toBeTruthy()
  const { aiReplyApi } = await import('./api')
  expect((await aiReplyApi.settings('acc-1')).data.publishedQaCount).toBe(0)
})
