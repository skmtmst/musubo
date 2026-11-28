// @vitest-environment happy-dom
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReminderDeliveryRunsResponse } from '@/lib/api'

const navigation = vi.hoisted(() => ({ query: 'id=rem-1', access: true }))
const apiMock = vi.hoisted(() => ({
  runs: vi.fn(),
  get: vi.fn(),
  retryRun: vi.fn(),
  update: vi.fn(),
  registrantsList: vi.fn(),
  registrantsUpdateTargetDate: vi.fn(),
  registrantsCancel: vi.fn(),
  registrantsResume: vi.fn(),
}))

vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => navigation.access }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { reminders: {
    runs: apiMock.runs,
    get: apiMock.get,
    retryRun: apiMock.retryRun,
    update: apiMock.update,
    registrants: {
      list: apiMock.registrantsList,
      updateTargetDate: apiMock.registrantsUpdateTargetDate,
      cancel: apiMock.registrantsCancel,
      resume: apiMock.registrantsResume,
    },
  } },
}))

import ReminderRunsPage from './page'

const RESPONSE = (overrides: Partial<ReminderDeliveryRunsResponse['reminder']> = {}): ReminderDeliveryRunsResponse => ({
  reminder: {
    id: 'rem-1',
    name: '予約前のお知らせ',
    isActive: true,
    lifecycleStatus: 'published',
    stopConditions: {
      bookingCancelled: false,
      supportMarkCompleted: false,
      daysAfterTarget: 7,
      friendBlocked: true,
    },
    // R146 監査：公開版の有無。ある設定が既定。
    hasPublishedVersion: true,
    ...overrides,
  },
  summary: { sent: 0, scheduled: 0, stopped: 0, errors: 0, targetCount: 0, nextScheduledAt: null },
  steps: [],
  items: [],
  pagination: { total: 0, limit: 20, offset: 0 },
})

beforeEach(() => {
  navigation.query = 'id=rem-1'
  navigation.access = true
  Object.values(apiMock).forEach(fn => fn.mockReset())
  apiMock.get.mockResolvedValue({ success: true, data: { id: 'rem-1', steps: [], deliveryMode: 'countdown', triggerType: 'manual' } })
  apiMock.registrantsList.mockResolvedValue({ success: true, data: [] })
  apiMock.update.mockResolvedValue({ success: true, data: {} })
})

afterEach(cleanup)

describe('リマインダ詳細の停止予定', () => {
  it('公開版の停止条件を実値で出す', async () => {
    apiMock.runs.mockResolvedValue({ success: true, data: RESPONSE() })
    render(<ReminderRunsPage />)
    await waitFor(() => expect(screen.getByTitle('基準日から7日後に自動終了・ブロックで即時停止')).toBeTruthy())
    // 「停止予定」行が固定の「—」でないことを、実値の表示で確認する。
    expect(screen.getByText('状態')).toBeTruthy()
  })

  it('停止条件がすべて無効なら「自動停止なし」、公開版が無ければ「未設定」と区別する', async () => {
    apiMock.runs.mockResolvedValue({
      success: true,
      data: RESPONSE({ stopConditions: { bookingCancelled: false, supportMarkCompleted: false, daysAfterTarget: null, friendBlocked: false } }),
    })
    const { unmount } = render(<ReminderRunsPage />)
    await waitFor(() => expect(screen.getByTitle('自動停止なし')).toBeTruthy())
    unmount()

    apiMock.runs.mockResolvedValue({ success: true, data: RESPONSE({ stopConditions: null }) })
    render(<ReminderRunsPage />)
    await waitFor(() => expect(screen.getByTitle('未取得')).toBeTruthy())
  })

  it('停止中のリマインダは「停止中」を出し、再開ボタンが実際にAPIを呼ぶ', async () => {
    apiMock.runs.mockResolvedValue({
      success: true,
      data: RESPONSE({ isActive: false, lifecycleStatus: 'stopped' }),
    })
    render(<ReminderRunsPage />)
    await waitFor(() => expect(screen.getByText('停止中')).toBeTruthy())
    const resume = screen.getByText('再開する')
    fireEvent.click(resume)
    await waitFor(() => expect(apiMock.update).toHaveBeenCalledWith('rem-1', { isActive: true }))
  })

  it('有効は一時停止ボタンが実際にAPIを呼ぶ', async () => {
    apiMock.runs.mockResolvedValue({ success: true, data: RESPONSE() })
    render(<ReminderRunsPage />)
    const pause = await screen.findByText('一時停止する')
    fireEvent.click(pause)
    fireEvent.click(screen.getAllByRole('button', { name: '一時停止する' }).at(-1)!)
    await waitFor(() => expect(apiMock.update).toHaveBeenCalledWith('rem-1', { isActive: false }))
  })

  it('R146: 未公開の下書きは「下書き」と出し、再開ボタンを出さない', async () => {
    apiMock.runs.mockResolvedValue({
      success: true,
      data: RESPONSE({ isActive: false, lifecycleStatus: 'draft', hasPublishedVersion: false }),
    })
    render(<ReminderRunsPage />)
    // 稼働状況の「状態」と追従バーの状態の2か所に「下書き」と出る。
    await waitFor(() => expect(screen.getAllByText('下書き').length).toBeGreaterThan(0))
    expect(screen.queryByText('再開する')).toBeNull()
    expect(screen.getByText('編集を続ける')).toBeTruthy()
  })
})


