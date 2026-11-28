// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TapAreaEditor, { tapAreaLetter, type TapAreaItem } from './tap-area-editor'

afterEach(cleanup)

describe('TapAreaEditor の27番目以降の面ラベル表示', () => {
  it('1〜26番目は A〜Z、27番目以降は記号にならず数字（27・28…）で画像上と一覧に表示する', () => {
    const items: TapAreaItem[] = Array.from({ length: 28 }, (_, index) => ({
      id: `area-${index}`,
      name: `${index + 1}番目の面`,
      summary: null,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    }))

    render(<TapAreaEditor items={items} selectedId="area-26" onSelect={vi.fn()} />)

    expect(screen.getByRole('button', { name: '面 A「1番目の面」を選択する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '面 Z「26番目の面」を選択する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '面 27「27番目の面」を選択する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '面 28「28番目の面」を選択する' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /面 \[/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /面 \\/ })).toBeNull()

    const list = screen.getByRole('list', { name: '面の一覧' })
    const rows = within(list).getAllByRole('button')
    expect(rows[0].textContent).toBe('A1番目の面未設定')
    expect(rows[25].textContent).toBe('Z26番目の面未設定')
    expect(rows[26].textContent).toBe('2727番目の面未設定')
    expect(rows[27].textContent).toBe('2828番目の面未設定')
    expect(tapAreaLetter(-1)).toBe('')
  })
})
