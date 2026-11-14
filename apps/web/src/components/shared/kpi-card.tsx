'use client'

import React from 'react'
import Link from 'next/link'
import { ArrowRight, MoreHorizontal } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import StatusBadge from './status-badge'
import ActionMenu, { type ActionMenuItem } from './action-menu'
import { isKpiNumberText, isZeroNumberText } from './kpi-number-text'
import HelpTip from './help-tip'
import { isCountableValue } from './not-connected'
import styles from './kpi-card.module.css'
import { formatNumber } from '@/lib/format'
import { RetryLabel } from './retry-label'
import { normalizeActionLabel } from './action-words'
import { KpiRollingValue } from './kpi-value-motion'
import { ProgressBar } from './progress'

function detailText(node: ReactNode): string {
  return React.Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return React.isValidElement<{ children?: ReactNode }>(child) ? detailText(child.props.children) : ''
  }).join('')
}

/**
 * 題の終わりの「（…）」（添え書き）は、マスに入らないときだけ行ごと隠す。本体の言葉は切らない。
 * 「始まる見込み（試算）」が狭いマスで「始まる見込み（…」と切れていた（・・・・）。
 * 全文は title と読み上げで残る。添え書きの無い題は今までどおり。
 */
function titleParts(title: string) {
  const m = /^(.+?)(（[^（）]+）)$/u.exec(title)
  if (!m) return title
  return <><span className={styles.labelMain}>{m[1]}</span><span className={styles.labelQualifier}>{m[2]}</span></>
}

/** ・：旧いtitleだけの「…」は、説明を共通の「？」へ渡す。 */
function staticMenuDescription(menu: ReactNode): string | undefined {
  if (!React.isValidElement<React.ButtonHTMLAttributes<HTMLButtonElement>>(menu) || menu.type !== 'button') return
  const props = menu.props
  if (props.type !== 'button' || typeof props.title !== 'string' || !Object.keys(props).every(key => ['type', 'title', 'className', 'aria-label', 'children'].includes(key))) return
  const child = props.children
  const decorativeDots = React.isValidElement<Record<string, unknown>>(child)
    && child.type === MoreHorizontal
    && (child.props['aria-hidden'] === true || child.props['aria-hidden'] === 'true')
    && Object.keys(child.props).every(key => ['size', 'aria-hidden'].includes(key))
  if (child !== '…' && child !== '...' && !decorativeDots) return
  return props.title.trim() || undefined
}

