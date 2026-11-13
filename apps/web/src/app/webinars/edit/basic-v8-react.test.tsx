// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Webinar, WebinarEditor } from '@/lib/api'

const mocks = vi.hoisted(() => ({ folders: vi.fn(), update: vi.fn(), saveEditor: vi.fn(), testNotifications: vi.fn(), testNotificationRecipients: vi.fn(), role: 'admin' }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => mocks.role, canManageRole: (role: string) => role === 'admin' || role === 'owner' }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), webinarApi: mocks }))
vi.mock('@/components/shared/select', () => ({ default: ({ value, onChange, options, ...props }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> } & React.ComponentProps<'select'>) => <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }))

import BasicPane from '@/v8/webinar-edit/basic'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'
import { ApiError } from '@/lib/api'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))

const webinar = { id: 'w1', accountId: 'a1', title: '説明会', slug: 'intro', folderId: 'f1', status: 'active', schedule: [{ type: 'daily', time: '20:00' }], durationSeconds: 601, videoPrefix: 'videos/intro' } as Webinar
const editor = { version: 3, deliveryKind: 'on_demand', publicDescription: '最初の案内', viewingCondition: { kind: 'registered', label: '申込者向け' } } as WebinarEditor

let save: (() => Promise<boolean>) | null
const dirty = vi.fn()
const onWebinarSaved = vi.fn()
const onEditorChange = vi.fn()
const register = (handler: (() => Promise<boolean>) | null) => { save = handler }

function draw(nextWebinar = webinar) {
  return <BasicPane ctx={webinarEditContext(nextWebinar, editor, { readOnly: mocks.role === 'staff', onWebinarSaved, onEditorChange })} chrome={webinarWizardChrome} onDirtyChange={dirty} registerSave={register} />
}
async function saveNow() {
  let result = false
  await act(async () => { result = await save!() })
  return result
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'admin'; save = null
  mocks.folders.mockResolvedValue({ success: true, data: [{ id: 'f1', name: 'セミナー', count: 1 }, { id: 'f2', name: '商品説明', count: 2 }] })
  mocks.update.mockImplementation(async (_id, patch) => ({ data: { ...webinar, ...patch } }))
  mocks.saveEditor.mockImplementation(async (_id, patch) => ({ data: { ...editor, ...patch, version: 4 } }))
  mocks.testNotifications.mockResolvedValue({ data: { sent: 2, failed: 0 } })
  mocks.testNotificationRecipients.mockResolvedValue({ data: { count: 1, recipients: [{ id: 'f1', displayName: '確認の人' }], token: 'token', confirmationId: 'confirmation' } })
})
afterEach(cleanup)

describe('V8 基本設定の編集と保存', () => {
  it('取得した基本情報を編集して、動画や公開状態を送らず保存する', async () => {
    render(draw())
    await screen.findByRole('option', { name: '商品説明' })
    fireEvent.change(screen.getByLabelText('名前', { exact: false }), { target: { value: '新しい説明会' } })
    fireEvent.change(screen.getByLabelText('フォルダ'), { target: { value: 'f2' } })
    fireEvent.change(screen.getByLabelText('案内文'), { target: { value: '新しい案内' } })
    expect(await saveNow()).toBe(true)
    expect(mocks.saveEditor).toHaveBeenCalledWith('w1', { expectedVersion: 3, publicDescription: '新しい案内', deliveryKind: 'on_demand' })
    expect(mocks.update).toHaveBeenCalledWith('w1', { title: '新しい説明会', slug: 'intro', folderId: 'f2' })
    expect(dirty).toHaveBeenLastCalledWith(false)
    expect(onEditorChange).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }))
  })

  it('案内文だけ保存できた後の失敗では、入力を残して基本情報だけを再試行する', async () => {
    mocks.update.mockRejectedValueOnce(new Error('network'))
    render(draw())
    fireEvent.change(screen.getByLabelText('名前', { exact: false }), { target: { value: '保存したい題' } })
    fireEvent.change(screen.getByLabelText('案内文'), { target: { value: '保存したい案内' } })
    expect(await saveNow()).toBe(false)
    expect((screen.getByLabelText('名前', { exact: false }) as HTMLInputElement).value).toBe('保存したい題')
    expect(dirty).toHaveBeenLastCalledWith(true)
    expect(await saveNow()).toBe(true)
    expect(mocks.saveEditor).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(dirty).toHaveBeenLastCalledWith(false)
  })

  it('設定の版が競合したら基本情報を上書きせず入力を残す', async () => {
    mocks.saveEditor.mockRejectedValue(new ApiError(409, 'version_conflict'))
    render(draw())
    fireEvent.change(screen.getByLabelText('名前', { exact: false }), { target: { value: '自分の題' } })
    fireEvent.change(screen.getByLabelText('案内文'), { target: { value: '自分の案内' } })
    expect(await saveNow()).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
    expect((screen.getByLabelText('案内文') as HTMLInputElement).value).toBe('自分の案内')
  })

  it('別の段が保存しても、この段の未保存の名前を消さない', () => {
    const view = render(draw())
    fireEvent.change(screen.getByLabelText('名前', { exact: false }), { target: { value: '入力途中' } })
    view.rerender(draw({ ...webinar, title: '別の段の題', durationSeconds: 1200 }))
    expect((screen.getByLabelText('名前', { exact: false }) as HTMLInputElement).value).toBe('入力途中')
    expect(dirty).toHaveBeenLastCalledWith(true)
  })

  it('閲覧のみでは入力・テスト送信と保存を止める', async () => {
    mocks.role = 'staff'
    render(draw())
    expect((screen.getByLabelText('名前', { exact: false }) as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: 'テストを送る' })).toBeNull()
    expect(save).toBeNull()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.saveEditor).not.toHaveBeenCalled()
  })

  it('テスト送信は確認後だけ実行し、未保存の設定を先に保存する', async () => {
    render(draw())
    fireEvent.change(screen.getByLabelText('案内文'), { target: { value: '送信前の案内' } })
    fireEvent.click(screen.getByRole('button', { name: 'テストを送る' }))
    expect(mocks.testNotifications).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    await screen.findByText('テスト受信者 1 人：確認の人')
    fireEvent.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'テストを送る')!)
    await waitFor(() => expect(mocks.testNotifications).toHaveBeenCalledWith('w1', 'token', 'confirmation'))
    expect(mocks.saveEditor.mock.invocationCallOrder[0]).toBeLessThan(mocks.testNotifications.mock.invocationCallOrder[0])
  })
})
