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

})
