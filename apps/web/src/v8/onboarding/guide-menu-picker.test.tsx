// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GuideMenuPicker } from './guide-menu-picker'

afterEach(cleanup)
it('６枚目から空のメニューを作り、下の操作には置かない', () => {
  const onCreate = vi.fn()
  render(<GuideMenuPicker accountId="a" version={1} step={2} total={8} onCreate={onCreate} onLater={vi.fn()} onSaved={vi.fn()} onReload={vi.fn()} />)
  const group = screen.getByRole('group', { name: 'リッチメニューの型' })
  const cards = within(group).getAllByRole('article')
  expect(cards).toHaveLength(6)
  expect(cards[5].getAttribute('aria-label')).toBe('0から自分で作る')
  fireEvent.click(within(cards[5]).getByRole('button', { name: '自分で作る' }))
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'あとで' }).closest('[data-dialog-actions]')?.textContent).not.toContain('0から自分で作る')
})

it.each(['close', 'escape', 'later'])('%s は同じあとでの操作を呼ぶ', (method) => {
  const onLater = vi.fn()
  render(<GuideMenuPicker accountId="a" version={1} step={2} total={8} onCreate={vi.fn()} onLater={onLater} onSaved={vi.fn()} onReload={vi.fn()} />)
  if (method === 'close') fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  else if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: 'あとで' }))
  expect(onLater).toHaveBeenCalledOnce()
})
