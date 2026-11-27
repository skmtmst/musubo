'use client'
import { knownValue } from '@/lib/known-value'

/*
 * ★V8 飲食店向けの板に共通の小さな部品（担当 a の画面だけで使う）。
 * - 数のカード（CHz31「数の並び」）：共通の KpiCard を絵の寸法で使う
 * - 白い枠（CHz31「枠 店舗一覧」）：題14/700・説明11・右端の注意、下に細い線
 * - 状態の札：共通の StatusBadge（点＋文字）
 */
import KpiBand from '@/components/shared/kpi-band'
import Card, { CardHeader } from '@/components/shared/card'
import { formatDate as polishFormatDate } from '@/lib/format'
import type { ReactNode } from 'react'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import styles from './parts.module.css'

const statusLabel: Record<string, string> = {
  connected: '正常', active: '有効', paused: '停止中', invited: '招待中', suspended: '停止中', archived: 'アーカイブ', approved: '承認済', completed: '完了', visited: '来店済',
  confirmed: '予約確定', warning: '要確認', pending: '承認待ち', draft: '下書き', scheduled: '予約済',
  unreplied: '未返信', unconfigured: '未設定', disabled: '停止中', error: 'エラー', returned: '差戻し',
  seated: '来店中', cancelled: '取消', no_show: '無断キャンセル', preview_only: 'プレビューのみ',
}

export function statusTone(value: string): StatusBadgeTone {
  if (['connected', 'active', 'approved', 'completed', 'visited', 'confirmed'].includes(value)) return 'success'
  if (['warning', 'pending', 'draft', 'scheduled', 'unreplied'].includes(value)) return 'warning'
  if (['error', 'no_show', 'cancelled'].includes(value)) return 'danger'
  return 'neutral'
}

/** 板の「状態の札」（点＋文字）。 */
export function Status({ value, label }: { value: string; label?: string }) {
  return <StatusBadge tone={statusTone(value)} className={styles.status}>{label ?? knownValue(statusLabel, value, '状態を確認できません')}</StatusBadge>
}

/** 数の帯（各マスは共通部品）。 */
export function StatRow({ children }: { children: ReactNode }) {
  return <KpiBand>{children}</KpiBand>
}

/** 白い枠。flush は表など枠いっぱいの中身（内側の余白なし）。 */
export function Panel({ title, description, aside, flush = false, narrow = false, children }: {
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  flush?: boolean
  /** 幅を絵の列の幅（280）に固定する（組織階層）。 */
  narrow?: boolean
  children?: ReactNode
}) {
  return (
    <Card variant={flush ? 'records' : 'form'} overflow="hidden" className={narrow ? styles.panelNarrow : undefined}>
      <CardHeader title={title} meta={description} action={aside} size="stacked" />
      {children}
    </Card>
  )
}

export function PanelAside({ tone = 'warning', children }: { tone?: 'warning' | 'success'; children: ReactNode }) {
  return <span className={`${styles.panelAside} ${tone === 'success' ? styles.panelAsideOk : ''}`}>{children}</span>
}

/** 2つ並びの枠（全店アクション／同期方針）。 */
export function HalfGrid({ children }: { children: ReactNode }) {
  return <div className={styles.halfGrid}>{children}</div>
}

/** 年/月/日 時:分（絵の「2026/09/30 10:12」）。 */
export function formatStamp(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list' })
}
