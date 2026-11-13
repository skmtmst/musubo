import { describe, expect, it } from 'vitest'
import {
  canSubmitDecision,
  confidenceText,
  decisionNote,
  decisionText,
  failureOf,
  impactText,
  maskedText,
  NOT_AVAILABLE,
  reprocessText,
  statusText,
  strengthText,
} from './identity-view'

describe('本人照合の言い換え', () => {
  it('未取得と実値0を別の文字で出す', () => {
    expect(impactText({ key: 'orders', label: '注文', value: null, unit: '件', note: null }))
      .toBe(NOT_AVAILABLE)
    // 0 は「数えた結果が0」。未取得と同じ見せ方にしない。
    expect(impactText({ key: 'sent', label: '過去のLINE送信', value: 0, unit: '通', note: null }))
      .toBe('0通')
    expect(impactText({ key: 'orders', label: '注文', value: 24, unit: '件', note: null }))
      .toBe('24件')
    expect(impactText({ key: 'orders', label: '注文', value: 12345, unit: '件', note: null }))
      .toBe('12,345件')
  })

  it('マスクされていない値は来ない前提で、無い項目を「—（未取得）」にする', () => {
    expect(maskedText(null)).toBe(NOT_AVAILABLE)
    expect(maskedText('ta***@example.com')).toBe('ta***@example.com')
  })

  it('確からしさと根拠の強さを日本語で言う', () => {
    expect(confidenceText('very_high')).toBe('とても高い')
    expect(confidenceText('low')).toBe('低い')
    expect(strengthText('strong')).toBe('決め手になる')
    expect(strengthText('weak')).toBe('参考')
  })

  it('候補の状態を内部名のまま出さない', () => {
    expect(statusText('pending')).toBe('未判定')
    expect(statusText('invalidated')).toBe('取り下げ')
    for (const status of ['pending', 'linked', 'different', 'deferred', 'invalidated'] as const) {
      expect(statusText(status)).not.toMatch(/[a-z_]/)
    }
  })

  it('「別人」が候補へ戻らないことを言う', () => {
    // ここを書かないと「あとで見直せる」と思って押される。
    expect(decisionNote('different')).toBe('別人として記録し、根拠が変わるまで候補へ戻しません。')
    expect(decisionText('different')).toBe('別人として記録する')
    expect(decisionNote('linked')).toContain('元の友だち・注文は消えません')
  })

  it('再処理の既定が過去へ副作用を出さないことを言う', () => {
    expect(reprocessText('future_only')).toContain('再送しません')
  })
})

describe('失敗の言い換え', () => {
  it('権限不足を「読み込み失敗」に混ぜない', () => {
    const forbidden = failureOf({ status: 403, code: 'FORBIDDEN' })
    expect(forbidden.kind).toBe('forbidden')
    expect(forbidden.title).toBe('この候補を見る権限がありません')
  })

  /*
   * M014：重複候補はオーナー・管理者だけが開ける（権限表に担当者の鍵は無い）。
   * 付けられない鍵への「追加を依頼」ではなく、開いてもらう案内にする。
   */
  it('権限不足は「開いてもらう」案内にし、付与の約束をしない（M014）', () => {
    const forbidden = failureOf({ status: 403, code: 'FORBIDDEN' })
    expect(forbidden.description).toContain('オーナーか管理者の方に開いてもらってください')
    expect(forbidden.description).not.toContain('追加を依頼')
  })

  it('版が競合したら読み直しを促す', () => {
    const stale = failureOf({ status: 409, code: 'STALE_CANDIDATE' })
    expect(stale.kind).toBe('stale')
    expect(stale.description).toContain('読み直して')
    expect(failureOf({ status: 409, code: 'CANDIDATE_ALREADY_DECIDED' }).kind).toBe('stale')
  })

  it('機械コードが取れなくても、409を「先を越された」として扱う', () => {
    /*
     * `extractApiErrorCode` はWorkerの `code`（大文字）を拾わないので、
     * 画面へ届く `ApiError.code` は `undefined` になる。コードで見分ける
     * 書き方だと、ここが黙って「表示できませんでした」に落ちる。
     */
    expect(failureOf({ status: 409, code: undefined }).kind).toBe('stale')
    expect(failureOf({ status: 409 }).title).toBe('先に別の判定が入っています')
  })

  it('内部の記号をそのまま画面へ出さない', () => {
    for (const input of [
      { status: 500, code: 'INTERNAL_ERROR' },
      { status: 409, code: 'IDENTITY_USER_CONFLICT' },
      null,
    ]) {
      const failure = failureOf(input)
      expect(`${failure.title}${failure.description}`).not.toMatch(/[A-Z_]{4,}/)
    }
  })
})

describe('判定を送ってよいか', () => {
  it('理由が空のままでは送れない', () => {
    expect(canSubmitDecision({ canDecide: true, reason: '', busy: false })).toBe(false)
    expect(canSubmitDecision({ canDecide: true, reason: '   ', busy: false })).toBe(false)
    expect(canSubmitDecision({ canDecide: true, reason: '同じ電話番号', busy: false })).toBe(true)
  })

  it('判定できない候補と送信中は送れない', () => {
    expect(canSubmitDecision({ canDecide: false, reason: '同じ電話番号', busy: false })).toBe(false)
    expect(canSubmitDecision({ canDecide: true, reason: '同じ電話番号', busy: true })).toBe(false)
  })
})
