import { Children, Fragment, isValidElement, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { formatNumber } from '@/lib/format'
import kpiStyles from './kpi-card.module.css'

/** 4つ並びのときの並べ方（管理画面 の見た目）。 */
export const gridFourUpClassName = 'grid grid-cols-2 gap-3 xl:grid-cols-4'

/**
 * 数の帯の包み（Pp3nS・全画面共通）。
 *
 * KpiCard を子に並べるだけで、v8 では1本の帯になる（隙間0・
 * 黒7%の右線・帯の上下線だけ）。1枚ずつ KpiCard を置いて
 * いる所は、並べる div をこの部品へ置き換えるだけで帯になる
 * （並べ方 gridClassName はそのまま渡すので 互換経路は不変）。
 */
export default function KpiBand({
  children,
  gridClassName = gridFourUpClassName,
  className,
  presentation = 'band',
  border,
  edgeInset,
  density,
  layout,
  maxColumns,
  frame,
  appearance,
  connections,
  ...rest
}: {
  children: ReactNode
  /** 従来の並べ方（`grid grid-cols-2 gap-3 xl:grid-cols-4` など）。管理画面 の見た目を保つ。 */
  gridClassName?: string
  presentation?: 'band'
  className?: string
  /** 隣に線やカードが無い所では、帯をカードの枠つきで置く。 */
  frame?: 'card'
  /**
   * 数のカードの形（案A）。マスを線で区切らず、1マスずつ白いカードにして間を空ける。
   * 題の左に灰の小箱の印、右上に状態の小さな札、0 は薄い灰の数字、流れの数は右下に細いグラフ。
   */
  appearance?: 'cards'
  /** 隣り合う指標の流れ。layoutより優先して横並びにする。割合が不明でも矢印は残す。順序は子のマスと同じ。 */
  connections?: readonly { label: string; value?: string }[]
  /** 型が区切りを持つ帯はinset-top、マスの間だけ区切る帯はdividers。 */
  border?: 'inset-top' | 'dividers'
  /** 親の本文が左右の余白を持つ場合、帯の両端では重ねない。 */
  edgeInset?: 'parent'
  /** 段や引き出しの中で使う小さい帯。 */
  layout?: 'booking' | 'link-row' | 'flow-summary'
  /** Keep every selected metric, wrapping into existing bands after this many columns. */
  maxColumns?: number
  density?: 'compact'
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  // 流れの子はKpiCardを直接置く。最も長い数に合わせ全マスを同じ大きさで縮め、単独の帯は従来どおり。
  const flowFit = connections ? Children.toArray(children).reduce((fit, child) => {
    if (!isValidElement<{ value?: number | null; valueText?: string; unit?: string; signed?: boolean }>(child)) return fit
    const text = child.props.valueText ?? formatNumber(child.props.value)
    const sign = child.props.signed && (child.props.value ?? 0) > 0 ? 1 : 0
    return { chars: Math.max(fit.chars, text.length + sign), unit: Math.max(fit.unit, (child.props.unit?.length ?? 0) * 12 + 2) }
  }, { chars: 1, unit: 0 }) : undefined
  if (maxColumns !== undefined && Number.isInteger(maxColumns) && maxColumns > 0) {
    const items = Children.toArray(children)
    if (items.length > maxColumns) {
      const rows: ReactNode[][] = []
      for (let start = 0; start < items.length; start += maxColumns) rows.push(items.slice(start, start + maxColumns))
      // 画面が渡す className（幅・置き場）は段の包み全体に付ける。各段に付けると包みが中身の幅に縮む。
      return <div data-shared-part="kpi-band-rows" {...rest} className={className} style={{ ...rest.style, '--kpi-band-row-columns': maxColumns } as CSSProperties}>
        {rows.map((row, index) => <KpiBand key={index} gridClassName={gridClassName} presentation={presentation} border={border} edgeInset={edgeInset} density={density} layout={layout} appearance={appearance} connections={connections?.slice(index * maxColumns, index * maxColumns + row.length - 1)}>{row}</KpiBand>)}
      </div>
    }
  }
  return (
    <div
      className={`${kpiStyles.strip} ${gridClassName}${className ? ` ${className}` : ''}`}
      data-kpi-layout={connections ? 'flow' : layout}
      data-kpi-flow-rates={connections?.some(connection => (connection.value?.length ?? 0) > 5) ? 'below' : undefined}
      data-kpi-border={border}
      data-kpi-frame={frame}
      data-kpi-appearance={appearance}
      data-kpi-edge-inset={edgeInset}
      data-kpi-density={density}
      data-shared-part="kpi-band"
      data-kpi-strip
      data-kpi-presentation={presentation}
      {...rest}
      style={flowFit ? { ...rest.style, '--kpi-flow-fit-chars': flowFit.chars, '--kpi-flow-fit-unit': `${flowFit.unit}px` } as CSSProperties : rest.style}
    >
      {connections ? Children.toArray(children).map((child, index) => <Fragment key={index}>
        {child}
        {connections[index] ? <span className={kpiStyles.connection} data-kpi-connection role="img" aria-label={`${connections[index].label}${connections[index].value ? `：${connections[index].value}` : ''}`}>
          <ArrowRight size={16} aria-hidden="true" />
          {connections[index].value ? <span>{connections[index].value}</span> : null}
        </span> : null}
      </Fragment>) : children}
    </div>
  )
}
