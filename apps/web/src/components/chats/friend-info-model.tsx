'use client'
import { SUPPORT_STATUS_LABELS } from '@/components/shared/status-pill'
import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { type CustomerMileageState } from '@/components/shared/customer-info-mileage'
import { type FriendUpcoming } from '@/lib/api'
import { formAnswerText } from '@/lib/form-answer'
import type { FriendField } from '@line-crm/shared'
import { useState } from 'react'
import { type ChatStatusInfo } from './friend-info-types'

export const DETAIL_SECTIONS = [
  { key: 'profile', label: 'プロフィール' },
  { key: 'names', label: '基本情報' },
  { key: 'tags', label: 'タグ' },
  { key: 'support', label: '次の対応' },
  { key: 'starred', label: '★つき情報' },
  { key: 'richMenu', label: 'リッチメニュー' },
  { key: 'metadata', label: '友だち情報' },
  { key: 'forms', label: 'フォーム回答' },
  { key: 'mileage', label: 'マイル' },
] as const

export type DetailSectionKey = (typeof DETAIL_SECTIONS)[number]['key']

/*
 * `Xi4x9` に描かれた、運用者が選ぶ7つの表示単位。
 *
 * INBOX-04: スイッチの名前は、実際に消える節の見出しと同じ言葉にする。
 * 以前は「予約・EC」でリッチメニュー、「内部メモ」で友だち情報と
 * フォーム回答が隠れ、何が消えるか名前から読めなかった。
 */
export const DETAIL_SETTING_GROUPS: Array<{
  key: string
  label: string
  sections: DetailSectionKey[]
}> = [
    { key: 'basic', label: 'プロフィール・基本情報', sections: ['profile', 'names'] },
    { key: 'tags', label: 'タグ', sections: ['tags'] },
    { key: 'assignment', label: '次の対応', sections: ['support'] },
    { key: 'next', label: '★つき友だち情報', sections: ['starred'] },
    { key: 'booking', label: 'リッチメニュー', sections: ['richMenu'] },
    { key: 'mileage', label: 'マイル', sections: ['mileage'] },
    { key: 'memo', label: '友だち情報・フォーム回答', sections: ['metadata', 'forms'] },
  ]

export const DEFAULT_SECTION_ORDER = DETAIL_SETTING_GROUPS.flatMap((group) => group.sections)

/** ★V8 顔の下の「2025年8月14日に友だち追加」。日本時間の暦で書く。 */
export function formatAddedDate(iso: string | null): string {
  if (!iso) return '友だち追加日は未登録'
  const d = japanCalendar(new Date(iso))
  if (Number.isNaN(d.getTime())) return '友だち追加日は未登録'
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日に友だち追加`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const statusLabels: Record<NonNullable<ChatStatusInfo['status']>, { label: string; className: string }> = {
  unread: { label: SUPPORT_STATUS_LABELS.unread, className: 'bg-status-danger-selected text-danger' },
  in_progress: { label: SUPPORT_STATUS_LABELS.in_progress, className: 'bg-warning-bg text-warning' },
  on_hold: { label: SUPPORT_STATUS_LABELS.on_hold, className: 'bg-action-soft text-action' },
  resolved: { label: SUPPORT_STATUS_LABELS.resolved, className: 'bg-success-bg text-success' },
}

/*
 * Render a metadata value safely as text.
 * INBOX-07: 配列やオブジェクトも生のJSONではなく読める形へ畳む。
 * 値の中身（URL・長文）はそのまま出し、枠の中で安全に折り返す。
 */
export function renderValue(value: unknown): string {
  if (typeof value === 'string' && value.includes('[object Object]')) return formAnswerText(value)
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const items = value.map((item) => renderValue(item)).filter((item) => item !== '-')
    return items.length > 0 ? items.join('、') : '-'
  }
  if (typeof value === 'object') {
    try {
      const entries = Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${key}: ${renderValue(item)}`)
      return entries.length > 0 ? entries.join('、') : '-'
    } catch {
      return '-'
    }
  }
  return String(value)
}

/**
 * 省略表示の名前や値。押すと(キーボードでも)全文へ広げられる。
 * 狭いサイドバーでは長い名前が切れるので、切れたまま読めない
 * 状態にしないためのもの(U008)。
 */
export function ExpandableText({ value, className = '', empty = '未登録' }: {
  value: string | null
  className?: string
  empty?: string
}) {
  const [expanded, setExpanded] = useState(false)
  /*
   * ★V8：空の「未登録」はほかの値と同じ大きさ（13px）・普通の太さで、薄い色にする。
   * 大きさを付けないと親の 16px を継いで、値より大きく見えていた（オーナー指摘）。
   */
  if (!value) return <span className="text-ink-faint text-label font-medium">{empty}</span>
  return (
    <button
      type="button"
      title={value}
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      className={`${className} min-w-0 text-left ${expanded ? 'whitespace-normal break-all' : 'truncate'}`}
    >
      {value}
    </button>
  )
}

/*
 * IDEA-02: 「次の予定」の行から詳細へ進む先。
 * kind ごとに専用の画面へ。個別相談は専用の一覧・詳細画面がまだ無いので、
 * 友だち詳細（相談の履歴が出る側）へ誘導する。
 */
export function upcomingBookingHref(booking: NonNullable<FriendUpcoming['nextBooking']>, friendId: string): string {
  if (booking.kind === 'booking') return `/booking/bookings/detail?id=${booking.id}`
  if (booking.kind === 'event_booking') return `/events/bookings?id=${booking.id}`
  return `/friends/detail?id=${friendId}`
}

export function upcomingDeliveryHref(delivery: NonNullable<FriendUpcoming['nextAutoDelivery']>): string {
  return delivery.kind === 'scenario'
    ? `/scenarios/detail?id=${delivery.id}`
    : `/reminders/detail?id=${delivery.id}`
}

export type MileageState = CustomerMileageState

/*
 * INBOX-05/07: ★つき項目と、友だち情報の項目名（内部キーではなく
 * 画面に出す名前）は friend_fields の定義から取る。
 * 友だち詳細の「情報」欄と同じ口・同じ名前にそろえる。
 */
export type FriendFieldsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; items: FriendField[]; hiddenPersonalCount: number }

// リッチメニュー — loading / error / data を区別して、null=未設定 を取得失敗と
// 混同しないようにする。Codex review (P3) の指摘で導入。
export type RichMenuState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; id: string | null; name: string | null; isDefault: boolean }

/*
 * IDEA-02: 次回予約と次の確定した自動配信。
 * サーバーは確定した予定だけを返す（動的条件の将来配信は含まない）。
 * 「予定なし」(null) と「未取得」(error / *_Error) を分けて出し、
 * 失敗はこのパネル内の再試行でやり直せるようにする。
 */
export type UpcomingState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; data: FriendUpcoming }

export type PurchaseState =
  | { kind: 'loading' }
  | { kind: 'empty'; reason: string }
  | { kind: 'data'; total: number; count: number; items: Array<{ id: string; title: string; amount: number | null; at: string }> }
