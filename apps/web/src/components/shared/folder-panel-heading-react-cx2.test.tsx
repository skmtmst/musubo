// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FolderPanel from './folder-panel'
import styles from './folder-panel.module.css'

afterEach(cleanup)
it('見出しは既定の名前と指定した名前を出し、欄の読み上げ名を保つ', () => {
  const rows = [{ id: 'f1', label: '春' }]
  const view = render(<FolderPanel rows={rows} activeId="f1" onSelect={() => {}} />)
  const panel = screen.getByRole('complementary', { name: 'フォルダ' })
  expect(within(panel).getByRole('navigation', { name: 'フォルダ' })).toBeTruthy()
  expect(within(panel).getByText('フォルダ')).toBeTruthy()
  view.rerender(<FolderPanel rows={rows} activeId="f1" onSelect={() => {}} heading="分類" />)
  expect(within(panel).getByRole('navigation', { name: '分類' })).toBeTruthy()
  expect(within(panel).getByText('分類')).toBeTruthy()
})
it('一覧の下に追加操作を置き、押すと渡された処理を呼ぶ', () => {
  const add = vi.fn()
  render(<FolderPanel rows={[{ id: 'f1', label: '春' }]} activeId="f1" onSelect={() => {}} onAddFolder={add} />)
  const item = screen.getByRole('button', { name: '春' })
  const button = screen.getByRole('button', { name: 'フォルダを追加する' })
  expect(button.classList.contains(styles.add)).toBe(true)
  expect(item.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(button)
  expect(add).toHaveBeenCalledTimes(1)
})
