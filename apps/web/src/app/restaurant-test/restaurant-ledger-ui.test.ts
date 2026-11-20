import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const ledgerSource = ['reservations', 'list', 'dialogs'].map(name => read('../../v8/restaurant/reservations/' + name + '.tsx')).join('\n') + read('../../v8/restaurant-reservations/detail-dialog.tsx')
const dashboardSource = read('../../v8/restaurant/dashboard/stores.tsx')
const approvalSource = read('../../v8/restaurant/approvals/approvals.tsx')
const apiSource = readFileSync(new URL('../../lib/restaurant-test-api.ts', import.meta.url), 'utf8')

describe('飲食店向け予約台帳（R103・R107）', () => {
  test('台帳取得に期間・状態・件数・開始位置を渡し総件数と更新口を持つ', () => {
    for (const token of [
      'reservationFrom',
      'reservationStatus',
      'reservationLimit',
      'reservationOffset',
      'reservationTotal',
      'updateReservation:',
      "method: 'PATCH'",
    ]) {
      expect(apiSource).toContain(token)
    }
  })

  test('初期表示は今後の予約で期間・状態の絞り込みとページ送りがある', () => {
    for (const label of [
      '今後の予約',
      'すべての期間',
      '過去の予約',
      '有効のみ',
      '取消・無断のみ',
      '予約台帳のページ送り',
    ]) {
      expect(ledgerSource).toContain(label)
    }
    expect(ledgerSource).toContain('from: today.from')
  })

  test('予約行に変更・取消・復活があり取消は確認して在庫を戻す', () => {
    for (const label of [
      '変更する',
      '終了日時',
      'この予約を取り消しますか？',
      'その時間帯の卓は空きに戻ります',
      '復活',
      '予約を有効に戻しました',
    ]) {
      expect(ledgerSource).toContain(label)
    }
    expect(ledgerSource).toContain("restaurantTestApi.updateReservation(accountId, id, { status: 'cancelled', ...(reason ? { cancellationCause: reason } : {}), expectedVersion:")
  })
})

describe('飲食店向けダッシュボード（R104）', () => {
  test('今日以降の有効予約だけを集計し固定客単価を使わない', () => {
    for (const label of [
      '今日以降の有効予約',
      'コース単価×人数の合計です',
      '固定の客単価では計算しません',
      'title="予約数"',
      'title="売上予測"',
    ]) {
      expect(dashboardSource).toContain(label)
    }
    expect(dashboardSource).not.toContain('guestCount * 8800')
  })

  test('店舗のLINE異常も要確認に数える', () => {
    expect(dashboardSource).toContain("line_status === 'error'")
  })
})

describe('飲食店向け承認（R105）', () => {
  test('承認カードに変更内容の本文・前後を見せる', () => {
    for (const label of [
      '変更内容',
      '投稿の内容を読み込めませんでした',
      '配信の内容を読み込めませんでした',
      '改定の前後が記録されていません',
      'payload_json',
    ]) {
      expect(approvalSource).toContain(label)
    }
    expect(apiSource).toContain('payload_json')
  })
})
