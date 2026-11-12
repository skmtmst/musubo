// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import NotificationsPane from '@/test-utils/webinar-notifications'
import ActualNotificationsPane from './notifications'
import BasicPane from './basic'
import ReviewPane from './review'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'
import type { Webinar, WebinarEditor } from '@/lib/api'
const net = vi.hoisted(() => ({ test: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'target', name: '送信元の店' }, { id: 'selected', name: '別の選択中' }] })) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, webinarApi: { ...actual.webinarApi,
    notifications: async () => ({ data: { settings: { version: 1, registrationEnabled: true, dayBeforeEnabled: true, dayBeforeTime: '19:00', hourBeforeEnabled: true,
      hourBeforeMinutes: 15, startEnabled: true, missedEnabled: false, missedTime: '10:00', missedWindowDays: 3, completedEnabled: true },
      overview: { total: 4, sent: 2, failed: 0, skipped: 0 } } }),
    actions: async () => ({ data: [] }), editor: async () => ({ data: { version: 2, notificationTest: null } }), testNotifications: net.test,
    testNotificationRecipients: async () => ({data:{count:1,recipients:[{id:'friend',displayName:'確認の人'}],token:'a'.repeat(64),confirmationId:'00000000-0000-4000-8000-000000000001'}}),
  } }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
it.each(['基本設定','確認'])('%s のテスト送信も確認した宛先を渡す', async pane => {
  net.test.mockResolvedValue({data:{sent:1,failed:0}})
  const editor={version:2,notificationTest:null,deliveryKind:'on_demand',viewingCondition:{label:''},actionPolicy:{missingResultPolicy:'escalate'}} as WebinarEditor
  const ctx=webinarEditContext({id:'webinar',title:'確認用',slug:'test',status:'draft',schedule:[],durationSeconds:3600,accountId:'target'} as Webinar,editor)
  if(pane==='基本設定')render(<BasicPane ctx={ctx} chrome={webinarWizardChrome} onDirtyChange={()=>{}} registerSave={()=>{}} />)
  else render(<ReviewPane ctx={ctx} chromeFor={primary=>({...webinarWizardChrome,footerActions:primary})} />)
  const buttons=await screen.findAllByRole('button',{name:pane==='基本設定'?'テストを送る':'通知のテストを送る',exact:true})
  fireEvent.click(buttons[0])
  const dialog=within(await screen.findByRole('dialog',{name:'通知をテスト送信しますか？'}))
  await dialog.findByText('テスト受信者 1 人：確認の人')
  fireEvent.click(dialog.getByRole('button',{name:'テストを送る',exact:true}))
  await waitFor(()=>expect(net.test).toHaveBeenCalledWith('webinar','a'.repeat(64),'00000000-0000-4000-8000-000000000001'))
})
it('通知のテスト前に、取得できないアカウントと環境を確認できる', async () => {
  render(<NotificationsPane webinarId="webinar" editor={{ version: 2, notificationTest: null } as WebinarEditor} />)
  fireEvent.click(await screen.findByRole('button', { name: 'テストを送る', exact: true }))
  const dialog = within(await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' }))
  expect(dialog.getByText('LINEアカウント')).toBeTruthy()
  expect(dialog.getByText('名前を確認できません')).toBeTruthy()
  expect(dialog.getByText('検証環境')).toBeTruthy()
  expect(net.test).not.toHaveBeenCalled()
})
it('通知の対象は選択中ではなくウェビナーのアカウントから表示する', async () => {
  const editor = { version: 2, notificationTest: null } as WebinarEditor
  const ctx = webinarEditContext({ id: 'webinar', title: '確認用', accountId: 'target' } as Webinar, editor)
  render(<ActualNotificationsPane ctx={ctx} chrome={webinarWizardChrome} onDirtyChange={() => {}} registerSave={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'テストを送る（全部）' }))
  const dialog = within(await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' }))
  expect(await dialog.findByText('送信元の店')).toBeTruthy()
  expect(dialog.queryByText('別の選択中')).toBeNull()
  expect(net.test).not.toHaveBeenCalled()
})
it.each(['成功', '失敗'])('前の%sの文を新しく開いた確認窓の赤い理由へ持ち越さない', async previous => {
  if (previous === '成功') net.test.mockResolvedValue({ data: { sent: 2, failed: 0 } })
  else net.test.mockRejectedValue(new Error('テスト送信できませんでした。'))
  render(<NotificationsPane webinarId="webinar" editor={{ version: 2, notificationTest: null } as WebinarEditor} />)
  fireEvent.click(await screen.findByRole('button', { name: 'テストを送る', exact: true }))
  const first = await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' })
  await within(first).findByText('テスト受信者 1 人：確認の人')
  await act(async () => { fireEvent.click(within(first).getByRole('button', { name: 'テストを送る', exact: true })) })
  expect(net.test).toHaveBeenCalledTimes(1)
  expect(net.test).toHaveBeenCalledWith('webinar', 'a'.repeat(64), '00000000-0000-4000-8000-000000000001')
  if (previous === '失敗') {
    expect(within(first).getByRole('alert')).toBeTruthy()
    fireEvent.click(within(first).getByRole('button', { name: 'キャンセル' }))
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'テストを送る', exact: true }))
  const fresh = await screen.findByRole('dialog', { name: '通知をテスト送信しますか？' })
  expect(within(fresh).queryByText(/テスト送信しました|テスト送信できませんでした/)).toBeNull()
  expect(within(fresh).queryByRole('alert')).toBeNull()
  expect(net.test).toHaveBeenCalledTimes(1)
})
