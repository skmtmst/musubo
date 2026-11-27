import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

describe('一覧KPIの取得失敗時', () => {
  it('V8タグ一覧は4つの指標の見出しを帯へ渡す', () => {
    const source = read('v8/tags/tags-tab.tsx')
    for (const title of ['未使用', '付けている友だち', '今月付けた回数', '整理の候補']) expect(source).toContain(`title: '${title}'`)
    expect(source).toContain('<KpiBand')
    expect(source).toContain('title={kpi.title}')
  })

  it('V8 のリマインダ・シナリオは取れない数を「—」で出す', () => {
    // 板 ・：ListKpis は使わず、取れない値は「—」。
    // シナリオの入口は src/v8/scenarios/list.tsx（古い app/scenarios/list-v8.tsx はもう描かれない）。
    for (const path of ['v8/reminders/list.tsx', 'v8/scenarios/list.tsx']) {
      expect(read(path), `${path} に「—」の欠け表示がありません`).toContain("? emptyValue('unknown')")
    }
  })
})
