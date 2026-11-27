// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ReminderDraftSettings,
  ReminderDraftVersion,
  ReminderPreviewResult,
  ReminderPublishResult,
  ReminderValidationResult,
} from '@line-crm/shared'

const fx = vi.hoisted(() => ({
  foldersList: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: { id: 'acc-1', name: 'テスト公式' }, selectedAccountId: 'acc-1', accounts: [], loading: false }),
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: fx.foldersList },
    },
  }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/reminders/edit',
  useSearchParams: () => new URLSearchParams(),
}))

import { ConfirmStageV8, DoneStageV8 } from './edit-confirm'

const baseFrame = {
  boardId: 'confirm-board',
  title: '確認',
  identity: null,
  steps: null,
  help: null,
}

const baseSettings: ReminderDraftSettings = {
  lineAccountId: 'acc-1',
  name: '予約前リマインド',
  folderId: 'folder-a',
  triggerType: 'reservation',
  deliveryMode: 'time',
  targetCondition: null,
  stopConditions: { onCancel: true, onComplete: true, onBlock: true },
  steps: [
    {
      id: 'step-1',
      offsetDays: -1,
      sendAtTime: '18:00',
      offsetMinutes: 0,
      messageType: 'text',
      messageContent: '明日お待ちしています',
    },
  ],
}

const baseDraft: ReminderDraftVersion = {
  id: 'draft-1',
  version: 1,
  settings: baseSettings,
  lastTestStatus: 'succeeded',
  lastTestedAt: '2026-11-28T01:00:00Z',
  updatedAt: '2026-11-28T01:00:00Z',
}

describe('ConfirmStageV8 / DoneStageV8 フォルダ名リセット・異常件数防御', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.foldersList.mockResolvedValue({ success: true, data: [{ id: 'folder-a', name: '予約前フォルダ' }] })
  })

  afterEach(() => {
    cleanup()
  })

  it('folderId 切替後にフォルダ一覧取得が失敗しても前のフォルダ名を残さない', async () => {
    const view = render(
      <ConfirmStageV8
        frame={baseFrame}
        notice={null}
        reminderId="rem-1"
        draft={baseDraft}
        settings={baseSettings}
        validation={null}
        preview={null}
        recipientView={{ kind: 'ready', recipient: { friendId: 'f-1', displayName: 'テスト太郎', source: 'self' } }}
        onRecipientRecheck={vi.fn()}
        sentName="テスト太郎"
        sentKind="self"
        sendBusy={false}
        onSend={vi.fn()}
        busy={false}
        publishReady={false}
        onPublish={vi.fn()}
        onSaveDraft={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(await screen.findByText('予約前リマインド・予約前フォルダ')).toBeTruthy()

    fx.foldersList.mockRejectedValueOnce(new Error('network'))
    view.rerender(
      <ConfirmStageV8
        frame={baseFrame}
        notice={null}
        reminderId="rem-1"
        draft={baseDraft}
        settings={{ ...baseSettings, folderId: 'folder-b' }}
        validation={null}
        preview={null}
        recipientView={{ kind: 'ready', recipient: { friendId: 'f-1', displayName: 'テスト太郎', source: 'self' } }}
        onRecipientRecheck={vi.fn()}
        sentName="テスト太郎"
        sentKind="self"
        sendBusy={false}
        onSend={vi.fn()}
        busy={false}
        publishReady={false}
        onPublish={vi.fn()}
        onSaveDraft={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.queryByText(/予約前フォルダ/)).toBeNull())
    expect(screen.getByText('予約前リマインド')).toBeTruthy()
  })

  it('対象人数や配信予定件数が負数・NaN のときは異常表記を出さず「対象者を数えた」を未達にする', async () => {
    const badValidation: ReminderValidationResult = {
      ok: false,
      audience: { matched: -5, excluded: 0 },
      checks: [],
    }
    const badPreview: ReminderPreviewResult = {
      items: [],
      summary: { next7Days: Number.NaN, duplicateCount: Number.NaN },
    }
    render(
      <ConfirmStageV8
        frame={baseFrame}
        notice={null}
        reminderId="rem-1"
        draft={baseDraft}
        settings={baseSettings}
        validation={badValidation}
        preview={badPreview}
        recipientView={{ kind: 'ready', recipient: { friendId: 'f-1', displayName: 'テスト太郎', source: 'self' } }}
        onRecipientRecheck={vi.fn()}
        sentName="テスト太郎"
        sentKind="self"
        sendBusy={false}
        onSend={vi.fn()}
        busy={false}
        publishReady={false}
        onPublish={vi.fn()}
        onSaveDraft={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(await screen.findByText('対象者を数えられませんでした')).toBeTruthy()
    expect(screen.queryByText(/-5 人/)).toBeNull()
    expect(screen.queryByText(/— 人/)).toBeNull()
    expect(screen.getByText('今後7日 —通')).toBeTruthy()
  })

  it('DoneStageV8 で preview の件数が NaN のときは有効な published.plannedDeliveries を使う', () => {
    const published: ReminderPublishResult = {
      reminderId: 'rem-1',
      status: 'active',
      plannedDeliveries: 12,
      nextScheduledAt: '2026-11-29T09:00:00Z',
    }
    const badPreview: ReminderPreviewResult = {
      items: [],
      summary: { next7Days: Number.NaN, duplicateCount: 0 },
    }
    render(
      <DoneStageV8
        frame={baseFrame}
        reminderId="rem-1"
        settings={baseSettings}
        published={published}
        preview={badPreview}
      />,
    )
    expect(screen.getByText('12 通')).toBeTruthy()
  })
})
