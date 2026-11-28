import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'breadcrumb.module.css'), 'utf8')

/*
 * R177: 長い項目名で戻るボタンが右へ押し出されていた。
 * happy-dom には配置計算が無いため、省略の構図（パンくずの省略・
 * 見出し行の縮み・ボタンの固定・全文確認）を源泉で固定する。
 * 実機の幅確認（390・320px）は撮影（司令塔）で行う。
 */
describe('R177 パンくずと戻るボタンのはみ出し', () => {
  it('いま開いている場所は省略し、親の階層は縮めない', () => {
    expect(css).toContain('text-overflow: ellipsis;')
    expect(css).toContain('white-space: nowrap;')
  })

  it('V8の情報欄はパンくずと未保存確認付きキャンセルで戻れる', () => {
    const field = readFileSync(join(here, '../../v8/tags/field-editor.tsx'), 'utf8')
    expect(field).toContain('usePageCrumbs(')
    expect(field).toContain("href: host ? '/hq/friend-attributes?tab=fields' : '/tags?tab=fields'")
    const search = readFileSync(join(here, '../../v8/tag-edit/search-edit.tsx'), 'utf8')
    expect(search).toContain("{ label: '保存した検索', href: '/tags?tab=searches' }")
    expect(search).toContain('<Button href="/tags?tab=searches">キャンセル</Button>')
  })
})
