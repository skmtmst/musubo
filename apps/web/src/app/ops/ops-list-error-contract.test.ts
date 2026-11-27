import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dashboard = readFileSync(new URL('../../v8/ops/dashboard.tsx', import.meta.url), 'utf8')

describe('ダッシュボードの固定文言', () => {
  it('共通部品に失敗時の見出しを渡す', () => {
    expect(dashboard).toContain('ダッシュボードを表示できませんでした')
    expect(dashboard).toContain('未登録の人を表示できませんでした')
  })
})
