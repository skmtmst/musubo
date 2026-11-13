/*
 * NEN配信 V8 の表示の言葉と日付。
 *
 * 現役の一覧・編集の表示を共用する。日時の入力と保存は column-form.ts を使う。
 */
import type { NenCampaignSetting } from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { formatDate as polishFormatDate } from '@/lib/format'


export type NenTab = 'auto' | 'columns' | 'history' | 'paused'

export type NenCoupon = {
  isEnabled: boolean
  codePrefix: string
  benefitLabel: string
  discountAmount: number
  validityDays: number
  leapYearPolicy: 'feb28' | 'mar1' | 'skip'
}

export type NenKpis = {
  monthLabel: string
  sentThisMonth: number | null
  sentLastMonth: number | null
  openRate: number | null
  orders: number | null
  orderAmount: number | null
  undelivered: number | null
  blocked: number
  unfollowed: number
}

export type ColumnDeliveryPlan = { when: 'now' | 'schedule'; scheduledAt: string }

export type FriendOption = { id: string; displayName: string | null }

const fixedTimingByCampaign: Record<string, string> = {
  column: '予約した日時',
  birthday_coupon: '誕生日の3日前 10:00',
}

/** 配信の起点（発送後と誕生日で言い分ける）。日数・時刻は設定値から作る。 */
export function formatCampaignTiming(setting: Pick<NenCampaignSetting, 'campaignKey' | 'delayDays' | 'deliveryTime'>): string {
  const known = fixedTimingByCampaign[setting.campaignKey]
  if (known) return known
  if (setting.delayDays === 0) return `発送当日 ${setting.deliveryTime}`
  return `発送から${setting.delayDays}日後 ${setting.deliveryTime}`
}

const audienceByCampaign: Record<string, string> = {
  arrival_check: '注文した会員',
  review_request: '注文した会員',
  cross_sell: '注文した会員',
  column: '友だち 全員',
  birthday_coupon: '誕生日を登録したペットの飼い主',
}

/** 「対象」列。だれに届く配信かを運用の言葉で。 */
export function formatCampaignAudience(setting: Pick<NenCampaignSetting, 'campaignKey' | 'category'>): string {
  return audienceByCampaign[setting.campaignKey] ?? (setting.category === 'birthday' ? 'ペットを登録した会員' : '注文した会員')
}

export const statusLabel: Record<string, string> = {
  pending: 'これから送ります',
  processing: '送信中',
  sent: '送りました',
  skipped: '対象外',
  failed: '届きませんでした',
  cancelled: '取り消し済み',
}

// skipped のうち運用で直せる理由（接続のやり直し・配信のオン戻し・フォームの選び直し）。
const skippedFixableReasons = new Set(['line_account_unavailable', 'campaign_disabled', 'campaign_form_unavailable'])

/** 再送できるのは上限まで失敗した記録と、直せる理由で止まった記録だけ。最終判断はサーバ。 */
export function canRetryDelivery(delivery: { status: string; attempts: number; unmetReasonCode: string | null }): boolean {
  if (delivery.status === 'failed') return delivery.attempts >= 5
  if (delivery.status !== 'skipped') return false
  return delivery.unmetReasonCode !== null && skippedFixableReasons.has(delivery.unmetReasonCode)
}

export const skippedNoRetryNote: Record<string, string> = {
  friend_unavailable: '友だち側の事情のため、この記録は再送できません。',
  recipient_changed: '確認したLINE宛先が変わったため、この記録は再送できません。',
  campaign_snapshot_missing: '予約内容が残っていないため、この記録は再送できません。',
  line_account_mismatch: 'アカウントが一致しないため、この記録は再送できません。',
  campaign_form_already_submitted: 'すでに回答済みのため、この記録は再送しません。',
  frequency_suppressed: '近い時期の同じ配信を代表1件にまとめたため、この記録は再送しません。',
  order_cancelled: '注文が取り消されたため、この記録は再送しません。注文の状態は「EC連携」の取り込みの記録で確認できます。',
  order_refunded: '注文が返金になったため、この記録は再送しません。注文の状態は「EC連携」の取り込みの記録で確認できます。',
}

export function deliveryTriggerLabel(campaignKey: string): string {
  const labels: Record<string, string> = {
    order_confirmed: '注文が確定', shipping_confirmed: '発送を登録', arrival_check: '発送後の到着確認',
    review_request: '発送後の口コミ依頼', cross_sell: '発送後のご案内', column: 'コラムの予約', birthday_coupon: 'ペットの誕生日',
  }
  return labels[campaignKey] ?? '配信の決めごと'
}

export function num(value: number | null | undefined): string {
  return value == null ? '—' : formatNumber(value)
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** 表の公開日「9/26」「8/08」（日本時間・日は2桁）。読めなければ「—」。 */
export function jstMonthDay(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

/** 「9/20 10:00」。読めなければ「—」。 */
export function jstDateTime(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list-time', fallback: '—' })
}

/* 予約日時の決めごとはコラムを書く画面と同じもの（column-form.ts）を使う。 */
export { isPastScheduledAt, publishedAtIso } from './column-form'
