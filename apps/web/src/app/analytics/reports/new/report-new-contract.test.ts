import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe("管理画面 URqOA 定期レポート作成", () => {
  it('設計の入力・予告・関係先を持つ', () => {
    expect(PAGE).toContain("'H5UoIu'")
  })

  it('通常・読込・空・失敗と権限を画面で分ける', () => {
    expect(PAGE).toContain('受け取るログインユーザーがいません')
    expect(PAGE).toContain('kind="empty"')
    // この出し分けは report-v8-react.test.tsx の動きと故障対照で確かめる。
    expect(PAGE).toContain('disabled={saving || !canManage || !hasRecipient || hasInvalidEmail}')
  })

  it('本物の設定APIへ接続し、未取得を0へ置き換えない', () => {
    expect(PAGE).not.toContain("|| 0")
  })

  it('宛先の初期値は空で、0件のときは作れない(点検#508の中1)', () => {
    // 例のアドレスが最初から入っていると、選んでいない相手へ送られる。
    expect(PAGE).not.toContain("useState(['report@example.com'])")
    // 受信者の先頭2件の自動チェックもしない。
    expect(PAGE).not.toContain('slice(0, 2)')
  })
})
