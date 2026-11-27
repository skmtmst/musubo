'use client'

import type { InsertTokenSpec } from '@/components/shared/insert-tokens'
import { formatNumber,formatDate as polishFormatDate } from '@/lib/format'
import { jstDateOffset } from '@/lib/jst-datetime'
import {
describeReminderTiming,
resolveReminderSendAt,
type ReminderDraftSettings,
type ReminderDraftStep,
type ReminderValidationResult
} from '@line-crm/shared'
import { useEffect,useState } from 'react'


/** リマインダの本文で札にする差し込み（{{date}} はリマインダでは予約日時）。 */
export const REMINDER_TOKENS: readonly InsertTokenSpec[] = [
  { token: '{{date}}', label: '予約日時', hint: '予約日時に置き換わります', icon: 'calendar' },
  { token: '{{meet_url}}', label: 'Google Meet の URL', hint: '予約の Google Meet の URL に置き換わります', icon: 'video' },
]

/*
 * ★V8 リマインダを作る・手順1の直し〜5と完了（src/v8 に一から書いた版）。
 * 板：（手順1の直し・競合）/ （対象者と止める条件）/
 *     ・（通知の中身 1440・1152）/ （配信予定）/
 *     （確認）/ （有効にした）。
 * 画面の枠は型（CreatePage）が持つ。動き（API・保存・競合・テスト送信・有効化）は
 * 既存のAPIと版管理を保持する。BEHAVIOR.md に一覧がある。
 */
export type V8Stage = 'basics' | 'target' | 'messages' | 'schedule' | 'confirm' | 'done'

function safeNonNegativeCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** 保存済みの対象人数。未取得を0にしない。現役の対象の段が使う。 */
export function reminderAudienceCounts(validation: ReminderValidationResult | null) {
  const matched = safeNonNegativeCount(validation?.audience?.matched)
  const excluded = safeNonNegativeCount(validation?.audience?.excluded)
  return {
    matched,
    excluded,
    total: matched == null || excluded == null ? null : matched + excluded,
  }
}

/** URLの?stage=を現役の手順へ対応させる。 */
export function stageFor(raw: string | null): V8Stage {
  switch (raw) {
    case 'basics':
      return 'basics'
    case 'target':
      return 'target'
    case 'preview':
    case 'schedule':
      return 'schedule'
    case 'test':
    case 'confirm':
      return 'confirm'
    case 'done':
      return 'done'
    default:
      return 'messages'
  }
}

export function countLabel(value: number | null, unit: string): string {
  const safe = safeNonNegativeCount(value)
  return safe == null ? `—${unit}` : `${formatNumber(safe)} ${unit}`
}

export const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土']

/** 「10/1（水）18:00」の形。 */
export function formatMd(value: Date | string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

/** 「10/1 18:00」の形（例の文の短い日時）。 */
export function formatShort(value: Date): string {
  return polishFormatDate(value, { style: 'detail' })
}

/** 「10月2日(木) 14:00」の形。 */
export function formatJpDay(value: Date): string {
  return polishFormatDate(value, { style: 'detail' })
}

/** 届く日時の例に使う見本の基準日。日本時間で3日後の14:00。 */
export function sampleBaseDate(): Date {
  return new Date(`${jstDateOffset(3)}T14:00:00+09:00`)
}

export function exampleSendAt(step: ReminderDraftStep, mode: ReminderDraftSettings['deliveryMode'], base: Date): Date {
  return resolveReminderSendAt(base, {
    offsetDays: step.offsetDays ?? null,
    sendAtTime: step.sendAtTime ?? null,
    offsetMinutes: step.offsetMinutes ?? 0,
  }, mode)
}

/** ステップの短い呼び名。「1日前 18:00」「1時間前」。 */
export function stepShortTiming(step: ReminderDraftStep, mode: ReminderDraftSettings['deliveryMode']): string {
  const sendAtTime = step.sendAtTime?.trim() || null
  const offsetDays = typeof step.offsetDays === 'number' && Number.isFinite(step.offsetDays) ? Math.trunc(step.offsetDays) : null
  if (mode === 'time' && offsetDays !== null && sendAtTime) {
    const dayLabel = offsetDays === 0 ? '当日' : offsetDays < 0 ? `${-offsetDays}日前` : `${offsetDays}日後`
    return `${dayLabel} ${sendAtTime}`
  }
  return describeReminderTiming({ ...step, offsetDays, sendAtTime }, mode)
}

/** 板が 1100px を切ったら（画面幅で約 1352px 未満）、通知の中身は 1152 の板  の形。 */
export function useNarrowBoard() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 1351px)')
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}


import { type ReactNode } from 'react'
/** 各手順が型（CreatePage）へ渡す頭の部分。 */
export type StageFrame = {
  boardId: string
  title: string
  identity: ReactNode
  steps: ReactNode
  help: ReactNode
  /** 頭の線の下に板の幅で置く帯（競合 ）。 */
  notice?: ReactNode
  noticeSpacing?: 'band'
  /** 下の帯の左の文（下書きの自動保存の状態）。 */
  status?: ReactNode
}
