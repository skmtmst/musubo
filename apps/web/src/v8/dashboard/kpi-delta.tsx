import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react'
import { kpiChangeTone, type KpiBetterDirection } from '@line-crm/shared'
import DeltaChip from '@/components/shared/delta-chip'
import StatusBadge from '@/components/shared/status-badge'
import { formatNumber } from '@/lib/format'

/** 比べる基準の言葉。札の短い言葉と、読み上げの「〇〇より」。 */
export type KpiDeltaBasis = { short: string; reading: string }

export const SAME_WEEKDAY_LAST_WEEK: KpiDeltaBasis = { short: '先週比', reading: '先週の同じ曜日' }

/** 札の見える文字と読み上げの文。符号と言葉でも増減が分かる。 */
export function kpiDeltaText(diff: number, unit: string, basis: KpiDeltaBasis): { visible: string; reading: string } {
  const amount = `${formatNumber(Math.abs(diff))} ${unit}`
  if (diff === 0) return { visible: `0 ${unit} ${basis.short}`, reading: `${basis.reading}と同じ` }
  return { visible: `${diff > 0 ? '+' : '−'}${amount} ${basis.short}`, reading: `${basis.reading}より ${amount}${diff > 0 ? '多い' : '少ない'}` }
}

/**
 * 数の帯の差の札（KpiCard の delta に入れる）。
 *
 * 色は良し悪しの向き（better）で決める：良い＝緑・悪い＝赤・どちらでもない／差 0＝灰色。
 * 増減は符号で表す。差0の既存の印は保つ。比べる値が無い数には、この札を置かない（0 として比べない）。
 */
export default function KpiDelta({ current, previous, better, unit, basis = SAME_WEEKDAY_LAST_WEEK }: {
  current: number
  previous: number
  better: KpiBetterDirection
  unit: string
  basis?: KpiDeltaBasis
}) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return <StatusBadge tone="neutral" size="compact" dot={false}>比較を確認できません</StatusBadge>
  const diff = current - previous
  const tone = kpiChangeTone(better, diff)
  const text = kpiDeltaText(diff, unit, basis)
  const body = <>
    <span aria-hidden="true">{text.visible}</span>
    <span className="sr-only">{text.reading}</span>
  </>
  if (tone === 'good' || tone === 'bad') {
    return <span data-kpi-delta={tone} title={text.reading}>
      <DeltaChip tone={tone === 'good' ? 'up' : 'down'} direction={diff > 0 ? 'up' : 'down'}>{body}</DeltaChip>
    </span>
  }
  return <span data-kpi-delta={tone} title={text.reading}>
    <StatusBadge tone="neutral" size="compact" dot={false}>{diff === 0 ? <ArrowRight size={16} aria-hidden="true" /> : diff > 0 ? <ArrowUp size={16} aria-hidden="true" /> : <ArrowDown size={16} aria-hidden="true" />}{body}</StatusBadge>
  </span>
}
