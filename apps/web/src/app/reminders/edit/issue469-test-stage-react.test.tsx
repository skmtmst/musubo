// @vitest-environment happy-dom
/*
 * N-070: テスト送信の画面が、送る前に送信先を出し、未設定・届かない・
 * 読み込み失敗・成功を分け、同じ画面からやり直せることを確かめる。
 * 遅い応答が別リマインダの送信先で上書きしないことも固定する。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReminderDraftVersion } from '@line-crm/shared'

const apiMocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  getTestRecipient: vi.fn(),
  testDraft: vi.fn(),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    reminders: { ...actual.api.reminders,
      previewDraft: vi.fn(async () => ({ success: true, data: null })),
      validateDraft: vi.fn(async () => ({ success: true, data: { valid: true, checks: [], audience: { matched: 5, excluded: 1 } } })),
      ...apiMocks,
    },
    folders: { ...actual.api.folders, list: vi.fn(async () => ({ success: true, data: [], unfiledCount: 0 })) },
    friendFields: { ...actual.api.friendFields, list: vi.fn(async () => ({ success: true, data: [] })) },
  } }
})
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/lib/line-accounts-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/line-accounts-cache')>()),
  loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-1', name: '保存済みアカウント' }, { id: 'account-2', name: '未保存アカウント' }] })),
}))


vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))

vi.mock('@/v8/reminders/edit-messages', () => ({
  MessagesStageV8: ({ settings, onChange }: { settings: ReminderDraftVersion['settings']; onChange: (value: ReminderDraftVersion['settings']) => void }) => <button onClick={() => onChange({ ...settings, lineAccountId: 'account-2' })}>未保存の設定を変更</button>,
}))

import ReminderEditV8 from '@/v8/reminders/edit'

const DRAFT: ReminderDraftVersion = {
  reminderId: 'rem-1',
  versionId: 'ver-1',
  versionNumber: 1,
  status: 'draft',
  settings: {
    name: '予約前のお知らせ',
    description: null,
    lineAccountId: 'account-1',
    triggerType: 'booking',
    deliveryMode: 'time',
    triggerFieldId: null,
    triggerEventId: null,
    repeatYearly: false,
    triggerOffsetMinutes: null,
    sendAtTime: null,
    targetTagId: null,
    folderId: null,
    stopConditions: { bookingCancelled: true, supportMarkCompleted: false, daysAfterTarget: null, friendBlocked: true },
    steps: [
      { stableStepId: 'step-1', offsetMinutes: 0, messageType: 'text', messageContent: '本文です', offsetDays: -1, sendAtTime: '18:00', templateId: null },
    ],
  },
  lastTestStatus: null,
  lastTestedAt: null,
  publishedAt: null,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function ok<T>(data: T) {
  return Promise.resolve({ success: true as const, data })
}

async function flush() {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  apiMocks.getDraft.mockReset()
  apiMocks.getTestRecipient.mockReset()
  apiMocks.testDraft.mockReset()
})
afterEach(cleanup)

describe('リマインダ テスト送信段 (N-070)', () => {
  it('未保存の設定より保存済み下書きの送信元を表示する', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    const view = render(<ReminderEditV8 stage="messages" reminderId="rem-1" />)
    await screen.findByRole('button', { name: '未保存の設定を変更' })
    fireEvent.click(screen.getByRole('button', { name: '未保存の設定を変更' }))
    view.rerender(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await waitFor(() => expect((screen.getAllByRole('button', { name: 'テストを送る' })[0] as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    const dialog = screen.getByRole('dialog', { name: 'テスト送信しますか？' })
    await waitFor(() => expect(dialog.textContent).toContain('保存済みアカウント'))
    expect(dialog.textContent).not.toContain('未保存アカウント')
    expect(apiMocks.testDraft).not.toHaveBeenCalled()
  })

  it('テスト送信前に下書きの送信元と環境を示す', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    const dialog = screen.getByRole('dialog', { name: 'テスト送信しますか？' })
    expect(dialog.textContent).toContain('LINEアカウント')
    await waitFor(() => expect(dialog.textContent).toContain('保存済みアカウント'))
    expect(dialog.textContent).toContain('環境')
    expect(apiMocks.testDraft).not.toHaveBeenCalled()
  })

  it('送る前に設定済みの送信先を出す', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()
    expect(screen.getAllByText(/見本 167/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('テスト送信後に表示')).toBeNull()
    expect(apiMocks.getTestRecipient).toHaveBeenCalledWith('rem-1')
  })

  it('本文にある差し込みだけ、テストの値と本番の取得元を送信先で確認できる', async () => {
    apiMocks.getDraft.mockReturnValue(ok({ ...DRAFT, settings: { ...DRAFT.settings, steps: [{ ...DRAFT.settings.steps[0], messageContent: '{{name}} {{field.birthday}} {{meet_datetime}}' }] } }))
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()
    const summary = screen.getByLabelText('送り先').getAttribute('title')!
    expect(summary).toContain('{{name}}：テストで使う値＝見本 167')
    expect(summary).toContain('本番での取得元＝')
    expect(summary).toContain('{{field.birthday}}')
    expect(summary).not.toContain('{{meet_datetime}}')
  })

  it('未設定のとき設定画面への導線を出し、再確認で読み直す', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValueOnce(ok({ state: 'unset', recipient: null }))
    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()
    expect(screen.getAllByText(/未設定/).length).toBeGreaterThanOrEqual(1)
    const link = screen.getByText('アカウント設定').closest('a')
    expect(link?.getAttribute('href')).toBe('/accounts/detail?id=account-1')

    // 設定して戻ってきたあと、同じ画面の「送信先を再確認」で読み直せる。
    apiMocks.getTestRecipient.mockReturnValueOnce(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    fireEvent.click(screen.getByRole('button', { name: '送信先を再確認' }))
    await flush()
    expect(apiMocks.getTestRecipient).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText(/見本 167/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/未設定/)).toBeNull()
  })

  it('読み込み失敗は未設定と区別し、再確認でやり直せる', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValueOnce(Promise.resolve({ success: false, error: 'server error' }))
    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()
    expect(screen.getAllByText(/テスト送信先を読み込めませんでした/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/未設定/)).toBeNull()

    apiMocks.getTestRecipient.mockReturnValueOnce(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    fireEvent.click(screen.getByRole('button', { name: '送信先を再確認' }))
    await flush()
    expect(screen.getAllByText(/見本 167/).length).toBeGreaterThanOrEqual(1)
  })

  it('送信が送信先未設定で失敗したら、その旨と案内を出して同じ画面で再試行できる', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValueOnce(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } })).mockReturnValue(ok({ state: 'unset', recipient: null }))
    apiMocks.testDraft.mockReturnValue(Promise.resolve({
      success: false,
      error: 'テスト送信先を設定してください',
      code: 'TEST_RECIPIENT_NOT_CONFIGURED',
    }))
    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()

    // 確認ダイアログから送信 → 422 未設定
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テスト送信' }))
    await flush()
    expect(screen.getAllByText('テスト送信先を設定してください').length).toBeGreaterThanOrEqual(1)
    // 送信先起因の失敗は送信先の表示も最新へ揃え直す（再読み込みされる）。
    expect(apiMocks.getTestRecipient.mock.calls.length).toBeGreaterThanOrEqual(1)

    expect((screen.getAllByRole('button', { name: 'テストを送る' })[0] as HTMLButtonElement).disabled).toBe(true)
    // 設定後に同じ画面から送信先を再確認して再試行 → 成功。
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    fireEvent.click(screen.getByRole('button', { name: '送信先を再確認' }))
    await flush()
    apiMocks.testDraft.mockReturnValue(ok({ sent: 1, recipientName: '見本 167', replayed: false, requestId: 'r1', testedAt: '2026-09-10T03:00:00.000Z' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テスト送信' }))
    await flush()
    expect(screen.getAllByText(/見本 167/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/前回：.*に送れました/).length).toBeGreaterThanOrEqual(1)
  })

  /*
   * DEEP-09: AのgetDraftが遅れている間にBへ切り替えると、遅れて届いたAの
   * 本文で画面を上書きしてはいけない。表示・宛先・送信APIの対象は常にB。
   */
  it('遅れて届いた別リマインダの本文で画面を上書きせず、送信も今の対象へ行く', async () => {
    const draftB: ReminderDraftVersion = {
      ...DRAFT,
      reminderId: 'rem-2',
      settings: { ...DRAFT.settings, steps: [{ ...DRAFT.settings.steps[0], messageContent: 'Bの実本文' }] },
    }
    const slowA = deferred<{ success: true; data: ReminderDraftVersion }>()
    apiMocks.getDraft.mockImplementation((id: string) => (id === 'rem-1' ? slowA.promise : ok(draftB)))
    apiMocks.getTestRecipient.mockImplementation((id: string) =>
      ok({ state: 'ready', recipient: { id: `f-${id}`, displayName: id === 'rem-1' ? 'Aの送信先' : 'Bの送信先', pictureUrl: null } }),
    )
    apiMocks.testDraft.mockReturnValue(ok({ sent: 1, recipientName: 'Bの送信先', replayed: false, requestId: 'r1', testedAt: '2026-09-10T03:00:00.000Z' }))

    const { rerender } = render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    rerender(<ReminderEditV8 stage="confirm" reminderId="rem-2" />)
    await flush()
    expect(screen.getByText('Bの実本文')).toBeTruthy()
    expect(screen.getAllByText(/Bの送信先/).length).toBeGreaterThanOrEqual(1)

    // 遅れて届いたAの応答は捨てる。本文も送信先もBのまま。
    await act(async () => {
      slowA.resolve({ success: true, data: DRAFT })
      await Promise.resolve()
    })
    expect(screen.queryByText('本文です')).toBeNull()
    expect(screen.queryByText(/Aの送信先/)).toBeNull()
    expect(screen.getByText('Bの実本文')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テスト送信' }))
    await flush()
    expect(apiMocks.testDraft.mock.calls[0][0]).toBe('rem-2')
  })

  it('連続して対象を切り替えても、最後の対象の本文だけを出す', async () => {
    const slowA = deferred<{ success: true; data: ReminderDraftVersion }>()
    const draftB: ReminderDraftVersion = {
      ...DRAFT,
      reminderId: 'rem-2',
      settings: { ...DRAFT.settings, steps: [{ ...DRAFT.settings.steps[0], messageContent: 'Bの実本文' }] },
    }
    const draftC: ReminderDraftVersion = {
      ...DRAFT,
      reminderId: 'rem-3',
      settings: { ...DRAFT.settings, steps: [{ ...DRAFT.settings.steps[0], messageContent: 'Cの実本文' }] },
    }
    apiMocks.getDraft.mockImplementation((id: string) =>
      id === 'rem-1' ? slowA.promise : id === 'rem-2' ? ok(draftB) : ok(draftC),
    )
    apiMocks.getTestRecipient.mockImplementation(() =>
      ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }),
    )

    const { rerender } = render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    rerender(<ReminderEditV8 stage="confirm" reminderId="rem-2" />)
    rerender(<ReminderEditV8 stage="confirm" reminderId="rem-3" />)
    await flush()
    expect(screen.getByText('Cの実本文')).toBeTruthy()
    // Bは応答済みだが、最終対象ではないので表示に残らない。
    expect(screen.queryByText('Bの実本文')).toBeNull()
  })

  /*
   * DEEP-10: 応答喪失（通信例外）の再試行は同じ冪等キーで送る。Worker側の
   * 重複防止とLINEのリトライキーが効くのは同じキーのときだけ。
   * 明示的な「別のテスト」を送るときだけ新しいキーになる。
   */
  it('応答を失った再試行は同じ冪等キーで送り、明示的な別送信だけ新しいキーになる', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    apiMocks.testDraft
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValue({ success: true, data: { sent: 1, recipientName: '見本 167', replayed: true, requestId: null, testedAt: '2026-09-10T03:00:00.000Z' } })

    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()

    // 1回目: 通信例外。窓は開いたまま、エラーは窓の中。
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テスト送信' }))
    await flush()
    expect(apiMocks.testDraft).toHaveBeenCalledTimes(1)

    // 2回目: 同じ窓からの再試行は同じ冪等キー。
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'もう一度送信' }))
    await flush()
    expect(apiMocks.testDraft).toHaveBeenCalledTimes(2)
    expect(apiMocks.testDraft.mock.calls[1][1]).toBe(apiMocks.testDraft.mock.calls[0][1])

    // 成功後に「別のテストをもう一度送る」ときだけ新しいキー。
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テスト送信' }))
    await flush()
    expect(apiMocks.testDraft).toHaveBeenCalledTimes(3)
    expect(apiMocks.testDraft.mock.calls[2][1]).not.toBe(apiMocks.testDraft.mock.calls[0][1])
  })

  /*
   * DEEP-11: 通信例外のエラーは確認窓の中に出す。背面に残さず、
   * 再試行が成功したあとも古い失敗文が残らない。結果表示は常に一つ。
   */
  it('通信例外のエラーは確認窓の中に出し、成功で消す', async () => {
    apiMocks.getDraft.mockReturnValue(ok(DRAFT))
    apiMocks.getTestRecipient.mockReturnValue(ok({ state: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null } }))
    apiMocks.testDraft
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValue({ success: true, data: { sent: 1, recipientName: '見本 167', replayed: false, requestId: 'r1', testedAt: '2026-09-10T03:00:00.000Z' } })

    render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    await flush()
    fireEvent.click(screen.getAllByRole('button', { name: 'テストを送る' })[0])
    await flush()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'テスト送信' }))
    await flush()

    // 窓は開いたまま、エラーは窓の中にあり、背面には出ない。
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/送信結果を確認できませんでした/)).toBeTruthy()
    expect(screen.queryByText('テスト送信に失敗しました。LINE連携と通知内容を確認してください。')).toBeNull()

    // 同じ窓から再試行して成功 → 窓が閉じ、失敗文はどこにも残らない。
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度送信' }))
    await flush()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText(/送信結果を確認できませんでした/)).toBeNull()
    expect(screen.queryByText(/テスト送信に失敗/)).toBeNull()
    expect(screen.getByText(/前回：.*に送れました/)).toBeTruthy()
  })

  it('遅れて届いた別リマインダの送信先で画面を上書きしない', async () => {
    const draftB: ReminderDraftVersion = { ...DRAFT, reminderId: 'rem-2' }
    apiMocks.getDraft.mockImplementation((id: string) => ok(id === 'rem-1' ? DRAFT : draftB))
    const slowA = deferred<{ success: true; data: { state: string; recipient: { id: string; displayName: string; pictureUrl: null } } }>()
    apiMocks.getTestRecipient.mockImplementation((id: string) =>
      id === 'rem-1' ? slowA.promise : ok({ state: 'ready', recipient: { id: 'f9', displayName: '別アカウントの人', pictureUrl: null } }),
    )

    const { rerender } = render(<ReminderEditV8 stage="confirm" reminderId="rem-1" />)
    // rem-1 の応答が来る前に rem-2 へ切り替える。
    rerender(<ReminderEditV8 stage="confirm" reminderId="rem-2" />)
    await flush()
    expect(screen.getAllByText(/別アカウントの人/).length).toBeGreaterThanOrEqual(1)

    // 遅れて届いた rem-1 の応答は捨てる。
    await act(async () => {
      slowA.resolve({ success: true, data: { state: 'ready', recipient: { id: 'f1', displayName: '古い送信先', pictureUrl: null } } })
      await Promise.resolve()
    })
    expect(screen.queryByText(/古い送信先/)).toBeNull()
    expect(screen.getAllByText(/別アカウントの人/).length).toBeGreaterThanOrEqual(1)
  })
})
