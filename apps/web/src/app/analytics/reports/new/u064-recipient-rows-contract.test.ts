import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PICKER = readFileSync(new URL('../../../../components/shared/entity-picker.tsx', import.meta.url), 'utf8')
const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

/**
 * #975 U064: 通知先の氏名・役割を細いチップにしない。
 * 390pxで1人1行、氏名が主情報、役割は下段に分かれて取り違えない。
 */
describe('レポート通知先の行リスト（#975 U064）', () => {
  it('選択候補は1人1行で、選択済みの宛先を別に確認できる', () => {
    expect(PAGE).toContain('aria-label="レポートを受け取る人"')
    expect(PAGE).not.toContain('rounded-pill flex items-center gap-2 border px-3 py-2')
    expect(PAGE).toContain('divide-y')
  })

  it('氏名は主情報として幅を確保し、省略時も title で全文を見られる', () => {
    expect(PICKER).toContain('title={item.name}')
    expect(PICKER).toContain('styles.multiNameText')
    expect(PAGE).toContain('ROLE_LABEL[person.role]')
  })
})
