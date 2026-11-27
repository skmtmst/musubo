'use client'

import { useListSnapshot } from '@/lib/use-list-snapshot'
import { jstDate, jstDateOffset } from '@/lib/jst-datetime'

/*
 * ★V8 分析の画面で共通に使う処理（app/analytics/page.tsx から写した）。
 * src/v8 からは @/app を読めないので、読み込み・数の出し方・期間・CSV を
 * ここへ写す。中身（判定・文言）は今の画面と同じ。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { AnalyticsMetric, AnalyticsMetricState } from '@/lib/api'
import { csvCell } from '@/lib/presentation'
import Button, { type ButtonProps } from '@/components/shared/button'
import styles from './analytics.module.css'
import { formatDateTime, formatDay, formatNumber } from '@/lib/format'
import { formatDate as polishFormatDate } from '@/lib/format'
import { formatYen as polishFormatYen } from '@/lib/format'


export function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 板の頭の「CSVで書き出す」へ、いま開いている見かたの書き出しを登録する。 */
export type ExportAction = { onClick: () => void; disabled: boolean; disabledReason?: string }
export const AnalyticsExportContextV8 = createContext<((action: ExportAction | null) => void) | null>(null)

export function useRegisterExport(onClick: () => void, disabled: boolean, disabledReason?: string) {
  const register = useContext(AnalyticsExportContextV8)
  const action = useRef(onClick)
  action.current = onClick
  useEffect(() => {
    register?.({ onClick: () => action.current(), disabled, disabledReason })
    return () => register?.(null)
  }, [register, disabled, disabledReason])
}

/** CSV と共通 Button の理由だけを同じ組に置く。可否と実行は呼び出し元が持つ。 */
export function CsvExportButton(props: ButtonProps) {
  return <span className={styles.csvAction} data-blocked={props.disabled && Boolean(props.disabledReason) || undefined}><Button {...props} /></span>
}

export const RANGES = [7, 30, 90]

export function reportPeriodLabel(days: number, hasCustomRange: boolean): string {
  return hasCustomRange ? 'この期間' : `この${days}日`
}

/** 今の画面と同じ日本時間の暦日の範囲。 */
export function rangeFor(days: number, now = new Date()): { from: string; to: string } {
  return { from: jstDateOffset(-days, now), to: jstDate(now) }
}

export type OverviewResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/** 概要の読み込み。key が変わった時と retry の時だけ読み直す。 */
export function useOverview<T>(load: () => Promise<OverviewResult<T>>, key: string) {
  const { value: data, setValue: setData } = useListSnapshot<T | null>(key, null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setData(null)
    void load()
      .then((result) => {
        if (!active) return
        if (result.success) setData(result.data)
        else setError(result.error || '分析を表示できませんでした。時間をおいて、もう一度お試しください。')
      })
      .catch(() => {
        if (active) setError('分析を表示できませんでした。時間をおいて、もう一度お試しください。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadSeq, setData])
  return { data, loading, error, retry: () => setReloadSeq((n) => n + 1) }
}

export function metricText(
  value: AnalyticsMetric<number | string>,
  options?: { percent?: boolean; currency?: boolean },
) {
  if (value.value === null) return '—'
  if (typeof value.value === 'string') return value.value
  if (options?.percent) return `${Math.round(value.value * 1000) / 10}%`
  if (options?.currency) return `${polishFormatYen(value.value)}`
  return formatNumber(value.value)
}

/** 実測（available）か途中まで（partial）のときだけ数を出す。集計待ちの 0 を実測に見せない。 */
export function shownValue(metric: AnalyticsMetric<number>): number | null {
  if (metric.value === null) return null
  return metric.state === 'available' || metric.state === 'partial' ? metric.value : null
}

export const METRIC_STATE_TEXT: Record<AnalyticsMetricState, string> = Object.assign(Object.create(null), {
  available: '',
  partial: '一部だけ集計できています',
  pending: '集計を待っています',
  insufficient: '数が少なく出せません',
  unavailable: '未取得',
  failed: '集計を読めませんでした。もう一度お試しください',
})

export type KpiCardState = { detail: string; description?: string; help?: string; onRetry?: () => void }

/** 理由があるときは短い状態を下の行へ、理由の全文は「？」へ。failed だけ読み直しを付ける。 */
export function metricCardState(
  metric: Pick<AnalyticsMetric<unknown>, 'state' | 'reason'>,
  fallback: KpiCardState,
  retry?: () => void,
): KpiCardState {
  const retryable = metric.state === 'failed' && retry ? { onRetry: retry } : {}
  if (!metric.reason) return { ...fallback, ...retryable }
  return { detail: METRIC_STATE_TEXT[metric.state] || '未取得', description: metric.reason, ...retryable }
}

export function formatAnalyticsDateTime(value: string | null): string {
  return polishFormatDate(value, { style: value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'day' : 'detail', fallback: '—' })
}

export function formatAnalyticsDate(value: string | null): string {
  return polishFormatDate(value, { style: 'day', fallback: '—' })
}

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'] as const
export function analyticsWeekday(date: string): string {
  return WEEKDAY_JP[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? ''
}

/** YYYY-MM-DD を「9/15」に。 */
export function shortDate(date: string): string {
  return polishFormatDate(date, { style: 'list-day', fallback: '—' })
}

export function periodCaption(from: string, to: string, cutoffAt: string): string {
  return `集計期間 ${formatAnalyticsDate(from)}〜${formatAnalyticsDate(to)} ／ データ締切 ${formatAnalyticsDateTime(cutoffAt)}`
}
