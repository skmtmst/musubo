// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReminderDraftSettings, ReminderDraftVersion, ReminderPreviewResult, ReminderValidationResult } from '@line-crm/shared'

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: { staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) }, reminders: {} } }))
/*
 * R15: TargetStage に共通の条件部品を置いたため、描画にアカウントの
 * 文脈が要る。条件なしの描画では数え直し口を叩かない。
 */
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', selectedAccount: { id: 'account-1', name: 'LINE' }, loading: false }),
}))
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: null, enabled: () => false }),
}))

import { ConfirmStage, DoneStage, PreviewStage, TargetStage, TestStage } from '../../test-utils/reminder-stages'

const SETTINGS: ReminderDraftSettings = {
  name: '予約前のお知らせ',
  description: null,
  lineAccountId: 'account-1',
  triggerType: 'booking',
  deliveryMode: 'time',
  triggerFieldId: null,
  triggerEventId: null,
  repeatYearly: false,
  leapYearPolicy: 'feb28',
  triggerOffsetMinutes: null,
  sendAtTime: null,
  targetTagId: null,
  folderId: null,
  stopConditions: {
    bookingCancelled: true,
    supportMarkCompleted: false,
    daysAfterTarget: 7,
    friendBlocked: true,
  },
  steps: [
    { stableStepId: 'step-1', offsetMinutes: 0, messageType: 'text', messageContent: '{{name}}さん、明日のご相談のご案内です。', offsetDays: -1, sendAtTime: '18:00', templateId: null },
    { stableStepId: 'step-2', offsetMinutes: -60, messageType: 'text', messageContent: 'まもなく開始です。', offsetDays: 0, sendAtTime: '09:00', templateId: null },
    { stableStepId: 'step-3', offsetMinutes: -60, messageType: 'text', messageContent: '直前の確認です。', offsetDays: 0, sendAtTime: '09:00', templateId: null },
  ],
}

const DRAFT: ReminderDraftVersion = {
  reminderId: 'rem-1',
  versionId: 'ver-1',
  versionNumber: 2,
  status: 'draft',
  settings: SETTINGS,
  lastTestStatus: 'succeeded',
  lastTestedAt: '2026-09-10T03:00:00.000Z',
  publishedAt: null,
}

const VALIDATION: ReminderValidationResult = {
  valid: true,
  checks: [{ key: 'audience', label: '対象者', status: 'passed', message: '' }],
  audience: { matched: 3, excluded: 1 },
}

const DAY = 86_400_000
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString()
const DUPLICATE_AT = inDays(2)

const PREVIEW: ReminderPreviewResult = {
  targetDate: inDays(3),
  items: [
    { stableStepId: 'step-1', stepNumber: 1, scheduledAt: inDays(1), label: '-1日 18:00', state: 'scheduled' },
    { stableStepId: 'step-2', stepNumber: 2, scheduledAt: DUPLICATE_AT, label: '当日 09:00', state: 'duplicate' },
    { stableStepId: 'step-3', stepNumber: 3, scheduledAt: DUPLICATE_AT, label: '当日 09:00', state: 'duplicate' },
  ],
  summary: { audience: 42, next7Days: 126, next30Days: 126, duplicateCount: 1 },
}

afterEach(cleanup)

