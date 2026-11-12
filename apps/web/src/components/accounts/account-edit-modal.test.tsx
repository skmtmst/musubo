// @vitest-environment happy-dom
/*
 * 登録内容・資格情報の編集窓（統括のホームから開く）。
 * 保存してある秘密値は読まず、差し替えの欄は空で始まり、名前だけ変えたら名前だけ送る。
 * 狭い画面でも窓が上から始まり、窓の中を縦に送れて、見出しが残ること。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const update = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, lineAccounts: { ...actual.api.lineAccounts, update } } }
})

import AccountEditModal from './account-edit-modal'

const props = {
  accountId: 'acc-1',
  initialName: '然 本店',
  initialChannelId: '2007000001',
  initialLoginChannelId: '2007000002',
  initialLiffId: '2007000002-abc',
  onClose: vi.fn(),
  onSaved: vi.fn(),
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  update.mockReset().mockResolvedValue({ success: true, data: {} })
  props.onClose.mockReset()
  props.onSaved.mockReset()
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

describe('LINEアカウントの編集窓', () => {
  it('資格情報の差し替えは、保存してある値を読まず空の欄で始まる', () => {
    render(<AccountEditModal {...props} initialSection="credentials" />)
    const secrets = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="password"]')]
    expect(secrets.length).toBeGreaterThan(0)
    expect(secrets.every((input) => input.value === '')).toBe(true)
  })

  it('名前だけ変えて保存すると、秘密値を送らず名前だけを送る', async () => {
    render(<AccountEditModal {...props} />)
    const name = screen.getByDisplayValue('然 本店')
    fireEvent.change(name, { target: { value: '然 本店（新）' } })
    fireEvent.submit(name.closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith('acc-1', { name: '然 本店（新）' }, undefined)
    expect(props.onSaved).toHaveBeenCalled()
  })

  it('狭い画面でも窓は上から始まって縦に送れ、見出しは上に残り、欄は1列から並べる', () => {
    render(<AccountEditModal {...props} />)
    const dialog = screen.getByRole('dialog')
    const overlay = dialog.parentElement!
    expect(overlay.classList.contains('items-start')).toBe(true)
    expect(overlay.classList.contains('overflow-y-auto')).toBe(true)
    expect(overlay.classList.contains('sm:items-center')).toBe(false)
    expect(dialog.classList.contains('max-h-[calc(100dvh-1rem)]')).toBe(true)
    expect(dialog.classList.contains('flex-col')).toBe(true)
    const form = dialog.querySelector('form')!
    expect(form.classList.contains('overflow-y-auto')).toBe(true)
    const footer = form.querySelector('[type="submit"]')?.parentElement
    expect(footer?.className).toContain('sticky')
    expect(footer?.className).toContain('justify-center')
    const header = screen.getByRole('heading', { name: '登録の内容を編集する' }).parentElement!
    expect(header.classList.contains('sticky')).toBe(true)
    expect(header.classList.contains('top-0')).toBe(true)
    const grid = document.querySelector('label[for="acc-capacity"]')!.closest('.grid')!
    expect([...grid.classList]).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']))
  })
})

it('入力した登録内容は、キャンセル時に捨てる前の確認を出す', async () => {
  render(<AccountEditModal {...props} />)
  fireEvent.change(screen.getByDisplayValue('然 本店'), { target: { value: '変更した名前' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(props.onClose).not.toHaveBeenCalled()
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' }).textContent).toContain('アカウントの登録内容への変更')
  expect((screen.getByDisplayValue('変更した名前') as HTMLInputElement).value).toBe('変更した名前')
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(props.onClose).toHaveBeenCalledOnce()
})

it('変更した内容は画面移動でも確認する', async () => {
  window.history.replaceState(null, '', '/hq')
  render(<><AccountEditModal {...props} /><a href="/events">イベントへ</a></>)
  fireEvent.change(screen.getByDisplayValue('然 本店'), { target: { value: '変更した名前' } })
  fireEvent.click(screen.getByRole('link', { name: 'イベントへ' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(props.onClose).not.toHaveBeenCalled()
})

it('未変更ならキャンセルで閉じる', () => {
  render(<AccountEditModal {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(props.onClose).toHaveBeenCalledOnce()
})

it('資格情報の入力を変えた後の Escape でも確認する', async () => {
  render(<AccountEditModal {...props} initialSection="credentials" />)
  const secret = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="password"]')!
  fireEvent.change(secret, { target: { value: 'test-secret' } })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(props.onClose).not.toHaveBeenCalled()
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})

it('画面内の切替を承認すると、移動しなくても編集内容を初期状態に戻す', async () => {
  const { requestUnsavedAction } = await import('@/lib/unsaved-action')
  const action = vi.fn()
  render(<AccountEditModal {...props} />)
  fireEvent.change(screen.getByDisplayValue('然 本店'), { target: { value: '変更した名前' } })
  requestUnsavedAction(action)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(action).toHaveBeenCalledOnce()
  expect(screen.getByDisplayValue('然 本店')).toBeTruthy()
})
