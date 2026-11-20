'use client'

import { useCardHeights } from './use-card-heights'
import React, { useCallback, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import styles from './card.module.css'
import { OptionalBadge } from './form-controls'

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  ref?: Ref<HTMLElement>
  children: ReactNode
  as?: 'section' | 'article' | 'form'
  /** 情報とは別に下端へ寄せる操作。間隔はカードのgapだけが持つ。 */
  actions?: ReactNode
  /** 既定は白地＋共通影。inset は内側の面、ring は選択枠。 */
  frame?: 'raised' | 'inset' | 'ring'
  layout?: 'block' | 'vertical' | 'horizontal' | 'media'
  /**
   * 設定の箱。'settings' は16の余白・10の間（EC設定）。
   * 'integration'（外部連携の設定）・'preview'（見本）は枠と内側の間を持つ。
   * 'normal' | 'roomy' | 'tight' | 'controls' は NEN の設定の中の間。指定したカードだけ。
   */
  spacing?: 'settings' | 'integration' | 'preview' | 'normal' | 'roomy' | 'tight' | 'controls'
  overflow?: 'visible' | 'hidden'
  /** rows は各行が端の余白を持つ一覧。外側に同じ余白を重ねない。 */
  padding?: 'none' | 'rows' | 'compact' | 'default' | 'roomy' | 'spacious'
  corner?: 'card' | 'segment' | 'control'
  /** 板ごとの余白はトークンで渡す（例 'var(--tpl-...)'）。枠の描画はこの部品が持つ。 */
  contentPadding?: string
  /** V8 の入力の段・右の箱・一覧の小窓。既定のカードは変えない。 */
  variant?: 'default' | 'form' | 'aside' | 'panel' | 'records'
  /** 枠と段の間を部品へ任せる連携設定のカード。既定の面は変えない。 */
  appearance?: 'outlined'
  /** 'tight' | 'normal' | 'loose' は決まった段。それ以外はトークン（例 'var(--tpl-...)'）を中の間として渡す。 */
  gap?: 'tight' | 'normal' | 'loose' | (string & {})
  /** 内側の線で寸法を保つカード（inset）・薄い面（muted）・NEN の設定の枠（bordered）。指定した面だけに適用。 */
  /** 選んだカードの枠と面。指定したカードだけ共通の選択色にする。 */
  selected?: boolean
  surface?: 'standard' | 'inset' | 'muted' | 'bordered' | 'danger' | 'proposal' | 'preview'
  /** 影ではなく内側の細い線で縁を出すカード（はじめにやること r3X34）。指定したカードだけ。 */
  edge?: 'hairline'
}

/*
 * 上下・左右を分けた余白（例 '8px 12px'）は max に入らず、余白が 0 になっていた。
 * かっこの外に空白がある値だけ、最低16を掛けずにそのまま使う（ の階層の行）。
 */
function hasSides(value: string): boolean {
  let flat = value
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '')
  return /\s/.test(flat.trim())
}

