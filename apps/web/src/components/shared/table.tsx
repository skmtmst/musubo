'use client'

import { FolderDotName, type FolderDotFolder } from './folder-dot'
import Avatar from './avatar'
import React, { createContext, useContext, useEffect, useState } from 'react'
import { recordTableColumns } from './record-table-columns'
import { useTableActionWidth } from './use-table-action-width'
import { useListRowDensity } from './use-list-row-density'
import { useListColumnSizing } from './use-list-column-sizing'
import { useListUrlState } from './list-url-state'
import type { ReactNode, TdHTMLAttributes, HTMLAttributes, CSSProperties } from 'react'
import shell from './data-table.module.css'
import { loadFailureCopy } from './api-error-message'
import { FailureTitle, RetryLabel } from './retry-label'
import styles from './table.module.css'
import cellPresentations from './table-cell-presentations.module.css'
import type { ThProps } from './table-head-cell'
export type { ThProps } from './table-head-cell'
import TruncatedText from './truncated-text'
import HelpTip from './help-tip'
import { DelayedSkeleton, ListSkeleton } from './skeleton'
import presentationStyles from './table-presentation.module.css'
import PageLink, { RowNavigation, useListNavigationHref } from './list-navigation'
import { isRowControl } from './destination-policy'
const CreatedRowHighlight = createContext('')

