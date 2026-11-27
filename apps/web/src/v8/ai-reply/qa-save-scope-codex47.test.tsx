// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), toast: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/components/shared/toast', async original => ({ ...await original<typeof import('@/components/shared/toast')>(), notifyToast: mocks.toast }))
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, aiReplyApi: { ...actual.aiReplyApi, createQa: mocks.create, updateQa: mocks.update } }
})
import QaEditDialog from './qa-edit-dialog'

beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/auto-replies?tab=qa') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function fill() {
  fireEvent.change(screen.getByRole('textbox', { name: /質問/ }), { target: { value: '見本の質問' } })
  fireEvent.change(screen.getByRole('textbox', { name: /答え/ }), { target: { value: '見本の答え' } })
}

it('保存を同時に2回押しても下書きは1回だけ作る', () => {
  mocks.create.mockReturnValue(new Promise(() => {}))
  render(<QaEditDialog open accountId="a" seed={null} canPublish onSaved={vi.fn()} onClose={vi.fn()} />)
  fill()
  const button = screen.getByRole('button', { name: '下書きで保存する' }) as HTMLButtonElement
  act(() => { button.click(); button.click() })
  expect(mocks.create).toHaveBeenCalledTimes(1)
})

it('保存中にアカウントが変わったら古い結果で新しい画面を閉じない', async () => {
  let resolve!: (value: unknown) => void
  mocks.create.mockReturnValue(new Promise(done => { resolve = done }))
  const onSaved = vi.fn()
  const { rerender } = render(<QaEditDialog open accountId="a" seed={null} canPublish onSaved={onSaved} onClose={vi.fn()} />)
  fill(); fireEvent.click(screen.getByRole('button', { name: '下書きで保存する' }))
  rerender(<QaEditDialog open accountId="b" seed={null} canPublish onSaved={onSaved} onClose={vi.fn()} />)
  await act(async () => resolve({ success: true, data: { id: 'sample' } }))
  expect(onSaved).not.toHaveBeenCalled()
  expect(mocks.toast).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Q&A を追加する' })).toBeTruthy()
})

it('切替前の保存失敗を新しいアカウントに表示しない', async () => {
  let reject!: (error: Error) => void
  mocks.create.mockReturnValue(new Promise((_done, fail) => { reject = fail }))
  const { rerender } = render(<QaEditDialog open accountId="a" seed={null} canPublish onSaved={vi.fn()} onClose={vi.fn()} />)
  fill(); fireEvent.click(screen.getByRole('button', { name: '下書きで保存する' }))
  rerender(<QaEditDialog open accountId="b" seed={null} canPublish onSaved={vi.fn()} onClose={vi.fn()} />)
  await act(async () => reject(new Error('見本の通信失敗')))
  expect(screen.queryByText(/見本の通信失敗/)).toBeNull()
  expect(screen.getByRole('textbox', { name: /質問/ })).toHaveProperty('value', '')
  expect(screen.getByRole('button', { name: '下書きで保存する' })).toBeTruthy()
})

it('新しいアカウントの保存中に古い応答が来ても、処理中を保つ', async () => {
  let finishOld!: (value: unknown) => void
  let finishNew!: (value: unknown) => void
  mocks.create.mockReturnValueOnce(new Promise(done => { finishOld = done }))
    .mockReturnValueOnce(new Promise(done => { finishNew = done }))
  const onSaved = vi.fn()
  const { rerender } = render(<QaEditDialog open accountId="a" seed={null} canPublish onSaved={onSaved} onClose={vi.fn()} />)
  fill(); fireEvent.click(screen.getByRole('button', { name: '下書きで保存する' }))
  rerender(<QaEditDialog open accountId="b" seed={null} canPublish onSaved={onSaved} onClose={vi.fn()} />)
  fill(); fireEvent.click(screen.getByRole('button', { name: '下書きで保存する' }))
  await act(async () => finishOld({ success: true, data: { id: 'old' } }))
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /処理中/ })).toHaveProperty('disabled', true)
  await act(async () => finishNew({ success: true, data: { id: 'new' } }))
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(onSaved).toHaveBeenCalledWith({ id: 'new' })
})
