// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Webinar, WebinarEditor } from '@/lib/api'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'

const mocks = vi.hoisted(() => ({
  folders: vi.fn(),
  saveEditor: vi.fn(),
  update: vi.fn(),
  testNotifications: vi.fn(),
  testNotificationRecipients: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [{ id: 'acc-1', name: '本店' }] }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-1', name: '本店' }] })) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    webinarApi: {
      ...actual.webinarApi,
      folders: mocks.folders,
      saveEditor: mocks.saveEditor,
      update: mocks.update,
      testNotifications: mocks.testNotifications,
      testNotificationRecipients: mocks.testNotificationRecipients,
    },
  }
})

import BasicPane from './basic'

const baseWebinar = {
  id: 'webinar-1',
  title: '導入ウェビナー',
  slug: 'intro-webinar',
  status: 'draft',
  schedule: [],
  durationSeconds: 3600,
  accountId: 'acc-1',
  folderId: null,
} as unknown as Webinar

const baseEditor = {
  version: 2,
  publicDescription: '説明文',
  deliveryKind: 'on_demand',
  viewingCondition: { label: '申込者向け' },
  notificationTest: null,
  actionPolicy: { missingResultPolicy: 'escalate' },
} as unknown as WebinarEditor

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.folders.mockResolvedValue({ success: true, data: [] })
  mocks.testNotificationRecipients.mockResolvedValue({
    success: true,
    data: {
      count: 1,
      recipients: [{ id: 'f-1', displayName: '確認 太郎' }],
      token: 'a'.repeat(64),
      confirmationId: '00000000-0000-4000-8000-000000000001',
    },
  })
})

afterEach(() => {
  cleanup()
})

describe('BasicPane の保存応答検証・テスト送信の連打防止と理由表示', () => {
  it('saveEditor が success:false を返したときは失敗扱いにして保存完了にしない', async () => {
    mocks.saveEditor.mockResolvedValueOnce({ success: false, error: 'conflict' })
    const onEditorChange = vi.fn()
    const ctx = webinarEditContext(baseWebinar, baseEditor, { onEditorChange })
    let triggerSave: (() => Promise<boolean>) | null = null

    render(
      <BasicPane
        ctx={ctx}
        chrome={webinarWizardChrome}
        onDirtyChange={vi.fn()}
        registerSave={(fn) => { triggerSave = fn }}
      />,
    )

    fireEvent.change(screen.getByDisplayValue('説明文'), { target: { value: '新しい説明' } })

    let ok = true
    await act(async () => {
      ok = await triggerSave!()
    })

    expect(ok).toBe(false)
    expect(onEditorChange).not.toHaveBeenCalled()
    expect(screen.getByText(/保存できませんでした/)).not.toBeNull()
  })

  it('テスト送信を連打しても1回しか送らず、success:false はエラーを出して確認窓を閉じない', async () => {
    const req = deferred<{ success: boolean }>()
    mocks.testNotifications.mockReturnValueOnce(req.promise)
    const ctx = webinarEditContext(baseWebinar, baseEditor)

    render(
      <BasicPane
        ctx={ctx}
        chrome={webinarWizardChrome}
        onDirtyChange={vi.fn()}
        registerSave={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'テストを送る' }))
    const dialog = await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' })
    await within(dialog).findByText('テスト受信者 1 人：確認 太郎')

    const sendButton = within(dialog).getByRole('button', { name: 'テストを送る' })
    fireEvent.click(sendButton)
    fireEvent.click(sendButton)
    expect(mocks.testNotifications).toHaveBeenCalledTimes(1)

    await act(async () => {
      req.resolve({ success: false })
      await req.promise
    })

    expect(screen.getByRole('dialog', { name: '通知をテスト送信しますか？' })).not.toBeNull()
    expect(within(dialog).getByText(/保存できませんでした/)).not.toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '通知をテスト送信しますか？' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'テストを送る' }))
    const reopened = await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' })
    expect(within(reopened).queryByText(/保存できませんでした/)).toBeNull()
  })

  it('テスト受信者が0人のときは確認ボタンを止めて理由を表示する', async () => {
    mocks.testNotificationRecipients.mockResolvedValueOnce({
      success: true,
      data: { count: 0, recipients: [], token: 'a'.repeat(64), confirmationId: '00000000-0000-4000-8000-000000000001' },
    })
    const ctx = webinarEditContext(baseWebinar, baseEditor)

    render(
      <BasicPane
        ctx={ctx}
        chrome={webinarWizardChrome}
        onDirtyChange={vi.fn()}
        registerSave={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'テストを送る' }))
    const dialog = await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' })
    await within(dialog).findByText('テスト受信者が登録されていません。設定から追加してください。')
    expect((within(dialog).getByRole('button', { name: 'テストを送る' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
