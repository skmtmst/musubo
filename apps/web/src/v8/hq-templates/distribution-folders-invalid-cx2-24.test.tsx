// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Folder } from '@line-crm/shared'
import { distributionFolderRows, DistributionFolderPanel } from './distribution-accounts'

const folder = { id: 'direct', name: '直営店', color: '#2563eb', displayOrder: 0 } as Folder
const accounts = [{ id: 'a' }, { id: 'b' }]
afterEach(cleanup)
const show = (membership: Map<string, { folderId: string | null; folder: Folder | null }>) => {
  const onChange = vi.fn()
  const rows = distributionFolderRows({ accounts, folders: [folder], membership, selected: [], onChange })
  render(<DistributionFolderPanel rows={rows} activeId="all" onSelect={vi.fn()} failed={false} />)
  return { rows, onChange }
}

it('所属の一部が届かない場合、フォルダを部分的にまとめて選ばない', () => {
  const { rows, onChange } = show(new Map([['a', { folderId: 'direct', folder }]]))
  expect(screen.getByText(/一部のアカウントの所属を確認できません/)).toBeTruthy()
  expect(rows.find(row => row.id === 'direct')?.count).toBeNull()
  const group = screen.getByRole('checkbox', { name: '直営店をまとめて選ぶ' }) as HTMLInputElement
  expect(group.disabled).toBe(true)
  fireEvent.click(group)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'すべてをまとめて選ぶ' }))
  expect(onChange).toHaveBeenCalledWith(['a', 'b'])
})

it('存在しないフォルダへの所属は0件と決めつけず、選択を止める', () => {
  const { rows, onChange } = show(new Map([['a', { folderId: 'direct', folder }], ['b', { folderId: 'missing', folder: null }]]))
  expect(screen.getByText(/一部のアカウントの所属を確認できません/)).toBeTruthy()
  expect(rows.find(row => row.id === 'none')?.count).toBeNull()
  const group = screen.getByRole('checkbox', { name: '未分類をまとめて選ぶ' }) as HTMLInputElement
  expect(group.disabled).toBe(true)
  fireEvent.click(group)
  expect(onChange).not.toHaveBeenCalled()
  expect(within(screen.getByRole('button', { name: /未分類/ })).queryByText('0')).toBeNull()
})

it('未所属が null で届く通常のアカウントは未分類からまとめて選べる', () => {
  const { rows, onChange } = show(new Map([['a', { folderId: 'direct', folder }], ['b', { folderId: null, folder: null }]]))
  expect(rows.find(row => row.id === 'none')?.count).toBe(1)
  expect(screen.queryByText(/一部のアカウントの所属を確認できません/)).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: '未分類をまとめて選ぶ' }))
  expect(onChange).toHaveBeenCalledWith(['b'])
})
