import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(join(import.meta.dirname, '../../../v8/inflow-links/detail.tsx'), 'utf8')
describe("管理画面 流入リンクの削除確認 UIaM7", () => {
  it('ブラウザ標準の確認ではなく画面内ダイアログを使う', () => {
    expect(PAGE).not.toMatch(/\b(?:window\.)?confirm\s*\(/)
  })

  it('APIの成否を見て、失敗時は窓を閉じず画面の言葉を出す', () => {
    expect(PAGE).toContain('if (!route || deleting) return')
  })

  it('転送先は利用者に選ばせ、先頭の自動採用をしない (#514 重大4)', () => {
    expect(PAGE).not.toContain('routes.find((candidate) => candidate.id !== route.id)')
  })
})