describe('リマインダ公開フローの実データ表示', () => {
  it('PreviewStage はAPIの対象者数を各行へ出し、固定人数を出さない', () => {
    render(<PreviewStage settings={SETTINGS} preview={PREVIEW} onNext={() => {}} />)
    // 各行の対象はAPIの matched を使う（全ステップ同じ対象）。
    expect(screen.getAllByText('対象になる人 全員（42 人）').length).toBe(3)
    expect(screen.queryByText('71人')).toBeNull()
    expect(screen.queryByText('82人')).toBeNull()
    expect(screen.queryByText('2人が重複')).toBeNull()
    // 重複は「人が重複」ではなく同時刻の通知件数として出す。
    expect(screen.getAllByText('重なり→1通にまとめる').length).toBe(2)
  })

  it('PreviewStage の絞り込みボタンは表示行を実際に変える', () => {
    const { container } = render(<PreviewStage settings={SETTINGS} preview={PREVIEW} onNext={() => {}} />)
    const rowCount = () => container.querySelectorAll('[role="table"] [role="row"]').length - 1
    expect(rowCount()).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: '重なりだけ' }))
    expect(rowCount()).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '今後30日' }))
    expect(rowCount()).toBe(3)
  })

  it('PreviewStage は重複が無いとき「無い」と明示し、0件と未取得を混ぜない', () => {
    const clean: ReminderPreviewResult = { ...PREVIEW, items: PREVIEW.items.slice(0, 1), summary: { ...PREVIEW.summary, duplicateCount: 0 } }
    render(<PreviewStage settings={SETTINGS} preview={clean} onNext={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '重なりだけ' }))
    expect(screen.getByText('条件に合う送信予定はありません')).toBeTruthy()
    expect(screen.getByText('重なり 0 件')).toBeTruthy()
  })

  it('PreviewStage は未取得の間は確認中とし、0件と混ぜない', () => {
    render(<PreviewStage settings={SETTINGS} preview={null} onNext={() => {}} />)
    expect(screen.getAllByText('配信予定を確認しています').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('今後7日 —通')).toBeTruthy()
    expect(screen.queryByText('0人')).toBeNull()
  })

  it('ConfirmStage は予定通知数を対象×通数で出し、固定の1,194通を出さない', () => {
    render(<ConfirmStage draft={DRAFT} settings={SETTINGS} validation={VALIDATION} onPublish={() => {}} busy={false} />)
    // matched 3人 × 3通 = 9通。
    expect(screen.getByTitle(/対象者×通知数：9 通/)).toBeTruthy()
    expect(screen.queryByText('1,194通')).toBeNull()
    // 実装の無いSlack通知は約束しない。
    expect(screen.queryByText(/Slack/)).toBeNull()
    // 基準日・停止条件・通知ステップは設定の実値。
    expect(screen.getAllByText('予約日時').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/基準日から7日後に自動終了/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/1日前の18:00/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('前日・1時間前・当日')).toBeNull()
  })

  it('TestStage は本文の実差し込みだけを並べ、実装に無い変数名を出さない', () => {
    render(<TestStage draft={DRAFT} recipientName="見本 143" recipientKind="registered" recipientView={{ kind: 'ready', recipient: { id: 'f1', displayName: '見本 143', pictureUrl: null }, recipientKind: 'registered' }} onRecipientRecheck={() => {}} onConfirm={() => {}} onNext={() => {}} />)
    expect(screen.getByLabelText('送り先').title).toContain('{{name}}')
    expect(screen.getByLabelText('送り先').title).toContain('見本 143')
    expect(screen.getByLabelText('送り先').textContent).toContain('見本 143')
    expect(screen.queryByText(/meet_datetime/)).toBeNull()
    expect(screen.queryByText(/meet_url/)).toBeNull()
    expect(screen.queryByText(/meet\.google\.com/)).toBeNull()
    // フッターは下書きの実テスト記録を見る。
    expect(screen.getByText(/前回：09\/10.*送れました/)).toBeTruthy()
    expect(screen.queryByText(/2026\/09\/06/)).toBeNull()
  })

  it('TestStage は送信前に設定済みの送信先を出す', () => {
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null }, recipientKind: 'registered' }} onRecipientRecheck={() => {}} onConfirm={() => {}} onNext={() => {}} />)
    // 送る前から実際の送信先が見える。「送ったあとに分かる」ではない。
    expect(screen.getByLabelText('送り先').textContent).toContain('見本 167')
    expect(screen.queryByText('テスト送信後に表示')).toBeNull()
  })

  // REMINDER-12: 登録済みテスト宛先は「自分のLINE」と名乗らない。
  it('TestStage は登録済みテスト宛先を自分のLINEと名乗らず、種別と実名を出す', () => {
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'ready', recipient: { id: 'f1', displayName: '見本 167', pictureUrl: null }, recipientKind: 'registered' }} onRecipientRecheck={() => {}} onConfirm={() => {}} onNext={() => {}} />)
    // 要約カード・送信先メトリクス・履歴のどれにも実名つきの種別が出る。
    expect(screen.getByLabelText('送り先').textContent).toContain('登録済みテスト宛先（見本 167）')
    expect(screen.getAllByText(/登録済みのテスト送信先へ/).length).toBeGreaterThanOrEqual(1)
    // 本人以外へ「自分のLINEへ」と案内しない。
    expect(screen.queryByText(/自分のLINE/)).toBeNull()
  })

  it('TestStage は本人対応を確認できたときだけ「自分のLINE」と出す', () => {
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'ready', recipient: { id: 'f2', displayName: '連携済みの本人', pictureUrl: null }, recipientKind: 'self' }} onRecipientRecheck={() => {}} onConfirm={() => {}} onNext={() => {}} />)
    expect(screen.getAllByText(/自分のLINE（連携済みの本人）/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/自分のLINEへ確認用メッセージを送ります/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/登録済みテスト宛先/)).toBeNull()
  })

  it('TestStage は未設定のとき設定画面への導線と再確認を出す', () => {
    const recheck = vi.fn()
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'unset' }} onRecipientRecheck={recheck} onConfirm={() => {}} onNext={() => {}} />)
    expect(screen.getByLabelText('送り先').textContent).toContain('未設定')
    const link = screen.getByText('アカウント設定').closest('a')
    // 下書きのLINEアカウントの設定画面へ直接行ける。
    expect(link?.getAttribute('href')).toBe('/accounts/detail?id=account-1')
    fireEvent.click(screen.getByRole('button', { name: '送信先を再確認' }))
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('TestStage は設定済みでも届かないときは別の案内を出す', () => {
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'unavailable' }} onRecipientRecheck={() => {}} onConfirm={() => {}} onNext={() => {}} />)
    expect(screen.getByLabelText('送り先').textContent).toContain('届けられません')
    expect(screen.getByText(/別の送信先を選び直してください/)).toBeTruthy()
    expect(screen.queryByText(/まだ設定されていません/)).toBeNull()
  })

  it('TestStage は読み込み失敗と未設定を分け、再確認できる', () => {
    const recheck = vi.fn()
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'error' }} onRecipientRecheck={recheck} onConfirm={() => {}} onNext={() => {}} />)
    expect(screen.getByLabelText('送り先').textContent).toContain('読み込めませんでした')
    expect(screen.queryByText('未設定')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '送信先を再確認' }))
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('TestStage は読み込み中に未設定と誤認させない', () => {
    render(<TestStage draft={DRAFT} recipientName={null} recipientView={{ kind: 'loading' }} onRecipientRecheck={() => {}} onConfirm={() => {}} onNext={() => {}} />)
    expect(screen.getAllByText('確認中').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('未設定')).toBeNull()
    expect(screen.queryByText('送信先を再確認')).toBeNull()
  })

  // REMINDER-08: 取得失敗は「確認中」のままにせず、失敗表示と再試行を出す。
  it('TargetStage は事前チェックの失敗を確認中と分け、再試行できる', () => {
    const retry = vi.fn()
    render(<TargetStage reminderId="rem-1" settings={SETTINGS} validation={null} validationFailed onRetryValidation={retry} onChange={() => {}} onNext={() => {}} busy={false} />)
    expect(screen.getByText(/公開前チェックを実行できませんでした/)).toBeTruthy()
    expect(screen.queryByText(/公開前チェックを実行しています/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '数え直す' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('TargetStage は取得中のままでは人数を0と見せない', () => {
    render(<TargetStage reminderId="rem-1" settings={SETTINGS} validation={null} onChange={() => {}} onNext={() => {}} busy={false} />)
    expect(screen.getAllByText('— 人').length).toBe(2)
    expect(screen.getByLabelText(/対象人数：当てはまる —人/)).toBeTruthy()
    expect(screen.queryByText('0 人')).toBeNull()
  })

  it('PreviewStage は取得失敗を「予定なし」と混ぜず、再試行できる', () => {
    const retry = vi.fn()
    render(<PreviewStage settings={SETTINGS} preview={null} previewFailed onRetryPreview={retry} onNext={() => {}} />)
    expect(screen.getAllByText(/配信予定を確認できませんでした/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('配信予定を確認しています')).toBeNull()
    expect(screen.queryByText('送信予定はまだありません')).toBeNull()
    expect(screen.getByText('今後7日 —通')).toBeTruthy()
    // 管理画面 x63W5x：失敗の1枚の副ボタンは「もう一度読み込む」1つ。
    fireEvent.click(screen.getAllByRole('button', { name: 'もう一度読み込む' })[0])
    expect(retry).toHaveBeenCalledTimes(1)
  })

  // REMINDER-09: 通知0件では次へ進ませず、通知編集へ戻す導線を出す。
  it('PreviewStage は通知0件なら予定を取らず編集へ戻す', () => {
    render(<PreviewStage settings={{ ...SETTINGS, steps: [] }} preview={null} editHref="/reminders/edit?id=rem-1" onNext={() => {}} />)
    expect(screen.getByText('送る通知がまだありません')).toBeTruthy()
    const link = screen.getByText('通知の中身へ').closest('a')
    expect(link?.getAttribute('href')).toBe('/reminders/edit?id=rem-1')
    // 通知0件のままテスト送信へは進めない。
    const next = screen.getByRole('button', { name: '次へ：確認' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
  })

  // REMINDER-09: 対象設定の次は通知ステップ。保存後は編集画面へ戻る。
  it('TargetStage の主ボタンは通知ステップへ進む', () => {
    const next = vi.fn()
    render(<TargetStage reminderId="rem-1" settings={SETTINGS} validation={VALIDATION} onChange={() => {}} onNext={next} busy={false} />)
    fireEvent.click(screen.getByRole('button', { name: '次へ：通知の中身' }))
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('ConfirmStage は事前チェックの失敗を成功扱いせず再試行できる', () => {
    const retry = vi.fn()
    render(<ConfirmStage draft={DRAFT} settings={SETTINGS} validation={null} validationFailed onRetryValidation={retry} onPublish={() => {}} busy={false} />)
    expect(screen.getAllByText(/チェックを実行できませんでした/).length).toBeGreaterThanOrEqual(1)
    // 管理画面 x63W5x：失敗の1枚の副ボタンは「もう一度読み込む」1つ。
    fireEvent.click(screen.getAllByRole('button', { name: 'もう一度読み込む' })[0])
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('DoneStage の主ボタンは詳細画面への実リンクで、Slackを約束しない', () => {
    render(<DoneStage draft={DRAFT} published={{ reminderId: 'rem-1', versionId: 'ver-2', versionNumber: 2, publishedAt: '2026-09-10T04:00:00.000Z', audience: 3, plannedDeliveries: 9, nextScheduledAt: inDays(1) }} preview={PREVIEW} validation={VALIDATION} />)
    const link = screen.getByText('詳細を見る').closest('a')
    expect(link?.getAttribute('href')).toBe('/reminders/detail?id=rem-1')
    expect(screen.queryByText(/Slack/)).toBeNull()
    expect(screen.getByText('配信予定を見る').closest('a')?.getAttribute('href')).toBe('/reminders/detail?id=rem-1&tab=schedule&status=planned')
    expect(screen.getByText('126 通')).toBeTruthy()
  })
})
