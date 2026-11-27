import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * シェルのキーボード操作（★管理画面 修正方針 §2、2026-09-24 の点検）。
 *
 * - 閉じたスマホのメニューは画面外にずらすだけで、中の11項目が Tab で選べた。
 *   焦点が見えない所へ行く。閉じている間は inert にする。
 * - 「本文へ移動」が無く、毎画面、更新案内とメニューを通らないと本文へ行けなかった。
 */

const COMPONENTS = join(__dirname, '..')
const shell = readFileSync(join(COMPONENTS, 'app-shell.tsx'), 'utf8')
const shellCss = readFileSync(join(COMPONENTS, 'app-shell.module.css'), 'utf8')

describe('本文へ移動', () => {
  it('シェルの先頭に置き、本文の main へ飛ぶ', () => {
    expect(shell).toContain('<a href="#main-content" className={styles.skipLink}>本文へ移動</a>')
    expect(shell).toMatch(/<main id="main-content" tabIndex=\{-1\}/)
  })

  it('ふだんは画面外、焦点が来たときだけ出る（display:none にしない）', () => {
    const block = shellCss.match(/\.skipLink \{[\s\S]*?\}/)?.[0] ?? ''
    expect(block).toContain('transform: translateY(-200%)')
    expect(block).not.toContain('display: none')
    expect(shellCss).toMatch(/\.skipLink:focus-visible \{\s*transform: none;/)
  })
})
