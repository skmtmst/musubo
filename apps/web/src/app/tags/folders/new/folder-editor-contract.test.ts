import { readUiSource as readFileSync } from '../../../../../scripts/test-ui-source.mjs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'src')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const FOLDER_EDITOR = 'app/tags/folders/new/page.tsx'

describe('フォルダの作成・編集（設計 byqIW）', () => {

  it('読込中・失敗・権限不足を言い分け、失敗を空欄のまま保存させない', () => {
    const source = read(FOLDER_EDITOR)
    // 以前は `if (!result.success) return` で失敗を黙って捨てていた。
    // 空欄のまま保存すると、元の名前を消すことになる。
    expect(source).not.toContain('if (!result.success) return')
    expect(source).toContain("setLoadState('error')")
    expect(source).toContain('読み込んでいます')
    expect(source).toContain('読み込めませんでした')
    expect(source).toContain('再読み込み')
    expect(source).toContain('見る権限がありません')
    expect(source).toContain("permissionDeniedMessage('store')")
    // 読み込み失敗時の保存制御は folder-page-react.test.tsx で確認する。
    expect(source).toContain('sameRequest(activeRef.current, request)')
    expect(source).toContain("setName('')")
  })

  it('保存上限をWorkerと揃え、APIの生文を画面へ出さない', () => {
    const source = read(FOLDER_EDITOR)
    expect(source).toContain('maxLength={60}')
    expect(source).toContain('folderSaveError(')
    expect(source).toContain('setError(folderSaveError(reason instanceof ApiError ? reason.status : undefined))')
  })

  it('保存が押せないときは、理由を本文に出す', () => {
    const source = read(FOLDER_EDITOR)
    expect(source).toContain('const blockedReason =')
    expect(source).toContain('disabled={saving || blockedReason !== null}')
    // 押せない見た目だけにしない。
    expect(source).toContain("title={blockedReason ?? undefined}")
  })

  it('削除の失敗は保存と別の言葉で出す', () => {
    const source = read(FOLDER_EDITOR)
    // D013: 以前は削除の失敗にも保存系の文言を使っていた。
    expect(source).toContain('folderDeleteError(')
    expect(source).toMatch(/remove[\s\S]*?folderDeleteError/u)
    expect(source).not.toMatch(/setDeleteOpen\(false\)[\s\S]{0,200}?folderSaveErrorMessage/u)
  })

  it('編集時はフォルダだけを削除し、中のタグを残すことを確認する', () => {
    const source = read(FOLDER_EDITOR)
    expect(source).toContain('api.tagGroups.delete(editId, folderAccountId)')
    expect(source).toContain('このフォルダを削除する')
    expect(source).toContain('中にあるタグは削除されず、未分類へ戻ります。')
    expect(source).toContain('フォルダを保存する')
  })

  it('選択中のLINE公式アカウントを分類の読込・保存へ渡す', () => {
    const source = read(FOLDER_EDITOR)
    expect(source).toContain('.list(selectedAccountId)')
    expect(source).toContain('accountId: selectedAccountId')
    expect(source).toContain('setFolderAccountId(group.accountId)')
  })
})

describe('タグの一覧（設計 hqrOv）', () => {
  it('指標カード4枚を、取得失敗でも見出しごと残す', () => {
    const source = read('v8/tags/tags-tab.tsx')
    // 「タグ数」は一覧の件数（1–20 / N件）と同じ数の重ね書きだったため
    // 「未使用」へ置き換えた（総数は一覧の上の1か所だけに出す決まり）。
    for (const title of ['未使用', '付けている友だち', '今月付けた回数', '整理の候補']) expect(source).toContain(`title: '${title}'`)
    expect(source).toContain('title={kpi.title}')
  })

  it('画面名を本文へ戻さない', () => {
    const source = read('v8/tags/tags-tab.tsx')
    // `/tags` の画面名は共通トップバーが menu.ts から出す。
    expect(source).not.toContain("import Header from '@/components/layout/header'")
    expect(source).not.toContain('<h1')
  })


})
