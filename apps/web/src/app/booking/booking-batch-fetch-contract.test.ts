import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'

/**
 * #1060: 一覧のN+1解消の表示契約。
 *
 * - 予約カレンダー: メニュー数ぶん往復していた空き枠取得を一括口へ。
 * - 担当割り当て表: スタッフ数ぶん往復していた読み込みを一括口へ。
 * - 回答フォーム一覧: 全件を受け取って画面側で切っていたページ分けを、
 *   Worker のサーバーページングへ。
 *
 * 一括口をまだ持たない Worker との段階配備に備えて、画面は従来の
 * 個別取得を「失敗時の退避」として残す。契約は「一括口を先に使う」こと。
 */
const MENU_NEW = readFileSync(new URL('./menus/new/page.tsx', import.meta.url), 'utf8')
// 回答フォームの入口は src/v8/forms/list.tsx（古い list-v8.tsx はもう描かれない）。
const FORMS = readFileSync(new URL('../../v8/forms/list.tsx', import.meta.url), 'utf8')

describe('担当割り当て表の読み込み（#1060）', () => {
  it('メニュー作成時の割り当て読み込みも一括口を先に使う', () => {
    expect(MENU_NEW).toContain('bookingApi.listStaffMenusBulk')
    // 書き込みは従来どおり担当ごとのPUT（失敗した担当だけ再試行できる形）。
    expect(MENU_NEW).toContain('bookingApi.putStaffMenus')
  })
})

describe('回答フォーム一覧のサーバーページング（#1060）', () => {
  it('一覧取得にページ・件数・絞り込み・並びを渡す', () => {
    expect(FORMS).toContain('with_list_summary=1')
    expect(FORMS).toContain('&page=')
    expect(FORMS).toContain('&limit=')
    expect(FORMS).toContain('&filter=')
    expect(FORMS).toContain('&sort=')
  })

  it('ページ送りは応答の total（絞り込み後の総件数）を母数にする', () => {
    expect(FORMS).toContain('listTotal / pageSize')
  })
})
