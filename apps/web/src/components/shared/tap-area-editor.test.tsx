// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TapAreaEditor, { type TapAreaItem } from './tap-area-editor'

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tap-area-editor.module.css'), 'utf8')
function block(selector: string): string {
  const at = CSS.indexOf(selector)
  if (at < 0) throw new Error(`missing ${selector}`)
  return CSS.slice(at, CSS.indexOf('}', at))
}

const ITEMS: TapAreaItem[] = [
  { id: 'a', name: '予約する', summary: '予約ページ「基本の予約」', x: 0, y: 0, width: 50, height: 100 },
  { id: 'b', name: 'お知らせ', summary: null, x: 50, y: 0, width: 50, height: 100 },
]

function Harness({ canvas }: { canvas?: React.ReactNode }) {
  const [selected, setSelected] = useState<string | null>('a')
  return (
    <TapAreaEditor
      items={ITEMS}
      selectedId={selected}
      onSelect={setSelected}
      canvas={canvas}
      detail={<p>{`選んだ面：${selected}`}</p>}
    />
  )
}

afterEach(cleanup)

describe('画像の上で面を選ぶ（共通部品 TapAreaEditor・採用案 Wmch0）', () => {
  it('右の一覧に記号・名前・動きの要約か未設定を出し、下に選んだ面の動きの欄を置く', () => {
    render(<Harness />)
    const list = screen.getByRole('list', { name: '面の一覧' })
    const rows = within(list).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual(['A予約する予約ページ「基本の予約」', 'Bお知らせ未設定'])
    expect(rows[0].getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('選んだ面：a')).toBeTruthy()
  })

  it('画像の上の面を押しても、一覧の行を押しても同じ面を選ぶ', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '面 B「お知らせ」を選択する' }))
    expect(screen.getByText('選んだ面：b')).toBeTruthy()
    const rows = within(screen.getByRole('list', { name: '面の一覧' })).getAllByRole('button')
    expect(rows[1].getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '面 B「お知らせ」を選択する' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(rows[0])
    expect(screen.getByText('選んだ面：a')).toBeTruthy()
    expect(screen.getByRole('button', { name: '面 A「予約する」を選択する' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('canvas を渡すと部品の画像の代わりにそれを左に置く（面を足す・区切り直す画像）', () => {
    render(<Harness canvas={<div data-testid="canvas">編集できる画像</div>} />)
    expect(screen.getByTestId('canvas')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /を選択する$/ })).toBeNull()
  })

  it('面がなければ一覧の代わりに文を出す', () => {
    render(<TapAreaEditor items={[]} selectedId={null} onSelect={() => {}} emptyNote="画像の上をドラッグすると、面を足せます。" />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('画像の上をドラッグすると、面を足せます。')).toBeTruthy()
  })

  it('見た目：画像は幅 320、記号は薄い地＋灰色の字、選んだ行の記号は濃い緑・白い字', () => {
    expect(block('.canvas {')).toContain('width: 320px')
    expect(block('.letter {')).toContain('var(--color-surface-pearl)')
    expect(block('.letter {')).toContain('var(--color-ink-secondary)')
    const on = block('.row[data-selected] .letter {')
    expect(on).toContain('var(--color-accent-deep)')
    expect(on).toContain('var(--color-on-accent)')
    expect(block('.row[data-selected], .row[data-selected]:hover {')).toContain('var(--color-accent-soft)')
    expect(block('.area[data-selected] {')).toContain('var(--color-accent-deep)')
    const unset = block('.unset {')
    expect(unset).not.toContain('font-weight')
  })
})
