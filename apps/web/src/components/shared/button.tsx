
import Link from '@/components/shared/list-navigation'
import type { LinkProps } from 'next/link'
import { Check, LoaderCircle, ArrowUpRight, LogIn, Settings, RotateCcw } from 'lucide-react'
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react'
import styles from './button.module.css'
import { normalizeActionLabel, normalizeActionNode } from './action-words'
import TooltipBubble from './tooltip-bubble'

type CommonProps = {
  /**
   * `danger` は確定ダイアログの削除・解除などに使う赤。
   * `#976` U077/U084: 危険操作は共通ボタンの1役割として持ち、
   * 画面ごとの直書き赤（濃さがバラバラだった）を1本にする。
   */
  variant?: 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'line' | 'text'
  /**
   * `compact` は一覧の行内・絞り込み行など、32px級の操作と高さを
   * そろえるときだけ使う（★管理画面：行内の操作は32）。本文の操作は
   * `standard` のままにする。
   */
  size?: 'standard' | 'field' | 'large' | 'compact' | 'inline' | 'slot' | 'thumbnail' | 'composer' | 'composer-small' | 'inbox-tool' | 'booking'
  fullWidth?: boolean
  align?: 'start'
  /**
   * 字の色だけを絵に合わせる指定。渡したボタンだけに効き、既定のボタンと他の画面は変えない。
   * `action` が既定（指定なしと同じ）。`ink` は行内の時刻など、リンク色にしない文字操作。
   * `danger`（赤）・`accent`（濃い緑）・`quiet`（本文より淡い灰）は、
   * 白地・細枠のまま字だけ色を変える絵のために置く
   * （★V8 デリバリー受注 kDQHr の `AuCyJ`/`HKAi1` 拒否・`WvPd6`/`jEsnn` 準備完了、
   * サービス札の「停止」「再開」）。画面CSSから共通ボタンを上書きしない書き方（設計ルール2節）。
   */
  textTone?: 'action' | 'ink' | 'danger' | 'accent' | 'quiet'
  /** よく使う絞り込みが適用中の印。開閉状態は aria-expanded で別に伝える。 */
  filterActive?: boolean
  /** 選んでいる絞り込み条件の数。0件は表示しない。 */
  count?: number
  /** 権限で使えない理由。Tab・吹き出しを保ち、送信と移動を止める専用の口。 */
  lockedReason?: string | null
  /** 欄の横の小さな文字操作。指定した操作だけ詰め、既定のボタンは変えない。 */
  presentation?: 'account-inline' | 'registration-inline' | 'restaurant' | 'row-action' | 'hours' | 'step-action' | 'first-run-start' | 'quiet-text'
  className?: string
  /** Authored action words only; entity names and arbitrary values remain unchanged. */
  actionWording?: boolean
  /** 保存・公開・比較など、明示した役目の印。省略時は従来の描画を保つ。 */
  icon?: ReactNode
  children: ReactNode
}

type NativeButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className' | 'href' | 'aria-busy'> & {
    href?: never
    /** 既存の無効条件に対応する理由。押せる状態では表示しない。 */
    disabledReason?: string | null
    /** 開いた直後に標的を寄せたいときだけ渡す（未保存の離脱確認の主ボタン）。 */
    ref?: React.Ref<HTMLButtonElement>
    /**
     * ★管理画面 仕上げ §2「保存中」。true の間は回る印＋`busyLabel`（規定
     * 「保存中…」）に見た目を切り替え、押せなくする（二重送信を防ぐ）。
     * 文字が変わっても幅はぶれない。呼び出し側はいままでの
     * `{saving ? '保存中…' : '…'}` の代わりに `busy={saving}` を渡す。
     */
    busy?: boolean | null
    /** `busy` の間に出す文字。規定は「保存中…」。 */
    busyLabel?: string
    /**
     * ★管理画面 仕上げ §2「完了」。true に切り替わったら ✓＋`doneLabel`
     * （規定「保存しました」）を1.2秒だけ出してから元の文字へ戻る。
     * 失敗したときは渡さない——ボタンは元に戻り、理由は知らせ
     * （Toast）と欄の下に出す。
     */
    done?: boolean | null
    /** `done` の間に出す文字。規定は「保存しました」。 */
    doneLabel?: string
    /**
     * 幅の控えのしかた。規定の `'states'` は「保存中…」「保存しました」の
     * 両方を先に測って広いほうで幅を押さえる（文字が変わっても跳ねない）。
     *
     * `'idle'` は平常時の文字だけで幅を決める。`done` を渡さないボタン、
     * かつ絵が幅を指定している並び（窓の足など）で使う。`busy` の間も
     * 平常時の幅を下回らないので、こちらでも幅は跳ねない。
     */
    /** `dynamic` は件数などで平常時の文字が変わる操作。状態の予約を保ち、現在の全文で測り直す。 */
    widthReserve?: 'states' | 'idle' | 'dynamic'
  }

type LinkButtonProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'aria-disabled' | 'children' | 'className' | 'disabled' | 'href'> & {
    external?: boolean
    href: LinkProps['href']
    disabled?: never
    'aria-disabled'?: never
  }

export type ButtonProps = NativeButtonProps | LinkButtonProps

/** 「完了」の見せ時間（★管理画面 仕上げ §2: 1.2秒）。 */
const DONE_FLASH_MS = 1200

/**
 * Pencil V5 の `nBRKk`（主要）と `uzNEC`（副次）を正本にした共通ボタン。
 * 管理画面専用のボタン部品は存在しないため、管理画面画面でもこの寸法を使う。
 *
 * 見た目は部品が固定し、呼び出し側は幅と外側余白だけを `className` で決める。
 * 表示制御にはTailwindのdisplayクラスではなくHTMLの `hidden` 属性を使う。
 */
/** 図柄だけの操作には title と同じ読み上げ名を付ける。文字の操作の名前は保つ。 */
function hasButtonText(children: ReactNode): boolean {
  return React.Children.toArray(children).some((child) => {
    if (typeof child === 'string') return child.trim().length > 0
    if (typeof child === 'number') return true
    if (!React.isValidElement<{children?:ReactNode; 'aria-hidden'?: boolean | 'true' | 'false'}>(child)) return false
    if (child.type === 'svg' || child.props['aria-hidden'] === true || child.props['aria-hidden'] === 'true') return false
    return hasButtonText(child.props.children)
  })
}
function iconButtonLabel(props: {children:ReactNode;title?:string;actionWording?:boolean;count?:number;'aria-label'?:string;'aria-labelledby'?:string}) {
  const label = props['aria-label'] ?? (!props['aria-labelledby'] && !hasButtonText(props.children) ? props.title : undefined)
  const normalized = props.actionWording && typeof label === 'string' ? normalizeActionLabel(label) : label
  return normalized && props.count !== undefined && Number.isFinite(props.count) && props.count > 0 ? `${normalized} ${props.count}件の条件` : normalized
}

/** 字の色の指定を束ねの名前へ。`action`（既定）は何も足さない。 */
const TEXT_TONE = {
  ink: 'textInk',
  danger: 'textDanger',
  accent: 'textAccent',
  quiet: 'textQuiet',
} as const

