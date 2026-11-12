// @vitest-environment happy-dom
/*
 * 詳細条件の「条件を保存する」は、ブラウザ1台だけの保存ではなく API へ保存する。
 * 保存した条件は別の端末・別の担当者の友だち一覧からも呼び出せる。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const net = vi.hoisted(() => ({ create: vi.fn(async () => ({ success: true as const, data: { id: 'view-1' } })) }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: { ...actual.api.friends, list: () => Promise.resolve({ success: true as const, data: { items: [], total: 0 } }) },
      friendSavedViews: {
        ...actual.api.friendSavedViews,
        list: () => Promise.resolve({ success: true as const, data: [] }),
        create: net.create,
      },
    },
  }
})

import AdvancedSearchDialog from './advanced-search-dialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('条件を保存すると今のアカウントの保存の口へ送り、ブラウザには書かない', async () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem')
  render(<AdvancedSearchDialog open accountId="acc" tags={[]} fieldNames={[]} marks={[]} scenarios={[]} onClose={() => {}} onApply={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '条件を保存する' }))
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2))
  const nested = screen.getAllByRole('dialog').at(-1)!
  fireEvent.change(within(nested).getByPlaceholderText('例：VIPかつ未契約'), { target: { value: 'VIPかつ未契約' } })
  await act(async () => { fireEvent.click(within(nested).getByRole('button', { name: '保存する' })) })
  expect(net.create).toHaveBeenCalledWith('acc', expect.objectContaining({ name: 'VIPかつ未契約', isShared: false, conditions: expect.any(Object) }))
  expect(await screen.findByText('条件を保存しました')).toBeTruthy()
  expect(setItem.mock.calls.some(([key]) => String(key).startsWith('friends.savedSearch'))).toBe(false)
})

it('保存する条件の名前を入力した後に画面を離れると、入力を残して確認する', async () => {
  window.history.replaceState(null, '', '/friends')
  render(<><AdvancedSearchDialog open accountId="acc" tags={[]} fieldNames={[]} marks={[]} scenarios={[]} onClose={() => {}} onApply={() => {}} /><a href="/events">イベントへ</a></>)
  fireEvent.click(await screen.findByRole('button', { name: '条件を保存する' }))
  const name = screen.getByPlaceholderText('例：VIPかつ未契約') as HTMLInputElement
  fireEvent.change(name, { target: { value: '作りかけ' } })
  fireEvent.click(screen.getByRole('link', { name: 'イベントへ', hidden: true }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(name.value).toBe('作りかけ')
})

it('保存名を入力して内窓を閉じても、外側から離れる前に確認する', async () => {
  const close = vi.fn()
  render(<AdvancedSearchDialog open accountId="acc" tags={[]} fieldNames={[]} marks={[]} scenarios={[]} onClose={close} onApply={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '条件を保存する' }))
  const nested = screen.getAllByRole('dialog').at(-1)!
  fireEvent.change(within(nested).getByPlaceholderText('例：VIPかつ未契約'), { target: { value: '作りかけ' } })
  fireEvent.click(within(nested).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(close).not.toHaveBeenCalled()
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(close).toHaveBeenCalledOnce()
})
it('入力した検索条件を閉じる前に確認し、編集を続けられる', async () => {
  const close = vi.fn()
  render(<AdvancedSearchDialog open accountId="acc" tags={[]} fieldNames={[]} marks={[]} scenarios={[]} onClose={close} onApply={() => {}} initialSort="recent" initialLimit={20} />)
  fireEvent.change(screen.getByLabelText('名前のキーワード'), { target: { value: '架空の名前' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(close).not.toHaveBeenCalled()
  const dialog = await screen.findByRole('dialog', { name: '保存していない変更があります' })
  expect(within(dialog).getByText(/検索条件への変更/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '編集を続ける' }))
  expect((screen.getByLabelText('名前のキーワード') as HTMLInputElement).value).toBe('架空の名前')
})
