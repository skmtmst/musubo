import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SIDEBAR = join(dirname(fileURLToPath(import.meta.url)), 'sidebar.tsx')

/**
 * 左メニューの通知の箱は、メニューの項目と同じ左端・幅にする。
 * 左右の余白は nav の padding、上下の余白は共通の Notice が持つ。
 * 呼び出し側で mx-/mb- を足すと、帯が項目より狭く右へ寄って見える
 *（2026-11-06 オーナー指摘）。
 */
describe('左メニューの通知の位置', () => {
  it('読み込み失敗の帯に呼び出し側の余白を付けない', () => {
    const source = readFileSync(SIDEBAR, 'utf8')
    const start = source.indexOf("visibilityStatus === 'error'")
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('</Notice>', start)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).not.toMatch(/mx-\S+/)
  })

  it('前に読めた表示の1行に呼び出し側の余白を付けない', () => {
    const source = readFileSync(SIDEBAR, 'utf8')
    const line = source.split('\n').find((row) => row.includes('<ShellStaleStyleNotice'))
    expect(line).toBeDefined()
    expect(line).not.toContain('className')
  })
})
