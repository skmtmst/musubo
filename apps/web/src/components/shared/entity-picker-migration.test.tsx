// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import EntitySelect from './entity-select'
import { EntityPickerField } from './entity-picker'

afterEach(cleanup)

test('選ぶ欄は独立したボタンで開き、空の値も確定できる。キャンセルは値を変えない', () => {
  const change = vi.fn()
  render(<EntitySelect aria-label="担当者" noun="担当者" value="a" onChange={change} options={[{ value: '', label: '指定なし' }, { value: 'a', label: '青木' }, { value: 'b', label: '山田' }]} />)
  const field = screen.getByRole('button', { name: '担当者' })
  expect(field.getAttribute('aria-haspopup')).toBe('dialog')
  expect(field.querySelector('button')).toBeNull()
  fireEvent.click(field)
  let dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: '山田' }))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(field)
  dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: '指定なし' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  expect(change).toHaveBeenCalledWith('')
})

test('札の×は窓を開かずその項目だけ外す。必須の選択は札とまとめて解除の両方で保護する', () => {
  function Host() {
    const [value, setValue] = useState(['a', 'b'])
    return <EntityPickerField multiple label="配信先" noun="アカウント" value={value} onChange={setValue} items={[{ id: 'a', name: '本店', locked: true, folderId: null }, { id: 'b', name: '支店', folderId: null }]} />
  }
  render(<Host />)
  expect(screen.queryByRole('button', { name: '本店を外す' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '支店を外す' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText('支店')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '配信先：変更する' }))
  const dialog = screen.getByRole('dialog')
  expect((within(dialog).getByRole('checkbox', { name: '本店' }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'すべてをまとめて選ぶ' }))
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'すべてをまとめて選ぶ' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' }))
  expect(screen.getByText('本店')).toBeTruthy()
})

test('読み込み失敗中は古い候補を確定できない', () => {
  render(<EntityPickerField defaultOpen label="フォーム" noun="フォーム" value="a" onChange={() => {}} items={[{ id: 'a', name: 'アンケート' }]} state={<p role="alert">読み込めませんでした</p>} />)
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: '選択する' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
})

test('任意の候補を外す操作を残す。外しても選ぶ窓は開かない', () => {
  function Host() {
    const [value, setValue] = useState('tag-a')
    return <EntitySelect clearable kind="tag" aria-label="予約後に付けるタグ" value={value} onChange={setValue} options={[{ value: 'tag-a', label: '来店済み' }]} />
  }
  render(<Host />)
  fireEvent.click(screen.getByRole('button', { name: '予約後に付けるタグを外す' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText('来店済み')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '予約後に付けるタグ' }))
  expect((within(screen.getByRole('dialog')).getByRole('radio', { name: '来店済み' }) as HTMLInputElement).checked).toBe(false)
  expect(within(screen.getByRole('dialog')).getByRole('link', { name: /タグを作る/ }).getAttribute('href')).toBe('/tags/new')
})
