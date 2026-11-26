// @vitest-environment happy-dom
/* 流入のフォルダ名の窓：日本語の変換を確定する Enter で保存しない（監査 WEB-018 の関連）。 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', () => ({
  api: { entryRouteGenres: apiMock },
  ApiError: class ApiError extends Error { status = 0 },
}))

import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import GenreDialog from './genre-dialog'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.clearAllMocks()
  apiMock.create.mockResolvedValue({ success: true, data: { id: 'g1', name: 'A店' } })
})
afterEach(() => { cleanup(); clearToastsForTest() })

it('フォルダ名の編集中は移動前に確認する', async () => {
  window.history.replaceState(null, '', '/inflow-links')
  render(<><GenreDialog genre={null} onClose={vi.fn()} onSaved={vi.fn()} /><a href="/events">イベントへ</a></>)
  fireEvent.change(screen.getByLabelText('フォルダ名'), { target: { value: '分類' } })
  fireEvent.click(screen.getByRole('link', { name: 'イベントへ' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})

it('変換中の Enter では作らず、変換が終わった Enter で作る', async () => {
  const onSaved = vi.fn()
  render(<GenreDialog genre={null} onClose={vi.fn()} onSaved={onSaved} />)
  const input = screen.getByLabelText('フォルダ名')
  fireEvent.change(input, { target: { value: 'えーてん' } })
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  })
  expect(apiMock.create).not.toHaveBeenCalled()
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(apiMock.create).toHaveBeenCalledWith('えーてん')
})


it.each([false, true])('フォルダの保存成功を知らせる（変更: %s）', async editing => {
  apiMock.update.mockResolvedValueOnce({ success: true, data: { id: 'g1', name: '新しい名前' } })
  render(<><GenreDialog genre={editing ? { id: 'g1', name: '元の名前' } as never : null} onClose={vi.fn()} onSaved={vi.fn()} /><ToastHost /></>)
  fireEvent.change(screen.getByLabelText('フォルダ名'), { target: { value: '新しい名前' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: editing ? '保存する' : 'フォルダを作る' })) })
  expect(await screen.findByText(editing ? 'フォルダ名を変更しました。' : 'フォルダを作りました。')).toBeTruthy()
})

it('フォルダの保存に失敗したら完了を知らせず入力を残す', async () => {
  apiMock.create.mockResolvedValueOnce({ success: false, error: '保存できませんでした' })
  render(<><GenreDialog genre={null} onClose={vi.fn()} onSaved={vi.fn()} /><ToastHost /></>)
  fireEvent.change(screen.getByLabelText('フォルダ名'), { target: { value: '新しい名前' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダを作る' })) })
  expect(screen.queryByText('フォルダを作りました。')).toBeNull()
  expect(screen.getByDisplayValue('新しい名前')).toBeTruthy()
})

it('窓を閉じた後に古い保存結果が返っても知らせない', async () => {
  let resolve!: (value: unknown) => void
  apiMock.create.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const onSaved = vi.fn()
  const view = render(<><GenreDialog genre={null} onClose={vi.fn()} onSaved={onSaved} /><ToastHost /></>)
  fireEvent.change(screen.getByLabelText('フォルダ名'), { target: { value: '見本' } })
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを作る' }))
  view.rerender(<ToastHost />)
  await act(async () => { resolve({ success: true, data: { id: 'g1', name: '見本' } }) })
  expect(screen.queryByText('フォルダを作りました。')).toBeNull()
  expect(onSaved).not.toHaveBeenCalled()
})
