import type { CommonVarFailure } from '@/components/shared/common-var-test-failure'
import { formatNumber } from '@/lib/format'
export type TestSendView = {
  kind: 'success' | 'partial' | 'error'
  message: string
  commonVars?: CommonVarFailure[]
}

/**
 * 送れなかった人がいる結果を、成功の緑色で表示しない。
 *
 * **HTTP の成功と配信の成功は別物。** API は全員に失敗しても
 * `success: true` で `sent: 0, failed: N` を返すので、届いた数と
 * 届かなかった数で分ける。1名も届かなければエラー、一部だけなら要対応。
 */
export function testSendResult(sent: number, failed: number, at: string): TestSendView {
  if (sent <= 0 && failed > 0) {
    return {
      kind: 'error',
      message: `${at} テスト送信できませんでした (${formatNumber(failed)}名すべてに届きませんでした)`,
    }
  }
  if (failed > 0) {
    return {
      kind: 'partial',
      message: `${at} 一部を送信できませんでした (${formatNumber(sent)}名成功, ${formatNumber(failed)}名失敗)`,
    }
  }
  if (sent <= 0) {
    return {
      kind: 'error',
      message: `${at} テスト送信できませんでした（送信先を確認してください）`,
    }
  }
  return { kind: 'success', message: `${at} テスト送信済み (${formatNumber(sent)}名成功)` }
}

export function testSendFailure(at: string): TestSendView {
  return { kind: 'error', message: `${at} テスト送信に失敗しました` }
}