describe('配信予定と実行結果', () => {
  it('取得した送信数と失敗数を表示し、失敗がある時だけ案内する', async () => {
    const response = RESPONSE()
    response.summary.sentThisMonth = 17
    response.summary.errors = 2
    apiMock.runs.mockResolvedValue({ success: true, data: response })
    const view = render(<ReminderRunsPage />)
    expect(await screen.findByText('17通')).toBeTruthy()
    expect(screen.getByText(/送れなかった通知が.*2通あります/)).toBeTruthy()
    expect(screen.queryByText('1,284')).toBeNull()
    view.unmount()
    apiMock.runs.mockResolvedValue({ success: true, data: RESPONSE() })
    render(<ReminderRunsPage />)
    await screen.findByText('予約前のお知らせ')
    expect(screen.queryByText(/送れなかった通知が/)).toBeNull()
  })

  it('予定を開くとplannedで取得し、0件を画面で示す', async () => {
    navigation.query = 'id=rem-1&tab=schedule'
    apiMock.runs.mockResolvedValue({ success: true, data: RESPONSE() })
    render(<ReminderRunsPage />)
    expect(await screen.findByText('送る予定はありません')).toBeTruthy()
    expect(apiMock.runs).toHaveBeenCalledWith('rem-1', expect.objectContaining({ status: 'planned', offset: 0 }))
  })

  it('詳細の読込中・失敗・再取得を区別する', async () => {
    let rejectLoad!: (reason: unknown) => void
    apiMock.runs.mockImplementation((_id: string, params: { status?: string }) => params.status === 'planned'
      ? Promise.resolve({ success: true, data: RESPONSE() })
      : new Promise((_resolve, reject) => { rejectLoad = reject }))
    render(<ReminderRunsPage />)
    expect(screen.getByText('リマインダの詳細を読み込んでいます')).toBeTruthy()
    expect(screen.queryByText('0通')).toBeNull()
    await act(async () => { rejectLoad(new Error('private error')) })
    expect(await screen.findByText('リマインダを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('private error')).toBeNull()
    apiMock.runs.mockResolvedValue({ success: true, data: RESPONSE() })
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(await screen.findByText('予約前のお知らせ')).toBeTruthy()
  })

  it('実行結果は失敗した行だけ再試行し、状態で絞る', async () => {
    navigation.query = 'id=rem-1&tab=runs'
    const response = RESPONSE()
    response.items = [
      { id: 'run-fail', friendId: 'friend-1', friendName: '失敗した友だち', stepNumber: 1, scheduledAt: '2026-11-01T00:00:00Z', startedAt: null, completedAt: null, domainStatus: 'permanent_failed', attemptCount: 1, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: '配信に失敗', lineRequestId: null, reminderStepId: 'step-1', occurredAt: '2026-11-01T00:00:00Z', subject: '失敗した友だち', accountLabel: null, triggerLabel: null, reference: null, status: 'failed', detail: null, durationMs: null, canRetry: true },
      { id: 'run-done', friendId: 'friend-2', friendName: '配信済みの友だち', stepNumber: 1, scheduledAt: '2026-11-01T00:00:00Z', startedAt: null, completedAt: null, domainStatus: 'succeeded', attemptCount: 1, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null, lineRequestId: null, reminderStepId: 'step-1', occurredAt: '2026-11-01T00:00:00Z', subject: '配信済みの友だち', accountLabel: null, triggerLabel: null, reference: null, status: 'succeeded', detail: null, durationMs: null, canRetry: false },
    ]
    apiMock.runs.mockResolvedValue({ success: true, data: response })
    apiMock.retryRun.mockResolvedValue({ success: true, data: {} })
    const view = render(<ReminderRunsPage />)
    const failed = (await screen.findByText('失敗した友だち')).closest('[role="row"]')!
    const done = screen.getByText('配信済みの友だち').closest('[role="row"]')!
    expect(within(done as HTMLElement).queryByRole('button', { name: '再試行する' })).toBeNull()
    fireEvent.click(within(failed as HTMLElement).getByRole('button', { name: '再試行する' }))
    await waitFor(() => expect(apiMock.retryRun).toHaveBeenCalledWith('run-fail', expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)))
    expect(await screen.findByText('再試行を受け付けました。次の配信処理で送ります。')).toBeTruthy()
    navigation.access = false
    view.rerender(<ReminderRunsPage />)
    expect(screen.queryByRole('button', { name: '再試行する' })).toBeNull()
    navigation.access = true
    view.rerender(<ReminderRunsPage />)
    apiMock.runs.mockClear()
    fireEvent.click(screen.getByLabelText('結果で絞り込む'))
    fireEvent.click(within(screen.getByRole('option', { name: '配信予定' })).getByRole('button'))
    await waitFor(() => expect(apiMock.runs).toHaveBeenCalledWith('rem-1', expect.objectContaining({ status: 'planned' })))
  })
})
