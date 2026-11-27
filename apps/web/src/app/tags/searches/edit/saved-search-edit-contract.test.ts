import { readUiSource } from '../../../../../scripts/test-ui-source.mjs'
const fs = { readFileSync: readUiSource }
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(path.join(process.cwd(), 'src/app/tags/searches/edit/page.tsx'), 'utf8')

describe('保存した検索の条件編集', () => {
  // 候補の取得・選択と失敗／0件は saved-search-options-rendered-cx6.test.tsx で確かめる。

  it('対応マークとシナリオを内部IDの自由入力へ戻さない', () => {
    expect(PAGE).toContain('condition.kind === \'mark\'')
    expect(PAGE).toContain('condition.kind === \'scenario\'')
    expect(PAGE).toContain('optionsWithCurrent(')
  })

  it('複製の失敗を黙らせず理由を出して画面に残す', () => {
    expect(PAGE).toContain('if (!res.success) { setError(res.error); return }')
    expect(PAGE).toContain('router.push(`/tags/searches/edit?id=${encodeURIComponent(res.data.id)}`)')
  })
})