export type KpiCardProps = {
  title: string
  /** 図柄。省略時は印を出さない。渡すときは指標の意味に合う図柄を使う。 */
  icon?: ReactNode
  /** V8: 数の右に出す増減の札。 */
  delta?: ReactNode
  /** V8: 指標の操作。呼び出し側が使える操作だけ渡す。 */
  menu?: ReactNode
  /**
   * 取れないときは「—」を表示する（D021）。
   * null だけでなく undefined・NaN も「—」にする。呼び出し側が
   * `x?.y` をそのまま渡しても画面ごと落ちない。**0 は 0 のまま出す。**
   */
  /** ：数の帯に『…』を置かず、数から既存の内訳を開く。 */
  valueMenu?: { label: string; open: boolean; items: ActionMenuItem[]; onOpenChange: (open: boolean) => void }
  valueAction?: { label: string; expanded: boolean; onClick: () => void }
  value: number | null | undefined
  unit: string
  /** 数字と単位を続けて出す板用。既定の間隔は変えない。 */
  unitSpacing?: 'normal' | 'tight'
  /** 増減の数（差し引きなど）。true のとき、プラスの数に「+」を付ける（単位はそのまま出す）。 */
  signed?: boolean
  /**
   * 数では表せない値（「1時間24分」「96.7%」など）をそのまま出す。
   * 渡したときは value と unit を使わない（★管理画面 37-6 の数値カード帯）。
   */
  valueText?: string
  /** 名前などを主の値として表示する。狭い幅は1行で省略し、titleで全文を読める。 */
  primaryText?: string
  /** 数字の範囲を数と単位で読む。片方を取得できないときは範囲全体が不明。 */
  valueRange?: { from: number | null | undefined; to: number | null | undefined }
  /** 「18 / 20人」のように、整形した値にも単位を添える。 */
  valueTextWithUnit?: boolean
  /**
   * 見出し・数値に続く3段目。短い状態・短い補足だけを置く。
   * 「未計測」「集計不可」「取得失敗」などの状態自体はここに残し、
   * 長い定義・詳しい理由は description（説明アイコン）へ渡す。
   */
  detail: ReactNode
  /**
   * 'qualifier'：説明と括弧の補足を2行で読む形。文章は同じまま、補足から改行する。
   * 'single'：帯の補足を1行＋省略にする（全文は title）。狭いマスで最後の1字だけ次の行に落ちる文に使う。
   */
  detailLayout?: 'qualifier' | 'single'
  /**
   * 指標の定義や取得できない詳しい理由などの長い説明。
   * 見出しの「？」を押したときだけ開く吹き出しへ入れるので、
   * カードの高さを理由の長さで伸ばさない。説明を開かないと異常が
   * 分からない形にしないため、状態の一言は必ず detail 側へ残す。
   */
  description?: ReactNode
  /** 説明アイコンの読み上げ名。省略時は「<title>の説明」。 */
  descriptionLabel?: string
  /**
   * 定義・分母・計算のしかた・単位・いつ時点の数か・言葉の意味。
   * 見出しのすぐ右の「？」へ入れる（★管理画面・§2-1b）。
   * `description` と両方渡したときは `help` を使う。
   */
  help?: ReactNode
  /** 題から説明を開くのが既定。「？」が描かれている題だけquestionを指定。 */
  helpDisplay?: 'label' | 'question'
  /** 「？」の見出し。省略時は title。読み上げ名は「{見出し}の説明」。 */
  helpLabel?: string
  /** 長い説明がある場所。渡すと吹き出しに「くわしく」が出る。 */
  helpHref?: string
  /** 「くわしく」の代わりの文言。 */
  helpHrefLabel?: string
  /**
   * 取得失敗など、その場でやり直せるときの再試行。
   * 短い状態のそばに出すので、説明を開かなくても辿れる。
   */
  onRetry?: () => void
  retryLabel?: string
  badge?: string
  /** warning は「見ておくとよい」。止まっている・壊れている（danger）ほど強くない注意に使う。 */
  badgeTone?: 'accent' | 'neutral' | 'warning' | 'danger'
  /** 行き先を数の行の右に置く。省略時・cards型の帯では補足の行（detail）を使う。 */
  actionPlacement?: 'detail' | 'value-row'
  action?: { label: string; href: string; onClick?: never } | { label: string; onClick: () => void; href?: never }
  loading?: boolean
  /** V8 は画面の絵に合わせてカードか線で区切るマスを選ぶ。 */
  presentation?: 'card' | 'band' | 'cell' | 'inline'
  density?: 'compact' | 'comfortable'
  className?: string
  hidden?: boolean
  id?: string
  'aria-label'?: string
  /**
   * faint は「値を出せない」の見せ方。0 を薄くする用途には使わない。
   * warning・danger は数字の色を変えず、右上に札（黄「要確認」・赤「要対応」）を出す。
   */
  valueTone?: 'default' | 'warning' | 'faint' | 'danger'
  /** 数と補足のあいだのメーター（送信枠の使った割合など）。value は 0〜100。 */
  meter?: { value: number; label: string; tone?: 'danger' }
  /** 流れが大事な数の細いグラフ（日ごとの数を古い順に）。数のカードの形（KpiBand appearance="cards"）で右下に出す。 */
  sparkline?: readonly number[]
}

/** 旧名。KpiCard に寄せたので、新しくは KpiCardProps を使う。 */
export type SummaryCardProps = KpiCardProps

/**
 * 現在のV8の数のカード。画面ごとの形はpresentationとdensityで指定する。
 *
 * 取れないときの出し方（★管理画面 `x63W5x`）。**0 とは別物。**
 * - 読み込み中：`loading` を渡す。数値は骨組み、3段目（`detail`）は部品が
 *   数字を含む補足を出さない（まだ確かでない「0件」を見せない）。言葉は画面が渡す。
 * - 取得失敗：`value`（または `valueText`）を `null` にして「—」を出し、
 *   3段目に「読み込めませんでした」と書く。やり直せるときは `onRetry` も渡す。
 */
