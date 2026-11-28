// @vitest-environment happy-dom
/*
 * ★V8 プルダウンの開いた中身（共通部品 select-menu・StFE7「選ぶ欄/開いた」・確認表 ）。
 * オーナーの悪い例（統括のアカウント画面）：開くと「並び：／友だち順」と2行に折れる・
 * 選択肢にも「並び：」が付く・緑の枠・✓ が左・選んだ行が緑の地。
 * ここは「頭を外して見出しにする」「✓ は右端」「選んだ値・キーボード・変換中」の動きを見張る。
 * 管理画面（data-theme なし）は今までの中身のまま。
 */
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Select from './select'
import { splitOptionHeads } from './select-menu'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string) => readFileSync(join(HERE, name), 'utf8')

const SORT = [
  { value: 'friends', label: '並び：友だち順' },
  { value: 'name', label: '並び：名前順' },
  { value: 'display', label: '並び：登録順' },
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

async function open(onChange = vi.fn(), options = SORT, value = 'friends', label?: string) {
  await act(async () => {
    render(<Select aria-label="アカウントの並び順" label={label} value={value} onChange={onChange} options={options} />)
  })
  const button = screen.getByRole('button', { name: 'アカウントの並び順' })
  await act(async () => { fireEvent.click(button) })
  return { button, onChange }
}

describe('splitOptionHeads', () => {
  it('全部が同じ頭なら外して見出しにする', () => {
    const { heading, labelOf } = splitOptionHeads(SORT)
    expect(heading).toBe('並び')
    expect(SORT.map(labelOf)).toEqual(['友だち順', '名前順', '登録順'])
  })

  it('先頭の「フォルダ：すべて」だけが頭を持つときも外して見出しにする', () => {
    const rows = [{ label: 'フォルダ：すべて' }, { label: 'お問い合わせ' }, { label: '未分類' }]
    const { heading, labelOf } = splitOptionHeads(rows)
    expect(heading).toBe('フォルダ')
    expect(rows.map(labelOf)).toEqual(['すべて', 'お問い合わせ', '未分類'])
  })

  it('頭の無い選択肢・違う頭が混ざるときは外さない（何の選択肢か分からなくなる）', () => {
    const mixed = [{ label: '動画だけ' }, { label: '並び：新しい順' }]
    expect(splitOptionHeads(mixed).heading).toBeUndefined()
    expect(mixed.map(splitOptionHeads(mixed).labelOf)).toEqual(['動画だけ', '並び：新しい順'])
    const two = [{ label: '状態：すべて' }, { label: '種類：すべて' }]
    expect(splitOptionHeads(two).heading).toBeUndefined()
  })

  it('label を渡したときはそれが見出し（選択肢はそのまま）', () => {
    const rows = [{ label: 'Kenta' }, { label: '未割り当て' }]
    const { heading, labelOf } = splitOptionHeads(rows, '担当')
    expect(heading).toBe('担当')
    expect(rows.map(labelOf)).toEqual(['Kenta', '未割り当て'])
  })
})

describe('★V8 の Select は開いた中身を select-menu で描く', () => {
  it('閉じたボタンは「並び：友だち順」のまま、選択肢には頭を付けず、上に見出し「並び」', async () => {
    const { button } = await open()
    expect(button.textContent).toContain('並び：友だち順')
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['友だち順', '名前順', '登録順'])
    const menu = document.querySelector('[data-select-menu]')!
    expect(menu.textContent?.startsWith('並び')).toBe(true)
  })

  it('選んだ行だけ印が付き、✓ は文字の後ろ（右端）', async () => {
    await open()
    const [chosen, other] = screen.getAllByRole('option')
    expect(chosen.getAttribute('aria-selected')).toBe('true')
    const row = chosen.querySelector('button')!
    expect(row.getAttribute('data-selected')).toBe('true')
    expect(row.lastElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(other.querySelector('svg')).toBeNull()
  })

  it('押すと値が変わって閉じる', async () => {
    const { onChange } = await open()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '名前順' }).querySelector('button')!) })
    expect(onChange).toHaveBeenCalledWith('name')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('上下キーと Enter で選べる・Esc で閉じる', async () => {
    const { button, onChange } = await open()
    await act(async () => { fireEvent.keyDown(button, { key: 'ArrowDown' }) })
    expect(screen.getByRole('option', { name: '名前順' }).querySelector('button')!.getAttribute('data-active')).toBe('true')
    await act(async () => { fireEvent.keyDown(button, { key: 'Enter' }) })
    expect(onChange).toHaveBeenCalledWith('name')
    await act(async () => { fireEvent.click(button) })
    expect(screen.getByRole('listbox')).toBeTruthy()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('日本語の変換中の Enter では選ばない', async () => {
    const { button, onChange } = await open()
    await act(async () => { fireEvent.keyDown(button, { key: 'ArrowDown' }) })
    await act(async () => { fireEvent.keyDown(button, { key: 'Enter', keyCode: 229 }) })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('外を押すと閉じる', async () => {
    await open()
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('選択肢の文字は折り返さず薄い枠を使う', () => {
    const css = read('select-menu.module.css')
    // 1行のまま折り返さない。
    expect(css).toMatch(/\.item \{[^}]*white-space: nowrap/s)
    expect(css).toMatch(/\.label \{[^}]*white-space: nowrap/s)
    // 緑の枠は付けない（薄い線）。
    expect(css).toMatch(/\.surface \{[^}]*border: 1px solid var\(--color-hairline\)/s)
  })
})

describe('テーマ指定がなくても現在の中身', () => {
  it('旧テーマ指定でも現在の見出しと候補を出す', async () => {
    document.documentElement.dataset.theme = 'v7'
    await open()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['友だち順', '名前順', '登録順'])
    expect(document.querySelector('[data-select-menu]')).not.toBeNull()
  })
})

it('半角コロンの見出しをそろえ、時刻とURLの中身は切らない', () => {
  const headed = splitOptionHeads([{ value: 'all', label: '予約元: すべて' }, { value: 'web', label: '予約元: Web' }])
  expect(headed.heading).toBe('予約元')
  expect(headed.labelOf({ value: 'web', label: '予約元: Web' })).toBe('Web')
  for (const label of ['10/12（月） 14:00', 'https://example.com']) {
    const option = { value: 'one', label }
    const names = splitOptionHeads([option], '開催回')
    expect(names.labelOf(option)).toBe(label)
  }
})