export default function Button(props: ButtonProps) {
  const variant = props.variant ?? 'secondary'
  const size = props.size ?? 'standard'
  const tone = props.textTone && props.textTone !== 'action' ? styles[TEXT_TONE[props.textTone]] : null
  const classes = [styles.button, styles[variant], styles[size], tone, props.filterActive && styles.filterActive, props.className].filter(Boolean).join(' ')

  if (props.lockedReason && 'href' in props && props.href !== undefined) {
    // 移動先をDOMに残さず、通常のリンクと同じ属性・文字を持つ焦点可能なボタンへ。
    const { href: _href, external: _external, target: _target, rel: _rel, download: _download, onClick: _onClick, ...locked } = props
    return <NativeButton {...(locked as NativeButtonProps)} classes={classes} />
  }

  if ('href' in props && props.href !== undefined) {
    const { children, icon, count, lockedReason: _lockedReason, actionWording: _actionWording, className: _className, href, external, size: _size, variant: _variant, align, fullWidth, textTone: _textTone, presentation, filterActive: _filterActive, ...linkProps } = props
    for (const key of ['busy', 'busyLabel', 'done', 'doneLabel', 'widthReserve', 'disabledReason']) delete (linkProps as Record<string, unknown>)[key]
    const newTab = external || linkProps.target === '_blank'
    return (
      <Link href={href} className={classes} data-shared-button="" data-variant={variant} data-align={fullWidth ? undefined : align} data-full-width={fullWidth || undefined} data-presentation={presentation} {...linkProps} data-text-content={hasButtonText(children) || undefined} target={newTab ? '_blank' : linkProps.target} rel={newTab ? 'noopener noreferrer' : linkProps.rel} aria-label={iconButtonLabel(props)}>
        {icon}{props.actionWording ? normalizeActionNode(children) : children}
        <ConditionCount count={count} />
        {newTab ? <ArrowUpRight size={16} aria-hidden="true" data-external-icon /> : null}
      </Link>
    )
  }

  const nativeProps = { ...props } as NativeButtonProps & Pick<LinkButtonProps, 'external'>
  delete nativeProps.external
  return <NativeButton {...nativeProps} classes={classes} />
}

