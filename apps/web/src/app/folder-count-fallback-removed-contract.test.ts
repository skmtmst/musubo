import { readUiSource as readFileSync } from '../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]) => readFileSync(join(HERE, ...parts), 'utf8')

/* 完全切り替え：管理画面 page は捨て、V8 を見る。シナリオの入口は src/v8/scenarios/list.tsx（古い list-v8 はもう描かれない）。 */
const SCENARIOS = read('..', 'v8', 'scenarios', 'list.tsx')
const REMINDERS = read("../v8/reminders/list.tsx")
const BROADCASTS = read('broadcasts', 'page.tsx')
const AUTO_REPLIES = read('auto-replies', 'page.tsx')
const TEMPLATES = read('templates', 'page.tsx')
const CONTENTS = read('contents', 'page.tsx')
const VARS = read('contents', 'vars', 'page.tsx')
const RICHMENUS = read('rich-menus', 'page.tsx')

/** 子の作るボタンの > / /> で切らず、共通欄の属性だけを見る。 */
function managedPanel(source: string): string {
  const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let attributes = ''
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === 'ManagedFolderPanel') {
      attributes = node.attributes.properties.map(property => property.getText(file)).join('\n')
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return attributes
}

/**
 * フォルダ件数の `??` フォールバック（現在ページの行だけを数える）が
 * 消えていることを固定する（#631）。
 *
 * このフォールバックがあると、値が来なくても数字が出てしまい、
 * しかもそれは別の母集団（現在ページの行数）になる。司令塔裁定の
 * 「これがこの票でいちばん大事な指示」への直接の証拠。
 */
describe('フォルダ件数フォールバックの削除(#631)', () => {
  it('scenarios: scenarios.filter(...).length でフォルダ件数を数えていない', () => {
    expect(SCENARIOS).not.toMatch(/scenarios\.filter\(.*folderId.*\)\.length/)
    expect(SCENARIOS).toContain('f.itemCount')
  })

  it('reminders: reminders.filter(...).length でフォルダ件数を数えていない', () => {
    expect(REMINDERS).not.toMatch(/reminders\.filter\(.*folderId.*\)\.length/)
    // フォルダの件数は共通のフォルダの列（ManagedFolderPanel）が既定でサーバーの itemCount を出す。
    const panel = managedPanel(REMINDERS)
    expect(panel).toContain('kind="reminder"')
    expect(panel).not.toContain('countOf=')
    // 型に無い itemCount を独自キャストで足していた拡張型を消した(#631)。
    // 型に足せば、来ていない経路は型エラーになる。
    expect(REMINDERS).not.toContain('VisualFolder')
    expect(REMINDERS).not.toContain('as VisualFolder')
  })

  it('broadcasts: broadcasts.filter(...).length でフォルダ件数を数えていない', () => {
    expect(BROADCASTS).not.toMatch(/broadcasts\.filter\(\(b\) => b\.folderId === f\.id\)\.length/)
    expect(BROADCASTS).toContain('f.itemCount')
  })

  it('auto-replies: 独自拡張型のキャストと現在ページの行数計算をしていない(#721)', () => {
    expect(AUTO_REPLIES).not.toContain('VisualFolder')
    expect(AUTO_REPLIES).not.toContain('as VisualFolder')
    expect(AUTO_REPLIES).not.toMatch(/\.itemCount \?\? items\.filter/)
    expect(AUTO_REPLIES).not.toMatch(/items\.filter\(\(r\) => r\.folderId === f\.id\)\.length/)
    expect(AUTO_REPLIES).not.toMatch(/items\.filter\(\(r\) => !r\.folderId\)\.length/)
    const panel = managedPanel(AUTO_REPLIES)
    expect(panel).toContain('kind="auto_reply"')
  })

  it('templates: 現在ページの行数でフォルダ件数を数えていない(#721)', () => {
    expect(TEMPLATES).not.toMatch(/templates\.filter\(\(t\) => t\.folderId === folder\.id\)\.length/)
    expect(TEMPLATES).not.toMatch(/templates\.filter\(\(t\) => t\.folderId === null\)\.length/)
    expect(TEMPLATES).toContain('folder.itemCount')
    expect(TEMPLATES).toContain('unfiledCount')
  })

  it('contents・vars: 読み込み済み範囲の行数でフォルダ件数を出さない(#721)', () => {
    // #730 で kind=media・common_var も件数対応した。読み込み済み範囲の
    // 行数を出す計算が残っていると、黙って別の母集団にすり替わる。
    expect(CONTENTS).not.toMatch(/items\.filter\(\(item\) => item\.folderId === folder\.id\)\.length/)
    expect(CONTENTS).not.toMatch(/items\.filter\(\(item\) => item\.folderId === null\)\.length/)
    expect(CONTENTS).toContain('folder.itemCount')
    expect(VARS).not.toMatch(/items\.filter\(\(item\) => item\.folderId === folder\.id\)\.length/)
    expect(VARS).not.toMatch(/items\.filter\(\(item\) => item\.folderId === null\)\.length/)
    expect(VARS).toContain("managedFolderNavRows('common_var', folders")
    const panel = VARS.match(/<ManagedFolderPanel[\s\S]*?\/>/)?.[0] ?? ''
    expect(panel).not.toContain('countOf=')
  })

  it('media・common_var・rich_menu: 選択中の1件に閉じた母集団で数えるよう、folders APIへ選択中IDを渡す(#730)', () => {
    // account_id を付けないと職員の可視範囲全体で数え、単一アカウントの
    // 一覧と母集団がずれる。未割当NULL行は一覧に出ないため件数へ入れない。
    expect(CONTENTS).toContain(`api.folders.list('media', accountAtRequest)`)
    expect(VARS).toContain(`api.folders.list('common_var', accountAtRequest)`)
    // rich_menu は画面の動きで確かめる（src/v8/rich-menus/list-guard.test.tsx：選択中と切り替え後のアカウントIDで呼ぶ）。
  })

  it('3画面とも「未分類」の件数はAPIから来た値(unfiledCount)を使い、現在ページのフィルタ計算をしていない', () => {
    expect(SCENARIOS).not.toMatch(/scenarios\.filter\(\(sc\) => !sc\.folderId\)\.length/)
    expect(SCENARIOS).toContain('unfiledCount')
    expect(REMINDERS).not.toMatch(/reminders\.filter\(\(item\) => !item\.folderId\)\.length/)
    expect(REMINDERS).toContain('unfiledCount')
    expect(BROADCASTS).not.toMatch(/broadcasts\.filter\(\(b\) => !b\.folderId\)\.length/)
    expect(BROADCASTS).toContain('unfiledCount')
  })
})
