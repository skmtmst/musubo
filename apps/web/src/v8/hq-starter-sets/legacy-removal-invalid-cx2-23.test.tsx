// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StarterSetItem } from '@/lib/api/helpers/styles'
import { LegacyDetails } from './legacy-details'
import { removeLegacyItem } from './legacy-removal'

const form: StarterSetItem = { key: 'form', name: '回答フォーム', kind: 'form' }
const invalidMenu = { key: 'menu', name: '初期メニュー', kind: 'rich_menu', initialMenu: 'future' } as unknown as StarterSetItem
function Screen({ initial, save }: { initial: StarterSetItem[]; save: (items: StarterSetItem[]) => void }) {
  const [items, setItems] = useState(initial)
  const [error, setError] = useState('')
  return <><button onClick={() => setItems([])}>一覧を更新</button><LegacyDetails items={items} busy={false} error={error} canRemove onClose={() => {}}
    onRemove={async (key) => { try { save(removeLegacyItem(items, key)) } catch (caught) { setError((caught as Error).message); throw caught } }} /></>
}
afterEach(cleanup)

it('分からない初期メニューがあるとき、フォームの関連を決めつけて保存しない', async () => {
  const save = vi.fn()
  render(<Screen initial={[invalidMenu, form]} save={save} />)
  fireEvent.click(screen.getAllByRole('button', { name: '初期セットから外す' })[1])
  fireEvent.click(screen.getByRole('button', { name: '外す' }))
  await waitFor(() => expect(screen.getAllByText(/初期セットの内容を確認できません/).length).toBeGreaterThan(0))
  expect(save).not.toHaveBeenCalled()
})

it('確認中に対象が消えたら、古い確認で保存しない', async () => {
  const save = vi.fn()
  render(<Screen initial={[form]} save={save} />)
  fireEvent.click(screen.getByRole('button', { name: '初期セットから外す' }))
  fireEvent.click(screen.getByRole('button', { name: '一覧を更新' }))
  fireEvent.click(screen.getByRole('button', { name: '外す' }))
  await waitFor(() => expect(screen.getAllByText(/初期セットの内容を確認できません/).length).toBeGreaterThan(0))
  expect(save).not.toHaveBeenCalled()
})

it('正しい初期セットの項目はこれまでどおり外して保存できる', async () => {
  const save = vi.fn()
  const other: StarterSetItem = { key: 'other', name: 'お知らせ', kind: 'template' }
  render(<Screen initial={[form, other]} save={save} />)
  fireEvent.click(screen.getAllByRole('button', { name: '初期セットから外す' })[0])
  fireEvent.click(screen.getByRole('button', { name: '外す' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith([other]))
})
