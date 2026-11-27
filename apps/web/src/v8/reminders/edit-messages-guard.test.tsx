// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReminderDraftSettings, ReminderDraftStep } from '@line-crm/shared'

const fx = vi.hoisted(() => ({
  accountId: 'acc-1' as string | null,
  friendFieldsList: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccount: fx.accountId ? { id: fx.accountId, name: 'テスト公式' } : null,
    selectedAccountId: fx.accountId,
    accounts: [],
    loading: false,
  }),
}))

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friendFields: { ...actual.api.friendFields, list: fx.friendFieldsList },
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/reminders/edit',
  useSearchParams: () => new URLSearchParams(),
}))

import { MessagesStageV8, TimingEditor } from './edit-messages'

function TimingHarness({ initial }: { initial: ReminderDraftStep }) {
  const [step, setStep] = useState<ReminderDraftStep>(initial)
  return (
    <TimingEditor
      step={step}
      mode="time"
      base={new Date('2026-12-01T14:00:00+09:00')}
      onChange={(patch) => setStep((prev) => ({ ...prev, ...patch }))}
    />
  )
}

const baseFrame = {
  boardId: 'messages-board',
  title: '通知の中身',
  identity: null,
  steps: null,
  help: null,
}

const baseSettings: ReminderDraftSettings = {
  lineAccountId: 'acc-1',
  name: '予約前リマインド',
  folderId: null,
  triggerType: 'reservation',
  deliveryMode: 'time',
  targetCondition: null,
  stopConditions: { onCancel: true, onComplete: true, onBlock: true },
  steps: [
    {
      stableStepId: 'step-1',
      offsetDays: -3,
      sendAtTime: '18:00',
      offsetMinutes: 0,
      messageType: 'text',
      messageContent: '予約のお知らせ',
    },
  ],
}

describe('edit-messages 時刻クリア時の日数保持・上限防御・友だち情報異常応答防御', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.accountId = 'acc-1'
    fx.friendFieldsList.mockResolvedValue({ success: true, data: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('TimingEditor で365日超の数値を無視し、時刻欄を空にしても日単位と日数3を失わない', () => {
    const onChange = vi.fn()
    render(
      <TimingEditor
        step={baseSettings.steps[0]!}
        mode="time"
        base={new Date('2026-12-01T14:00:00+09:00')}
        onChange={onChange}
      />,
    )
    const daysInput = screen.getByLabelText('基準日からの数') as HTMLInputElement
    fireEvent.change(daysInput, { target: { value: '400' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(daysInput, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()

    cleanup()
    render(<TimingHarness initial={baseSettings.steps[0]!} />)
    const timeInput = screen.getByLabelText('送る時刻') as HTMLInputElement
    fireEvent.change(timeInput, { target: { value: '' } })
    expect((screen.getByLabelText('基準日からの数') as HTMLInputElement).value).toBe('3')
    expect(screen.getByLabelText('送る時刻')).toBeTruthy()
  })

  it('MessagesStageV8 で友だち情報の応答が配列でない不正形ならクラッシュせず警告を出す', async () => {
    fx.friendFieldsList.mockResolvedValueOnce({ success: true, data: 'invalid-shape' })
    render(
      <MessagesStageV8
        frame={baseFrame}
        notice={null}
        narrow={false}
        settings={baseSettings}
        onChange={vi.fn()}
        busy={false}
        onNext={vi.fn()}
        onSaveDraft={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(await screen.findByText(/友だち情報の差し込み候補を読み込めませんでした/)).toBeTruthy()
    await waitFor(() => expect(fx.friendFieldsList).toHaveBeenCalledWith('acc-1'))
  })
})
