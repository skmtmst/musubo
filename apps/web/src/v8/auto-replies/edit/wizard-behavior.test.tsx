import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 自動応答を作る（V8）の、押して確かめる動き。
 * 手順4の試す相手と試し送り・動く順番と重なり・見送りの理由、保存の知らせと競合の帯、
 * 有効にするときの確認キー、狭い幅の板、下書きを読めない時の言い分け。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  title: vi.fn(), query: 'id=synthetic-rule&step=priority',
  getDraft: vi.fn(), validateDraft: vi.fn(), list: vi.fn(), conflicts: vi.fn(), saveDraft: vi.fn(),
  testDraft: vi.fn(), publishDraft: vi.fn(), friends: vi.fn(), liveStatus: 'draft', wide: false,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: (url: string) => { net.query = url.split('?')[1] }, push: vi.fn() }), useSearchParams: () => new URLSearchParams(net.query) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'synthetic-account', accounts: [{ id: 'synthetic-account' }] }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: net.title }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false, status: 'ready' }) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => !net.wide }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ default: () => null, useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [] }) }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      autoReplies: {
        getDraft: net.getDraft,
        get: async () => ({ success: true, data: { isActive: net.liveStatus === 'published', lifecycleStatus: net.liveStatus } }),
        list: net.list, conflicts: net.conflicts, validateDraft: net.validateDraft, saveDraft: net.saveDraft,
        testDraft: net.testDraft, publishDraft: net.publishDraft,
      },
      templates: { list: async () => ({ success: true, data: [] }) },
      folders: { list: async () => ({ success: true, data: [] }) },
      friends: { list: net.friends },
    },
  }
})

import { ApiError } from '@/lib/api'
import Page from './wizard'

const SETTINGS = {
  keyword: '予約', matchType: 'contains', responseType: 'text', responseContent: '承りました', templateId: null,
  lineAccountId: 'synthetic-account', activeFrom: null, activeUntil: null, cooldownMinutes: null, skipWhenOperatorActive: false,
  priority: 5, messageKinds: null, receiveSources: ['line'], friendConditions: null, actions: null, responseWeekdays: null,
  responseHolidayRule: null, oncePerFriend: false, keywords: null, respondToAll: false, name: '予約の受付',
  keywordMatchMode: 'any', folderId: null, internalMemo: null, replyDelaySeconds: null, unmatchedAction: null,
}
const draft = (settings: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    autoReplyId: 'synthetic-rule', versionId: 'v1', versionNumber: 1, status: 'draft', settings: { ...SETTINGS, ...settings },
    lastTestStatus: null, lastTestedAt: null, publishedAt: null, matchedLast28Days: null,
  },
})
const otherRule = {
  id: 'rule-top', name: '先に動くルール', isActive: true, lifecycleStatus: 'published', priority: 1,
  createdAt: '2026-09-01T00:00:00.000Z', keyword: '予約', activeFrom: null, activeUntil: null,
}

beforeEach(() => {
 verifiedStaffRole('owner')
  net.query = 'id=synthetic-rule&step=priority'; net.liveStatus = 'draft'; net.wide = false
  vi.clearAllMocks()
  net.getDraft.mockResolvedValue(draft())
  net.validateDraft.mockResolvedValue({ success: true, data: { errors: [], warnings: [], conflicts: [] } })
  net.list.mockResolvedValue({ success: true, data: [otherRule] })
  net.conflicts.mockResolvedValue({ success: true, data: { conflicts: [{ autoReplyId: 'rule-top', name: '先に動くルール', certainty: 'certain', reason: '同じ言葉' }] } })
  net.saveDraft.mockResolvedValue({ ...draft(), data: { ...draft().data, versionNumber: 2 } })
  net.friends.mockResolvedValue({ success: true, data: { items: [{ id: 'friend-1', displayName: '試す友だち' }], total: 3 } })
})
afterEach(() => { cleanup(); forgetStaffIdentity() })

const orderNames = () => [...document.querySelectorAll('ol li p:first-child')].map((node) => node.textContent)