export default function KpiCard({
  title,
  icon,
  delta,
  menu,
  value,
  valueAction,
  valueMenu,
  unit,
  unitSpacing = 'normal',
  signed = false,
  detail: detailProp,
  detailLayout,
  description,
  descriptionLabel,
  help,
  helpDisplay = 'label',
  helpLabel,
  helpHref,
  helpHrefLabel,
  onRetry,
  retryLabel,
  badge,
  badgeTone = 'accent',
  action,
  actionPlacement = 'detail',
  loading = false,
  presentation = 'card',
  density = 'comfortable',
  className,
  valueTone = 'default',
  valueText,
  primaryText,
  valueRange,
  valueTextWithUnit = false,
  meter,
  sparkline,
  ...cardProps
}: KpiCardProps) {
  // 読み込み中は、数字を含む補足（「0件」など、まだ確かでない数）を出さない。数字の無い補足はそのまま出す
  // （読み込み中に文字を足さず骨組みだけにする画面があるため、決まった一言には置き換えない）。
  const detail: ReactNode = loading && /[0-9０-９]/u.test(detailText(detailProp)) ? '' : detailProp
  const valueRef = React.useRef<HTMLButtonElement>(null)
  const classes = [styles.card, className].filter(Boolean).join(' ')

  /*
    補足は見出しの「？」（HelpTip）へ。開閉・Esc・外側・1つだけの
    扱いは HelpTip が持つので、カード側は中身を渡すだけにする。
  */
  const rangeText = valueRange === undefined ? undefined
    : isCountableValue(valueRange.from) && isCountableValue(valueRange.to)
      ? `${formatNumber(valueRange.from)} → ${formatNumber(valueRange.to)}` : '—'
  const textIsNumber = valueRange !== undefined || valueText === undefined || isKpiNumberText(valueText)
  const statusText = primaryText !== undefined || textIsNumber ? undefined : valueText
  const numberText = rangeText ?? (textIsNumber ? valueText : undefined)
  const menuDescription = help == null && description == null ? staticMenuDescription(menu) : undefined
  const tip = help ?? description ?? menuDescription
  const hasTip = tip !== undefined && tip !== null
  const explanation = <>{tip}{helpHref ? <a href={helpHref}>{helpHrefLabel ?? 'くわしく'}</a> : null}</>
  const explanationLabel = descriptionLabel ?? `${helpLabel ?? title}の説明`

  const displayedNumber = `${numberText === undefined && signed && isCountableValue(value) && value > 0 ? '+' : ''}${numberText !== undefined ? numberText : isCountableValue(value) ? formatNumber(value) : '—'}`
  /*
   * 値が無いとき（「—」）は単位だけを残さない。「— 件」のように、無い値に
   * 単位が付いて数があるように見えるのを防ぐ。0 は値なので単位を付ける。
   */
  const showUnit = statusText ? false
    : valueRange !== undefined ? rangeText !== '—'
      : valueText !== undefined ? textIsNumber && valueTextWithUnit
        : isCountableValue(value)
  /*
   * 数字に色は付けない（数は黒、0 は帯が薄い灰にする）。注意・危険は右上の札で知らせる。
   * 呼び出し側が札を渡していなければ、注意は黄の「要確認」、危険は赤の「要対応」を出す。
   */
  const toneBadge = !loading && (valueTone === 'warning' || valueTone === 'danger') ? valueTone : null
  const shownBadge = badge ?? (toneBadge === 'warning' ? '要確認' : toneBadge === 'danger' ? '要対応' : undefined)
  const shownBadgeTone = badge ? badgeTone : toneBadge ?? badgeTone
  const numberAndUnit = primaryText !== undefined ? (
    <span data-kpi-text-value className={styles.textValue} title={primaryText}>{primaryText || '—'}</span>
  ) : <>
    <KpiRollingValue text={displayedNumber} identity={cardProps.id ?? title} loading={loading || Boolean(cardProps.hidden)} />
    {showUnit ? <span data-kpi-unit className={styles.unit}>{unit}</span> : null}
  </>

  const actionNode = action ? (
    action.href !== undefined ? <Link href={action.href} prefetch={false} className={styles.link}>
      <span>{normalizeActionLabel(action.label)}</span><ArrowRight size={16} aria-hidden="true" />
    </Link> : <button type="button" className={styles.link} onClick={action.onClick}>
      <span>{normalizeActionLabel(action.label)}</span><ArrowRight size={16} aria-hidden="true" />
    </button>
  ) : null

  return (
    <div
      className={classes}
      data-kpi-presentation={presentation}
      data-kpi-density={density}
      data-kpi-range={valueRange !== undefined || undefined}
      data-kpi-detail-layout={detailLayout}
      data-kpi-zero={!loading && primaryText === undefined && valueRange === undefined && (valueText === undefined ? value === 0 : isZeroNumberText(valueText)) ? '' : undefined}
      aria-busy={loading || undefined}
      data-design-version="v8"
      {...cardProps}
    >
      <div className={styles.head}>
        {/*
          ★V8 G3：狭いマスで題がはみ出すときは CSS の「…」で受け、
          全文は title で読めるようにする（読み上げは変わらない）。
        */}
        <p
          data-kpi-label
          className={styles.label}
          title={title || undefined}
        >
          {icon == null ? null : (
            <span data-kpi-icon className={styles.icon} aria-hidden="true">
              {icon}
            </span>
          )}
          {hasTip && helpDisplay === 'label' ? (
            <HelpTip label={explanationLabel} className={styles.labelHelp} trigger={<span className={styles.labelText}>{titleParts(title)}</span>}>
              {explanation}
            </HelpTip>
          ) : <span className={styles.labelText}>
            {title ? titleParts(title) : (loading ? <span className={styles.labelSkeleton} aria-hidden="true" /> : null)}
          </span>}
          {hasTip && helpDisplay === 'question' ? (
            <HelpTip label={explanationLabel} className={styles.tip}>
              {explanation}
            </HelpTip>
          ) : null}
        </p>
        {menu && !menuDescription ? <span className={styles.menu}>{menu}</span> : null}
        {shownBadge ? (
          <span data-kpi-badge={shownBadgeTone} className={[styles.badge, ({ neutral: styles.badgeNeutral, warning: styles.badgeWarning, danger: styles.badgeDanger, accent: undefined })[shownBadgeTone]].filter(Boolean).join(' ')}>{shownBadge}</span>
        ) : null}
      </div>

      {/*
        帯の1マスに数が入りきらない時（「¥38,500」など）は、隣へはみ出さず字を少し小さくする。
        省略はしない。数の字数と単位の幅を CSS へ渡し、マスの幅から入る大きさを決める。
      */}
      <div className={styles.valueRow} data-unit-spacing={unitSpacing} data-kpi-fit
        style={{ '--kpi-fit-chars': Math.max(1, displayedNumber.length), '--kpi-fit-unit': `${showUnit ? (unit ?? '').length * 12 + 2 : 0}px` } as CSSProperties}>
      {/* 状態の言葉（「有効」など）は札だけで出す。数の場所に空の「—」を並べない（「—」は値が本当に無い時だけ）。 */}
      {loading ? (
        <div data-kpi-skeleton className={styles.skeleton} aria-hidden="true" />
      ) : statusText ? null : (
        <p
          className={[
            styles.value,
            primaryText !== undefined ? styles.textValueContainer : null,
            valueTone === 'faint' ? styles.valueFaint : null,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {valueMenu ? <button ref={valueRef} type="button" className={styles.valueAction} aria-label={valueMenu.label} aria-haspopup="menu" aria-expanded={valueMenu.open} onClick={() => valueMenu.onOpenChange(!valueMenu.open)}>{numberAndUnit}</button> : valueAction ? (
            <button type="button" className={styles.valueAction} aria-label={valueAction.label} aria-expanded={valueAction.expanded} onClick={valueAction.onClick}>{numberAndUnit}</button>
          ) : numberAndUnit}

        </p>
      )}

      {statusText && !loading ? <StatusBadge>{statusText}</StatusBadge> : null}
      {delta ? <span className={styles.delta} data-kpi-delta-slot>{delta}</span> : null}
      {actionPlacement === 'value-row' && actionNode ? <span className={styles.valueActionSlot} data-kpi-action-slot>{actionNode}</span> : null}
      </div>

      {sparkline && sparkline.length > 1 && !loading ? <Sparkline values={sparkline} /> : null}
      {meter && !loading ? <ProgressBar appearance="quota" tone={meter.tone} value={meter.value} label={meter.label} className={styles.meter} /> : null}
      {valueMenu ? <ActionMenu open={valueMenu.open} items={valueMenu.items} ariaLabel={valueMenu.label} anchorRef={valueRef} onClose={() => valueMenu.onOpenChange(false)} /> : null}
      <p data-kpi-detail data-kpi-detail-present={Boolean(detailText(detail).trim() || onRetry || (actionPlacement === 'detail' && action)) || undefined} className={styles.detail}>
        <span role="note" className={styles.detailText} title={detailText(detail) || undefined}>{detailLayout === 'qualifier' && typeof detail === 'string' ? detail.replace(/(.)(（)/u, '$1\n$2') : detail}</span>
        {onRetry ? (
          <button type="button" className={styles.retry} onClick={onRetry}>
            {retryLabel ?? <RetryLabel />}
          </button>
        ) : null}
        {actionPlacement === 'detail' ? actionNode : null}
      </p>
    </div>
  )
}

/** 細いグラフ（読み上げない飾り。数そのものは数字と補足で伝える）。 */
function Sparkline({ values }: { values: readonly number[] }) {
  const max = Math.max(...values), min = Math.min(...values)
  const span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${22 - ((value - min) / span) * 20}`).join(' ')
  return <svg data-kpi-sparkline className={styles.sparkline} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <polyline points={`0,24 ${points} 100,24`} className={styles.sparklineArea} />
    <polyline points={points} className={styles.sparklineLine} />
  </svg>
}
