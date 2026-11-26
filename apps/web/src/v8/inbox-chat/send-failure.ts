import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { ApiError } from '@/lib/api'
import { formatTime } from '@/lib/format'
import type { InsertTokenNames } from '@/components/shared/insert-tokens'
import { unresolvedSendFailureText } from './chat-inserts'

type SendFailureData = {
  retryable?: boolean
  nextRetryAt?: string | null
}

/**
 * 再送できる時刻を、運用者が待てる単位で言い換える。
 *
 * ISOの時刻をそのまま出しても読めないので、近ければ「約N分後」、
 * 遠ければ日本時間の時刻にする。解釈できない値は待機時間なしとして扱う。
 */
function describeWaitUntil(nextRetryAt: string | null | undefined, now: Date): string | null {
  if (!nextRetryAt) return null
  const target = Date.parse(nextRetryAt)
  if (!Number.isFinite(target)) return null
  const diffMs = target - now.getTime()
  if (diffMs <= 0) return 'まもなく'
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes <= 90) return `約${minutes}分後`
  const jst = formatTime(target)
  return `${jst}（日本時間）`
}

/**
 * 個別送信の失敗を、運用者が次に取る行動へ言い換える。
 *
 * Workerの構造化code（N-023契約）で 409・429・通信障害・再試行不能を
 * 区別し、429系は安全な待機時間まで添える。文言は機械codeから作り、
 * 例外本文や内部文言は画面へ出さない。
 */
export function describeSendFailure(error: unknown, now: Date = new Date(), names: InsertTokenNames = {}): string {
  if (!(error instanceof ApiError)) {
    return '通信状況を確認して、もう一度送信してください。'
  }
  const data = error.data as SendFailureData | undefined

  if (error.status === 409) {
    if (error.code === 'OUTBOUND_SEND_IN_PROGRESS') {
      return '同じメッセージを送信または結果を確認中です。少し待ってから会話を読み直してください。'
    }
    if (error.code === 'LINE_DELIVERY_UNKNOWN' || error.code === 'OUTBOUND_CONFIRMATION_FAILED') {
      return 'LINEに届いたか確認できない送信があります。二重送信を防ぐため自動再送を止めました。LINE側の履歴を確認してください。'
    }
    if (data?.retryable === false) {
      return 'この送信はLINEに受け付けられませんでした。内容を見直して送り直してください。'
    }
    const wait = describeWaitUntil(data?.nextRetryAt, now)
    if (wait) {
      return `LINEの送信制限のため、${wait}にもう一度送信してください。`
    }
    return 'ほかの担当者による更新または返信を確認しました。送信せず、会話を読み直してください。'
  }

  if (error.status === 429) {
    const wait = describeWaitUntil(data?.nextRetryAt, now)
    return wait
      ? `LINEの送信制限に達しています。${wait}にもう一度送信してください。`
      : 'LINEの送信制限に達しています。少し待ってからもう一度送信してください。'
  }

  // N-026: 差し込みが残ったままだと送信口が止める。LINEの拒否ではなく
  // 本文側の問題なので、直す差し込みを札の名前で伝える（生の {{…}} は出さない）。
  if (error.code === 'UNRESOLVED_TEMPLATE_VARIABLES') {
    return unresolvedSendFailureText((error.data as { variables?: string[] } | undefined)?.variables ?? [], names)
  }

  if (error.status === 400) {
    /*
     * INBOX-29: 入力の検証文(文字数・必須項目など)はLINEの拒否ではない。
     * 口が返す検証済みの文言をそのまま伝え、文言が無いときだけ
     * 従来の言い換えを使う。検証文は fetchApi が内部文言を除いた
     * 安全なものだけを載せる。
     */
    const detail = japaneseDetailOf(error)
    return detail || 'LINEがこの送信を受け付けませんでした。内容を見直して送り直してください。'
  }

  if (error.status === 502) {
    const wait = describeWaitUntil(data?.nextRetryAt, now)
    return wait
      ? `LINE側で一時的な障害が起きています。${wait}にもう一度送信してください。`
      : 'LINE側で一時的な障害が起きています。時間をおいてもう一度送信してください。'
  }

  if (error.status === 503) {
    return 'LINEに届いたか確認できない状態です。二重送信を防ぐため自動再送を止めました。'
  }

  if (error.code === 'OUTBOUND_PREPARATION_FAILED') {
    return '送信の準備に失敗しました。時間をおいてもう一度送信してください。'
  }

  return 'メッセージの送信に失敗しました。時間をおいてもう一度送信してください。'
}