/** 情報の面。白地と共通影を既定にし、入れ子・選択中だけ面を変える。 */
export default function Card({
  children,
  ref: forwardedRef,
  as: CardTag = 'section',
  actions,
  className,
  frame = 'raised',
  layout = 'block',
  overflow = 'visible',
  padding = 'none',
  corner = 'card',
  contentPadding,
  style,
  variant = 'default',
  appearance,
  gap,
  surface = 'standard',
  edge,
  selected,
  spacing,
  ...props
}: CardProps) {
  const cardRef = useCardHeights()
  const setCardRef = useCallback((node: HTMLElement | null) => {
    cardRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [cardRef, forwardedRef])
  const gapToken = gap === 'tight' || gap === 'normal' || gap === 'loose' ? gap : undefined
  const gapValue = gapToken ? undefined : gap
  const classes = [
    styles.card,
    actions ? styles.withActions : null,
    corner === 'segment' ? styles.segment : null,
    frame === 'inset' ? styles.inset : null,
    variant !== 'default' ? styles[variant] : null,
    surface === 'inset' ? styles.inset : null,
    gap === 'tight' ? styles.gapTight : null,
    surface === 'bordered' ? styles.bordered : null,
    spacing === 'normal' ? styles.spacingNormal : null,
    spacing === 'roomy' ? styles.spacingRoomy : null,
    spacing === 'tight' ? styles.spacingTight : null,
    spacing === 'controls' ? styles.spacingControls : null,
    layout === 'vertical' ? styles.vertical : layout === 'horizontal' ? styles.horizontal : layout === 'media' ? styles.media : null,
    overflow === 'hidden' ? styles.overflowHidden : null,
    padding === 'compact' ? styles.paddingCompact : null,
    padding === 'default' ? styles.paddingDefault : null,
    padding === 'roomy' ? styles.paddingRoomy : null,
    padding === 'spacious' ? styles.paddingSpacious : null,
    spacing === 'integration' || spacing === 'preview' ? styles.spacedInset : null,
    spacing === 'integration' || spacing === 'preview' ? styles[spacing] : null,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <CardTag ref={setCardRef} className={classes} data-design-part="card" data-appearance={appearance} data-gap={gapToken} data-spacing={spacing}
      data-card-frame={frame === 'ring' ? frame : undefined} data-card-selected={selected || undefined} data-card-padding={padding} data-card-variant={variant}
      data-card-surface={surface === 'standard' ? undefined : surface} data-card-corner={corner === 'control' ? corner : undefined} data-card-edge={edge}
      data-card-spacing={contentPadding || gapValue ? '' : undefined}
      data-card-spacing-sides={contentPadding && hasSides(contentPadding) ? '' : undefined}
      style={contentPadding || gapValue ? { ...style, '--card-content-padding': contentPadding ?? '0px', '--card-content-gap': gapValue ?? '0px' } as CSSProperties : style} {...props}>
      {actions ? <><div className={styles.information}>{children}</div><div className={styles.bottomActions} data-card-actions>{actions}</div></> : children}
    </CardTag>
  )
}

/** Content between edge-to-edge media and the card's end. */
export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={[styles.content, className].filter(Boolean).join(' ')}>{children}</div>
}

/** カード内の同格操作を均等幅で並べる。 */
export function CardActionRow({ children, className, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'style'> & { children: ReactNode }) {
  return <div {...props} className={[styles.actionRow, className].filter(Boolean).join(' ')} data-card-action-row>{children}</div>
}

export function CardHeader({
  title,
  optional = false,
  meta,
  action,
  size = 'standard',
  headingLevel = 2,
  titleId,
  help,
}: {
  title: ReactNode
  /** 題の右の「？」（HelpTip）。題とは間 8 で、題の行の高さの真ん中にそろえる。 */
  help?: ReactNode
  optional?: boolean
  meta?: ReactNode
  action?: ReactNode
  size?: 'standard' | 'roomy' | 'stacked' | 'panel' | 'restaurant' | 'content'
  headingLevel?: 2 | 3
  titleId?: string
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <div
      className={[styles.header, size === 'roomy' && styles.headerRoomy, size === 'stacked' && styles.headerStacked, size === 'panel' && styles.headerPanel, size === 'restaurant' && styles.headerRestaurant, size === 'content' && styles.headerContent].filter(Boolean).join(' ')}
      data-design-node="t0jk8p"
    >
      <div className={styles.titleGroup}>
        {help ? (
          <span className={styles.titleRow}>
            <Heading id={titleId} className={styles.title}>{title}{optional ? <OptionalBadge /> : null}</Heading>
            {help}
          </span>
        ) : <Heading id={titleId} className={styles.title}>{title}{optional ? <OptionalBadge /> : null}</Heading>}
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </div>
      {action ? (
        <div className={styles.action}>
          {action}
        </div>
      ) : null}
    </div>
  )
}
