'use client'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { barChartTicks } from './bar-chart'
import styles from './charts.module.css'
export const CHART_COLORS = { primary: 'var(--color-accent-deep)', secondary: 'var(--color-ink-faint)' } as const
export function chartNumber(value: number | null, unit = '') { return value === null || !Number.isFinite(value) ? '—' : `${value.toLocaleString('ja-JP')}${unit}` }
export function chartDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${Number(value.slice(5,7))}/${Number(value.slice(8,10))}` : value }
export type ChartPoint = { key: string; label: string; value: number | null; note?: string; emphasis?: boolean }
export function ValueBarChart({ items, label, unit = '', presentation = 'standard', signed = false, showLastAxis = true }: { items: ChartPoint[]; label: string; unit?: string; presentation?: 'standard' | 'summary'; signed?: boolean; showLastAxis?: boolean }) {
 const columnsRef = useRef<HTMLDivElement>(null)
 const [labelStep, setLabelStep] = useState(1)
 const [columnsWidth, setColumnsWidth] = useState(0)
 const [edgeClamp, setEdgeClamp] = useState({ first: false, last: false })
 useEffect(() => {
  const columns = columnsRef.current
  if (!columns) return
  const measure = () => {
   const width = columns.getBoundingClientRect().width
   if (!width || !items.length) return
   const axis = columns.querySelector<HTMLElement>('[data-chart-axis]')
   const fontSize = axis ? Number.parseFloat(getComputedStyle(axis).fontSize) || 11 : 11
   const gap = Number.parseFloat(getComputedStyle(columns).columnGap) || 0
   const longest = Math.max(...items.map(item => chartDate(item.label).length)) * fontSize
   setLabelStep(Math.max(1, Math.ceil((longest + gap) / ((width + gap) / items.length))))
   const roundedWidth = Math.floor(width)
   setColumnsWidth(prev => prev === roundedWidth ? prev : roundedWidth)
   const colWidth = (width - gap * Math.max(0, items.length - 1)) / items.length
   const axisWidth = (edge: 'first' | 'last', text: string) => {
    const el = columns.querySelector<HTMLElement>(`[data-axis-edge="${edge}"]`)
    const measured = el ? el.getBoundingClientRect().width : 0
    if (measured > 0 && (items.length === 1 || Math.abs(measured - width) > 0.5)) return measured
    let units = 0
    for (const ch of text) units += ch.charCodeAt(0) <= 0x7f ? 0.65 : 1
    return units * fontSize
   }
   const first = items.length > 1 && axisWidth('first', chartDate(items[0].label)) > colWidth + 0.5
   const last = items.length > 1 && showLastAxis && axisWidth('last', chartDate(items[items.length - 1].label)) > colWidth + 0.5
   setEdgeClamp(prev => prev.first === first && prev.last === last ? prev : { first, last })
  }
  measure()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
  observer?.observe(columns)
  void document.fonts?.ready.then(measure)
  return () => observer?.disconnect()
 }, [items, showLastAxis])
 const max = Math.max(1,...items.map(p=>p.value ?? 0)); const positiveTicks = barChartTicks(max); const top=positiveTicks.at(-1) || 1
 const below=signed ? barChartTicks(Math.max(0,...items.map(p=>-(p.value??0)))).at(-1)! : 0
 const minimum=signed && items.some(p=>(p.value??0)<0) ? -below : 0, span=top-minimum
 const ticks=minimum<0 ? [...barChartTicks(-minimum).filter(t=>t>0).map(t=>-t),...positiveTicks] : positiveTicks
 const bottom=(value:number)=>(value-minimum)/span*100
 return <div className={styles.root} role="group" aria-label={label}>
  <div className={styles.plot} data-presentation={presentation}>{presentation === 'standard' && ticks.map(tick=><span className={styles.grid} key={tick} style={{bottom:`${bottom(tick)}%`}} aria-hidden="true"><span>{chartNumber(tick,unit)}</span></span>)}
   <div ref={columnsRef} className={styles.columns} data-dense={items.length > 14 || undefined} style={columnsWidth ? { '--chart-columns-width': `${columnsWidth}px` } as CSSProperties : undefined}>{items.map((item,index)=>{
    const edge = items.length > 1 ? index === 0 ? 'first' : index === items.length - 1 ? 'last' : undefined : undefined
    const clamp = edge === 'first' && edgeClamp.first ? 'first' : edge === 'last' && edgeClamp.last ? 'last' : undefined
    return <div className={styles.column} key={item.key}><button type="button" className={styles.hit} aria-label={`${item.label} ${chartNumber(item.value,unit)}${item.note ? `・${item.note}`:''}`}><span className={styles.bar} style={{...(signed?{position:'absolute' as const,bottom:`${bottom(Math.min(0,item.value??0))}%`,height:`${Math.abs(item.value??0)/span*100}%`}:{height:`${Math.max(0,item.value??0)/top*100}%`}),background:presentation === 'summary' && !item.emphasis ? 'var(--color-accent)' : CHART_COLORS.primary}}/><span className={styles.tooltip}>{item.label} {chartNumber(item.value,unit)}{item.note}</span></button><span className={styles.axis} data-chart-axis data-axis-edge={edge} data-axis-clamp={clamp} hidden={index !== 0 && (index !== items.length - 1 || !showLastAxis) && (index % labelStep !== 0 || (showLastAxis && items.length - 1 - index < labelStep))}>{chartDate(item.label)}</span></div>
   })}</div>
  </div>
 </div>
}
export function FunnelChart({ items, label, unit = '人', selectedKey, onSelect, disabled, numbered = true }: { items: (ChartPoint & {detail?: ReactNode})[]; label: string; unit?: string; selectedKey?: string; onSelect?: (key:string)=>void; disabled?: boolean; numbered?: boolean }) {
 const top = Math.max(1,...items.map(i=>i.value??0))
 // 段の行は同じ列を共有する（番号・名前・棒・数・補足）。補足の長さで段ごとに棒の右端がずれないようにする。
 const columns = [numbered ? 'max-content' : null, 'var(--chart-funnel-label-w)', 'minmax(var(--chart-funnel-track-min), 1fr)', 'max-content', items.some(i=>i.detail) ? 'max-content' : null].filter(Boolean).join(' ')
 return <div className={styles.funnel} role="group" aria-label={label} style={{ gridTemplateColumns: columns }}>{items.map((item,i)=><button type="button" className={styles.funnelRow} data-part="funnel-row" key={item.key} disabled={disabled} onClick={()=>onSelect?.(item.key)} aria-pressed={onSelect ? item.key===selectedKey:undefined} aria-label={`${item.label} ${chartNumber(item.value,unit)}${item.note?`・${item.note}`:''}`} title={item.note}>{numbered ? <span>{i+1}</span> : null}<span className={styles.label} title={item.label}>{item.label}</span><span className={styles.track} aria-hidden="true"><span className={styles.funnelBar} style={{width:`${Math.max(0,item.value??0)/top*100}%`}}/></span><span>{chartNumber(item.value,unit)}</span>{item.detail}</button>)}</div>
}
export function LineChart({ points, label, unit = '', maxX, maxY, marker }: { points: {x:number;value:number|null;label:string}[]; label:string; unit?:string; maxX?:number; maxY?:number; marker?:{x:number;label:string} }) {
 const topX=Math.max(1,maxX??0,...points.map(p=>p.x)); const topY=Math.max(1,maxY??0,...points.map(p=>p.value??0)); let gap=true
 const path=points.map(p=> { if(p.value===null){gap=true;return ''} const start=gap;gap=false;return `${start?'M':'L'}${p.x/topX*1000} ${100-Math.max(0,Math.min(topY,p.value))/topY*100}` }).join(' ')
 return <div className={styles.root} role="group" aria-label={label}><svg className={styles.line} viewBox="-80 -20 1100 150" role="img" aria-label={label}>
 {[0,topY/2,topY].map(t=><g key={t}><line x1="0" x2="1000" y1={100-t/topY*100} y2={100-t/topY*100} stroke="var(--color-hairline)"/><text x="-8" y={105-t/topY*100} textAnchor="end">{chartNumber(t,unit)}</text></g>)}
 <path d={path} fill="none" stroke={CHART_COLORS.primary} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
 {points.filter(p=>p.value!==null).map((p,i)=><circle key={i} cx={p.x/topX*1000} cy={100-Math.max(0,Math.min(topY,p.value??0))/topY*100} r="3" fill={CHART_COLORS.primary} tabIndex={0} aria-label={`${p.label} ${chartNumber(p.value,unit)}`}><title>{p.label} {chartNumber(p.value,unit)}</title></circle>)}
 {marker ? <g><line x1={marker.x/topX*1000} x2={marker.x/topX*1000} y1="0" y2="100" stroke={CHART_COLORS.secondary} strokeDasharray="4 4"/><text x={marker.x/topX*1000} y="-8">{marker.label}</text></g>:null}
 {points.length ? <><text x="0" y="125">{points[0].label}</text><text x="1000" y="125" textAnchor="end">{points.at(-1)?.label}</text></>:null}
 </svg></div>
}

/**
 * 幅いっぱいの推移の線（絵  健康日記の体重）。描く面の実寸を測って座標を取るので、
 * 狭い欄でも文字や線が縮まない。縦は 0 から maxY を3本の目盛り、横は軸の名前を
 * axisLabels（位置 x と文字）で置く。値の無い位置は点を置かず、ある点どうしを線でつなぐ。
 */
export function TrendLineChart({ points, label, unit = '', maxX, maxY, axisLabels, height = 160 }: { points: { x: number; value: number; label: string }[]; label: string; unit?: string; maxX: number; maxY: number; axisLabels: { x: number; label: string }[]; height?: number }) {
 const ref = useRef<HTMLDivElement>(null)
 const [width, setWidth] = useState(0)
 useEffect(() => {
  const node = ref.current
  if (!node) return
  const update = () => setWidth(node.clientWidth)
  update()
  if (typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(update)
  observer.observe(node)
  return () => observer.disconnect()
 }, [])
 const left = 40, right = 8, top = 8, bottom = 24
 const plotW = Math.max(1, width - left - right), plotH = height - top - bottom
 const px = (x: number) => left + (maxX > 0 ? x / maxX : 0) * plotW
 const py = (v: number) => top + plotH - Math.max(0, Math.min(maxY, v)) / Math.max(1e-9, maxY) * plotH
 const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x)} ${py(p.value)}`).join(' ')
 return <div ref={ref} className={styles.trend} role="group" aria-label={label}>{width > 0 ? <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
  {[0, maxY / 2, maxY].map((t) => <g key={t}><line x1={left} x2={left + plotW} y1={py(t)} y2={py(t)} stroke="var(--color-hairline)" /><text x={left - 8} y={py(t) + 4} textAnchor="end">{chartNumber(t, unit)}</text></g>)}
  <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
  {points.map((p) => <circle key={p.x} cx={px(p.x)} cy={py(p.value)} r="2.5" fill="var(--color-accent)"><title>{p.label} {chartNumber(p.value, unit)}</title></circle>)}
  {axisLabels.map((a) => <text key={a.x} x={px(a.x)} y={height - 6} textAnchor="middle">{a.label}</text>)}
 </svg> : null}</div>
}

/**
 * 横棒（絵 「集まった回答」）：名前120・細い棒（全体に占める割合）・数と割合。
 * 行は押せない読み物なので、枠の付いた箱にしない。total を渡さなければ並べた数の合計を全体にする。
 */
export function HorizontalBarChart({ items, label, unit = '件', total }: { items: ChartPoint[]; label: string; unit?: string; total?: number }) {
 const whole = Math.max(1, total ?? items.reduce((sum, item) => sum + Math.max(0, item.value ?? 0), 0))
 return <div className={styles.hbar} role="group" aria-label={label}>{items.map(item => {
  const share = Math.round(Math.max(0, item.value ?? 0) / whole * 100)
  const text = `${chartNumber(item.value, unit)}（${share}%）`
  return <div className={styles.hbarRow} key={item.key} role="group" aria-label={`${item.label} ${text}`}>
   <span className={styles.hbarLabel} title={item.label}>{item.label}</span>
   <span className={styles.hbarTrack} aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
   <span className={styles.hbarValue}>{text}</span>
  </div>
 })}</div>
}
