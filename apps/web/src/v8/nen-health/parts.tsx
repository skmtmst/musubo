'use client'

import { statusLabel } from '@/lib/status-labels'


/*
 * ★V8 健康日記の小さな部品（言葉・日付・行の「…」・札・体重の棒）。
 * 今の画面（app/nen/health の summary-drawer.tsx・health-tab.tsx）から写した。
 * src/v8 は @/app を読めないので、同じ約束のまま持つ。
 */
import { useState, type ReactNode } from 'react'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu as SharedRowMenu } from '@/components/shared/row-actions'
import { paginationSummary } from '@/components/shared/pagination'
import type { NenHealthChangeFilter, NenHealthLastFilter, NenHealthRow, NenHealthSort } from '@/lib/nen-pets-api'
import StatusBadge from '@/components/shared/status-badge'
import styles from './health.module.css'
import { emptyValue } from '@/components/shared/empty-value'

export type HealthTabKey = 'logs' | 'concern' | 'items'
export type HealthFilters = { q: string; change: NenHealthChangeFilter; last: NenHealthLastFilter; sort: NenHealthSort }
export const EMPTY_FILTERS: HealthFilters = { q: '', change: '', last: '', sort: 'concern' }

export const SKIN_LABELS: Record<string, string> = Object.assign(Object.create(null), { normal: '問題なし', itchy: 'かゆそう', red: '赤み', other: 'その他' })
export const TEAR_LABELS: Record<string, string> = Object.assign(Object.create(null), { normal: '問題なし', mild: '少し気になる', concern: '気になる' })

export function countText(counts: Record<string, number>, labels: Record<string, string>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return entries.length ? entries.map(([key, n]) => `${Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key} ${n}回`).join('・') : emptyValue('unknown')
}

/** 「2026-09-30」→「9/30」。 */
export function md(date: string | null | undefined): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return '—'
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
}

/** 件数の文（「6件中 1〜6件」）。 */
export function rangeText(total: number, page: number, size: number): string {
  return paginationSummary(total, total === 0 ? 0 : (page - 1) * size + 1, Math.min(total, page * size))
}

/**
 * 「気になる変化」の札。言葉は短く（絵の言い方）、くわしい数は title で読む。
 * 変化が無ければ、30日の記録があれば「いつもどおり」、無ければ「記録なし」。
 */
export function changeBadges(row: NenHealthRow): Array<{ key: string; label: string; detail: string; tone: 'ok' | 'warn' | 'off' }> {
  if (row.changes.length === 0) {
    return [row.count30d > 0
      ? { key: 'ok', label: 'いつもどおり', detail: '気になる変化はありません', tone: 'ok' }
      : { key: 'none', label: '記録なし', detail: '30日の記録がありません', tone: 'off' }]
  }
  const short: Record<string, string> = Object.assign(Object.create(null), {
    weight_drop: '体重が減った',
    weight_gain: '体重が増えた',
    stool_abnormal: '便の異常が続く',
    appetite_poor: '食いつき不良が続く',
    silent: '記録なし',
  })
  return row.changes.map((change) => ({
    key: change.key,
    label: short[change.key] ?? change.label,
    detail: change.label,
    tone: change.tone === 'warn' ? 'warn' : 'off',
  }))
}

/** 状態の札（点＋文字）。 */
export function Pill({ tone, children, title }: { tone: 'ok' | 'warn' | 'off'; children: ReactNode; title?: string }) {
  return (
    <StatusBadge tone={tone === 'ok' ? 'success' : tone === 'off' ? 'neutral' : tone === 'warn' ? 'warning' : 'neutral'} title={title}>{children}</StatusBadge>
  )
}

/** 行の右端の「…」。押すと行の操作のメニュー（右クリックだけにしない）。 */
export function RowMenu({ subject, items }: { subject: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <span className={styles.menuBox}>
      <SharedRowMenu
        label={`「${subject}」の操作`}
        open={open}
        onOpenChange={setOpen}
        items={items.map((item) => ({ ...item, onSelect: () => { setOpen(false); item.onSelect?.() } }))}
      />
    </span>
  )
}

/**
 * 8週の週平均体重を小さな棒で。最小〜最大の幅で高さを決め、記録の無い週は「—」。
 * 気になる体重の変化がある行は琥珀の棒にする。
 */
export function WeightBars({ series, warn }: { series: Array<number | null>; warn: boolean }) {
  const known = series.filter((v): v is number => v != null)
  if (known.length === 0) return <span className={styles.cell}>{emptyValue('unknown')}</span>
  const min = Math.min(...known)
  const max = Math.max(...known)
  const label = known.length >= 2 ? `${known[0]}kg → ${known[known.length - 1]}kg` : `${known[0]}kg`
  return (
    <span className={styles.bars} role="img" aria-label={`体重の推移（8週）：${label}`} title={label} data-warn={warn || undefined}>
      {series.map((value, index) => (
        <span
          key={index}
          className={value == null ? styles.barEmpty : styles.bar}
          data-level={value == null ? undefined : max === min ? 3 : 1 + Math.round(((value - min) / (max - min)) * 3)}
        />
      ))}
    </span>
  )
}
