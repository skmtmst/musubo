// @vitest-environment happy-dom
/*
 * 実行結果の「CSVで書き出す」を押して確かめる（点検・中8）。
 * 上限 5,000 件で止めて分ける案内を出す・読み込み中の件数を出す・途中で止められる・書き出した件数を出す。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runs: vi.fn(), get: vi.fn(), stop: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, autoReplies: { ...actual.api.autoReplies, runs: mocks.runs, get: mocks.get, stop: mocks.stop } } }
})
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({
  ...(await importOriginal()),
  useStaffRole: () => 'owner',
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/auto-replies/runs',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=rule-1'),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-1', name: '本店' }] })) }))

import AutoReplyRunsPage from '@/app/auto-replies/runs/page'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

function runItem(index: number) {
  return {
    id: `evaluation-${index}`, ownerKind: 'auto_reply', ownerId: 'rule-1', lineAccountId: 'acc-1',
    occurredAt: '2026-09-15T01:00:00.000Z', subject: '友だち', accountLabel: '本店', triggerLabel: '予約', reference: null,
    status: 'succeeded', detail: '', durationMs: 100, canRetry: false, autoReplyId: 'rule-1', autoReplyName: '予約問い合わせ',
    friendId: 'friend-1', friendName: '友だち', messageKind: 'text', inputPreview: '', matchedKeyword: '予約', versionNumber: 1,
    domainStatus: 'completed', replyStatus: 'accepted', actionSummary: { executed: 0, failed: 0 }, lineRequestId: null,
  }
}

function page(offset: number, size: number, total: number) {
  return {
    success: true,
    data: {
      rule: { id: 'rule-1', name: '予約問い合わせ', isActive: true, priorityPosition: 1 },
      summary: { monthHits: total, totalHits: total, handovers: 0, errors: 0, lastRunAt: null, averageResponseMs: null },
      handovers: { waiting: 0, inProgress: 0, completed: 0 },
      triggerBreakdown: [],
      items: Array.from({ length: size }, (_, i) => runItem(offset + i)),
      pagination: { total, limit: size, offset },
    },
  }
}

const downloads: string[] = []
let createObjectURL: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  forgetSessionSnapshot()
  verifiedStaffRole('owner')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  downloads.length = 0
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:runs')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
})

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  forgetSessionSnapshot()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mocks.runs.mockReset()
  mocks.get.mockReset()
  mocks.stop.mockReset()
})

/** 画面の最初の読み込み（offset 0・件数少なめ）と、書き出しの読み込み（limit 100）を分けて返す。 */
function serve(total: number, onExportPage?: (offset: number) => Promise<unknown> | undefined) {
  mocks.runs.mockImplementation(async (query: { limit?: number; offset?: number }) => {
    if (query.limit !== 100) return page(0, Math.min(total, 1), total)
    const offset = query.offset ?? 0
    const held = onExportPage?.(offset)
    if (held) return held
    return page(offset, Math.max(0, Math.min(100, total - offset)), total)
  })
}

async function startExport() {
  render(<AutoReplyRunsPage />)
  const button = await screen.findByRole('button', { name: /CSVで書き出す/ })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(button) })
}

const exportCalls = () => mocks.runs.mock.calls.filter(([query]) => query.limit === 100)

it('一時停止の確認にはルールの実際のLINEアカウントを示す', async () => {
  serve(1)
  mocks.get.mockResolvedValue({ success: true, data: { id: 'rule-1', lineAccountId: null, confirmationRevision: 1 } })
  render(<AutoReplyRunsPage />)
  fireEvent.click(await screen.findByRole('button', { name: '一時停止する' }))
  expect(await screen.findByText('すべてのLINEアカウント')).toBeTruthy()
  expect(mocks.get).toHaveBeenCalledWith('rule-1')
})

