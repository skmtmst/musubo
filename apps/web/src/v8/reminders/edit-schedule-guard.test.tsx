// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReminderDraftSettings } from '@line-crm/shared'
import { ScheduleStageV8 } from './edit-schedule'

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: { id: 'acc-1', name: 'テスト店' } }),
}))

vi.mock('@/components/templates', () => ({
  CreatePage: ({ children, footerActions, preview }: {
    children?: ReactNode
    footerActions?: ReactNode
    preview?: ReactNode
  }) => (
    <div>
      <div>{children}</div>
      <div>{preview}</div>
      <footer>{footerActions}</footer>
    </div>
  ),
}))

vi.mock('./ui', () => ({
  PhoneV8: ({ chip }: { chip: string }) => <div data-testid="phone-chip">{chip}</div>,
  SummaryCardV8: () => <div data-testid="summary-card" />,
  WizardFooterV8: ({
    onCancel,
    onDraft,
    onNext,
  }: {
    onCancel: () => void
    onDraft: () => void
    onNext: () => void
  }) => (
    <div>
      <button type="button" onClick={onCancel}>footer-cancel</button>
      <button type="button" onClick={onDraft}>footer-draft</button>
      <button type="button" onClick={onNext}>footer-next</button>
    </div>
  ),
}))

const FRAME = {
  boardId: 'YChR6',
  title: 'リマインダ',
  identity: null,
  steps: null,
  help: null,
}

const SETTINGS: ReminderDraftSettings = {
  lineAccountId: 'acc-1',
  name: '前日リマインダ',
  folderId: null,
  triggerType: 'booking_date',
  targetCondition: null,
  stopConditions: { onCancel: true, onCompleted: false, tagIds: [] },
  deliveryMode: 'same_time',
  steps: [
    {
      stableStepId: 'step-1',
      timingType: 'before',
      daysOffset: 1,
      sendTime: '10:00',
      messageType: 'text',
      messageContent: '明日お待ちしています',
    },
  ],
}

afterEach(() => {
  cleanup()
})

describe('ScheduleStageV8 の操作ガードと読み直し無しの失敗表示', () => {
  it('処理中はフッターのキャンセル・下書き保存・次へをコールバック側でも止める', () => {
    const onCancel = vi.fn()
    const onSaveDraft = vi.fn()
    const onNext = vi.fn()

    render(
      <ScheduleStageV8
        frame={FRAME}
        notice={null}
        reminderId="rem-1"
        settings={SETTINGS}
        preview={null}
        busy
        onCancel={onCancel}
        onSaveDraft={onSaveDraft}
        onNext={onNext}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'footer-cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'footer-draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'footer-next' }))

    expect(onCancel).not.toHaveBeenCalled()
    expect(onSaveDraft).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
  })

  it('通知が0通のときは次へをコールバック側でも止め、通常時は3つとも実行する', () => {
    const onCancel = vi.fn()
    const onSaveDraft = vi.fn()
    const onNext = vi.fn()

    const { rerender } = render(
      <ScheduleStageV8
        frame={FRAME}
        notice={null}
        reminderId="rem-1"
        settings={{ ...SETTINGS, steps: [] }}
        preview={null}
        busy={false}
        onCancel={onCancel}
        onSaveDraft={onSaveDraft}
        onNext={onNext}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'footer-next' }))
    expect(onNext).not.toHaveBeenCalled()

    rerender(
      <ScheduleStageV8
        frame={FRAME}
        notice={null}
        reminderId="rem-1"
        settings={SETTINGS}
        preview={null}
        busy={false}
        onCancel={onCancel}
        onSaveDraft={onSaveDraft}
        onNext={onNext}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'footer-cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'footer-draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'footer-next' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('読み直し手段が無い失敗時はページ全体再読み込みボタンを出さず、通知の中身への導線を出す', () => {
    render(
      <ScheduleStageV8
        frame={FRAME}
        notice={null}
        reminderId="rem-1/a"
        settings={SETTINGS}
        preview={null}
        previewFailed
        busy={false}
        onCancel={vi.fn()}
        onSaveDraft={vi.fn()}
        onNext={vi.fn()}
      />,
    )

    expect(screen.getByText('配信予定を確認できませんでした')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
    const link = screen.getByRole('link', { name: '通知の中身へ' })
    expect(link.getAttribute('href')).toBe('/reminders/edit?id=rem-1%2Fa')
  })

  it('読み直し手段がある失敗時は処理中の再試行を止め、待機中だけ呼ぶ', () => {
    const onRetryPreview = vi.fn()

    const { rerender } = render(
      <ScheduleStageV8
        frame={FRAME}
        notice={null}
        reminderId="rem-1"
        settings={SETTINGS}
        preview={null}
        previewFailed
        onRetryPreview={onRetryPreview}
        busy
        onCancel={vi.fn()}
        onSaveDraft={vi.fn()}
        onNext={vi.fn()}
      />,
    )

    const busyBtn = screen.getByRole('button', { name: '読み込んでいます' }) as HTMLButtonElement
    expect(busyBtn.disabled).toBe(true)
    busyBtn.removeAttribute('disabled')
    fireEvent.click(busyBtn)
    expect(onRetryPreview).not.toHaveBeenCalled()

    rerender(
      <ScheduleStageV8
        frame={FRAME}
        notice={null}
        reminderId="rem-1"
        settings={SETTINGS}
        preview={null}
        previewFailed
        onRetryPreview={onRetryPreview}
        busy={false}
        onCancel={vi.fn()}
        onSaveDraft={vi.fn()}
        onNext={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(onRetryPreview).toHaveBeenCalledTimes(1)
  })
})
