// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { WizardBasicStep } from './wizard-basic-step'
import { EMPTY_FORM } from './wizard-model'

const network = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, folders: { ...actual.api.folders, create: network.create } } }
})

function Host({ accountId = 'synthetic-account', canManage = true, folderState = 'ready' }: {
  accountId?: string
  canManage?: boolean
  folderState?: 'loading' | 'ready' | 'error'
}) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [folders, setFolders] = useState<{ id: string; name: string; color?: string | null }[]>([])
  return <WizardBasicStep accountId={accountId} {...{ canManage, folderState, form, folders, setForm, setFolders }}
    patch={part => setForm(current => ({ ...current, ...part }))} loadFolders={async () => {}} goToStep={() => {}} />
}

beforeEach(() => {
  forgetSessionSnapshot()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.theme = 'v8'
  network.create.mockResolvedValue({ success: true, data: { id: 'created-folder', name: '予約の応答' } })
})
afterEach(() => {
  cleanup(); clearToastsForTest()
  forgetStaffIdentity(); forgetSessionSnapshot()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})


async function open() {
  verifiedStaffRole('owner'); render(<><Host /><ToastHost /></>)
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '予約の応答' } })
}
it('フォルダを作ると完了を知らせ、選択する', async () => {
  await open(); await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
  expect(await screen.findByText('自動応答のフォルダを作りました。')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'フォルダ', exact: true }).textContent).toBe('予約の応答')
})
it('作成に失敗したら完了を知らせず入力を残す', async () => {
  network.create.mockResolvedValueOnce({ success: false, error: '作れませんでした' }); await open()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
  expect(screen.queryByText('自動応答のフォルダを作りました。')).toBeNull()
  expect(screen.getByDisplayValue('予約の応答')).toBeTruthy()
})

it('アカウントを切り替えた後の古い結果で通知しない', async () => {
  let resolve!: (v: unknown) => void; network.create.mockImplementationOnce(() => new Promise(done => { resolve = done })); verifiedStaffRole('owner')
  const view = render(<><Host /><ToastHost /></>)
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '予約の応答' } })
  fireEvent.click(screen.getByRole('button', { name: '作って選択する' }))
  view.rerender(<><Host accountId="other" /><ToastHost /></>)
  await act(async () => { resolve({ success: true, data: { id: 'f', name: '予約の応答' } }) })
  expect(screen.queryByText('自動応答のフォルダを作りました。')).toBeNull()
  expect(screen.getByRole('button', { name: 'フォルダ', exact: true }).textContent).toBe('未分類')
})
