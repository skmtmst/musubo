import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAYMENT = readFileSync(new URL('../../v8/affiliates/payment.tsx', import.meta.url), 'utf8')
const PAYMENT_DIALOGS = readFileSync(new URL('../../v8/affiliates/payment-dialogs.tsx', import.meta.url), 'utf8')
const DIALOGS = readFileSync(new URL('../../v8/affiliates/dialogs.tsx', import.meta.url), 'utf8')
const API = readApiSource(new URL('../../lib/api.ts', import.meta.url), 'utf8')
const PAYOUTS = readFileSync(new URL('../../../../worker/src/routes/affiliate-payouts.ts', import.meta.url), 'utf8')

describe("管理画面 支払いの追記台帳契約", () => {
  it('LINEアカウントと締め期間を渡して締め対象を読む', () => {
    expect(API).toContain('settlementPreview:')
    expect(API).toContain('/api/affiliate-settlements/preview?')
    expect(PAYOUTS).toContain("'/api/affiliate-settlements/preview'")
    expect(PAYMENT).toContain('api.affiliates.settlementPreview(accountId, period)')
    expect(PAYMENT).toContain('currentSettlementPeriod()')
  })

  it('締め・明細・振込バッチ・再認証つきCSVを実APIへ接続する', () => {
    for (const word of [
      'api.affiliates.closeSettlement',
      'api.affiliates.createStatement',
      'api.affiliates.createPayoutBatch',
      'api.affiliates.payoutStepUp',
      'api.affiliates.exportPayoutBatch',
      '支払明細をまとめて出す',
      '銀行用 CSV',
    ]) {
      expect(`${PAYMENT}\n${PAYMENT_DIALOGS}`).toContain(word)
    }
    expect(API).toContain("'Idempotency-Key': idempotencyKey")
    expect(API).toContain("'X-Step-Up-Token': stepUpToken")
    expect(API).toContain("purpose: 'affiliate.payout.export'")
    expect(PAYMENT).toContain('process.env.NEXT_PUBLIC_API_URL')
    expect(PAYMENT).toContain('statementKeys.current.get(item.affiliateId)')
    // R43: 締め直後はプレビュー、再開時は台帳の内訳から対象を取る。
    expect(PAYMENT).toContain('Promise.allSettled(statementTargets.map')
    expect(PAYMENT).toContain('}, key)')
    expect(PAYMENT_DIALOGS).toContain('exportKey)')
  })

  it('口座番号を管理画面へ返さず、登録状態だけを表示する', () => {
    expect(API).toContain('bankProfileRegistered: boolean')
    expect(PAYMENT).toContain('口座番号は本人だけに表示')
    expect(DIALOGS).toContain('口座番号は本人だけに表示します')
    expect(PAYMENT).not.toMatch(/1234567|accountNumber/)
    expect(DIALOGS).not.toMatch(/1234567|accountNumber/)
  })

  it('人ごとの内訳は実プレビューを読み、締め期間と登録状態を重ねる', () => {
    expect(DIALOGS).toContain('designNode="GqFTV"')
    expect(DIALOGS).toContain('api.affiliates.paymentPreview')
    expect(DIALOGS).toContain('api.affiliates.confirmPayment')
    expect(DIALOGS).toContain('periodTo ?? preview.closeDate')
    expect(DIALOGS).toContain('settlement?.bankProfileRegistered')
    expect(DIALOGS).toContain('api.affiliates.createStatement')
    /*
      NEXT-22: 明細作成とLINE通知は createStatement 1本の処理で分けられない。
      連動する2つのチェックは1つへまとめ、飾りのチェックマークは実状態に
      連動させる（OFFでもONに見える表示を残さない）。
      m21u: 素の input＋飾りアイコンを共通の Checkbox へ置き換えた。
      見た目は共通部品が実状態に連動させる。
    */
    expect(DIALOGS).toContain('支払明細を作成して、この方のLINEに知らせる')
    expect(DIALOGS).not.toContain('type="checkbox"')
    expect(DIALOGS).not.toContain('{issueStatement ? <Check size={12} /> : null}')
    expect(DIALOGS).toContain('支払いは確定しましたが、支払明細とLINE通知を作れませんでした')
    /*
      NEXT-23: プレビューが返さない却下件数・除外金額を固定値で補わない。
      無反応の「直す」は置かず、本人への依頼導線にする。
    */
    expect(DIALOGS).not.toContain('却下した2件')
    expect(DIALOGS).not.toContain('>直す<')
    expect(DIALOGS).toContain('本人にLINEで依頼する')
  })

  it('一覧と締め対象の返事を形検査してから画面へ入れる', () => {
    const settlementCheck = PAYMENT.indexOf('Array.isArray(settlement.data.affiliates)')
    const setPreview = PAYMENT.indexOf('setPreview(settlement.data)')
    expect(settlementCheck).toBeGreaterThan(-1)
    expect(PAYMENT).toContain('!summaries.success || !Array.isArray(summaries.data) || !current.success')
    expect(PAYMENT).toContain('setItems(summaries.data)')
    expect(setPreview).toBeGreaterThan(settlementCheck)
  })

  it('明細発行は1人失敗で全体失敗にせず、人ごとに結果を出す（#554 点検#505中8）', () => {
    expect(PAYMENT).toContain('Promise.allSettled')
    expect(PAYMENT).toContain('failedNames')
    expect(PAYMENT).toContain('もう一度押すと失敗分を試し直せます')
    expect(PAYMENT).not.toContain('await Promise.all(preview.affiliates.map')
  })

  it('振込用CSVは合言葉が空のまま送らない（#554 点検#505中8）', () => {
    // 合言葉は締め直後だけでなく再開時にも必要なため、無ければ払い出す。
    expect(PAYMENT).toContain('payoutKey || crypto.randomUUID()')
    expect(PAYMENT).toContain('disabled={!closed || operationBusy || Boolean(resumed?.batch)}')
  })
})
