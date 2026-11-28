import type { Webinar, WebinarAnalytics, WebinarPublishValidation } from '@/lib/api'
import { formatNumber } from '@/lib/format'

/** 概要は実際の値と、読めていない理由を既存の説明にまとめる。 */
export function summaryRows(webinar: Webinar, analytics: WebinarAnalytics | null) {
  const hasVideo = Boolean(webinar.videoPrefix || webinar.videoMediaId)
  const reservations = analytics?.summary?.reservations
  const validReservations = typeof reservations === 'number' && Number.isSafeInteger(reservations) && reservations >= 0
  return [
    { label: '動画', value: hasVideo ? 'アップロード済み' : '未設定', note: hasVideo ? undefined : '動画が無いままでは友だちが視聴できません' },
    { label: '公開', value: webinar.status === 'active' ? '公開中' : webinar.status === 'draft' ? '下書き' : webinar.status === 'archived' ? 'アーカイブ' : '確認できません' },
    { label: '配信枠', value: `${formatNumber(webinar.schedule.length)}件`, note: webinar.schedule.length === 0 ? '枠が無いと「次の回」が出ません' : undefined },
    { label: '申込', value: validReservations ? `${formatNumber(reservations)}人` : '—', note: validReservations ? undefined : analytics ? '申込人数を確認できません' : 'まだ読み込んでいません' },
  ]
}

/*
 * R93: 設定サマリーと最終確認の文言は値に連動させる。未設定・未検証の
 * まま「確認しました」「追加」と出す固定文は置かない。
 */

function findCheck(validation: WebinarPublishValidation | null, key: string) {
  return validation?.checks.find((check) => check.key === key) ?? null
}

/** 最終確認の「アクション」行。視聴後アクションの検査結果をそのまま出す。 */
export function reviewActionSummaryText(validation: WebinarPublishValidation | null): string {
  const check = findCheck(validation, 'action_dependencies')
  if (!check) return '—'
  return check.detail || check.label
}

/** 設定サマリーのプレビュー文。通知・公開ページのテスト結果で分ける。 */
export function reviewTestSummaryBody(
  validation: WebinarPublishValidation | null,
  validationState: 'loading' | 'ready' | 'error',
): string {
  if (!validation) {
    return validationState === 'error'
      ? '公開前検査を読み込めませんでした。左の段からもう一度読み込んでください。'
      : '公開前検査を読み込んでいます。'
  }
  const pending: string[] = []
  if (findCheck(validation, 'notification_test')?.status !== 'passed') pending.push('通知のテスト送信')
  if (findCheck(validation, 'public_page_test')?.status !== 'passed') pending.push('公開ページの確認')
  return pending.length === 0
    ? '公開ページと通知のテスト結果を確認しました。'
    : `${pending.join('・')}が終わっていません。`
}

/** 設定サマリーの「監視」行。失敗の件数で分ける。 */
export function reviewMonitoringText(failures: number): string {
  return failures > 0 ? `${failures}件の要確認` : '問題なし'
}
