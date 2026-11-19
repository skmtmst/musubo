import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const editPage = readFileSync(resolve(root, 'src/app/tags/searches/edit/page.tsx'), 'utf8')
const friendsPage = readFileSync(resolve(root, 'src/app/friends/page.tsx'), 'utf8')
  + readFileSync(resolve(root, 'src/components/friends/saved-search-dialog.tsx'), 'utf8')
const advanced = readFileSync(resolve(root, 'src/components/friends/advanced-search-dialog.tsx'), 'utf8')
const list = readFileSync(resolve(root, 'src/v8/tags/searches-tab.tsx'), 'utf8') + readFileSync(resolve(root, 'src/components/friend-fields/saved-search-list.tsx'), 'utf8')

/*
 * 禁止の見張りだけを文字で持つ。動きは描いて押す試験が見る：
 * 一覧＝`v8/tags/searches-tab-react.test.tsx`、編集＝`v8/tag-edit/search-edit-actions.test.tsx`、
 * 友だち一覧の保存＝`components/friends/advanced-search-save-react.test.tsx`。
 */
describe('V8 保存した検索の禁止の見張り', () => {
  it('保存と呼び出しをブラウザ1台だけのlocalStorageへ戻さない', () => {
    expect(advanced + friendsPage).not.toContain("localStorage.setItem('friends.savedSearch'")
    expect(advanced + friendsPage).not.toContain("localStorage.getItem('friends.savedSearch'")
  })

  it('条件の日本語変換を一覧の中で作り直さない', () => {
    expect(list).not.toContain('function describeOne')
    expect(list).not.toContain("parts.map(String).join(' ')")
  })

  it('編集画面に見本の使用先を書かない', () => {
    expect(editPage).not.toContain('一斉配信「VIP未契約案内」')
    expect(editPage).not.toContain('オートメーション「3日後フォロー」')
  })
})
