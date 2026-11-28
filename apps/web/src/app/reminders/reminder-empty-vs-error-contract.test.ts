import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/* 完全切り替え：管理画面 の page.tsx は捨て、V8 の list-v8.tsx を見る。 */
const LIST = readFileSync(new URL('../../v8/reminders/list.tsx', import.meta.url), 'utf8')
const LIST_STATE = readFileSync(
  join(HERE, '..', '..', 'components', 'shared', 'list-state.tsx'),
  'utf8',
)

/**
 * リマインダ一覧の「無い」と「読めない」（設計 `dC0yg` 7-1-J）。
 *
 * **失敗を「ありません」と言わない。** 上に「読み込めませんでした」を
 * 出しているのに、一覧の中で「ありません。作成してください」と並ぶと、
 * **登録済みのものが消えたように読める。**
 *
 * **言い方は共通部品から引く。** 画面ごとに書くと、同じ事故が画面に
 * よって違う言葉になる。ここは「リマインダの読み込みに失敗しました。
 * もう一度お試しください。」で、ほかの画面は「表示できませんでした」だった。
 */
describe('リマインダ一覧の空と失敗', () => {
  it('一覧のフォルダ欄を共通パネルの統一幅で表示する', () => {
    expect(LIST).toContain('FolderPanel')
    // 追加の窓は共通のフォルダの列（ManagedFolderPanel）が変えてよい人にだけ出す。
    expect(LIST).toMatch(/<ManagedFolderPanel[\s\S]*?canManage=\{canEdit\}/)
    expect(LIST).not.toContain('lg:grid-cols-[13rem_minmax(0,1fr)]')
  })

  it('共通部品が、直らないときの行き先を持っている', () => {
    // 「もう一度お試しください」だけだと、押し直しても直らないとき詰まる。
    expect(LIST_STATE).toContain('再読み込みしても直らない場合はエラー報告へ。')
    // 画面から読めるように出ていること（`export` を外すと引けなくなる）。
    expect(LIST_STATE).toMatch(/export const PRESETS/)
  })

})
