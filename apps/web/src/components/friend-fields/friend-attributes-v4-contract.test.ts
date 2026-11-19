import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'src')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

/*
 * 禁止の見張りと、ブラウザでしか赤くできない見た目の値だけを文字で持つ。
 * 動きは描いて押す試験が見る：
 * タグ一覧＝`v8/tags/tags-tab-behavior.test.tsx`、保管の窓＝`delete-tag-dialog-react.test.tsx`、
 * CSV＝`tag-csv-import-filedrop.test.tsx`、編集フォーム＝`v8/tag-edit/edit-form-behavior.test.tsx`、
 * 編集画面のつなぎ＝`app/tags/edit/edit-page-states.test.tsx`、削除の窓＝`tag-edit-delete-dialog-react.test.tsx`、
 * 複製＝`new-tag-page-d011-d012.test.tsx`、情報欄＝`app/tags/fields-tab-v8-parity-react.test.tsx`、
 * 移行＝`app/tags/fields/migrate/field-migrate-r547-r548-react.test.tsx`。
 */
const tagsList = () => read('v8/tags/tags-tab.tsx') + read('v8/tags/list.tsx') + read('components/friend-fields/tags-page-v4.tsx')
const tagEditor = () => read('v8/tag-edit/edit-form.tsx') + read('components/friend-fields/tag-editor-v4.tsx') + read('components/shared/action-list.tsx') + read('components/friend-fields/linked-action-list.tsx')
const fieldList = () => read('v8/tags/fields-tab.tsx') + read('components/friend-fields/field-list.tsx')
const markList = () => read('v8/tags/marks-tab.tsx') + read('components/friend-fields/mark-list.tsx')

describe('タグ V4 の禁止の見張り', () => {
  it('タグ編集の遡及付与は初期OFFで専用確認を通す', () => {
    const editor = tagEditor()
    expect(editor).toContain('<Dialog open={isCurrent()} size="large"')
    expect(editor).toContain('titleIcon={<Coins aria-hidden="true" />')
    expect(editor).not.toContain('max-w-[670px] -translate-y-7')
  })

  it('タグ作成・編集の本文に大見出しや古い説明・見本の連動を置かない', () => {
    const editor = tagEditor()
    expect(editor).not.toContain('text-[32px] font-bold tracking-tight')
    expect(editor).not.toContain('友だちを分類するタグを作ります。タグが付いた瞬間の連動')
    // マイル設定だけを根拠に、存在しない連動アクションを作って表示しない。
    expect(editor).not.toContain("id: 'sample-1'")
  })

  it('一覧のページ送り・並び替え・幅に古い作りを戻さない', () => {
    const source = tagsList()
    expect(source).not.toContain("'前へ'")
    expect(source).not.toContain('並び替えを終了')
    expect(source).not.toContain('min-w-[1180px]')
  })

  it('情報欄と対応マークもPC画面で横スクロールを要求しない', () => {
    for (const source of [fieldList(), markList()]) {
      if (source.includes('<DataTable')) {
        expect(read('v8/tags/list.module.css')).toContain('table-layout: fixed')
      } else expect(source).toContain('table-fixed')
      expect(source).not.toMatch(/min-w-\[/)
      expect(source).not.toContain('overflow-x-auto')
    }
  })

  it('移行と項目の作成に古い言葉や本文の大見出しを戻さない', () => {
    const create = read('app/tags/fields/new/page.tsx')
    const migrate = read('app/tags/fields/migrate/page.tsx')
    expect(migrate).not.toContain('dry-run')
    expect(create).not.toContain("import Header from '@/components/layout/header'")
    expect(migrate).not.toContain("import Header from '@/components/layout/header'")
  })

  it('友だち情報欄はV8でも確認・実行・応答逆転の守りを保つ', () => {
    const migrate = read('app/tags/fields/migrate/page.tsx')
    // ATTR-10: 確認中に条件を変えたら、飛んでいる確認の応答を捨てる。
    // 描く試験では、選び直すと移行先が消えるので、この守りだけを壊しても赤くならない（報告済み）。
    expect(migrate).toContain('createResponseGate')
    expect(migrate).toContain('resetConfirmation')
  })

  it('使用人数を取れない項目を0人として削除できる形に戻さない', () => {
    expect(fieldList()).not.toContain('disabled={(field.usageCount ?? 0) > 0}')
  })

  it('タグではブラウザ標準confirmを使わない', () => {
    const sources = [
      read('components/friend-fields/tags-page-v4.tsx'),
      read('components/friend-fields/tag-editor-v4.tsx'),
      read('components/friend-fields/edit-tag-page-v4.tsx'),
      fieldList(),
      markList(),
      (read('v8/tags/searches-tab.tsx') + read('components/friend-fields/saved-search-list.tsx')),
    ]
    for (const source of sources) {
      expect(source).not.toMatch(/\bconfirm\s*\(/)
    }
  })

  it('取れていない値を固定の件数で埋めず、行でフォルダを選び直さない', () => {
    const source = tagsList()
    expect(source).not.toMatch(/参照<\/dt><dd[^>]*>3件/)
    expect(source).not.toContain('<FolderSelect')
  })

  it('整理候補と未使用を別の集計や仮の型から数えない', () => {
    const source = tagsList()
    // **読んでいない**ことを見る。コメントで名前に触れるのは構わない。
    expect(source).not.toMatch(/\$\{stats\.tags\.unused\}/)
    expect(source).not.toMatch(/value:\s*stats\.tags\.unused/)
    expect(source).not.toContain('TagWithCleanup')
  })

  it('CSVは出力の口や古い列を戻さない', () => {
    expect(tagsList()).not.toContain('CSVで出力')
    expect(read('components/friend-fields/tag-csv-import-dialog.tsx')).not.toContain('<Th>フォルダ</Th><Th>入らなかった理由</Th>')
  })

  it('使用中のタグは削除せず、影響確認後に履歴を残してアーカイブする', () => {
    const source = tagsList()
    expect(source).toContain('<Dialog open size="large"')
    expect(source).toContain('gap-3 px-4 py-3')
    expect(source).not.toContain('max-w-[670px] -translate-y-5')
    expect(source).not.toContain('api.tags.delete(tag.id)')
  })

  it('タグ編集の削除の窓に固定の参照件数を書かない', () => {
    const source = read('components/friend-fields/edit-tag-page-v4.tsx') + read('v8/tag-edit/edit.tsx')
    expect(source).not.toMatch(/参照<\/dt><dd[^>]*>3件/)
    expect(source).not.toMatch(/自動付与の参照<\/dt><dd[^>]*>1件/)
  })
})
