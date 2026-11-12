import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 通知と視聴後のこと（）の描画。
 * 差し替えるのは通信だけ。入り切りの段・実績・視聴後の段が実在する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  notifications: vi.fn(),
  saveNotifications: vi.fn(),
  testNotifications: vi.fn(),
  testNotificationRecipients: vi.fn(async () => ({ data: { count: 1, recipients: [{ id: 'f1', displayName: '確認の人' }], token: 'token', confirmationId: 'confirmation' } })),
  actions: vi.fn(),
  editor: vi.fn(),
  saveEditor: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    webinarApi: {
      notifications: apiMocks.notifications,
      saveNotifications: apiMocks.saveNotifications,
      testNotifications: apiMocks.testNotifications,
      testNotificationRecipients: apiMocks.testNotificationRecipients,
      actions: apiMocks.actions,
      editor: apiMocks.editor,
      saveEditor: apiMocks.saveEditor,
    },
  }
})

import NotificationsV8 from '@/test-utils/webinar-notifications'
import { fireEvent } from '@testing-library/react'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
import type { WebinarEditor } from '@/lib/api'

const SETTINGS = {
  version: 1,
  registrationEnabled: true,
  dayBeforeEnabled: true,
  dayBeforeTime: '19:00',
  hourBeforeEnabled: true,
  hourBeforeMinutes: 15,
  startEnabled: true,
  missedEnabled: false,
  missedTime: '10:00',
  missedWindowDays: 3,
  completedEnabled: true,
}

const EDITOR = { version: 2, notificationTest: null } as unknown as WebinarEditor

const roots: Root[] = []
function render(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(
      <NotificationsV8
        webinarId="webinar-1"
        editor={EDITOR}
      />,
    )
  })
  return host
}

  beforeEach(() => {
    Object.values(apiMocks).forEach(mock => mock.mockReset())
    apiMocks.testNotificationRecipients.mockResolvedValue({ data: { count: 1, recipients: [{ id: 'f1', displayName: '確認の人' }], token: 'token', confirmationId: 'confirmation' } })
    apiMocks.notifications.mockResolvedValue({
      data: { settings: SETTINGS, overview: { total: 423, sent: 412, failed: 3, skipped: 8 } },
    })
    apiMocks.editor.mockResolvedValue({ data: EDITOR })
    apiMocks.actions.mockResolvedValue({ data: [] })
    apiMocks.saveNotifications.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({
      data: { settings: { ...SETTINGS, ...input }, queued: 0, cancelled: 0 },
    }))
  })

  afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

