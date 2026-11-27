// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FolderPanel from './folder-panel'
import styles from './folder-panel.module.css'

afterEach(cleanup)
const rows = [{ id: 'all', label: 'すべて' }, { id: 'f1', label: '春', onEdit: vi.fn() }, { id: 'none', label: '未分類' }]
const row = (name: string) => screen.getByRole('button', { name }).parentElement!
it('選択中で操作がない行だけ、読み上げない空き場所を用意する', () => {
  const view = render(<FolderPanel rows={rows} activeId="all" onSelect={() => {}} />)
  const slot = row('すべて').querySelector(`.${styles.menuSlot}`)!
  expect(slot).toBeTruthy()
  expect(slot.getAttribute('aria-hidden')).toBe('true')
  expect(row('未分類').querySelector(`.${styles.menuSlot}`)).toBeNull()
  view.rerender(<FolderPanel rows={rows} activeId="f1" onSelect={() => {}} />)
  expect(row('春').querySelector(`.${styles.menuSlot}`)).toBeNull()
  expect(screen.getByRole('button', { name: 'フォルダ「春」の操作' })).toBeTruthy()
})
it('操作メニューを開閉すると行の状態も切り替わる', () => {
  render(<FolderPanel rows={rows} activeId="all" onSelect={() => {}} />)
  const target = row('春')
  expect(target.hasAttribute('data-menu-open')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ「春」の操作' }))
  expect(target.getAttribute('data-menu-open')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ「春」の操作' }))
  expect(target.hasAttribute('data-menu-open')).toBe(false)
})
