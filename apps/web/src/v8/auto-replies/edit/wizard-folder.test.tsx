// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WizardBasicStep } from './wizard-basic-step'
import { EMPTY_FORM } from './wizard-model'

const network = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, folders: { ...actual.api.folders, create: network.create } } }
})

function Host({ canManage = true, folderState = 'ready' }: {
  canManage?: boolean
  folderState?: 'loading' | 'ready' | 'error'
}) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [folders, setFolders] = useState<{ id: string; name: string; color?: string | null }[]>([])
  return <WizardBasicStep accountId="synthetic-account" {...{ canManage, folderState, form, folders, setForm, setFolders }}
    patch={part => setForm(current => ({ ...current, ...part }))} loadFolders={async () => {}} goToStep={() => {}} />
}

beforeEach(() => {
  forgetSessionSnapshot()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.theme = 'v8'
  network.create.mockResolvedValue({ success: true, data: { id: 'created-folder', name: '予約の応答' } })
})
afterEach(() => {
  cleanup()
  forgetStaffIdentity(); forgetSessionSnapshot()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

it('権限があり一覧取得済みなら同じ所属でフォルダを作り、その場で選択する', async () => {
  verifiedStaffRole('owner')
  render(<Host />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' })) })
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '予約の応答' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選択する' })) })
  expect(network.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'auto_reply', accountId: 'synthetic-account', name: '予約の応答' }))
  expect(screen.getByRole('button', { name: 'フォルダ', exact: true }).textContent).toBe('予約の応答')
})

it('権限がないときはフォルダ作成を出さない', async () => {
  verifiedStaffRole('viewer')
  render(<Host canManage={false} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true })) })
  expect(screen.queryByRole('button', { name: '新しいフォルダを作る' })).toBeNull()
  expect(network.create).not.toHaveBeenCalled()
})

it.each(['loading', 'error'] as const)('一覧が%sの間はフォルダの選択と作成を開始できない', async folderState => {
  verifiedStaffRole('owner')
  render(<Host folderState={folderState} />)
  const select = screen.getByRole('button', { name: 'フォルダ', exact: true }) as HTMLButtonElement
  expect(select.disabled).toBe(true)
  await act(async () => { fireEvent.click(select) })
  expect(screen.queryByRole('button', { name: '新しいフォルダを作る' })).toBeNull()
  expect(network.create).not.toHaveBeenCalled()
})
