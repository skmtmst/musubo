import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { describeSendFailure } from '@/v8/inbox-chat/send-failure'

const NOW = new Date('2026-09-17T00:00:00.000Z')

describe('describeSendFailure: N-028/N-029 失敗理由の言い換え', () => {
  it('同時送信の409は「確認中」と伝え、読み直しを促さない', () => {
    const error = new ApiError(409, '送信中', 'OUTBOUND_SEND_IN_PROGRESS')
    expect(describeSendFailure(error, NOW)).toContain('確認中')
  })

  it('送達不明の409は二重送信を防ぐ止まり方を伝える', () => {
    for (const code of ['LINE_DELIVERY_UNKNOWN', 'OUTBOUND_CONFIRMATION_FAILED']) {
      const text = describeSendFailure(new ApiError(409, '', code, { retryable: false }), NOW)
      expect(text).toContain('二重送信')
      expect(text).not.toContain('もう一度送る')
    }
  })

  it('再試行不能の409は内容の見直しを伝える', () => {
    const error = new ApiError(409, '', 'LINE_REQUEST_REJECTED', { retryable: false, nextRetryAt: null })
    expect(describeSendFailure(error, NOW)).toContain('受け付けられませんでした')
  })

  it('再送待ちの409は待機時間を添える', () => {
    const error = new ApiError(409, '', 'LINE_RATE_LIMITED', {
      retryable: true,
      nextRetryAt: '2026-09-17T00:05:00.000Z',
    })
    expect(describeSendFailure(error, NOW)).toContain('約5分後')
  })

  it('dataの無い409は従来の読み直し案内を維持する', () => {
    const error = new ApiError(409, 'revision conflict')
    expect(describeSendFailure(error, NOW)).toContain('読み直してください')
  })

  it('429は待機時間つきの送信制限として伝える', () => {
    const error = new ApiError(429, '', 'LINE_RATE_LIMITED', {
      retryable: true,
      nextRetryAt: '2026-09-17T00:10:00.000Z',
    })
    const text = describeSendFailure(error, NOW)
    expect(text).toContain('送信制限')
    expect(text).toContain('約10分後')
  })

  it('待機時間の無い429は安全な「少し待って」へ落とす', () => {
    const error = new ApiError(429, '', 'LINE_RATE_LIMITED')
    expect(describeSendFailure(error, NOW)).toContain('少し待って')
  })

  it('400はLINEに受け付けられなかった旨を伝える', () => {
    const error = new ApiError(400, '', 'LINE_REQUEST_REJECTED')
    expect(describeSendFailure(error, NOW)).toContain('受け付けませんでした')
  })

  // 差し込みの未解決はLINEの拒否ではなく本文側の問題。直す差し込みを札の名前で伝え、生の記号は出さない。
  it('差し込み未解決の400は差し込みの名前と修正方法を伝える', () => {
    const error = new ApiError(400, '', 'UNRESOLVED_TEMPLATE_VARIABLES', {
      variables: ['pet_name', 'var.guest_count', 'var.closure_datetime'],
    })
    const text = describeSendFailure(error, NOW)
    expect(text).toBe('「不明な差し込み」「人数」「休業の日時」が入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。')
    expect(text).not.toContain('{{')
    expect(text).not.toContain('LINE')
  })

  it('差し込み未解決の400は、受信箱が読んだ共通情報の名前で言う', () => {
    const error = new ApiError(400, '', 'UNRESOLVED_TEMPLATE_VARIABLES', { variables: ['var.closure_datetime'] })
    expect(describeSendFailure(error, NOW, { vars: { closure_datetime: '臨時休業の日時' }, varsComplete: true }))
      .toBe('「臨時休業の日時」が入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。')
  })

  it('差し込みの名前が分からない未解決の400も、記号を出さずに直し方を伝える', () => {
    const text = describeSendFailure(new ApiError(400, '差し込みを解決できません: {{var.x}}', 'UNRESOLVED_TEMPLATE_VARIABLES'), NOW)
    expect(text).toBe('差し込みの値が入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。')
  })

  it('502は一時障害として待機時間つきで伝える', () => {
    const error = new ApiError(502, '', 'LINE_TEMPORARILY_UNAVAILABLE', {
      retryable: true,
      nextRetryAt: '2026-09-17T00:03:00.000Z',
    })
    const text = describeSendFailure(error, NOW)
    expect(text).toContain('一時的な障害')
    expect(text).toContain('約3分後')
  })

  it('503は送達不明として自動再送を止める', () => {
    const error = new ApiError(503, '', 'OUTBOUND_CONFIRMATION_FAILED')
    expect(describeSendFailure(error, NOW)).toContain('自動再送を止めました')
  })

  it('準備失敗の500はLINEの障害と混ぜずに伝える', () => {
    const error = new ApiError(500, '', 'OUTBOUND_PREPARATION_FAILED')
    const text = describeSendFailure(error, NOW)
    expect(text).toContain('準備に失敗')
    expect(text).not.toContain('LINE側で一時的')
  })

  it('API以外の失敗は通信状況の確認を促す', () => {
    expect(describeSendFailure(new TypeError('fetch failed'), NOW)).toContain('通信状況')
  })
})
