import { readUiSource } from '../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/* 完全切り替え：管理画面 の scenario-list.tsx は捨て、V8 を見る。入口は src/v8/scenarios/list.tsx（古い list-v8.tsx はもう描かれない）。 */
const AUTO_REPLIES = readUiSource(new URL('../v8/auto-replies/list.tsx', import.meta.url), 'utf8')
const FRIEND_ADD = read('../v8/friend-add/list.tsx')
const VARS = readUiSource(new URL('../app/contents/vars/page.tsx', import.meta.url), 'utf8')
const NEN_OVERVIEW = read('../v8/nen-campaigns/list.tsx')
const TAGS = read('../components/shared/folder-dot.tsx') + read('../v8/tags/tags-tab.tsx') + read('../components/friend-fields/tags-page-v4.tsx') + read('../components/shared/folder-panel.tsx')
const ANALYTICS = readUiSource(new URL('../app/analytics/page.tsx', import.meta.url), 'utf8')
const ANALYTICS_TIME = read('../app/analytics/analytics-time.ts')

/*
 * #640（第5パス D-3）: 表記一貫性。
 * - 1行省略の値は title などで全文を確認できる（狭い列の省略＋title）。
 * - 日時は JST・画面ごとの統一フォーマットで出す。
 */
describe('#640 省略表示の全文確認（title）', () => {
  // /scenarios の数のセルの title は v8/scenarios/list-folder-dot-and-reorder.test.tsx が描いて読む。

  it('/auto-replies V8: 応答数・長い条件・連動内容に全文確認を残す', () => {
    // 数の欄の title の全文は v8/auto-replies/list-behavior.test.tsx が描いて読む。
    expect(AUTO_REPLIES).toContain('title={name}') // : 条件の補足は名前の下に出さない
    expect(AUTO_REPLIES).not.toContain('sub={') // : 連動の補足は名前の下に出さない
  })

  it('/friend-add-settings V8: 設定名・経路・送るものに全文確認を残す', () => {
    expect(FRIEND_ADD).toContain('title={rule.name}')
    expect(FRIEND_ADD).not.toContain('styles.nameSub}') // : 経路は詳細で見る
    expect(FRIEND_ADD).toContain('title={line}')
  })

  it('/contents/vars: 省略した中身・使用箇所・更新と操作に全文を残す', () => {
    expect(VARS).toContain('<TableHeadRow>')
    expect(VARS).toContain("title={displayValue(valueText, 'unconfigured')}")
    expect(VARS).toContain('title={`${formatNumber(item.usageCount)}か所で使われています`}')
    expect(VARS).toContain('const updateTitle = `最終更新 ')
    expect(VARS).toContain('title={updateTitle}')
    expect(VARS).toContain('label={`共通情報「${item.name}」の操作`}')
  })

  it('/nen-campaigns: 配信名の補足・送った先・並び順に title', () => {
    expect(NEN_OVERVIEW).toContain('title={setting.title}')
    expect(NEN_OVERVIEW).toContain('title={who}')
    expect(NEN_OVERVIEW).toContain("const who = `${delivery.friendName || '名前未取得'}・${delivery.lineAccountName}`")
    expect(NEN_OVERVIEW).toContain('title={delivery.label}')

  })

  it('/tags: フォルダ行・使用先セルに title', () => {
    // フォルダの列は選び直し欄を置かず文字だけ出す（m21o）。
    // 欄の幅が列を超えて隣へ重なっていたため。長い名前は省略し、
    // 全文は title で確認できる（#640 の意図は残す）。
    expect(TAGS).not.toContain('<FolderSelect')
    expect(TAGS).toContain('<FolderDotName folder={group}>')
    expect(TAGS).toContain('title={label}')
    expect(TAGS).toContain("const label = `フォルダ：${folder?.name ?? '未分類'}`")
    expect(TAGS).not.toContain('<select')
    expect(TAGS).toContain('title={row.label}')
    // 使用先セルは共通 Td（余白は部品側）。全文確認の title は残す。
    expect(TAGS).toContain('title={usageLabel(tag)}')
  })
})

describe('#640 日時表記の統一（JST・フォーマット）', () => {
  it('/analytics: 配信日時は共通の日本時間の一覧表示にそろえる', () => {
    expect(ANALYTICS).not.toContain("slice(0, 16).replace('T', ' ')")
    expect(ANALYTICS).toContain('shortDateTime(item.sentAt)')
  })

  it('/analytics: 集計期間・結果履歴は formatAnalyticsDate にそろえる', () => {
    expect(ANALYTICS).toMatch(/集計期間 \$\{formatAnalyticsDate\(from\)\}〜\$\{formatAnalyticsDate\(to\)\}/)
    expect(ANALYTICS).toContain('formatAnalyticsDate(item.latestSnapshot.periodFrom)')
    expect(ANALYTICS).toContain('formatAnalyticsDate(snapshot.periodFrom)')
    // 生の YYYY-MM-DD を表示へ流す残りがないこと（API引数用の slice は許容）。
    expect(ANALYTICS.match(/periodFrom\.slice\(0, 10\)/g) ?? []).toHaveLength(0)
    expect(ANALYTICS.match(/periodTo\.slice\(0, 10\)/g) ?? []).toHaveLength(0)
  })

  it('/tags: 登録日は端末の地域ではなく JST 固定で出す', () => {
    expect(TAGS).not.toContain('d.getFullYear()')
  })

  it('/contents/vars: 更新日は JST、日付型の値は formatStamp の「/」区切り', () => {
    expect(VARS).toMatch(/function formatListDate[\s\S]{0,400}?formatListTimestamp\(value\)/)
    expect(VARS).toMatch(/formatVarValue\(item\.type, item\.value\)/)
    expect(VARS).toMatch(/formatVarValue\(item\.type, pending\.value\)/)
  })

  it('日時の整形は画面の既存ユーティリティを使う（場当たりの文字列処理を増やさない）', () => {
    expect(ANALYTICS_TIME).toMatch(/import \{ formatDateTime, formatDay \} from '@\/lib\/format'/)
    expect(VARS).toMatch(/import \{[^}]*formatStamp[^}]*\} from '@\/lib\/common-vars'/)
  })
})
