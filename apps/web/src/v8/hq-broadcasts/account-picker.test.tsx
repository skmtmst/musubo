// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@line-crm/shared'
import BroadcastAccountPicker, { type BroadcastAccount } from './account-picker'

const folders = [{ id: 'east', name: '東日本', color: '#2f6fde' }, { id: 'west', name: '西日本', color: '#e89b3f' }] as Folder[]
const accounts = [
  { id: 'a', name: '銀座店', folderId: 'east', friendCount: 120, isActive: true, connection: { status: 'ok' } },
  { id: 'b', name: '新宿店', folderId: 'east', friendCount: 30, isActive: true, connection: { status: 'warn' } },
  { id: 'c', name: '梅田店', folderId: 'west', friendCount: null, isActive: false },
  { id: 'd', name: '未分類の店', folderId: null, friendCount: 0, isActive: true },
] as BroadcastAccount[]
const props = { accounts, folders, foldersFailed: false, initialIds: [], onConfirm: vi.fn(), onCancel: vi.fn() }
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('送るアカウントの選択窓', () => {
  it('フォルダ全体の選択と横棒、検索で絞っても隠れた選択を保ち、確定時だけ返す', async () => {
    const confirm = vi.fn()
    render(<BroadcastAccountPicker {...props} onConfirm={confirm} />)
    const dialog = await screen.findByRole('dialog', { name: '送るアカウントを選ぶ' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '銀座店' }))
    expect((within(dialog).getByRole('checkbox', { name: '東日本をまとめて選ぶ' }) as HTMLInputElement).indeterminate).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '東日本をまとめて選ぶ' }))
    expect((screen.getByRole('checkbox', { name: '新宿店' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '梅田' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    expect(screen.queryByRole('checkbox', { name: '銀座店' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '梅田店' }))
    expect(screen.getByText('3 件')).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '選択する（3件）' }))
    expect(confirm).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  it('フォルダの絞り込みと選ぶチェックを別操作にし、未分類と色の丸も出す', async () => {
    render(<BroadcastAccountPicker {...props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: /東日本/ }))
    expect(screen.queryByRole('checkbox', { name: '梅田店' })).toBeNull()
    expect(screen.getByText('除く人は次の手順で決めます')).toBeTruthy()
    expect(screen.queryByText('選んだもの：')).toBeNull()
    expect(within(screen.getByText('銀座店').closest('label')!).getByTitle('フォルダ：東日本')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /未分類/ }))
    expect(screen.getByRole('checkbox', { name: '未分類の店' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '銀座店' })).toBeNull()
  })

  it('接続の要確認と送れない理由を出しても選べ、未取得の人数を0としない', async () => {
    render(<BroadcastAccountPicker {...props} />)
    await screen.findByRole('dialog')
    expect(screen.getByText('・接続を確かめてください')).toBeTruthy()
    expect(screen.getByText('・今は送れません（アカウントを停止中）')).toBeTruthy()
    expect(screen.getByText('—（未取得） 人')).toBeTruthy()
    for (const name of ['新宿店', '梅田店']) {
      const checkbox = screen.getByRole('checkbox', { name }) as HTMLInputElement
      expect(checkbox.disabled).toBe(false)
      fireEvent.click(checkbox)
      expect(checkbox.checked).toBe(true)
    }
  })

  it('取消・Esc・×は確定を呼ばず、開いた時の選択を維持する', async () => {
    const confirm = vi.fn()
    function Host() {
      const [open, setOpen] = React.useState(false)
      return <><button onClick={() => setOpen(true)}>選び直す</button>{open ? <BroadcastAccountPicker {...props} initialIds={['a']} onConfirm={confirm} onCancel={() => setOpen(false)} /> : null}</>
    }
    render(<Host />)
    const trigger = screen.getByRole('button', { name: '選び直す' })
    for (const close of ['キャンセル', 'Escape', '閉じる']) {
      trigger.focus(); fireEvent.click(trigger)
      await screen.findByRole('dialog')
      expect((screen.getByRole('checkbox', { name: '銀座店' }) as HTMLInputElement).checked).toBe(true)
      expect((screen.getByRole('checkbox', { name: '新宿店' }) as HTMLInputElement).checked).toBe(false)
      fireEvent.click(screen.getByRole('checkbox', { name: '新宿店' }))
      if (close === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
      else fireEvent.click(screen.getByRole('button', { name: close }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(trigger)
    }
    expect(confirm).not.toHaveBeenCalled()
  })
})
