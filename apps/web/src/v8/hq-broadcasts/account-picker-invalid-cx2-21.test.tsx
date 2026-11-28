// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BroadcastAccountPicker, { type BroadcastAccount } from './account-picker'

afterEach(cleanup)
it('不正な友だち人数を確かな人数として表示せず、アカウントは選べる', async () => {
  const confirm = vi.fn()
  const accounts = [{ id: 'a', name: '銀座店', folderId: null, friendCount: -3, isActive: true }] as BroadcastAccount[]
  render(<BroadcastAccountPicker accounts={accounts} folders={[]} foldersFailed={false} initialIds={[]} onConfirm={confirm} onCancel={vi.fn()} />)
  const dialog = await screen.findByRole('dialog', { name: '送るアカウントを選ぶ' })
  expect(within(dialog).getByText('—（未取得） 人')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '銀座店' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' }))
  expect(confirm).toHaveBeenCalledWith(['a'])
})