it('確認した版を送り、競合後は最新の版を読み直して再確認する', async () => {
  serve(1)
  const { ApiError } = await import('@/lib/api')
  mocks.get.mockResolvedValueOnce({ success: true, data: {id:'rule-1',lineAccountId:'acc-1',confirmationRevision:2} })
    .mockResolvedValue({ success: true, data: {id:'rule-1',lineAccountId:'acc-1',confirmationRevision:3} })
  mocks.stop.mockRejectedValueOnce(new ApiError(409, '変更されました', 'auto_reply_confirmation_conflict')).mockResolvedValue({success:true})
  render(<AutoReplyRunsPage />)
  fireEvent.click(await screen.findByRole('button', {name:'一時停止する'}))
  await screen.findByText('この自動応答を止めますか？')
  let dialog = screen.getByRole('alertdialog', {name:'この自動応答を止めますか？'})
  await waitFor(() => expect((within(dialog).getByRole('button', {name:'一時停止する'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(within(dialog).getByRole('button', {name:'一時停止する'}))
  await screen.findAllByText('内容が変わりました。読み直した内容を確認してください。')
  expect(mocks.stop.mock.calls[0][1]).toEqual({reason:null,expectedVersion:2})
  dialog = screen.getByRole('alertdialog', {name:'この自動応答を止めますか？'})
  fireEvent.click(within(dialog).getByRole('button', {name:'もう一度'}))
  await waitFor(() => expect(mocks.stop.mock.calls[1][1]).toEqual({reason:null,expectedVersion:3}))
})

it('対象ルールを取得できなければアカウントを不明として示す', async () => {
  serve(1)
  mocks.get.mockRejectedValue(new Error('offline'))
  render(<AutoReplyRunsPage />)
  fireEvent.click(await screen.findByRole('button', { name: '一時停止する' }))
  expect(await screen.findByText('名前を確認できません')).toBeTruthy()
  expect(screen.queryByText('すべてのLINEアカウント')).toBeNull()
})

it('特定アカウントのルールはその名前を示す', async () => {
  serve(1)
  mocks.get.mockResolvedValue({ success: true, data: { id: 'rule-1', lineAccountId: 'acc-1', confirmationRevision: 1 } })
  render(<AutoReplyRunsPage />)
  fireEvent.click(await screen.findByRole('button', { name: '一時停止する' }))
  expect(await screen.findByText('本店', { selector: 'dd span' })).toBeTruthy()
  expect(screen.queryByText('すべてのLINEアカウント')).toBeNull()
})

it('別のルールの応答を対象として表示しない', async () => {
  serve(1)
  mocks.get.mockResolvedValue({ success: true, data: { id: 'other-rule', lineAccountId: null } })
  render(<AutoReplyRunsPage />)
  fireEvent.click(await screen.findByRole('button', { name: '一時停止する' }))
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('rule-1'))
  expect(screen.getByText('名前を確認できません')).toBeTruthy()
  expect(screen.queryByText('すべてのLINEアカウント')).toBeNull()
})

it('全部を100件ずつ読み、書き出した件数を知らせる', async () => {
  serve(150)
  await startExport()
  await screen.findByText('150 件を書き出しました。')
  expect(exportCalls().map(([query]) => query.offset)).toEqual([0, 100])
  expect(exportCalls().every(([query]) => query.ruleId === 'rule-1')).toBe(true)
  expect(createObjectURL).toHaveBeenCalledTimes(1)
  expect(downloads).toHaveLength(1)
})

it('5,000件で読むのを止め、期間を絞って分ける案内を出す', async () => {
  serve(6000)
  await startExport()
  await screen.findByText('直近5,000 件まで書き出しました。全部要るときは期間を絞って分けてください。')
  expect(exportCalls()).toHaveLength(50)
  expect(downloads).toHaveLength(1)
})

it('読み込み中は件数と「書き出しを止める」を出し、止めたら書き出さない', async () => {
  let release!: () => void
  serve(3000, (offset) => offset === 1000
    ? new Promise((resolve) => { release = () => resolve(page(offset, 100, 3000)) })
    : undefined)
  await startExport()
  await screen.findByText('1,000 件読み込み中…')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '書き出しを止める' })) })
  await act(async () => { release() })
  await screen.findByText('書き出しを止めました。')
  expect(exportCalls()).toHaveLength(11)
  expect(downloads).toHaveLength(0)
  expect(screen.queryByRole('button', { name: '書き出しを止める' })).toBeNull()
})


it('実行の日時は日付と日本時間を同じ欄に出し、機械用の日時も保つ', async () => {
  serve(1)
  render(<AutoReplyRunsPage />)
  await waitFor(() => {
    const timestamp = document.querySelector('time[datetime="2026-09-15T01:00:00.000Z"] [data-list-date-time]')
    expect(timestamp?.textContent).toContain('09/15')
    expect(timestamp?.textContent).toContain('10:00')
  })
})
