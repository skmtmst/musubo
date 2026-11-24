'use client'

import { useTableActionWidth } from './use-table-action-width'
import { useListColumnSizing } from './use-list-column-sizing'
import { useListRowDensity } from './use-list-row-density'
import { restGridTracks, useGridTableStack } from './use-grid-table-stack'
import { FolderDotName, type FolderDotFolder } from './folder-dot'
import { Children, cloneElement, isValidElement, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import styles from './grid-table.module.css'
import TruncatedText from './truncated-text'

/** 板ごとの列幅と密度を受け取る共通の表。色・線・省略・役割は部品が持つ。 */
export type GridTableDesign = {
  columns: string
  gap: string
  rowPadding: string
  headPadding?: string
  padding?: string
  rowGap?: string
  /** auto は選択欄など複数段の内容に合わせて行を広げる。 */
  rowHeight?: string
  headHeight?: string
  fontSize: string
  lineHeight?: string
  headFontWeight?: string
  headFontSize?: string
  headLineHeight?: string
  color?: string
  headColor?: string
  headBackground?: string
}

export function GridTable({ children, label, design, framed = true, className, presentation, columnSizing, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'style' | 'role' | 'aria-label'> & {
  children: ReactNode
  columnSizing?: 'content'
  label: string
  design: GridTableDesign
  framed?: boolean
  /** 時刻×担当の盤。既存のカレンダー枠と専用密度を使う。 */
  presentation?: 'calendar' | 'dashboard' | 'metrics' | 'comparison'
  /** 幅と、狭い板での列の並びだけを渡す。 */
  className?: string
}) {
  const actionWidthRef = useTableActionWidth<HTMLDivElement>()
  useListRowDensity(actionWidthRef)
  useListColumnSizing(actionWidthRef, columnSizing === 'content')
  // 名前の列が細すぎる幅では行を2段にする（横送りより先に形を変える）。盤と分析の表は列の並びが意味を持つので変えない。
  useGridTableStack(actionWidthRef, design.columns, columnSizing !== 'content' && (presentation === undefined || presentation === 'dashboard'))
  const variables = Object.fromEntries(Object.entries(design).map(([key, value]) => [`--grid-table-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value]))
  variables['--grid-table-rest-columns'] = restGridTracks(design.columns)
  return <div {...props} ref={actionWidthRef} data-shared-part="list-table" role="table" aria-label={label} className={[styles.table, className].filter(Boolean).join(' ')} data-row-sizing={design.rowHeight === 'auto' ? 'content' : undefined} data-framed={presentation === 'calendar' ? undefined : framed || undefined} data-table-presentation={presentation} data-booking-calendar={presentation === 'calendar' ? '' : undefined} style={variables as CSSProperties}>{children}</div>
}

export function GridHeadRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-shared-part="list-head" role="row" className={[styles.row, className].filter(Boolean).join(' ')} data-head="">{Children.map(children, child => isValidElement<{ children?: ReactNode }>(child) && child.props.children === '操作' ? cloneElement(child, {}, <span className="sr-only">操作</span>) : child)}</div>
}

export function GridRow({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-shared-part="list-row" role="row" className={[styles.row, className].filter(Boolean).join(' ')} {...props}>{children}</div>
}

export function GridCell({ children, className, align, tone, stack = false, role = 'cell', ...props }: HTMLAttributes<HTMLSpanElement> & { align?: 'left' | 'right'; tone?: 'danger'; stack?: boolean }) {
  const hidden = props['aria-hidden'] === true || props['aria-hidden'] === 'true' || className?.split(/\s+/).includes('sr-only')
  return <span role={role} data-align={align} data-tone={tone} data-stack={stack || undefined} className={[styles.cell, className].filter(Boolean).join(' ')} {...props}>{role === 'columnheader' && typeof children === 'string' && !hidden ? <TruncatedText value={children} /> : children}</span>
}

/** : grid で描く一覧にも表と同じ名前のセルを使う。 */
export function GridNameCell({ name, folder, className }: {
  name: ReactNode
  /** フォルダ分けの無い名簿は false。未分類の一覧は null/省略。 */
  folder?: FolderDotFolder | null | false
  className?: string
}) {
  return <GridCell className={className} data-list-name-cell="">{folder === false ? name : <FolderDotName folder={folder}>{name}</FolderDotName>}</GridCell>
}
