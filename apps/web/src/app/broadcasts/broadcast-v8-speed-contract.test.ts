import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIR = dirname(fileURLToPath(import.meta.url))
// 一覧の入口は src/v8/broadcasts/list.tsx（古い list-v8.tsx はもう描かれない）。
const LIST = readFileSync(join(DIR, '../../v8/broadcasts/list.tsx'), 'utf8')

/*
 * 一斉配信V8の速さ。条件を変えるたび3つの口を取り直していた。
 * 一覧だけが条件で変わるので、一覧と名前解決（タグ・シナリオ）を分ける。
 * 条件変更・ページ送り・削除や移動の後の取り直しは一覧の口だけにする。
 */
describe('一斉配信V8 条件変更は一覧の口だけ取り直す', () => {
  it('一覧の口にタグ・シナリオを混ぜていない', () => {
    expect(LIST).not.toContain('const [broadcastsRes, tagsRes, scenariosRes] = await Promise.all')
  })

  it('古い3つまとめ取り直し口は残っていない', () => {
    expect(LIST).not.toMatch(/(^|[^A-Za-z])load\(/)
  })
})
