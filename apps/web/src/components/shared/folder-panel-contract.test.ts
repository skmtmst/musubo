import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PANEL = readFileSync(new URL('./folder-panel.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('./folder-panel.module.css', import.meta.url), 'utf8')

describe('共通フォルダ欄', () => {
  it('テンプレート画面の252px幅を全画面用の1値として公開する', () => {
    expect(PANEL).toContain("export const FOLDER_RAIL_WIDTH = '15.75rem'")
    expect(PANEL).toContain("'--folder-rail-width': FOLDER_RAIL_WIDTH")
  })

  it('R37: 狭い幅では操作メニューを常に出す（スマホでも名前変更・削除に届く）', () => {
    expect(CSS).toMatch(/@media \(hover: none\)[\s\S]*?\.menuButton \{ opacity: 1; \}/)
  })
})