describe('通知と視聴後のことのV8（E7iAYs）', () => {
  it('板IDと通知の段・実績・視聴後の段を描く', async () => {
    const host = render()
    await act(async () => undefined)
    expect(host.querySelector('[data-design-node="E7iAYs"]')).not.toBeNull()
    for (const label of ['通知とリマインド', '視聴後にすること', '申込のお礼']) {
      expect(host.textContent).toContain(label)
    }
    expect(host.textContent).toContain('412')
    expect(host.textContent).toContain('申込のお礼')
    expect(host.textContent).toContain('見終わった人へのお礼')
  })

  it('入り切りの入力を残し、下書き保存したときだけ保存する', async () => {
    const host = render()
    await act(async () => undefined)
    const toggle = host.querySelector('[role="switch"][aria-label="申込のお礼"]')
    expect(toggle).not.toBeNull()
    await act(async () => {
      fireEvent.click(toggle!)
    })
    expect(apiMocks.saveNotifications).not.toHaveBeenCalled()
    await act(async () => { ([...host.querySelectorAll('button')].find((el) => el.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!.click() })
    expect(apiMocks.saveNotifications).toHaveBeenCalledTimes(1)
    const input = apiMocks.saveNotifications.mock.calls[0][1] as { registrationEnabled: boolean }
    expect(input.registrationEnabled).toBe(false)
  })
  it('下書き保存に失敗してもスイッチの入力を残して再試行できる', async () => {
    apiMocks.saveNotifications.mockRejectedValueOnce(new Error('network'))
    const host = render()
    await act(async () => undefined)
    const toggle = host.querySelector('[role="switch"][aria-label="申込のお礼"]') as HTMLInputElement
    await act(async () => { fireEvent.click(toggle) })
    const save = ([...host.querySelectorAll('button')].find((el) => el.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
    await act(async () => { querySupplementaryPageAction('下書きを保存')!.click() })
    expect(host.textContent).toContain('入力を残しました')
    expect((toggle.getAttribute('aria-checked') === 'true')).toBe(false)
    expect(apiMocks.saveNotifications).toHaveBeenCalledTimes(1)
    await act(async () => { querySupplementaryPageAction('下書きを保存')!.click() })
    expect(apiMocks.saveNotifications).toHaveBeenCalledTimes(2)
    expect(apiMocks.saveNotifications.mock.calls[1][1].registrationEnabled).toBe(false)
  })

})

it('送信済みの結果は後続GETの失敗で消さず、再試行はGETだけにする', async () => {
  apiMocks.testNotifications.mockResolvedValue({ data: { sent: 2, failed: 0 } })
  apiMocks.editor.mockRejectedValueOnce(new Error('reload'))
  const host = render()
  await act(async () => undefined)
  const trigger = ([...host.querySelectorAll('button')].find(el => el.textContent?.trim() === 'テストを送る') ?? querySupplementaryPageAction('テストを送る'))!
  await act(async () => { trigger.click() })
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('確認の人')
  const confirm = ([...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'テストを送る') ?? querySupplementaryPageAction('テストを送る'))!
  await act(async () => { confirm.click(); confirm.click() })
  expect(apiMocks.testNotifications).toHaveBeenCalledTimes(1)
  expect(apiMocks.testNotifications).toHaveBeenCalledWith('webinar-1', 'token', 'confirmation')
  expect(host.textContent).toContain('テスト送信しました。成功 2 件・失敗 0 件')
  expect(host.textContent).not.toContain('テスト送信できませんでした')
  expect(trigger.disabled).toBe(true)
  for (const button of [...host.querySelectorAll('button')].filter(el => el.textContent?.includes('テストを送る'))) {
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('送信済みの結果を読み直してください')
  }
  const retry = ([...host.querySelectorAll('button')].find(el => el.textContent?.trim() === '送信結果を読み直す') ?? querySupplementaryPageAction('送信結果を読み直す'))!
  await act(async () => { retry.click() })
  expect(apiMocks.editor).toHaveBeenCalledTimes(2)
  expect(apiMocks.testNotifications).toHaveBeenCalledTimes(1)
  expect(host.textContent).not.toContain('確認状態を読み込めませんでした')
})

it('通知保存後に版の読込が失敗しても、再開時は保存を繰り返さず最新版を取得する', async () => {
  apiMocks.saveEditor.mockResolvedValueOnce({ data: { ...EDITOR, version: 10 } })
  apiMocks.editor.mockRejectedValueOnce(new Error('reload')).mockResolvedValueOnce({ data: { ...EDITOR, version: 9 } })
  const host = render()
  await act(async () => undefined)
  await act(async () => { fireEvent.click(host.querySelector('[role="switch"][aria-label="申込のお礼"]')!) })
  await act(async () => { fireEvent.change(host.querySelector('input[aria-label="視聴完了メッセージ本文"]')!, { target: { value: '再開後も残す本文' } }) })
  const save = ([...host.querySelectorAll('button')].find(el => el.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
  await act(async () => { querySupplementaryPageAction('下書きを保存')!.click() })
  expect(apiMocks.saveNotifications).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('入力を残しました')
  expect(apiMocks.saveEditor).not.toHaveBeenCalled()
  await act(async () => { querySupplementaryPageAction('下書きを保存')!.click() })
  expect(apiMocks.saveNotifications).toHaveBeenCalledTimes(1)
  expect(apiMocks.editor).toHaveBeenCalledTimes(2)
  expect(apiMocks.saveEditor).toHaveBeenCalledExactlyOnceWith('webinar-1', { expectedVersion: 9, actionTemplateBody: '再開後も残す本文', missingResultPolicy: 'escalate' })
})
