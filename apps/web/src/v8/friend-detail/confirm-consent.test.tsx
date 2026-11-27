// @vitest-environment happy-dom
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import Drawer from './delivery-consent'
const net = vi.hoisted(() => ({ save: vi.fn(), reload: vi.fn() }))
vi.mock('@/lib/api/helpers/friend-delivery-consents', () => ({
  friendDeliveryConsentsApi: { save: net.save },
  friendDeliveryConsentHistoryApi: { list: async () => ({ success: true, data: { items: [], total: 0, nextCursor: null } }) },
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const row = (version: number, source: string) => ({ purpose: 'marketing', state: 'revoked', source, reason: '本人の操作', updatedBy: null, updatedAt: '2026-10-12T05:05:00Z', version })
function Host() {
  const [rows, setRows] = useState([row(3, 'liff')])
  return <Drawer open friendId="friend" friendName="確認用の友だち" rows={rows as never} canEdit onClose={() => {}}
    onSaved={async () => { net.reload(); setRows([row(4, 'manual')]) }} />
}
it('本人が止めた宣伝の409は窓を残して再送せず、最新の版と本人の操作を読み直してから明示保存する', async () => {
  net.save.mockRejectedValueOnce(new ApiError(409, 'ほかの人が先に変更しました。')).mockResolvedValue({ success: true, data: [] })
  render(<Host />)
  fireEvent.click((await screen.findAllByRole('button', { name: '変更する' }))[2])
  fireEvent.click(screen.getByRole('radio', { name: '受け取る' }))
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: '来店時に了承を得た' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  const dialog = await screen.findByRole('alertdialog', { name: '本人が止めた宣伝を、受け取るに戻しますか？' })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '受け取るに戻す' })) })
  expect(within(dialog).getByRole('alert').textContent).toContain('本人の受け取り設定と理由を確かめてください')
  expect(net.reload).toHaveBeenCalledTimes(1)
  const retry = within(dialog).getByRole('button', { name: 'もう一度' })
  expect(retry.hasAttribute('disabled')).toBe(true)
  fireEvent.click(retry); expect(net.save).toHaveBeenCalledTimes(1)
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  expect((screen.getByLabelText('理由') as HTMLInputElement).value).toBe('来店時に了承を得た')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
  expect(net.save).toHaveBeenNthCalledWith(2, 'friend', 'marketing', { state: 'granted', reason: '来店時に了承を得た', expectedVersion: 4 })
})

 it('注意の窓を通らない保存の422でも理由を残し、入力を直して一度だけ送り直せる', async () => {
  net.save.mockRejectedValueOnce(new ApiError(422, '理由を確認してください。', undefined, undefined, undefined, undefined, { reason: '了承を得た理由を記入してください。' })).mockResolvedValue({ success: true, data: [] })
  render(<Host />)
  fireEvent.click((await screen.findAllByRole('button', { name: '変更する' }))[0])
  fireEvent.click(screen.getByRole('radio', { name: '受け取る' }))
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: '入力した理由' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.getByText('了承を得た理由を記入してください。')).toBeTruthy()
  expect((screen.getByLabelText('理由') as HTMLInputElement).value).toBe('入力した理由')
  expect(net.save).toHaveBeenCalledTimes(1)
  expect(net.reload).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: '電話で了承を得た' } })
  await act(async () => { const save = screen.getByRole('button', { name: '保存する' }); fireEvent.click(save); fireEvent.click(save) })
  expect(net.save).toHaveBeenCalledTimes(2)
  expect(net.save.mock.calls[1][2]).toMatchObject({ state: 'granted', reason: '電話で了承を得た' })
 })
