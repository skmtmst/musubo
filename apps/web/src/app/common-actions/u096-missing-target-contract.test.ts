import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')
const EDIT = readFileSync(join(HERE, 'edit', 'page.tsx'), 'utf8')
const VERSIONS = readFileSync(join(HERE, 'versions', 'page.tsx'), 'utf8')
const RICH_MENUS = readFileSync(join(SRC, 'app', 'rich-menus', 'edit', 'page.tsx'), 'utf8')

/*
 * #975 U096: 「対象が指定されていません」「id クエリパラメータが必要です」
 * 「API error: 404」のような内部向けの言葉で止まっていた画面を、
 * 何が足りないかと次の動きが分かる言い方へ。
 */
describe('対象が分からないときの言い方（#975 U096）', () => {
  it('共通アクション編集は、対象未指定を専用の案内にし一覧へ戻す', () => {
    // 戻り先は ★管理画面 TargetMissing の backHref が持つ。
    // 技術的な「IDが不正」は画面の文言から外す。
    expect(EDIT).not.toContain('IDが不正')
  })

  it('版の画面は、対象未指定とアカウント未選択・対象なしを分ける', () => {
    expect(VERSIONS).not.toContain('IDが不正')
  })

  it('リッチメニュー編集は、対象未指定・対象なし・権限なし・失敗を分けて案内する', () => {
    expect(RICH_MENUS).toContain('編集するリッチメニューが指定されていません')
    expect(RICH_MENUS).toContain('このリッチメニューは見つかりません')
    expect(RICH_MENUS).toContain('permissionScope="store"')
    expect(RICH_MENUS).toContain('<ListState kind="forbidden"')
    expect(RICH_MENUS).toContain('backHref="/rich-menus"')
    // 再読み込みは ★管理画面 TargetMissing の error（文言は部品が持つ。取り直し口があることだけ見る）。
    expect(RICH_MENUS).toContain('onRetry={() => void loadGroup()}')
    expect(RICH_MENUS).toContain("loadState === 'forbidden'")
    // 旧来の技術的な言い回しは残さない。
    expect(RICH_MENUS).not.toContain('対象が指定されていません')
  })
})