it('手順4は試す相手を読み、選んだ友だちと届いた文で下書きを試す', async () => {
  net.testDraft.mockResolvedValue({ success: true, data: { draftWon: true, winner: null, candidates: [], staleTest: false } })
  render(<Page />); await act(async () => {})
  expect(net.friends).toHaveBeenCalledWith({ accountId: 'synthetic-account', includeChatStatus: true, limit: 20 })
  expect(document.body.textContent).toContain('候補 3人中 1人')
  fireEvent.change(document.querySelector('#wiz-test-message') as HTMLInputElement, { target: { value: '予約したい' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '試す', exact: true })))
  expect(net.testDraft).toHaveBeenCalledWith('synthetic-rule', { friendId: 'friend-1', incomingText: '予約したい' })
  expect(screen.getByText('このルールが返します。')).toBeTruthy()
})

it('動く順番に自分の位置と先に動く重なりを示し、重なりより前へ一度で動かせる', async () => {
  render(<Page />); await act(async () => {})
  expect(net.conflicts).toHaveBeenCalledWith('synthetic-rule')
  expect(orderNames()).toEqual(['先に動くルール', '予約の受付（このルール）'])
  expect(screen.getByText('同じ受信に当たる → このルールより先に動きます')).toBeTruthy()
  const card = screen.getByRole('region', { name: '重なりを1件ずつ確かめる' })
  expect(card.textContent).toContain('先に動くルール（1番目）')
  expect(within(card).getByRole('checkbox', { name: '「先に動くルール」を確かめた' })).toBeTruthy()
  expect(screen.getByText('当たる受信（過去28日）').parentElement?.textContent).toContain('—')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /「先に動くルール」より前へ/ })))
  expect(orderNames()).toEqual(['予約の受付（このルール）', '先に動くルール'])
})

it('見送りになったら、先に動くルールと見送った理由を運用者の言葉で出す', async () => {
  net.testDraft.mockResolvedValue({ success: true, data: {
    draftWon: false, winner: { autoReplyId: 'rule-top', name: '先に動くルール' }, staleTest: false,
    candidates: [{ autoReplyId: 'synthetic-rule', reasonCodes: ['higher_priority_won', 'operator_handling'] }],
  } })
  render(<Page />); await act(async () => {})
  fireEvent.change(document.querySelector('#wiz-test-message') as HTMLInputElement, { target: { value: '予約したい' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '試す', exact: true })))
  expect(screen.getByText('このルールは見送りです：先に動くルールが先に動きます。動かすには、順番をそれより前にします。')).toBeTruthy()
  expect(screen.getByText(/見送った理由：/).textContent).toBe('見送った理由：上のルールが先に動きます・担当者が対応中です')
})

it('未知の見送り理由が組み込み名と同じでも理由を文字列として表示する', async () => {
  net.testDraft.mockResolvedValue({ success: true, data: {
    draftWon: false, winner: { autoReplyId: 'rule-top', name: '先に動くルール' }, staleTest: false,
    candidates: [{ autoReplyId: 'synthetic-rule', reasonCodes: ['operator_handling', 'new_reason', 'constructor', 'toString', '__proto__'] }],
  } })
  render(<Page />); await act(async () => {})
  fireEvent.change(document.querySelector('#wiz-test-message') as HTMLInputElement, { target: { value: '予約したい' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '試す', exact: true })))
  expect(screen.getByText(/見送った理由：/).textContent).toBe('見送った理由：担当者が対応中です・理由を確認できませんでした')
})

it('保存できたときだけ「下書きを保存しました」を出す', async () => {
  net.query = 'id=synthetic-rule&step=basic'
  render(<Page />); await act(async () => {})
  await act(async () => fireEvent.click(getPageAction({ name: '下書きとして保存' })))
  expect(net.saveDraft).toHaveBeenCalledTimes(1)
  expect(screen.getByText('下書きを保存しました')).toBeTruthy()
})

