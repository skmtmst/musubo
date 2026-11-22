/**
 * m21u: 素の radio・checkbox 残りの置き換え契約。
 *
 * 本線（components/shared の部品の中・試験を除く）に素の
 * `input[type="radio"]`・`input[type="checkbox"]` を直接書かない。
 * 共通の RadioCard・Checkbox を使う。1件でも素に戻すと赤になる。
 *
 * 旧比較カード（app/scenarios/mode-v8.tsx）は残存コードの例外。実際に描く
 * V8の方式選択（v8/scenarios/create.tsx）は共通RadioCardを使う。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)))
const EXCEPTIONS = new Set([
  /*
   * リマインダV8の選ぶカード（ChoiceCardV8）は共通 RadioCard が持たない
   * 「アイコン左上・丸右上」の形。丸は本物の input[type=radio] で、
   * 意味は保ったまま。★V8板（等）の見た目を守るために残す。
   */
  'v8/reminders/wizard-ui.tsx',
  /*
   * イベント変更確認V8の開催回選択は表の行内の単一選択。共通 RadioCard は
   * カード型で表のセルに入らず、共通 Checkbox は複数選択の意味になる。
   * 本物の input[type=radio]（name 群・aria-label 付き）で意味を保つ。
   */
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (name.endsWith('.tsx') && !name.includes('.test.') && !name.includes('.stories.')) {
      out.push(full)
    }
  }
  return out
}

describe('m21u: 素の選ぶ入力は残っていない', () => {
  it('本線に type="radio"・type="checkbox" の直書きがない（例外を除く）', () => {
    const offenders: string[] = []
    for (const full of walk(SRC)) {
      const relative = full.slice(SRC.length + 1)
      if (relative.startsWith('components/shared/')) continue
      if (EXCEPTIONS.has(relative)) continue
      const body = readFileSync(full, 'utf8')
      if (body.includes('type="radio"') || body.includes('type="checkbox"')) {
        offenders.push(relative)
      }
    }
    expect(offenders).toEqual([])
  })

  it('V8の配信方式は共通の選択カードで両方式を選べる', () => {
    const body = readFileSync(join(SRC, 'v8/scenarios/create.tsx'), 'utf8')
    expect(body).toContain('<RadioCardGroup legend="配信方式"')
    expect(body.match(/<RadioCard\s/g)).toHaveLength(2)
    // 方式を選べる動きは作成画面の実描画試験で両方向を確かめる。
    expect(body).not.toContain('type="radio"')
  })
})
