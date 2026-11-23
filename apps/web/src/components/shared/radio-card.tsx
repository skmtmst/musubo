import { useId, type CSSProperties, type FormEventHandler, type KeyboardEventHandler, type Ref, type ReactNode } from 'react'
import styles from './radio-card.module.css'
import { CircleCheck } from 'lucide-react'
import { joinDescribedBy, useFieldContext } from './field-context'
import { usePermissionLockTip } from './permission-lock-tip'

/**
 * ラジオカード。「この中から1つだけ選ぶ」選択肢をカードで出す共通部品。
 *
 * 監査 DEEP-02／共通仕様「入力欄と選択カード」§2:
 * ●・○ の文字や role の無い button ではなく、**本物の input[type=radio]** を
 * 使う。同じ `name` のラジオ群は Tab で群に入り、矢印キーと Space で
 * 選べて、読み上げにも選択状態が伝わる。
 *
 * 押せる範囲はカード全体（label が丸ごと囲む）。V8 の箱（card・compact）は
 * 選んだことが**枠と面の色**で分かるので装飾の丸を出さない。読み上げと矢印
 * キーのために本物の input は残し、見えない大きさで置く（キーボードの位置は
 * 箱の枠に出す）。行（row）は素のラジオ行なので丸 18px をそのまま出す。
 *
 * 使い方:
 *   <RadioCardGroup legend="配信方法" className="grid gap-3 md:grid-cols-3">
 *     <RadioCard name="delivery-method" value="new" checked={...} onChange={...}
 *                title="新しいメッセージを作る" note="一から作ります。" />
 *   </RadioCardGroup>
 */

/**
 * 1つだけ選ぶ群を fieldset/legend で束ねる。legend は読み上げの「群名」に
 * なるので必ず渡す。画面上に同じ名前の見出しがすでにあるときは
 * 既定（`legendVisible` なし）で視覚的には隠し、読み上げだけに効かせる。
 * `className` はカードを並べる内側のコンテナへ付く（既定は縦1列）。
 */
export function RadioCardGroup({
  id,
  legend,
  invalid,
  'aria-describedby': describedBy,
  onInput,
  legendVisible = false,
  columns,
  className,
  children,
}: {
  /** 群の名前。例「基準日の選択」「配信方法」。 */
  id?: string
  invalid?: boolean
  'aria-describedby'?: string
  onInput?: FormEventHandler<HTMLFieldSetElement>
  legend: string
  /** true にすると群名を見出しとして表示する。既定は読み上げ専用。 */
  legendVisible?: boolean
  /** 窓内のカードを本文幅に等分する。省略時は既存の並びを保つ。 */
  columns?: 2 | 3
  className?: string
  children: ReactNode
}) {
  return (
    <fieldset id={id} className={styles.group} aria-invalid={invalid || undefined} aria-describedby={describedBy} onInput={onInput}>
      <legend className={legendVisible ? styles.legend : 'sr-only'}>{legend}</legend>
      <div className={[styles.items, className].filter(Boolean).join(' ')} data-choice-columns={columns} style={columns ? { '--choice-columns': columns } as CSSProperties : undefined}>{children}</div>
    </fieldset>
  )
}

export interface RadioCardProps {
  id?: string
  inputRef?: Ref<HTMLInputElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  tabIndex?: number
  ariaLabel?: string
  /** 同じ群で同じ name。矢印キーで行き来できるのは同じ name のラジオ同士だけ。 */
  name: string
  value: string
  checked: boolean
  onChange: (value: string) => void
  /** 選択肢の名前。 */
  title: string
  /** 補足。選ぶと何が起きるか（実行を伴う選択ならその動作）を書く。 */
  note?: ReactNode
  /** 説明の下に置く図など。省略時は既存のカードの形を保つ。 */
  children?: ReactNode
  disabled?: boolean
  /**
   * 選べない理由。disabled のときは必ず併記する。
   * 「選べないのに選択済みの見た目」にはしない（選択中の着色は付けない）。
   */
  disabledReason?: string
  /** 権限で選べない時の理由。選択の印と焦点は残し、選択や再選択の操作を止める。 */
  lockedReason?: string
  /** エラー状態。選択が必須なのに未確定、など。 */
  invalid?: boolean
  /**
   * 選択済みのカードをもう一度押したときにも呼ばれるクリック。
   * 「テンプレートを選択」のように、再選択で別画面を開き直す選択肢だけに使う。
   */
  onClick?: () => void
  className?: string
  /** V8 の上段に出す印。省略すると印は出さない（既定）。互換経路では非表示。 */
  icon?: ReactNode
  /**
   * 選ぶカードの形。既定は箱（fNPdg/r3xz1W）。
   * `'row'` は箱なしの行（ の素のラジオ行：丸 18・文字 13）。
   * `'compact'` は小さい箱（★BG-B の出力サイズ o2XyUk/aCyxg：
   * 角 8・余白 8/10・題 11/600・補足 10）。狭い脇のパネルに並べる選択肢に使う。
   * `'form'` は作る画面や操作窓の小さい箱。印を題の左に並べる（・）。
   * 画面の絵で行で並んでいる選択肢には `'row'` を使う。カードのラジオは右上に置く。
   */
  variant?: 'card' | 'row' | 'compact' | 'form'
  /** 統括の生成パネルの小さい箱（題12/700、補足11）。 */
  compactTypography?: 'default' | 'banner'
  /**
   * 箱（card）の高さ。既定は上に印がある場合だけ最低 98。
   * `'short'` は高さ 90 の箱（★V8 E-3 ウォークインの卓のカード ：上に印・右上に丸・題・説明）。
   * `'fit'` は中身なりの高さ（LINE新規追加 v06 ①事前確認 GLA3C 52・f7UGE 78：
   * 題だけの選択肢を 98 の箱に入れると下が大きく空くため、最低高さだけ外す）。
   * 渡したときだけ効き、既定の見た目は変えない。
   */
  height?: 'default' | 'short' | 'fit'
  /** 横並びの小さい箱。既定のカード・行・管理画面 の寸法は変えない。 */
  size?: 'default' | 'small'
  /** 図・本文を右上の丸の下へ置く箱。本文の右側を丸用に狭めない。 */
  contentPlacement?: 'standard' | 'below-indicator'
  /** 面のタイルは選択枠と題の印で示し、入力自体は読み上げとキー操作に残す。 */
  indicator?: 'radio' | 'check'
}