it('ほかの人が先に保存していたら頭の下に帯を出し、最新との違いを比べられる', async () => {
  net.query = 'id=synthetic-rule&step=basic'
  net.saveDraft.mockRejectedValueOnce(new ApiError(409, 'conflict'))
  render(<Page />); await act(async () => {})
  net.getDraft.mockResolvedValue(draft({ name: 'ほかの人の名前' }))
  await act(async () => fireEvent.click(getPageAction({ name: '下書きとして保存' })))
  expect(screen.queryByText('下書きを保存しました')).toBeNull()
  const band = screen.getByRole('alert')
  expect(band.closest('[data-design-node="UGrd2"]')).not.toBeNull()
  expect(band.textContent).toContain('ほかの人がルール「予約の受付」を先に保存しました')
  await act(async () => fireEvent.click(within(band).getByRole('button', { name: '違いを比べる' })))
  expect(net.getDraft).toHaveBeenLastCalledWith('synthetic-rule')
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('ルール名が違います（最新「ほかの人の名前」／あなた「予約の受付」）')
})

it('有効にするときは確認キーを付け、失敗して押し直しても同じキーで送る', async () => {
  net.query = 'id=synthetic-rule&step=priority'
  net.conflicts.mockResolvedValue({ success: true, data: { conflicts: [] } })
  net.list.mockResolvedValue({ success: true, data: [] })
  net.testDraft.mockResolvedValue({ success: true, data: { draftWon: true, winner: null, candidates: [], staleTest: false } })
  net.publishDraft.mockResolvedValueOnce({ success: false, error: '一時的に失敗しました' }).mockResolvedValueOnce({ success: true, data: {} })
  const view = render(<Page />); await act(async () => {})
  fireEvent.change(document.querySelector('#wiz-test-message') as HTMLInputElement, { target: { value: '予約' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '試す', exact: true })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '次へ：確認', exact: true })))
  view.rerender(<Page />); await act(async () => {})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '有効にする', exact: true })))
  await waitFor(() => expect(screen.getByRole('button', { name: '有効にする', exact: true }).hasAttribute('disabled')).toBe(false))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '有効にする', exact: true })))
  expect(net.publishDraft).toHaveBeenCalledTimes(2)
  const [first, second] = net.publishDraft.mock.calls
  expect(typeof first[2]).toBe('string')
  expect(first[2].length).toBeGreaterThan(0)
  expect(second[2]).toBe(first[2])
})

it('狭い幅の「どんなときに動くか」は狭い幅の板で描く', async () => {
  net.query = 'id=synthetic-rule&step=trigger'
  render(<Page />); await act(async () => {})
  expect(document.querySelector('[data-design-node="Z2LIUx"]')).not.toBeNull()
  cleanup()
  net.wide = true
  render(<Page />); await act(async () => {})
  expect(document.querySelector('[data-design-node="Z2LIUx"]')).toBeNull()
})

it('下書きを見る権限が無いときは通信の失敗と言わず、権限の案内にする', async () => {
  net.query = 'id=synthetic-rule&step=basic'
  net.getDraft.mockRejectedValue(new ApiError(403, 'forbidden'))
  render(<Page />); await act(async () => {})
  expect(screen.getByText('下書きを見る権限がありません')).toBeTruthy()
  expect(document.body.textContent).not.toContain('通信が切れたか')
})

it('下書きを読めなかったら、同じ下書きをその場で読み直せる', async () => {
  net.query = 'id=synthetic-rule&step=basic'
  net.getDraft.mockRejectedValueOnce(new ApiError(500, 'failed')).mockResolvedValue(draft())
  render(<Page />); await act(async () => {})
  expect(document.body.textContent).toContain('管理者にお問い合わせください。')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })))
  expect(net.getDraft).toHaveBeenCalledTimes(2)
  expect(net.getDraft.mock.calls.every(([id]) => id === 'synthetic-rule')).toBe(true)
  expect((screen.getByLabelText(/ルール名/) as HTMLInputElement).value).toBe('予約の受付')
})

it('新規の題とブラウザ・パンくず用の題には自動応答と分かる名前を付ける',async()=>{
 net.query='step=basic'
 render(<Page/>)
 await waitFor(()=>expect(screen.getByRole('heading',{name:'自動応答を作る'})).toBeTruthy())
 expect(net.title).toHaveBeenCalledWith('自動応答を作る・基本設定')
})
