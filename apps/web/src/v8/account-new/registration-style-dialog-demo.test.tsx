// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import RegistrationStyleDialog from './registration-style-dialog'

beforeEach(() => { setTestReducedMotion(true) })
afterEach(cleanup)
it('登録のデモで選ぶと、onChooseへ渡し選択済みボタンへ焦点を移す', async () => {
  const choose = vi.fn()
  function Subject() {
    const [choice, setChoice] = useState<AccountStyle | ''>('')
    return <RegistrationStyleDialog open choice={choice} busy={false} ready error="" onChoose={style => { choose(style); setChoice(style) }} onSave={vi.fn()} onClose={vi.fn()} />
  }
  render(<Subject />)
  fireEvent.click(screen.getByRole('button', { name: '詳しく見る' }))
  const dialog = screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  const action = within(dialog).getByRole('button', { name: 'このスタイルにする' })
  expect(action.closest('[data-dialog-actions]')).toBeTruthy()
  fireEvent.click(action)
  expect(choose).toHaveBeenCalledExactlyOnceWith('restaurant')
  const selected = within(dialog).getByRole('button', { name: '選んでいます' })
  await waitFor(() => expect(document.activeElement).toBe(selected))
  expect(within(dialog).getByText('選んでいるスタイル：飲食店')).toBeTruthy()
})

it('表示したスタイルを次へで保存する', () => {
  const save = vi.fn()
  render(<RegistrationStyleDialog open choice="" busy={false} ready error="" onChoose={vi.fn()} onSave={save} onClose={vi.fn()} />)
  const desktop = within(screen.getByRole('group', { name: '見るスタイル' }))
  expect(screen.getByRole('button', { name: '飲食店で次へ' })).toBeTruthy()
  fireEvent.click(desktop.getByRole('button', { name: 'サロン' }))
  expect(screen.getByRole('heading', { name: 'サロンでできること' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'サロンで次へ' }))
  expect(save).toHaveBeenCalledExactlyOnceWith('salon')
})

it('表示を切り替えると選択表示も同期し、表示中を保存する', () => {
  const save = vi.fn()
  function Subject() {
    const [choice, setChoice] = useState<AccountStyle | ''>('restaurant')
    return <RegistrationStyleDialog open choice={choice} busy={false} ready error="" onChoose={setChoice} onSave={save} onClose={vi.fn()} />
  }
  render(<Subject />)
  fireEvent.click(within(screen.getByRole('group', { name: '見るスタイル' })).getByRole('button', { name: 'サロン' }))
  expect(screen.getByText('選んでいるスタイル：サロン')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /で次へ$/ }))
  expect(save).toHaveBeenCalledExactlyOnceWith('salon')
})

it('保存失敗後も表示中のスタイルで再試行する', () => {
  const save = vi.fn()
  render(<RegistrationStyleDialog open choice="" busy={false} ready error="保存できませんでした" onChoose={vi.fn()} onSave={save} onClose={vi.fn()} />)
  fireEvent.click(within(screen.getByRole('group', { name: '見るスタイル' })).getByRole('button', { name: 'サロン' }))
  fireEvent.click(screen.getByRole('button', { name: 'もう一度保存する' }))
  expect(save).toHaveBeenCalledExactlyOnceWith('salon')
})
