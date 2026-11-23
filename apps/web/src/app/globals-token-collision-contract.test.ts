import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * **同じ塊の中で、同じ変数を違う値で2回書かない。**
 *
 * CSS は後に書いた値が勝つ。`:root` の中で予約スタッフ用の
 * `--tpl-bks-title-size: 22px` を書いたあと、予約からの売上の行で同じ名前を
 * `20px` と書き直していたため、予約スタッフの4枚（・・・）の
 * 題が絵の 22px ではなく 20px になっていた（監査 W152）。
 *
 * 画面ごとに値が違うときは、用途の分かる別の名前にする。
 */
const GLOBALS = path.join(__dirname, 'globals.css')

type Collision = { selector: string; name: string; first: string; second: string }

function findTokenCollisions(css: string): Collision[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const stack: Array<{ selector: string; seen: Map<string, string> }> = []
  const collisions: Collision[] = []
  let buffer = ''
  const take = () => {
    const top = stack[stack.length - 1]
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(buffer)
    if (top && match) {
      const [, name, value] = match
      const before = top.seen.get(name)
      if (before !== undefined && before !== value) collisions.push({ selector: top.selector, name, first: before, second: value })
      top.seen.set(name, value)
    }
    buffer = ''
  }
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ selector: buffer.trim(), seen: new Map() })
      buffer = ''
    } else if (ch === '}') {
      take()
      stack.pop()
    } else if (ch === ';') {
      take()
    } else {
      buffer += ch
    }
  }
  return collisions
}

describe('globals.css の変数の書き直し', () => {
  it('同じ塊の中で同じ変数を違う値で書き直していない', () => {
    const collisions = findTokenCollisions(fs.readFileSync(GLOBALS, 'utf8'))
    expect(collisions.map((c) => `${c.selector} ${c.name}: ${c.first} → ${c.second}`)).toEqual([])
  })

  it('見張りそのものが書き直しを見つける（対照）', () => {
    expect(findTokenCollisions(':root { --a: 22px; --b: 1px; --a: 20px; }')).toHaveLength(1)
    expect(findTokenCollisions(':root { --a: 22px; } [data-theme="v7"] { --a: 20px; }')).toHaveLength(0)
  })

  it('予約スタッフの題と予約からの売上の題は別の名前で、どちらもページの題の共通値を読む', () => {
    const css = fs.readFileSync(GLOBALS, 'utf8')
    expect(css).toMatch(/--tpl-title-size:\s*var\(--polish-text-page-title\)/)
    expect(css).toMatch(/--tpl-bks-title-size:\s*var\(--tpl-title-size\)/)
    expect(css).toMatch(/--tpl-bks-sales-title-size:\s*var\(--tpl-title-size\)/)
    const sales = fs.readFileSync(new URL('./booking/sales/sales-v8.module.css', import.meta.url), 'utf8')
    expect(sales).toContain('var(--tpl-bks-sales-title-size)')
  })

  it('売上用の題だけを変更してもスタッフ画面の題へ伝わらない', () => {
    const staff = fs.readFileSync(path.join(__dirname, '../v8/booking-staff/layout.module.css'), 'utf8')
    const sales = fs.readFileSync(new URL('./booking/sales/sales-v8.module.css', import.meta.url), 'utf8')
    const staffTitle = staff.match(/\.title\s*\{([^}]+)\}/)![1]
    const salesTitle = sales.match(/\.title\s*\{([^}]+)\}/)![1]
    expect(staffTitle).toContain('font-size: var(--tpl-title-size)')
    expect(staffTitle).not.toContain('--tpl-bks-sales-title-size')
    expect(salesTitle).toContain('font-size: var(--tpl-bks-sales-title-size)')
    expect(salesTitle).not.toContain('var(--tpl-bks-title-size)')
  })
})
