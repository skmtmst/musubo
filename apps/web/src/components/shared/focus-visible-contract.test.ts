import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = __dirname
const files = fs.readdirSync(DIR)
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8')
// 共通の太さの値も同じ2pxとして検査する。実際の幅・色・重なりは実ブラウザでも確かめる。
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\(--polish-focus-width\)/g, '2px')

/**
 * **押せる部品には、キーボードのフォーカスが見えること。**
 *
 * 最初の3部品はフォーカス指定が0件だった（`docs/v8-design-rules.md` §5）。
 * キーボードだけで操作する人が、**いまどこにいるか分からなくなる。**
 *
 * これまでは部品を名指しで見ていたので、**新しく足した部品は見張られない。**
 * `filter-chip.css` は押せる部品なのに 1 度も見られていなかった。
 * ここで「自分で押せる要素を描いている部品」を機械で拾って、全部に当てる。
 *
 * ## `:focus` ではなく `:focus-visible`
 *
 * `:focus` だとマウスで押したときにも輪郭が出る。押した直後に枠が付くと
 * 「選んだ状態になった」と読み違える。キーボードのときだけ出す。
 */

/** 自分で押せる要素を描いている部品（共通 Button を使うだけの部品は対象外）。 */
function drawsOwnControl(src: string): boolean {
  return /<button|<a\s|role="button"|<[a-z][\w-]*\b[^>]*\btabIndex=|<summary|<details|<input|<select|<textarea/.test(src)
}

const PARTS = files
  .filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))
  .map((n) => ({ n, base: n.replace(/\.tsx$/, ''), src: read(n) }))
  .filter((p) => drawsOwnControl(p.src))

/** その部品が持つ自前の CSS。無ければ Tailwind か、ほかの部品に任せている。 */
const cssOf = (base: string) =>
  [`${base}.module.css`, `${base}.css`].find((n) => files.includes(n))

describe('押せる部品のフォーカスが見える', () => {
  it('押せる部品を拾えている', () => {
    // 拾い方を間違えて 0 件になると、以下が素通りする。
    expect(PARTS.length).toBeGreaterThanOrEqual(20)
    expect(PARTS.map((p) => p.base)).toContain('filter-chip')
  })

  it('自前の CSS を持つ部品は :focus-visible を持つ', () => {
    const missing = PARTS.filter((p) => {
      const css = cssOf(p.base)
      const commonInput = p.src.includes('data-input-field') && /:focus-visible/.test(withoutComments(read('input-field-ring.css')))
      return css !== undefined && !commonInput && !/:focus-visible/.test(withoutComments(read(css)))
    }).map((p) => p.base)
    expect(missing, '押せる部品にフォーカスの輪郭が無い').toEqual([])
  })

  it('フォーカスの輪郭を消さない', () => {
    // CSS 側。`outline: none` / `outline: 0` を書かない。
    // 例外: 外側の枠が `:focus-within` で ring を出す複合部品
    // （Combobox・MultiSelect）は、中の input の輪郭を消して
    // 外枠の ring を正本にする。二重の輪郭を避けるため。
    // V8 SearchField は :has(:focus-visible) で外枠に輪郭を出し、内側と重ねない。
    // 緑は「正常」の意味なので、輪郭の色は action にそろえる。
    for (const name of files.filter((n) => n.endsWith('.css'))) {
      const css = withoutComments(read(name))
      if (/:(?:focus-within|has\(:focus-visible\))\s*\{[^}]*outline:\s*2px solid var\(--color-focus-ring\)/.test(css)) continue
      // 通常時だけ輪郭を消す指定は、キーボードの輪郭を消さない。
      const focusCss = css.replace(/([^{}]+)\{([^{}]*)\}/g, (rule, selectors) =>
        selectors.split(',').every((selector: string) => selector.includes(':not(:focus-visible)')) ? '' : rule,
      )
      // 開閉行は外側の行に輪を出し、ボタンの輪と重ねない。
      const disclosureRing = name === 'disclosure.module.css' && /\.itemHead:has\(\.itemToggle:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--color-focus-ring\)/.test(focusCss)
      const checked = disclosureRing ? focusCss.replace(/html:root\s+\.itemToggle\.itemToggle:focus-visible\s*\{\s*outline:\s*none;\s*\}/, '') : focusCss
      expect(checked, `${name} がフォーカス輪郭を消している`).not.toMatch(/outline:\s*(?:0|none)\b/)
    }
  })

  it('入力欄の線は共通の太さ・青と赤・枠の上で決める', () => {
    const css = withoutComments(read('input-field-ring.css'))
    const colors = [...css.matchAll(/--polish-input-ring-color:\s*([^;]+);/g)].map(match => match[1])
    expect({
      colors,
      outline: /outline:\s*([^;]+);/.exec(css)?.[1],
      offset: /outline-offset:\s*([^;]+);/.exec(css)?.[1],
    }).toEqual({ colors: ['var(--polish-focus)', 'var(--color-danger)'], outline: '2px solid var(--polish-input-ring-color)', offset: 'var(--polish-focus-input-offset)' })
  })

  it('Tailwind でもフォーカスの輪郭を消さない', () => {
    // **CSS だけ見ていると素通りする。** `focus:outline-none` は class 名なので、
    // CSS モジュールの検査に当たらない。実際 3 部品がこれで消していた。
    const offenders = files
      .filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))
      .filter((n) => /focus:outline-none|focus-visible:outline-none/.test(read(n)))
    expect(offenders, '輪郭を消すなら、代わりの輪郭を focus-visible で出す').toEqual([])
  })
})
