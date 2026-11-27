import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const GALLERY = readFileSync(new URL('../../v8/automations/templates.tsx', import.meta.url), 'utf8')
const API = readApiSource(new URL('../../lib/api.ts', import.meta.url), 'utf8')

describe("管理画面 25-1-C 見本から下書きを作る", () => {
  it('見本タブを実Nodeへ接続し、サーバーから使える見本だけを読む', () => {
    expect(PAGE).toContain("{ key: 'templates', label: '見本' }")
    expect(PAGE).toContain("tab === 'templates' ? <AutomationTemplatesV8 /> : <AutomationListV8 />")
  })

  it('見本選択は公開せず下書きを作り、その下書きの編集へ進む', () => {
    /*
     * DETAIL-13: 「これで作る」1回の操作ごとの冪等鍵を渡す。同じ操作の
     * 再試行だけが同じ下書きへ戻り、別の新規作成は別の下書きになる。
     * 鍵なしの呼び出しは Worker が断る（前の下書きへ戻る道を塞ぐ）。
     */
    /*
      **下書きは「ルールを作る」とは別の画面。** 白紙から作る `Rv8Jv` と
      出発点が違ううえ、同じ画面に混ぜると設計の骨格に下書き側の節が混ざり、
      どちらの画面を見ているのか読めなくなる（`design-structure.test.ts`）。
    */
    expect(API).toContain('/api/automation-templates/')
    expect(API).toContain('/api/automation-drafts/')
  })

  it('未取得・空・失敗を別にし、失敗時に下書きを作ったように見せない', () => {
    expect(GALLERY).toContain("'loading' | 'ready' | 'error'")
    expect(GALLERY).toContain('見本を表示できませんでした')
    expect(GALLERY).toContain('条件に合う見本はありません')
  })
})
