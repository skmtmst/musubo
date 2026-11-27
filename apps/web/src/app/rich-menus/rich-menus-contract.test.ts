import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
// 「LINE上にあるメニュー」の取り込み画面は external-import.tsx（★管理画面・★V8 で共有）。
const PAGE = readFileSync(join(HERE, '../../v8/rich-menus/list.tsx'), 'utf8')
  + readFileSync(join(HERE, '../../v8/rich-menus/external-import.tsx'), 'utf8')
const EDIT_PAGE = readUiSource(new URL('../../v8/rich-menus/new/create.tsx', import.meta.url), 'utf8')
const PUBLISHER = readFileSync(
  join(HERE, '..', '..', '..', '..', 'worker', 'src', 'lib', 'rich-menu-publisher.ts'),
  'utf8',
)

describe("管理画面リッチメニューの画面契約", () => {
  it('LINEアカウント切替前の応答を捨て、全件をページ送りでたどれる', () => {
    expect(PAGE).toContain('activeAccountRef.current !== accountId')
    expect(PAGE).toContain("import Pagination from '@/components/shared/pagination'")
    expect(PAGE).toContain('pageCount={pageCount}')
    expect(PAGE).toContain('api.richMenuGroups.listPage(accountId')
    expect(PAGE).toContain('setGroupTotal(groupsRes.data.total)')
    expect(PAGE).not.toContain('「表示」を増やすと出ます')
  })

  it('一覧を取得できないときはメニュー数と出し分け数を0件と断定しない', () => {
    expect(PAGE).toContain("unit={groupKpiReady && groupFacets?.published != null ? '件' : ''}")
  })

  it('一覧APIの月間タップ数とのべ人数を表示し、部分集計だと明記する', () => {
  })

  it('LINEから読んだ面ごとの動きを取り込み前に表示する', () => {
    expect(PAGE).toContain('selected.areas.slice(0, 6)')
    expect(PAGE).toContain('externalActionText(area.action)')
    expect(PAGE).toContain('URLを開く（${action.url}）')
    expect(PAGE).toContain('メッセージを送る「${action.text}」')
    expect(PAGE).toContain('未対応の動き')
  })

  it('GO8RQどおり実際に友だちへ出す優先順を既定表示にする', () => {
    expect(PAGE).toContain('出す順番')
    expect(PAGE).toContain('上のメニューが優先されます。')
    expect(PAGE).toContain('いちばん上の1つだけが出ます。')
    expect(PAGE).toContain("sort: sortKey")
    // 実際の優先順・同順位の作成順は packages/db/test/rich-menu-targeting-order.test.ts で守る。
  })

  it('並び替えは見た目だけでなく実際の判定順を全件そろえる', () => {
    // #502中: 全件ぶんPATCHの並列投げは1口(reorderPriorities)に寄せた。
    // 途中失敗で順番が中途半端に残らない。隠れているメニューも含めて全部送る。
    expect(PAGE).toContain('api.richMenuGroups.reorderPriorities')
    expect(PAGE).toContain('moveTargetingGroup(ordered, id, direction)')
    expect(PAGE).toContain('updates.map((u) => u.id)')
    expect(PAGE).not.toContain("setSortKey('manual')")
  })

  it('編集画面も一覧と同じ1番始まりの出す順番を案内する', () => {
    expect(EDIT_PAGE).toContain('出す順番')
    expect(EDIT_PAGE).toContain('一覧で上にあるメニューが優先されます。1がいちばん先です。')
    expect(EDIT_PAGE).toContain('setPriorityInput(String(targetingPriority + 1))')
    expect(EDIT_PAGE).toContain('value={priorityInput}')
    expect(EDIT_PAGE).toContain("Math.max(0, (parseInt(priorityInput, 10) || 1) - 1)")
    expect(EDIT_PAGE).not.toContain('数が小さいほうが先に出ます。')
  })
})

describe("管理画面リッチメニューの公開安全契約", () => {
  it('全画像の準備後にaliasを切り替え、旧メニューは最後に削除する', () => {
    expect(PUBLISHER).toContain('全ページを作成し、全画像を upload する')
    expect(PUBLISHER).toContain('ここが完走するまで alias は触らない')
    expect(PUBLISHER).toContain('await line.upsertRichMenuAlias(')
    expect(PUBLISHER).toContain('公開切替がすべて終わってから旧メニューを削除する')
  })

  it('alias切替に失敗したら旧IDへ戻す', () => {
    // E-08 #621 案Aで段階公開へ分割。補償は restorePreSwitchLive が担う。
    expect(PUBLISHER).toContain('export async function restorePreSwitchLive(')
    expect(PUBLISHER).toContain('await line.upsertRichMenuAlias(aliasId, old.lineRichMenuId)')
    expect(PUBLISHER).toContain('await deleteRichMenuShells(')
  })
})