function NativeButton(props: NativeButtonProps & { classes: string }) {
  const {
    children: rawChildren,
    icon,
    count,
    actionWording: _actionWording,
    classes,
    className: _className,
    variant: _variant,
    size: _size,
    align,
    fullWidth,
    textTone: _textTone,
    filterActive: _filterActive,
    presentation,
    href: _href,
    type = 'button',
    busy,
    busyLabel = '保存しています…',
    done,
    doneLabel = '保存しました',
    widthReserve = 'states',
    disabled,
    disabledReason,
    lockedReason,
    onPointerEnter: onPointerEnterProp,
    onPointerLeave: onPointerLeaveProp,
    onPointerDown: onPointerDownProp,
    onFocus: onFocusProp,
    onBlur: onBlurProp,
    onKeyDown: onKeyDownProp,
    ref,
    onClick,
    ...buttonProps
  } = props
  const children = props.actionWording ? normalizeActionNode(rawChildren) : rawChildren
  const permissionLocked = Boolean(lockedReason)
  const ariaLocked = buttonProps['aria-disabled'] === true || buttonProps['aria-disabled'] === 'true'
  const reasonId = useId()
  const tipId = useId()
  const focusFrame = useRef(0)
  const [tip, setTip] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const showReason = useCallback(() => {
    const element = elementRef.current
    if (!element) return
    const css = getComputedStyle(document.documentElement)
    const edge = Number.parseFloat(css.getPropertyValue('--polish-space-row')) || 8
    const width = Number.parseFloat(css.getPropertyValue('--polish-tooltip-width')) || 288
    const gap = Number.parseFloat(css.getPropertyValue('--polish-tooltip-gap')) || 8
    const rect = element.getBoundingClientRect()
    const below = rect.top < 48
    setTip({ left: Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge)), top: below ? rect.bottom + gap : rect.top - gap, below })
  }, [])
  const hideReason = useCallback(() => setTip(null), [])
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), [])
  useEffect(() => {
    if (!tip) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { cancelAnimationFrame(focusFrame.current); hideReason() } }
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hideReason, true)
    window.addEventListener('resize', hideReason)
    return () => {
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', hideReason, true)
      window.removeEventListener('resize', hideReason)
    }
  }, [tip, hideReason])

  /*
   * ★管理画面 仕上げ §2「保存中・完了」。DOM に出す文字は常に今のラベル1つだけ
   * （読み上げ・検索が迷子にならないよう、隠した文字は残さない）。
   * 幅はぶれないよう、平常時に測った幅を `min-width` に留めておき、
   * 「保存中…」「保存しました」の間もその幅を下回らない。
   */
  const [automaticBusy, setAutomaticBusy] = useState(false)
  const [automaticError, setAutomaticError] = useState('')
  const automaticLock = useRef(false)
  const stateful = busy !== undefined || done !== undefined || props.busyLabel !== undefined || automaticBusy
  const busyNow = busy === true || automaticBusy

  /* done が true になったら 1.2 秒だけ ✓ を出して元の文字へ戻す。 */
  const [doneFlashing, setDoneFlashing] = useState(false)
  useEffect(() => {
    if (done === true && busy !== true) {
      setDoneFlashing(true)
      const timer = setTimeout(() => setDoneFlashing(false), DONE_FLASH_MS)
      return () => clearTimeout(timer)
    }
    setDoneFlashing(false)
  }, [done, busy])

  const elementRef = useRef<HTMLButtonElement | null>(null)
  const idleWidthRef = useRef(0)
  const measuredLabelRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = elementRef.current
    if (!el || !stateful) return
    if (fullWidth) { el.style.width = ''; el.style.minWidth = ''; return }
    if (busyNow || done === true) {
      if (idleWidthRef.current > 0) el.style.minWidth = `${idleWidthRef.current}px`
      return
    }
    // 親の再描画でラベルが変わらなければ、複製・挿入・幅取得を繰り返さない。
    const measurementKey = JSON.stringify([classes, el.innerHTML, busyLabel, doneLabel, widthReserve, presentation, buttonProps.style, buttonProps.hidden])
    if (measuredLabelRef.current === measurementKey) return
    const measure = () => {
      // Responsive toolbars mount both actions; the hidden copy has no measurable width.
      // Wait for that copy to become visible instead of caching a 21px icon-only width.
      if (el.offsetWidth === 0) return
      measuredLabelRef.current = measurementKey
      // 前のラベル用に予約した幅を外し、今の全文と状態ラベルから測り直す。
      el.style.width = ''
      el.style.minWidth = ''
      idleWidthRef.current = el.offsetWidth
      if (widthReserve === 'idle') {
        /*
         * 絵が幅を決めている並び。結果の文字の分を控えず、平常時の文字で幅を決める。
         * `busy` の間は上の min-width がこの幅を守るので、やはり跳ねない。
         */
        el.style.width = ''
        idleWidthRef.current = el.offsetWidth
        return
      }
      // いちばん長い結果の文字も最初に測る。成功した瞬間に幅が跳ねない。
      const sample = el.cloneNode(false) as HTMLButtonElement
      sample.removeAttribute('id')
      sample.setAttribute('aria-hidden', 'true')
      sample.style.cssText = 'position:absolute;visibility:hidden;width:max-content;min-width:0;pointer-events:none'
      el.parentElement?.appendChild(sample)
      let widest = idleWidthRef.current
      for (const label of [busyLabel, doneLabel]) {
        sample.textContent = label
        widest = Math.max(widest, sample.offsetWidth + 21)
      }
      sample.remove()
      el.style.width = `${widest}px`
    }
    measure()
    if (measuredLabelRef.current === measurementKey || !window.ResizeObserver) return
    const observer = new ResizeObserver(() => {
      measure()
      if (measuredLabelRef.current === measurementKey) observer.disconnect()
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  const setRefs = (el: HTMLButtonElement | null) => {
    elementRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (permissionLocked || ariaLocked) { event.preventDefault(); event.stopPropagation(); return }
    if (busyNow || disabled || automaticLock.current) return
    // Reactがbusyを描き直す前と、onClick内からの再入も共通の門で止める。
    automaticLock.current = true
    setAutomaticError('')
    let pending: unknown
    try {
      pending = onClick?.(event)
      if (!pending || typeof (pending as PromiseLike<unknown>).then !== 'function') {
        automaticLock.current = false
        return
      }
    } catch {
      automaticLock.current = false
      setAutomaticError('処理できませんでした。もう一度お試しください。')
      return
    }
    setAutomaticBusy(true)
    void Promise.resolve(pending).catch(() => {
      setAutomaticError('処理できませんでした。もう一度お試しください。')
    }).finally(() => {
      automaticLock.current = false
      setAutomaticBusy(false)
    })
  }
  const shownDone = doneFlashing && !busyNow
  return (<>
    <button
      type={type}
      className={classes}
      data-shared-button=""
      data-variant={_variant ?? 'secondary'}
      data-align={fullWidth ? undefined : align} data-full-width={fullWidth || undefined}
      data-presentation={presentation}
      ref={setRefs}
      disabled={!permissionLocked && (Boolean(disabled) || busyNow)}
      aria-busy={busyNow ? true : undefined}
      {...buttonProps}
      aria-disabled={permissionLocked || ariaLocked ? true : undefined}
      aria-describedby={[buttonProps['aria-describedby'], permissionLocked ? reasonId : null].filter(Boolean).join(' ') || undefined}
      data-text-content={hasButtonText(busyNow ? busyLabel : shownDone ? doneLabel : children) || undefined}
      data-permission-locked={permissionLocked ? '' : undefined}
      title={buttonProps.title}
      aria-description={permissionLocked ? undefined : disabled && disabledReason ? disabledReason : buttonProps['aria-description']}
      aria-label={iconButtonLabel(props)}
      onPointerEnter={(event) => { onPointerEnterProp?.(event); if (permissionLocked && event.pointerType !== 'touch') showReason() }}
      onPointerLeave={(event) => {
        onPointerLeaveProp?.(event)
        if (permissionLocked && event.pointerType !== 'touch' && document.activeElement !== event.currentTarget) hideReason()
      }}
      onPointerDown={(event) => { if (permissionLocked) { if (event.pointerType === 'touch') showReason() } else if (!ariaLocked) onPointerDownProp?.(event) }}
      onFocus={(event) => {
        onFocusProp?.(event)
        if (permissionLocked) {
          showReason()
          // Tabの自動スクロールが終わった位置で描き直す。最初のscrollで理由を消したままにしない。
          cancelAnimationFrame(focusFrame.current)
          focusFrame.current = requestAnimationFrame(() => { if (document.activeElement === elementRef.current) showReason() })
        }
      }}
      onBlur={(event) => { onBlurProp?.(event); cancelAnimationFrame(focusFrame.current); if (permissionLocked) hideReason() }}
      onKeyDown={(event) => {
        if ((permissionLocked || ariaLocked) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); return }
        onKeyDownProp?.(event)
      }}
      onClick={handleClick}
    >
      {busyNow ? <LoaderCircle className={styles.spin} size={16} aria-hidden="true" /> : null}
      {shownDone ? <Check size={16} aria-hidden="true" /> : null}
      {!busyNow && !shownDone ? icon : null}
      {busyNow ? busyLabel : shownDone ? doneLabel : children}
      <ConditionCount count={count} />
    </button>
    {permissionLocked ? <><span id={reasonId} hidden>{lockedReason}</span>{tip ? <TooltipBubble id={tipId} text={lockedReason!} left={tip.left} top={tip.top} below={tip.below} /> : null}</> : null}
    {disabled && !buttonProps.hidden && !permissionLocked && !busyNow && disabledReason ? <span className={styles.disabledReason} role="status">{disabledReason}</span> : null}
    {automaticError ? <span role="alert" data-button-error>{automaticError}</span> : null}
  </>)
}

function ConditionCount({ count }: { count?: number }) {
  return count !== undefined && Number.isFinite(count) && count > 0
    ? <span className={styles.conditionCount} aria-label={`${count}件の条件`}>{count}</span> : null
}

/** アカウント操作の文字と印は、この対応表だけで決める。 */
const ACCOUNT_ACTIONS = {
  enter: { label: '入る', icon: LogIn },
  detail: { label: '詳細', icon: null },
  settings: { label: '設定', icon: Settings },
  restore: { label: '戻す', icon: RotateCcw },
} as const

export function AccountActionButton({ action, ...props }: Omit<NativeButtonProps, 'children' | 'icon'> & { action: keyof typeof ACCOUNT_ACTIONS }) {
  const { label, icon: Icon } = ACCOUNT_ACTIONS[action]
  return <Button {...props} icon={Icon ? <Icon aria-hidden="true" /> : undefined}>{label}</Button>
}
