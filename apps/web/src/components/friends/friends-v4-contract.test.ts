import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, '..', '..', 'app', 'friends', 'page.tsx'), 'utf8')
const NAV = PAGE
const TABLE = PAGE
const ROW = readFileSync(join(HERE, 'friend-list-row.tsx'), 'utf8')
const ADVANCED = readFileSync(join(HERE, 'advanced-search-dialog.tsx'), 'utf8')
/* N-039: 保存検索・通知の窓は overlay 規約へ乗せるため部品へ切り出した。 */
const SAVED_DIALOG = readFileSync(join(HERE, 'saved-search-dialog.tsx'), 'utf8')
const NOTICE_DIALOG = readFileSync(join(HERE, 'notice-dialog.tsx'), 'utf8')
/* #984 LAY-14: 友だち配下の主タブの正本は friends-tabs.ts。 */
const FRIENDS_TABS = readFileSync(join(HERE, '../../v8/friends/shared/nav.ts'), 'utf8')
const DETAIL = readFileSync(join(HERE, '..', '..', 'app', 'friends', 'detail', 'page.tsx'), 'utf8')
const API = readFileSync(join(HERE, '..', '..', 'lib', 'api.ts'), 'utf8')

describe('友だちV8の画面契約', () => {
  it('データ管理に移しても既存の行き先とCSV操作を残す', () => {
    expect(PAGE).not.toContain("import Header from '@/components/layout/header'")
    expect(PAGE).not.toContain('<Header')
    expect(PAGE).not.toContain('<MergedTabs')
    expect(PAGE).toContain('<ListPage')
    // 主タブの項目は friends-tabs.ts が正本（#984 LAY-14。UID移行側も同じ一覧を使う）。
    expect(PAGE).toContain('<FriendsTabs')
    expect(FRIENDS_TABS).toContain("{ key: 'duplicates', label: '重複検出'")
    expect(FRIENDS_TABS).toContain("{ key: 'uid-migration', label: 'UID移行', href: '/friends/migrations?tab=uid' }")
    expect(NAV).toContain('CSVで書き出す')
    expect(PAGE).not.toContain('友だち管理のマニュアルは準備中です')
  })

  it('共通の表示件数と省略ページングを持つ', () => {
    expect(PAGE).toContain("from '@/components/shared/page-size-select'")
    expect(PAGE).toContain('const PAGE_SIZE_OPTIONS = STANDARD_PAGE_SIZES')
    expect(TABLE).toContain("import Pagination from '@/components/shared/pagination'")
    expect(PAGE).toContain('Math.ceil(total / pageSize)')
  })

  it('V8でも検索・絞り込みの実行先を残す', () => {
    expect(PAGE).toContain('名前・LINE名・タグ・メモで探す')
    expect(PAGE).toContain('詳細条件')
    expect(PAGE).toContain('SavedSearchDialog')
    expect(SAVED_DIALOG).toContain('api.friendSavedViews.list')
    expect(PAGE).toContain('savedSearchId')
    expect(ADVANCED).toContain('この条件で表示')
    expect(PAGE).toContain('友だち追加の新しい順')
    /* 「担当者：すべて」は共通Selectの label + option から組み立てる。 */
    expect(PAGE).toContain('aria-label="担当で絞り込む"')
    expect(PAGE).toContain('aria-label="シナリオで絞り込む"')
    expect(PAGE).toContain("{ value: '', label: 'すべて' }")
    expect(PAGE).toContain('注目のみ')
    expect(PAGE).toContain('boardId="x6QsVz"')
    // overlayの役割・Escape・入れ子の順序は advanced-search-dialog-focus.test.tsx で実際に操作して確認する。
    expect(ADVANCED).toContain('現在の条件に一致')
    expect(ADVANCED).toContain('いずれか1つ以上満たす条件')
    expect(ADVANCED).toContain('条件を保存')
  })

  it('未対応・注目・表示列の選択状態を目と再読み込み後の両方で確認できる', () => {
    // m13i: 札の形は共通 FilterChip 1つにそろえた。目の選択表示は部品が持つ。
    expect(PAGE).toContain("selected={responseFilter === 'unhandled'}")
    expect(PAGE).toContain('selected={attentionOnly}')
    expect(TABLE).toContain("localStorage.getItem('friends.visibleColumns')")
    expect(TABLE).toContain("localStorage.setItem('friends.visibleColumns'")
    expect(API).toContain('JSON.stringify(metadata)')
    expect(API).not.toContain('JSON.stringify({ metadata })')
  })

  it('友だち詳細から一括確認済み操作を除く', () => {
    // 履歴は詳細の画面（detail/page.tsx）が自分で描く。古い friend-timeline.tsx はどこからも描かれないので 2026-10-07 に消した。
    expect(DETAIL).not.toContain('すべて確認済みにする')
  })

  it('ブラウザ標準アラートを使わず独自ダイアログを出す', () => {
    expect(PAGE).not.toContain('window.alert')
    expect(PAGE).not.toContain('window.confirm')
    /* N-039: 通知・保存検索の窓は部品側へ。共通overlay規約（Esc・復元）に乗せる。 */
    expect(SAVED_DIALOG).toContain('<EntityPickerDialog')
    for (const source of [NOTICE_DIALOG]) {
      expect(source).toContain('role="dialog"')
      expect(source).toContain('aria-modal="true"')
      expect(source).toContain('useOverlayFocus')
    }
  })

  it('既存の検索・タグ・対応・詳細・受信箱への経路を残す', () => {
    for (const marker of [
      'api.friends.list',
      'api.tags.list',
      'AdvancedSearchDialog',
      'SingleFriendActions',
      '/friends/detail?id=',
      '/chats?friend=',
      '/friends/migrations',
    ]) {
      expect(PAGE + ROW + readFileSync(join(HERE, 'friend-row-menu.tsx'), 'utf8')).toContain(marker)
    }
  })
})
