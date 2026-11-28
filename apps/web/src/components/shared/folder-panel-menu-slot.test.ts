import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(new URL('./folder-panel.module.css', import.meta.url), 'utf8')

describe('フォルダ行の「…」の場所（I3L41O）', () => {
  it('今の行は共通の規定で操作の場所を取る', () => {
    expect(CSS).not.toContain('.menuSlot { display: none; }')
    expect(CSS).toMatch(/:root \.menuSlot\s*\{[^}]*width:/s)
  })

  it('選んでいない行の「…」は場所を取らない（重ねて出す）', () => {
    expect(CSS).toContain(".row:not([data-active]) .menu")
    expect(CSS).toContain('position: absolute')
  })

  it('触る・キーボード・開いている間は「…」が出る', () => {
    expect(CSS).toContain('.row:not([data-active]):hover .menu')
    expect(CSS).toContain('.row:not([data-active]):focus-within .menu')
    expect(CSS).toContain('.row:not([data-active])[data-menu-open] .menu')
  })

  it('触れない端末では「…」を常に出す（スマホでも名前変更・削除に届く）', () => {
    expect(CSS).toContain('@media (hover: none)')
  })
})
