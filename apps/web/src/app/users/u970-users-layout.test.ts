import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(new URL('./users-screen.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../friends/friends-v8.module.css', import.meta.url), 'utf8')

describe('統合ユーザーの現役の配置', () => {
  it('主要操作と検索・絞り込みを別の行に置く', () => {
    expect(PAGE).toContain('className={styles.headAction}')
    expect(PAGE).toContain('className={styles.toolbar}')
    expect(PAGE).toContain('className={styles.searchWrap}')
    expect(PAGE).toContain('aria-label="統合ユーザーを検索"')
  })

  it('表は現役の幅と見出しの折り返しの決まりを使う', () => {
    expect(PAGE).toContain('className={styles.tableWrap}')
    expect(CSS).toMatch(/\.table\s*\{[\s\S]*?width: 100%/)
    expect(CSS).toMatch(/\.table th\s*\{[\s\S]*?white-space: nowrap/)
  })
})
