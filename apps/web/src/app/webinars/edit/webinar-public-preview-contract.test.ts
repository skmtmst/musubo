import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(path.join(__dirname, '../../../v8/webinar-edit/edit.tsx'), 'utf8')

/*
 * 管理画面 ウェビナー公開ページ確認。公開中で検査済みの URL だけを別窓で開くこと・開けない理由の言い分けは
 * webinar-edit-contract-react.test.tsx と webinar-unsaved-flow-react.test.tsx、公開ページのテストは
 * review-v8-react.test.tsx が描いて押して見る。ここは戻してはいけない形の見張りだけ。
 */
describe("管理画面 ウェビナー公開ページ確認の契約", () => {

  it('選んでいるアカウントからは公開先を作らない', () => {
    expect(PAGE).not.toContain('selectedAccountId')
  })

  it('内部の管理APIやslugだけの相対URLを公開先にしない', () => {
    expect(PAGE).not.toContain('href={`/webinar/${webinar.slug}`')
    expect(PAGE).not.toContain('/api/liff/webinars/${webinar.slug}')
  })
})
