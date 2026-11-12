import { describe, expect, it } from 'vitest'
import {
  APPROVAL_ORDER_STATUS_TEXT,
  CLICK_SUMMARY_LABEL,
  DUPLICATE_FLAG_TITLE,
  LINK_CODE_HEADING,
  NAME_UNAVAILABLE,
  ORDER_DUPLICATE_TITLE,
  PAYOUT_BATCH_STATE_TEXT,
  PAYOUT_RESULT_TEXT,
  REWARD_ENTRY_STATUS_TEXT,
  SETTLEMENT_STATE_TEXT,
  approvalReviewReasons,
  duplicateFlagHeading,
  duplicateFriendNameText,
  personNameText,
} from './affiliate-display'

describe('成果・アフィリエイトの言葉づかい', () => {
  it('名前が取れないときにIDの断片を出さない', () => {
    expect(personNameText('見本 141')).toBe('見本 141')
    expect(personNameText(null)).toBe(NAME_UNAVAILABLE)
    expect(personNameText(undefined)).toBe(NAME_UNAVAILABLE)
    // 空白だけの名前は「取れた」ことにしない。
    expect(personNameText('   ')).toBe(NAME_UNAVAILABLE)
    expect(NAME_UNAVAILABLE).toBe('名前を取得できませんでした')
  })

  it('見出しにデータベースの語を混ぜない', () => {
    for (const label of [CLICK_SUMMARY_LABEL, LINK_CODE_HEADING, DUPLICATE_FLAG_TITLE]) {
      expect(label).not.toMatch(/ref_tracking|ref_code|identity_key/i)
    }
    expect(CLICK_SUMMARY_LABEL).toBe('クリック')
    expect(LINK_CODE_HEADING).toBe('リンクコード')
    expect(DUPLICATE_FLAG_TITLE).toBe('同じ友だちの重複')
  })

  it('重複の見出しは件数を実値で書く', () => {
    expect(duplicateFlagHeading(1)).toBe('同じ友だちの重複（1件）')
    expect(duplicateFlagHeading(1200)).toBe('同じ友だちの重複（1,200件）')
    expect(duplicateFlagHeading(1)).not.toMatch(/identity_key/i)
  })

  it('重複の札は読み込み済みの名前から引き、引けなければ作らない', () => {
    const people = [
      { friendId: 'friend-4aaaaaaa', displayName: '見本 141' },
      { friendId: 'friend-5bbbbbbb', displayName: null },
    ]
    expect(duplicateFriendNameText('friend-4aaaaaaa', people)).toBe('見本 141')
    expect(duplicateFriendNameText('friend-5bbbbbbb', people)).toBe(NAME_UNAVAILABLE)
    // まだ読み込んでいないページの友だち。IDを代わりに出さない。
    expect(duplicateFriendNameText('friend-9zzzzzzz', people)).toBe(NAME_UNAVAILABLE)
    expect(duplicateFriendNameText('friend-9zzzzzzz', people)).not.toContain('friend-9')
  })

  it('注文・報酬・支払いの状態語に内部のコード名を出さない', () => {
    for (const map of [
      APPROVAL_ORDER_STATUS_TEXT,
      REWARD_ENTRY_STATUS_TEXT,
      SETTLEMENT_STATE_TEXT,
      PAYOUT_BATCH_STATE_TEXT,
      PAYOUT_RESULT_TEXT,
    ]) {
      for (const label of Object.values(map)) {
        // metadata のキー名・表名・列名は運用者に通じない。
        expect(label).not.toMatch(/metadata|order_number|ec_event|reward_entries|settlement|payout|_id\b/i)
      }
    }
    expect(ORDER_DUPLICATE_TITLE).toBe('同じ注文の重複')
    expect(APPROVAL_ORDER_STATUS_TEXT.refunded).toBe('返金済み')
    expect(APPROVAL_ORDER_STATUS_TEXT.cancelled).toBe('取り消し済み')
  })

  it('確認が必要な理由を集め、理由が無い成果だけが確認不要になる', () => {
    // 従来の「同じ友だちの重複」は引き続き確認対象。
    expect(approvalReviewReasons({ duplicateFlag: true, sameOrderDuplicate: false, orderStatus: null }))
      .toEqual(['同じ友だちの重複'])
    // 同じ注文の重複候補は根拠（注文）の名前で出す。
    expect(approvalReviewReasons({ duplicateFlag: false, sameOrderDuplicate: true, orderStatus: null }))
      .toEqual(['同じ注文の重複'])
    // 返金・取消済みの注文に由来する成果も確認対象。
    expect(approvalReviewReasons({ duplicateFlag: false, sameOrderDuplicate: false, orderStatus: 'refunded' }))
      .toEqual(['注文は返金済み'])
    expect(approvalReviewReasons({ duplicateFlag: false, sameOrderDuplicate: false, orderStatus: 'cancelled' }))
      .toEqual(['注文は取り消し済み'])
    // 理由が重なるときは全部出す。
    expect(
      approvalReviewReasons({ duplicateFlag: true, sameOrderDuplicate: true, orderStatus: 'refunded' }),
    ).toEqual(['同じ友だちの重複', '同じ注文の重複', '注文は返金済み'])
    // 通常の注文・フラグ無しは確認不要。
    expect(approvalReviewReasons({ duplicateFlag: false, sameOrderDuplicate: false, orderStatus: 'current' }))
      .toEqual([])
    expect(approvalReviewReasons({ duplicateFlag: false, sameOrderDuplicate: false, orderStatus: null }))
      .toEqual([])
    // 旧いWorkerの応答（項目自体が無い）は確認不要と同等に扱う。
    expect(approvalReviewReasons({ duplicateFlag: false })).toEqual([])
  })
})
