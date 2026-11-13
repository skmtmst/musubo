import { describe, expect, it } from 'vitest'
import {
  canSaveDeliveryPriorities,
  confidenceText,
  dateText,
  eventText,
  failureOf,
  groupByPurpose,
  mergedPersonIdOf,
  NOT_AVAILABLE,
  previewText,
  purposeText,
  sourceText,
  statusText,
  updateModeText,
} from './merged-person-view'

const priority = (
  purpose: 'broadcast' | 'reminder',
  friendId: string,
  rank: number,
  isActive = true,
) => ({
  purpose, friendId, lineAccountId: `account-${friendId}`,
  lineAccountName: `アカウント${friendId}`, priority: rank, isActive,
  reason: '理由',
})

describe('一覧の行から統合ユーザーを取り出す', () => {
  it('UIDでまとめた行だけ詳細を開ける', () => {
    // 一覧は `'uid:' || friends.user_id` を返す（users-grouped.ts の IDENTITY_KEY_SQL）。
    expect(mergedPersonIdOf({ identityKey: 'uid:merged-person-1', identityKeyKind: 'uid' }))
      .toBe('merged-person-1')
  })

  it('要確認・未連携の行には開く先が無い', () => {
    expect(mergedPersonIdOf({ identityKey: 'tok_abc', identityKeyKind: 'url_token' })).toBeNull()
    expect(mergedPersonIdOf({ identityKey: 'solo:friend-2', identityKeyKind: 'solo' })).toBeNull()
  })

  it('形が合わない行を無理に開かない', () => {
    expect(mergedPersonIdOf({ identityKey: 'identity-1', identityKeyKind: 'uid' })).toBeNull()
    expect(mergedPersonIdOf({ identityKey: 'uid:', identityKeyKind: 'uid' })).toBeNull()
  })
})

describe('未取得と取得できた値を分ける', () => {
  it('確からしさの未記録を0%にしない', () => {
    // null は「移行前の結び付きで記録していない」。0% ではない。
    expect(confidenceText(null)).toBe(NOT_AVAILABLE)
    expect(confidenceText(0)).toBe('0%')
    expect(confidenceText(92)).toBe('92%')
  })

  it('マスク済みの値が無ければ「—」にする', () => {
    expect(previewText(null)).toBe(NOT_AVAILABLE)
    expect(previewText('ta***@example.com')).toBe('ta***@example.com')
  })

  it('日時が読めなければ「—」にする', () => {
    expect(dateText(null)).toBe(NOT_AVAILABLE)
    expect(dateText('こわれた日付')).toBe(NOT_AVAILABLE)
    // JSTで読む。UTCのままだと日付が1日ずれる。
    expect(dateText('2026-08-28T15:30:00.000Z')).toContain('8月29日 00:30')
  })
})

describe('内部の記号を画面へ出さない', () => {
  it('状態・種別・用途・採用元を日本語で言う', () => {
    for (const text of [
      statusText('archived'), eventText('migration'), purposeText('transactional'),
      sourceText('friend_field'), updateModeText('auto'),
    ]) {
      expect(text).not.toMatch(/[a-z_]/)
    }
    expect(statusText('review')).toBe('確認待ち')
    expect(purposeText('broadcast')).toBe('一斉配信')
  })
})

describe('配信元の優先順', () => {
  it('用途ごとにまとめて、順位で並べる', () => {
    // 用途を混ぜると1位が2つあるように見える。
    const groups = groupByPurpose([
      priority('reminder', 'b', 2), priority('broadcast', 'b', 2),
      priority('broadcast', 'a', 1), priority('reminder', 'a', 1),
    ])
    expect(groups.map((g) => g.purpose)).toEqual(['broadcast', 'reminder'])
    expect(groups[0].rows.map((r) => r.friendId)).toEqual(['a', 'b'])
    expect(groups[1].rows.map((r) => r.friendId)).toEqual(['a', 'b'])
  })

  it('全部を「使わない」にしたときだけ、承知の印を要る', () => {
    const some = [priority('broadcast', 'a', 1), priority('broadcast', 'b', 2, false)]
    expect(canSaveDeliveryPriorities({ priorities: some, confirmedClearAll: false, busy: false }))
      .toBe(true)

    const none = [priority('broadcast', 'a', 1, false), priority('broadcast', 'b', 2, false)]
    expect(canSaveDeliveryPriorities({ priorities: none, confirmedClearAll: false, busy: false }))
      .toBe(false)
    expect(canSaveDeliveryPriorities({ priorities: none, confirmedClearAll: true, busy: false }))
      .toBe(true)
  })

  it('送信中は押せない', () => {
    const some = [priority('broadcast', 'a', 1)]
    expect(canSaveDeliveryPriorities({ priorities: some, confirmedClearAll: false, busy: true }))
      .toBe(false)
  })
})

describe('失敗の言い換え', () => {
  it('権限不足を「読み込み失敗」に混ぜない', () => {
    const forbidden = failureOf({ status: 403, code: 'FORBIDDEN' })
    expect(forbidden.kind).toBe('forbidden')
    expect(forbidden.title).toBe('この統合ユーザーを見る権限がありません')
  })

  it('版が競合したら読み直しを促す', () => {
    const stale = failureOf({ status: 409, code: 'STALE_PERSON' })
    expect(stale.kind).toBe('stale')
    expect(stale.title).toBe('別の人が先に変更しました')
    expect(stale.description).toContain('読み直して')
  })

  it('機械コードが取れなくても、409を版の競合として扱う', () => {
    /*
     * `extractApiErrorCode` はWorkerの `code`（大文字）を拾わないので、
     * 画面へ届く `ApiError.code` は `undefined` になる。コードで見分ける
     * 書き方だと、ここが黙って「表示できませんでした」に落ちる。
     */
    expect(failureOf({ status: 409, code: undefined }).kind).toBe('stale')
    expect(failureOf({ status: 409 }).title).toBe('別の人が先に変更しました')
  })

  it('内部の記号をそのまま画面へ出さない', () => {
    for (const input of [
      { status: 500, code: 'INTERNAL_ERROR' },
      { status: 422, code: 'EXPECTED_REVISION_REQUIRED' },
      null,
    ]) {
      const failure = failureOf(input)
      expect(`${failure.title}${failure.description}`).not.toMatch(/[A-Z_]{4,}/)
    }
  })
})
