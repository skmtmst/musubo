import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('../../v8/broadcasts/list.tsx', import.meta.url), 'utf8')
/**
 * 一斉配信の一覧（設計 `q76C35` ★管理画面 6-1）の、中身が出せないときの見え方。
 *
 * **一覧が「1件も無い」「読み込めなかった」「権限が無い」を1つの文で
 * 済ませていると、運用する人からは登録したものが消えたように見える。**
 * 直し方がそれぞれ違う——空は作ればよい、失敗は読み直す、権限不足は
 * 誰かに足してもらう——ので、1枚ずつ言い分ける。
 */
describe('一覧の状態（設計 6-1-N `TmHjF`）', () => {
  /*
   * 骨格の注記：読み込んでいるときの骨格は f1075d55e4 から
   * `DelayedSkeleton` の包みへ移り、`listBody` は権限不足が先頭になった。
   * 三項の続き形 `) : forbidden ? (` は固定せず、各状態の枝があること自体を見る。
   */
  it('失敗をページ上の帯と一覧の2か所に出さない', () => {
    // ★管理画面 `x63W5x`：同じ失敗は1画面に1つ。一覧の失敗なら帯を出さず、
    // 一覧の場所の ListState error だけ残す。権限不足も別の1枚で重ねない。
    expect(PAGE).not.toContain('{error && !forbidden && (')
    // ページ上の帯（`p-4 bg-danger-bg` の箱）。行の削除ボタンの hover は別物。
    expect(PAGE).not.toContain('p-4 bg-danger-bg')
  })

})

describe('フォルダ操作（設計 6-1-M `xkRDb`）', () => {
  it('画面名は上部バーだけに出し、フォルダ追加を左欄へ置く', () => {
    expect(PAGE).not.toContain('<Header')
    expect(PAGE).not.toContain('<h1')
    // 追加口の描画・実行・権限拒否は broadcasts/list.test.tsx の実操作で確かめる。
  })

  it('追加と配信作成は実際の処理へつなぐ', () => {
    // 追加口の描画・実行・権限拒否は broadcasts/list.test.tsx の実操作で確かめる。
    expect(PAGE).toContain("onSelect: () => openCreate(true)")
    expect(PAGE).toContain('openTemplatePickerInitially={openTemplatePicker}')
  })
})
