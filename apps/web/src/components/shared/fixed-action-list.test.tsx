// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import FixedActionList from './fixed-action-list'
afterEach(cleanup)
it('種類を選び対象を確定してから固定の保存口へ。取消は行を足さない', () => {
  const select = vi.fn()
  function Example() {
    const [enabled, setEnabled] = useState(false)
    return <FixedActionList options={[{ id: 'tag', label: 'タグを付ける', enabled, onEnabledChange: setEnabled, onSelect: select,
      picker: { title: 'タグを選ぶ', items: [{ id: 'tag-1', name: '紹介者' }] } }]} />
  }
  const { container } = render(<Example />)
  const open = () => { fireEvent.click(screen.getByRole('button', { name: '行うことを足す' })); fireEvent.click(screen.getByRole('menuitem', { name: 'タグを付ける' })) }
  open()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  expect(container.querySelectorAll('[data-action-row]')).toHaveLength(0)
  expect(select).not.toHaveBeenCalled()
  open()
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: /紹介者/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  expect(select).toHaveBeenCalledWith('tag-1')
  expect(container.querySelectorAll('[data-action-row]')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /並べ替える/ })).toBeNull()
  expect(screen.queryByRole('button', { name: '行うことを足す' })).toBeNull()
})
it('固定の初期値は残し、確認して外した項目だけオフにする', () => {
  const saved = vi.fn()
  function Example() {
    const [on, setOn] = useState(true)
    return <FixedActionList options={[{ id: 'notify', label: '本人に知らせる', enabled: on, onEnabledChange: next => { setOn(next); saved(next) } }]} />
  }
  render(<Example />)
  expect(screen.getByRole('button', { name: '本人に知らせる' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /1つ目の行うこと.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(saved).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '削除する' }))
  expect(saved).toHaveBeenCalledWith(false)
})
it('固定チェックと押せない成果地点に戻すと見張りで止める', () => {
  const offer = readFileSync('src/v8/affiliate-offer-new/create.tsx', 'utf8')
  const affiliate = readFileSync('src/v8/affiliates/create.tsx', 'utf8')
  for (const source of [offer, affiliate]) expect(source).toContain('<FixedActionList')
  expect(offer).not.toMatch(/<Checkbox[^>]*checked=\{(?:tagEnabled|scenarioEnabled)\}/)
  expect(affiliate).not.toMatch(/<Checkbox[^>]*checked=\{(?:notifyOnConversion|startTracking)\}/)
  expect(offer).not.toContain('まだ選べません')
  expect(offer).toContain('href="/conversions"')
})