/** Pencil V5/管理画面の `tPTMp` を正本にした表見出しセル。 */
export function Th({
  children,
  align = 'left',
  className,
  scope = 'col',
  help,
  helpLabel,
  helpHref,
  truncate,
  showActionLabel = false,
  collapseAt,
  grow,
  weight,
  inset,
  columnKind,
  ...cellProps
}: ThProps) {
  const classes = [
    styles.cell,
    align === 'right' && styles.right,
    align === 'center' && styles.center,
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const hasHelp = help !== undefined && help !== null
  const actionHeading = children === '操作' && !showActionLabel
  const heading = helpLabel ?? (typeof children === 'string' ? children : 'この項目')
  return (
    <th className={classes} data-align={align} data-column-kind={columnKind} scope={scope} data-cell-collapse={collapseAt} data-cell-grow={grow || undefined} data-cell-align={align} style={inset || weight ? { ...(inset ? { paddingInlineStart: inset } : {}), ...(weight ? { '--cell-weight': weight } : {}) } as CSSProperties : undefined} data-cell-weight={weight} {...cellProps}>
      {actionHeading ? <span className="sr-only">操作</span> : truncate ? typeof children === 'string' ? <TruncatedText className={styles.truncated} value={children} /> : <span className={styles.truncated}>{children}</span> : children}
      {hasHelp ? (
        <HelpTip label={`${heading}の説明`}>
          {help}
          {helpHref ? <a href={helpHref}>くわしく</a> : null}
        </HelpTip>
      ) : null}
    </th>
  )
}

type TableHeadRowProps = Omit<HTMLAttributes<HTMLTableRowElement>, 'children' | 'className'> & {
  children: ReactNode
  className?: string
}

export function TableHeadRow({
  children,
  className,
  density,
  presentation,
  as = 'tr',
  ...rowProps
}: TableHeadRowProps & { density?: 'standard' | 'comfortable'; presentation?: 'embedded'; as?: 'tr' | 'div' }) {
  const classes = [styles.headRow, density === 'comfortable' && styles.headComfortable, className]
    .filter(Boolean)
    .join(' ')
  return (
    <React.Fragment>{as === 'div' ? <div data-shared-part="list-head" role="row" className={classes} data-table-layout="columns" data-presentation={presentation} {...rowProps as HTMLAttributes<HTMLDivElement>}>
      {children}
    </div> : <tr data-shared-part="list-head" className={classes} data-presentation={presentation} {...rowProps}>
      {children}
    </tr>}</React.Fragment>
  )
}

/**
 * Pencil 管理画面 `RwC76` を正本にした一覧表の外枠。
 * 設計の節の印は表へ写す（data-design 受け口）。共通化で印を落とすと、
 * 画面の骨格の契約試験が節を見失う。
 */
export function DataTable({
  children,
  className,
  'data-design': dataDesign,
  presentation,
  cellPresentation,
  density,
  columns,
  label,
  columnLayout,
  'aria-label': ariaLabel,
  grid,
  columnSizing,
  columnWeights,
  mobileMinWidth,
}: {
  children: ReactNode
  className?: string
  /** 列の幅の割合（1,2.2,…）。均等割りにせず、条件のような長い列に幅を取る。列の数と同じだけ渡す。 */
  columnWeights?: readonly number[]
  /** 狭い画面で列を保つ必要がある一覧だけ、表内を横に送る。 */
  mobileMinWidth?: string
  'data-design'?: string
  /** 時間×卓と予約一覧の寸法、飲食店のカード内の密度、アカウントのカード内の表。指定した表だけに適用する。 */
  cellPresentation?: 'friends'
  presentation?: 'ledger' | 'calendar' | 'inventory' | 'channels' | 'columns' | 'account-list' | 'account-handover' | 'connection-check' | 'event-list' | 'template-list' | 'version-history'
  /** 連携画面の3種類の行（reviews・media・sample）と設定内の詰めた一覧（compact・records）。指定のない表の見た目は変えない。 */
  density?: 'reviews' | 'media' | 'sample' | 'compact' | 'records'
  /** 列の幅を持つ設定一覧。共通の枠・セル・行で描く。 */
  columns?: string
  label?: string
  'aria-label'?: string
  /** フレックスで並ぶ一覧。既定の表の余白は変えず、指定した表だけに使う。 */
  columnLayout?: { headHeight: string; rowHeight: string; gap: string; padding: string; numberInset?: string; nameInset?: string; headPadding?: string; headRadius?: string; rowGap?: string; headTextSize?: string; bodyTextSize?: string; collapseScope?: 'page' }
  /** 列の寸法が板ごとに決まる設定一覧（LINE通知）。セル・線・枠は共通部品が持つ。 */
  grid?: { columns: string; compactColumns?: string; padding: string; headPadding: string; gap?: string; rowHeight?:string; headTextSize?: string; bodyTextSize?: string }
  /** 名前へ残りを配る。contentは補助列の内容幅、controlsは札・操作だけ最低必要幅を確保。 */
  columnSizing?: 'content' | 'controls'
}) {
  const actionWidthRef = useTableActionWidth<HTMLDivElement>()
  const [urlState, setUrlState] = useListUrlState({ highlight: '' })
  const [createdId, setCreatedId] = useState('')
  // 対象行が実際に描かれるまでURLの印を残す。読み込み中には消費しない。
  useEffect(() => {
    if (!urlState.highlight || !actionWidthRef.current) return
    const found = Array.from(actionWidthRef.current.querySelectorAll('[data-row-id]'))
      .some(row => row.getAttribute('data-row-id') === urlState.highlight)
    if (!found) return
    setCreatedId(urlState.highlight)
    setUrlState({ highlight: '' })
  })
  useEffect(() => {
    if (!createdId) return
    // 一覧につき1個だけ。行を増やしてもタイマーは増やさない。
    const timer = setTimeout(() => setCreatedId(''), 200)
    return () => clearTimeout(timer)
  }, [createdId])
  useListRowDensity(actionWidthRef)
  useListColumnSizing(actionWidthRef, columnSizing !== undefined)
  const tableDensity = density === 'compact' || density === 'records' ? density : undefined
  columns ??= tableDensity && !grid && !columnLayout ? recordTableColumns(children) : undefined
  const rowDensity = tableDensity ? undefined : density
  return (
    <CreatedRowHighlight.Provider value={urlState.highlight || createdId}><div ref={actionWidthRef} data-shared-part="list-table" data-mobile-scroll={mobileMinWidth ? "" : undefined} data-column-sizing={columnSizing} data-cell-presentation={cellPresentation} className={[shell.frame, cellPresentation === 'friends' && cellPresentations.friendList, presentation && (presentationStyles as Record<string, string>)[presentation], className].filter(Boolean).join(' ')} data-density={rowDensity} data-table-density={tableDensity} data-table-presentation={presentation} data-column-layout={columnLayout ? '' : undefined} data-collapse-scope={columnLayout?.collapseScope} data-grid-table={grid ? '' : undefined} style={columns || columnLayout || mobileMinWidth ? ({
      ...(mobileMinWidth ? { '--table-mobile-min-width': mobileMinWidth } : {}),
      ...(columns ? { '--table-columns': columns } : {}),
      ...(columnLayout ? {
        '--table-head-height': columnLayout.headHeight, '--table-row-height': columnLayout.rowHeight,
        '--table-column-gap': columnLayout.gap, '--table-column-padding': columnLayout.padding,
        '--table-number-inset': columnLayout.numberInset ?? '0px', '--table-name-inset': columnLayout.nameInset ?? '0px',
        '--table-head-padding': columnLayout.headPadding ?? columnLayout.padding,
        '--table-head-radius': columnLayout.headRadius ?? '0px', '--table-row-gap': columnLayout.rowGap ?? '0px',
        '--table-head-text-size': columnLayout.headTextSize ?? 'var(--text-caption)',
        '--table-body-text-size': columnLayout.bodyTextSize ?? 'var(--text-label)',
      } : {}),
    } as CSSProperties) : undefined}>
      <table className={shell.table} data-design={dataDesign} data-table-presentation={presentation} aria-label={label ?? ariaLabel} style={grid ? {
        '--table-columns': grid.columns,
        '--table-compact-columns': grid.compactColumns ?? grid.columns,
        '--table-row-padding': grid.padding,
        '--table-grid-gap':grid.gap,
        '--table-grid-row-height':grid.rowHeight,
        '--table-head-padding': grid.headPadding,
        '--table-head-text-size': grid.headTextSize ?? 'var(--tpl-sb-tbl-head)',
        '--table-body-text-size': grid.bodyTextSize ?? 'var(--tpl-sb-tbl-head)',
      } as CSSProperties : undefined}>{columnWeights?.length ? <colgroup>{columnWeights.map((weight, index) => <col key={index} style={{ width: `${(weight / columnWeights.reduce((sum, value) => sum + value, 0)) * 100}%` }} />)}</colgroup> : null}{children}</table>
    </div></CreatedRowHighlight.Provider>
  )
}
export type TrProps = Omit<HTMLAttributes<HTMLTableRowElement>, 'children' | 'className'> & {
  children: ReactNode
  className?: string
  /** ★管理画面：選んでいる行を薄い緑の地で示す。渡さなければ何も付けない。 */
  selected?: boolean
  /** ★管理画面：指を乗せた行に薄い地を敷く。押せる行・選べる行だけに付ける。 */
  interactive?: boolean
  /** 行の余白からも開く。名前は通常の Link のままにする。 */
  href?: string
  onOpen?: () => void
  /** パネルのURLの鍵。名前から移るときも対象を戻り先へ残す。 */
  detailKey?: string
  /** ★管理画面：行の高さ。`comfortable` は64px。未指定は58pxのまま。 */
  density?: 'standard' | 'comfortable' | 'template'
  /**
   * ★V8 仕上げ3回目（M10）④：消える行。渡すと 150ms で薄くなってから
   * 画面側が DOM から外す（外す側の合図は画面が持つ。ここは見た目だけ）。
   * 渡さなければ何も変わらない。
   */
  leaving?: boolean
  highlighted?: boolean
}

/** 標準一覧の高さ58pxの行。 */
export function Tr({ children, className, selected, interactive, href, onOpen, detailKey, density, leaving, highlighted, onClick, onKeyDown, ...rowProps }: TrProps) {
  const createdId = useContext(CreatedRowHighlight)
  const createdHighlight = Boolean(createdId && createdId === (rowProps as Record<string, unknown>)['data-row-id'])
  const navigationHref = useListNavigationHref()
  const hasLink = (nodes: ReactNode): boolean => React.Children.toArray(nodes).some(node => React.isValidElement<{ href?: string; children?: ReactNode; name?: ReactNode }>(node) && (node.type === RowNameLink || Boolean((node.props as Record<string, unknown>)['data-row-link']) || (node.type === NameCell && hasLink(node.props.name)) || hasLink(node.props.children)))
  const rowId = (rowProps as Record<string, unknown>)['data-row-id']
  const canOpen = Boolean(href || onOpen || onClick || hasLink(children))
  const classes = [shell.row, density === 'comfortable' && shell.rowComfortable, density === 'template' && shell.rowTemplate,
    interactive !== false && canOpen && shell.rowInteractive, (selected || createdHighlight) && shell.rowSelected, className].filter(Boolean).join(' ')
  const openLink = (newTab: boolean) => {
    if (!href) return
    if (newTab) window.open(navigationHref(href), '_blank', 'noopener,noreferrer')
    else window.location.assign(navigationHref(href))
  }
  return <RowNavigation.Provider value={detailKey && rowId ? { key: detailKey, id: String(rowId) } : null}><tr data-shared-part="list-row" data-row-open={canOpen || undefined} className={classes} aria-selected={selected === undefined ? undefined : selected}
    data-created-highlight={createdHighlight || undefined} data-leaving={leaving || undefined} data-highlighted={highlighted || undefined}
    {...rowProps} inert={leaving || rowProps.inert || undefined} tabIndex={rowProps.tabIndex ?? (canOpen ? 0 : undefined)}
    onClick={(event) => {
      if (event.defaultPrevented || isRowControl(event.target, event.currentTarget) || window.getSelection()?.toString()) return
      if (href && (event.metaKey || event.ctrlKey || event.shiftKey)) { openLink(true); return }
      if (onOpen) { onOpen(); return }
      if (onClick) { onClick(event); return }
      if (href) { openLink(false); return }
      const link = event.currentTarget.querySelector<HTMLAnchorElement>('a[data-row-link]')
      if (!link) return
      if (event.metaKey || event.ctrlKey || event.shiftKey) window.open(link.href, '_blank', 'noopener,noreferrer')
      else link.click()
    }} onKeyDown={(event) => {
      onKeyDown?.(event)
      if (event.defaultPrevented || event.target !== event.currentTarget || !canOpen || !['Enter', ' '].includes(event.key)) return
      event.preventDefault()
      if (onOpen) onOpen()
      else if (href) openLink(event.metaKey || event.ctrlKey)
      else event.currentTarget.click()
    }}>{children}</tr></RowNavigation.Provider>
}

/** 名前はその物のページへ。件数等のリンクはこの印を付けない。 */
export function RowNameLink({ onOpen, onClick, ...props }: React.ComponentProps<typeof PageLink> & { onOpen?: () => void }) {
  return <PageLink {...props} className={[props.className, styles.rowNameLink].filter(Boolean).join(' ')} data-row-link="" data-row-local-open={onOpen ? '' : undefined} onClick={event => {
    onClick?.(event)
    if (!onOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onOpen()
  }} />
}

/** 名前から既存の詳細を開く操作。行き先の切り替え方は画面が保つ。 */
export function RowNameButton({ className, selected, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return <button type="button" aria-pressed={selected} data-part="row-name" {...props} className={[styles.rowNameLink, className].filter(Boolean).join(' ')} />
}

export type TdProps = Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align' | 'children' | 'className'> & {
  children?: ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
  collapseAt?: 'narrow'
  grow?: boolean
  /** 余った幅の割合（grow の列どうしの比）。 */
  presentation?: 'friend-list' | 'template-plain'
  columnKind?: 'check' | 'star' | 'menu'
  weight?: number
}

/** 標準一覧の本文セル。 */
export function Td({ children, align = 'left', className, collapseAt, grow, presentation, columnKind, weight, style, ...cellProps }: TdProps) {
  const classes = [
    shell.bodyCell,
    presentation === 'friend-list' && cellPresentations.friendListCell,
    presentation === 'template-plain' && cellPresentations.templatePlainCell,
    align === 'right' && styles.right,
    align === 'center' && styles.center,
    className,
  ].filter(Boolean).join(' ')
  return <td className={classes} data-align={align} data-column-kind={columnKind} data-cell-collapse={collapseAt} data-cell-grow={grow || undefined} data-cell-align={align} data-cell-weight={weight} style={weight ? { ...style, '--cell-weight': weight } as CSSProperties : style} {...cellProps}>{children}</td>
}

/** 日時の本文セル。数字の桁と補足色は共通部品が持つ。 */
export function DateCell({ children, ...cellProps }: Omit<TdProps, 'className'>) {
  return <Td {...cellProps} className={styles.dateCell}>{children}</Td>
}

/** 顔と名前を同じ1行に保つ。狭い列では名前だけを省略する。 */
export function PersonCell({ name, nameTitle, avatarName, avatarSrc, avatarSize = 24, avatarShape, avatarAlt, gap, ...cellProps }: Omit<TdProps, 'children'> & {
  name: ReactNode
  nameTitle?: string
  avatarName?: string | null
  avatarSrc?: string | null
  avatarSize?: 24 | 32
  avatarShape?: 'circle' | 'rounded'
  avatarAlt?: string | null
  gap?: string
}) {
  return <Td {...cellProps} data-list-person-cell><span className={styles.person} style={gap ? { gap } : undefined}>
    <Avatar name={avatarName} src={avatarSrc} size={avatarSize} shape={avatarShape} alt={avatarAlt} />
    <span className={styles.personName} title={nameTitle ?? (typeof name === 'string' ? name : undefined)}>{name}</span>
  </span></Td>
}

/** : states belong to their column; stacked badges keep the 60px row. */
export function StatusCell({ primary, children, ...cellProps }: Omit<TdProps, 'className'> & { primary?: ReactNode }) {
  return <Td {...cellProps} className={shell.statusCell} data-list-status-cell><div className={shell.statusStack}>{primary ? <span className={shell.statusPrimary}>{primary}</span> : null}{children}</div></Td>
}

/** : 名前のセルはフォルダの丸と名前1行だけ。 */
export function NameCell({ name, description, folder, nameCarriesDot, annotation, selection, className, grow, weight }: {
  name: ReactNode
  description?: string | null
  /** 名前が色の丸を持つ札（タグの札）のとき、フォルダの丸を置かない。 */
  nameCarriesDot?: boolean
  /** 名前の横の状態札。名前やリンクの中には入れない。 */
  annotation?: ReactNode
  /** Selection stays outside the truncatable name, including its context menu. */
  selection?: ReactNode
  folder?: FolderDotFolder | null
  className?: string
  /** 列の余りを名前へ配る。見出しの Th と同じ役割を渡す。 */
  grow?: boolean
  /** 補助列と残りの幅を分け合う割合。未指定なら名前へ余りを配る。 */
  weight?: number
}) {
  return (
    <td data-list-name-cell="" data-cell-grow={grow || undefined} data-cell-weight={weight} className={[shell.bodyCell, className].filter(Boolean).join(' ')}>
      <div className={shell.name}><FolderDotName folder={folder} nameCarriesDot={nameCarriesDot} annotation={annotation} selection={selection}>{name}</FolderDotName></div>
      {description ? <TruncatedText data-list-name-description="" className={shell.nameDescription} value={description} /> : null}
    </td>
  )
}

/** 並び替えハンドル専用の先頭列。 */
export function HandleCell({ children }: { children?: ReactNode }) {
  return <td className={shell.handleCell}>{children}</td>
}

/** 行の右端に置く操作列。 */
export function ActionCell({ children, className }: { children?: ReactNode; className?: string }) {
  return <td data-list-action-cell="" className={[shell.bodyCell, shell.actionCell, className].filter(Boolean).join(' ')}>{children}</td>
}

export type SortDirection = 'asc' | 'desc' | 'none'

export type SortThProps = ThProps & {
  /** 並び順。`none` は印を出さず、押すと並べ替えを始める。 */
  sort: SortDirection
  onSort?: () => void
  /** 押したときの読み上げ名。未指定は見出し文字に「で並べ替える」を足す。 */
  sortLabel?: string
}

/**
 * ★管理画面：押して並べ替える見出しセル。
 *
 * 並び順は `aria-sort` と ▲▼ の印の両方で伝える（印だけ・読み上げだけにしない）。
 * 押せない見出しは今までどおり `Th` を使う。
 */
export function SortTh({ children, sort, onSort, sortLabel, help, helpLabel, helpHref, ...cellProps }: SortThProps) {
  const mark = sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : null
  const name = typeof children === 'string' ? children : undefined
  return (
    <Th
      aria-sort={sort === 'none' ? 'none' : sort === 'asc' ? 'ascending' : 'descending'}
      help={help}
      helpLabel={helpLabel ?? name}
      helpHref={helpHref}
      {...cellProps}
    >
      <button
        type="button"
        onClick={onSort}
        aria-label={sortLabel ?? (name ? `${name}で並べ替える` : '並べ替える')}
        className={styles.sortButton}
      >
        <span>{children}</span>
        {mark ? (
          <span aria-hidden="true" className={styles.sortMark}>
            {mark}
          </span>
        ) : null}
      </button>
    </Th>
  )
}

export type TableStateKind = 'empty' | 'loading' | 'error'

const TABLE_STATE_TEXT: Record<TableStateKind, { title: string; description: string }> = {
  empty: { title: '記録はありません', description: '記録が増えると、ここに表示されます。' },
  loading: { title: '読み込んでいます', description: 'このまま少しお待ちください。' },
  error: { title: '表示できませんでした', description: '時間をおいて開き直してください。' },
}

/**
 * ★管理画面：表の中に1行で出す状態（空・読み込み中・失敗）。
 *
 * 「0件」と「読めなかった」を同じ顔にしない。失敗のときだけ、やり直す
 * ボタンを出す（`onRetry` が無いときは飾りボタンを置かない）。
 *
 * `error` に捕まえた失敗を渡すと、403 は権限の案内にして再試行の口を
 * 出さず（押しても直らないため）、429 は待ち秒数を添える（m23m）。
 * 画面は `title`・`description` で上書きできる。
 */
export function TableStateRow({
  colSpan,
  kind,
  title,
  description,
  onRetry,
  retryLabel,
  error,
}: {
  colSpan: number
  kind: TableStateKind
  title?: string
  description?: string
  onRetry?: () => void
  retryLabel?: string
  error?: unknown
}) {
  if (kind === 'loading') return <tr><td colSpan={colSpan} aria-busy="true" aria-label={title ?? TABLE_STATE_TEXT.loading.title}><DelayedSkeleton loading skeleton={<ListSkeleton columns={colSpan} />} /></td></tr>
  const text = TABLE_STATE_TEXT[kind]
  const failure = kind === 'error' && error !== undefined ? loadFailureCopy(error, 'この画面') : null
  return (
    <tr className={shell.row}>
      <td colSpan={colSpan} className={shell.bodyCell}>
        <div className={styles.stateCell} role={kind === 'error' ? 'alert' : 'status'}>
          <p className={styles.stateTitle}>{kind === 'error' ? <FailureTitle title={title ?? failure?.title ?? text.title} /> : (title ?? failure?.title ?? text.title)}</p>
          <p className={styles.stateDescription}>{description ?? failure?.description ?? text.description}</p>
          {kind === 'error' ? (
            <button type="button" onClick={onRetry ?? (() => window.location.reload())} className={styles.stateRetry}>
              <RetryLabel />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
