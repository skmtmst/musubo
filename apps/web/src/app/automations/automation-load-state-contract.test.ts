import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, '../../v8/automations/list.tsx'), 'utf8')

describe('V8 オートメーション一覧の状態', () => {

  it('到達不能だった旧作成フォームを持たない（#554 点検#519中6）', () => {
    expect(PAGE).not.toContain('showCreate')
    expect(PAGE).not.toContain('handleCreate')
    expect(PAGE).not.toContain('automations.create(')
    expect(PAGE).not.toContain('新規オートメーションを作成')
    // #942 N-352: 稼働切替と「保管」は管理画面の定義ステータス遷移で行う。
    // 削除は保管に置き換わり、旧 PUT/DELETE には接続しない。
    expect(PAGE).toContain('api.automations.setStatus(')
    expect(PAGE).toContain("'archived'")
    expect(PAGE).not.toContain('api.automations.update(')
    expect(PAGE).not.toContain('api.automations.delete(')
  })

  it('ページ送りは操作でき、7件目以降へ行ける（#554 点検#519中1・中9）', () => {
    expect(PAGE).toContain('const paged = visible.slice((current - 1) * pageSize, current * pageSize)')
    // 共通のページ送りへ寄せたため、操作は Pagination・件数は ListRange が担う。
    expect(PAGE).toContain('<Pagination')
    expect(PAGE).toContain('onPageChange={setPage}')
    expect(PAGE).toContain('<ListPagePagination')
    expect(PAGE).not.toContain('slice(0, 6)')
    expect(PAGE).not.toContain('2　3　次へ')
  })
})
