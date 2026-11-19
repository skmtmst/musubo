import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = dirname(fileURLToPath(import.meta.url))
const staffSource = readFileSync(join(directory, 'page.tsx'), 'utf8')
const actionsSource = readFileSync(join(directory, '../../v8/settings/staff/staff-actions.ts'), 'utf8')

describe("管理画面 30 見せる範囲の保存と名寄せ", () => {

  it('開く対象は行の人で、名前検索の先頭固定はやめる', () => {
    expect(staffSource).toContain('openPermissions(user)')
    expect(staffSource).not.toContain("user.name.includes('高田')")
    expect(staffSource).not.toContain('activeUsers[0] ?? null')
  })

  it('別人表とアクセス表は名前で名寄せしない', () => {
    expect(staffSource).toContain('matchStaffMember(members, user)')
    expect(staffSource).not.toContain('candidate.name === user.name')
    expect(actionsSource).toContain('function matchStaffMember')
  })

  it('突合に失敗した行は「要確認」と出す', () => {
    expect(staffSource).toContain('要確認')
  })
})