export default function RadioCard({
  id,
  inputRef, onKeyDown, tabIndex, ariaLabel,
  name,
  value,
  checked,
  onChange,
  title,
  note,
  children,
  disabled = false,
  disabledReason,
  lockedReason,
  invalid = false,
  onClick,
  className,
  icon,
  variant = 'card',
  compactTypography = 'default',
  height = 'default',
  size = 'default',
  contentPlacement = 'standard',
  indicator = 'radio',
}: RadioCardProps) {
  const field = useFieldContext()
  const disabledReasonId = useId()
  const lock = usePermissionLockTip<HTMLLabelElement>(lockedReason, field?.describedBy)
  invalid = invalid || Boolean(field?.invalid)
  return (
    <label
      ref={lockedReason ? lock.ref : undefined}
      className={[
        variant === 'row' ? styles.row : styles.card,
        variant === 'compact' ? styles.compact : null,
        variant === 'form' ? styles.form : null,
        variant === 'card' && height === 'short' ? styles.short : null,
        variant === 'card' && height === 'fit' ? styles.fit : null,
        variant === 'card' && size === 'small' ? styles.small : null,
        checked ? styles.checked : null,
        disabled || lockedReason ? styles.disabled : null,
        lockedReason ? styles.locked : null,
        invalid ? styles.invalid : null,
        className,
      ].filter(Boolean).join(' ')}
      data-choice-card={variant !== 'row' || undefined}
      data-top-icon={icon && variant !== 'form' ? '' : undefined}
      data-permission-locked={lockedReason ? '' : undefined}
      data-no-name-tip={lockedReason ? '' : undefined}
      data-variant={variant}
      data-content-placement={contentPlacement}
      data-choice-indicator={indicator === 'check' ? indicator : undefined}
      data-compact-typography={variant === 'compact' ? compactTypography : undefined}
      onClick={lockedReason ? lock.handlers?.onClick : disabled ? undefined : onClick}
      onDoubleClick={lock.handlers?.onDoubleClick}
      onPointerEnter={lock.handlers?.onPointerEnter}
      onPointerLeave={lock.handlers?.onPointerLeave}
      onPointerDown={lock.handlers?.onPointerDown}
      onFocus={lock.handlers?.onFocus}
      onBlur={lock.handlers?.onBlur}
    >
      {icon && variant !== 'form' ? <span className={styles.topIcon} aria-hidden="true">{icon}</span> : null}
      <input
        type="radio"
        ref={inputRef}
        onKeyDown={lockedReason ? (event) => {
          if (['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault()
            event.stopPropagation()
          } else onKeyDown?.(event)
        } : onKeyDown}
        tabIndex={tabIndex}
        aria-label={ariaLabel}
        id={id}
        className={styles.radio}
        name={name}
        value={value}
        checked={checked}
        disabled={lockedReason ? false : disabled}
        aria-disabled={lockedReason ? true : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={lockedReason ? lock.handlers?.['aria-describedby'] : joinDescribedBy(field?.describedBy, disabled && disabledReason ? disabledReasonId : undefined)}
        onChange={() => { if (!lockedReason) onChange(value) }}
      />
      <span className={styles.body}>
        <strong className={styles.title} title={title}>{indicator === 'check' && checked && (!disabled || lockedReason) ? <CircleCheck className={styles.check} data-choice-check aria-hidden="true" /> : null}{icon && variant === 'form' ? <span className={styles.inlineIcon} aria-hidden="true">{icon}</span> : null}{title}</strong>
        {note ? <small className={styles.note} title={typeof note === 'string' ? note : undefined}>{note}</small> : null}
        {disabled && disabledReason && !lockedReason ? <small id={disabledReasonId} className={styles.reason}>{disabledReason}</small> : null}
      </span>
      {children}
      {lock.node}
    </label>
  )
}
