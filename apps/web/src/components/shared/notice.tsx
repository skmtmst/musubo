'use client'

import { Children, Fragment, cloneElement, isValidElement, useCallback, useEffect, useState, type ComponentPropsWithRef, type HTMLAttributes, type ReactNode } from 'react'
import { Check, Info, TriangleAlert, X } from 'lucide-react'
import HelpTip from './help-tip'
import './notice-tokens.css'
import styles from './notice.module.css'
import { humanizeErrorText } from './human-error-text'
import { jstDate } from '@/lib/jst-datetime'

/** 複数の帯の間隔をまとめて持ち、各帯の外側の余白を二重にしない。 */
export function NoticeStack({children}:{children:ReactNode}){
  return <div className={styles.stack} data-notice-stack>{children}</div>
}

/** 知らせは案内・成功・注意・危険の4種類。呼び名と見た目はここが持つ。 */
export type NoticeTone = 'info' | 'success' | 'warn' | 'danger'
type CanonicalTone = NoticeTone

/* 正本は Pencil ★V8 `ThDed`「帯/案内」。下の節点の印 uR9s8 は前の版から引き継いだ値で、4種とも同じ。 */
const NODE_BY_TONE: Record<CanonicalTone, string> = {
  info: 'uR9s8',
  success: 'uR9s8',
  warn: 'uR9s8',
  danger: 'uR9s8',
}

/* 色だけに頼らないよう、注意と失敗は題（題が無ければ本文）の頭に言葉を付ける。 */
const STATUS_WORD_BY_TONE: Partial<Record<CanonicalTone, string>> = {
  warn: '要確認',
  danger: '失敗',
}

/** 文字・断片・要素の中の文字だけをつないで、書き出しを読む。 */
function leadingText(node: ReactNode): string {
  let text = ''
  Children.forEach(node, child => {
    if (text.length > 8) return
    if (typeof child === 'string' || typeof child === 'number') text += String(child)
    else if (isValidElement<{ children?: ReactNode }>(child)) text += leadingText(child.props.children)
  })
  return text.trimStart()
}

/** 段落・箇条書きの先頭にも、同じ行の言葉として札を入れる。本文の幅と段落の余白を保つ。 */
function prependStatusWord(content: ReactNode, prefix: ReactNode): ReactNode {
  let placed = false
  const inlineContainers = new Set(['p', 'span', 'strong', 'em', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const prepend = (nodes: ReactNode, mayPlace = true): ReactNode => Children.map(nodes, child => {
    if (placed || child === null || typeof child === 'boolean' || typeof child === 'string' && !child.trim()) return child
    if (isValidElement<{ children?: ReactNode; className?: string; hidden?: boolean; 'aria-hidden'?: boolean | 'true' | 'false' }>(child)) {
      if (child.props.hidden || child.props['aria-hidden'] === true || child.props['aria-hidden'] === 'true' || child.props.className?.split(/\s+/).includes('sr-only')) return child
      if (typeof child.type === 'string' && ['svg', 'img', 'br', 'hr', 'input'].includes(child.type)) return child
      if ((child.type === Fragment || typeof child.type === 'string' && inlineContainers.has(child.type)) && child.props.children !== undefined) {
        const isList = child.type === 'ul' || child.type === 'ol'
        const nested = prepend(child.props.children, child.type === Fragment ? mayPlace : !isList)
        if (placed) return cloneElement(child, undefined, nested)
      }
    }
    if (!mayPlace) return child
    placed = true
    return <>{prefix}{child}</>
  })
  const result = prepend(content)
  return placed ? result : <>{prefix}{content}</>
}

export type NoticeProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  ref?: ComponentPropsWithRef<'div'>['ref']
  'data-design-node'?: string
  tone: NoticeTone
  density?: 'compact'
  /** 2行の競合通知。既定の案内帯は変えない。 */
  heading?: ReactNode
  /** 保存の状況など、説明の下に並べる状態。 */
  states?: readonly { label: string; state: 'done' | 'pending' }[]
  /** 区切り線の下の控えめな操作。確認と遷移は呼び出し側が持つ。 */
  footer?: ReactNode
  /** @deprecated 印は tone ごとに固定。互換のため受け取るが描画には使わない。 */
  marker?: 'dot'
  /** カード内などの小さな帯。案内・成功の本文は1行に省略し、title で全文を渡す。警告・危険は折り返す。 */
  compact?: boolean
  /** 枠線のない注意帯を描く板だけで指定する。既定の帯は変えない。 */
  appearance?: 'soft' | 'subtle' | 'caution'
  /** 本文（1〜2文）。`children` があるときはそちらが勝つ。 */
  message?: string
  children?: ReactNode
  /** 右の操作。主操作は1つ、副操作と並べられる。 */
  action?: ReactNode
  /** 長い本文を持つ帯では、狭幅時だけ操作を本文の下へ置ける。 */
  actionLayout?: 'stack-on-narrow'
  /** 閉じる印を出す。押すと呼ばれる。 */
  onClose?: () => void
  /**
   * 読まなくても操作できる定義だけの補足。文のすぐ右の「？」へ入れる
   * （★管理画面・§2-1b）。警告・失敗・操作の結果は入れない。
   */
  help?: ReactNode
  /** 「？」の見出し。省略時は「この案内」。 */
  helpLabel?: string
  /** 長い説明がある場所。渡すと吹き出しに「くわしく」が出る。 */
  helpHref?: string
  /** @deprecated 印は tone ごとに固定。互換のため受け取るが描画には使わない。 */
  icon?: ReactNode
  /** アカウントの短い説明。既定の帯の色・寸法は変えない。 */
  presentation?: 'account-note' | 'ops'
  /**
   * 頭の言葉（注意＝「要確認：」・失敗＝「失敗：」）を付けない。危ない操作の窓で、
   * 題そのものが問いかけになっている帯だけが使う。知らせでは使わない。
   */
  statusWord?: false
}

/**
 * 帯（Notice）。`note-bar` と1本化した正本。見た目は CSS が持つ。
 *
 * 一時的な知らせ（「保存しました」など）はここに置かず Toast
 *（`./toast` の `notifyToast`）へ送る。帯は読み直しても残る内容だけ。
 */
export default function Notice({
  tone,
  density,
  heading,
  states,
  footer,
  compact = false,
  appearance,
  message,
  children,
  action,
  actionLayout,
  onClose,
  className,
  help,
  helpLabel,
  helpHref,
  icon,
  marker,
  presentation,
  statusWord,
  role,
  ...props
}: NoticeProps) {
  // 呼び出し側が渡す図柄で tone と印の組み合わせが崩れないよう、互換 prop は描画しない。
  void icon
  void marker
  const canonical = tone
  const body = typeof children === 'string' ? humanizeErrorText(children) : children ?? (message === undefined ? message : humanizeErrorText(message))
  const word = statusWord === false || appearance === 'caution' ? undefined : STATUS_WORD_BY_TONE[canonical]
  const lead = heading ? heading : body
  // 呼び出し側がもう同じ言葉で書き出している時（「失敗した処理が…」など）は重ねない。
  const prefix = word && !leadingText(lead).startsWith(word)
    ? <span className={styles.statusWord} data-notice-status-word>{word}：</span>
    : null
  const labeledLead = prefix ? prependStatusWord(lead, prefix) : lead
  const node = NODE_BY_TONE[canonical]
  const hasHelp = help !== undefined && help !== null
  const helpTip = hasHelp ? (
    <HelpTip label={`${helpLabel ?? 'この案内'}の説明`}>
      {help}
      {helpHref ? <a href={helpHref}>くわしく</a> : null}
    </HelpTip>
  ) : null
  const closeButton = onClose ? <button type="button" className={styles.close} data-notice-close onClick={onClose} aria-label="通知を閉じる"><X aria-hidden="true" size={16} /></button> : null
  return (
    <div
      {...props}
      className={[styles.notice, styles[canonical], heading ? styles.twoLine : null, className].filter(Boolean).join(' ')}
      // 呼び出し側が role を指定したらそれを優先する（下書きの競合帯の alert など）。
      // 指定がないときだけ、種類から既定（危険＝alert、ほかは note）を決める。
      role={role ?? (canonical === 'danger' ? 'alert' : 'note')}
      data-compact={compact || undefined}
      data-appearance={appearance}
      data-design-part="notice"
      data-tone={canonical}
      data-density={density}
      data-presentation={presentation}
      data-action-layout={action ? actionLayout : undefined}
      data-has-action={!!action || undefined}
      data-design-node={props['data-design-node'] ?? node}
    >
      <div className={styles.content}>
        <span className={appearance === 'subtle' || appearance === 'caution' ? styles.subtleIcon : styles.dotLine} aria-hidden="true">{appearance === 'caution' ? <TriangleAlert size={16}/> : appearance === 'subtle' ? <Info size={16}/> : <span className={styles.dot} data-notice-dot aria-hidden="true" />}</span>
        <div className={styles.message} data-notice-message>
          {heading ? <><div className={styles.headingRow}><div className={styles.heading} data-notice-heading>{labeledLead}</div>{hasHelp ? helpTip : null}</div><div className={styles.description}>{body}</div></>
            : <>{labeledLead}</>}
          {hasHelp && !heading ? helpTip : null}
          {states?.length ? <NoticeStates items={states} /> : null}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </div>
      {/* ［×］は操作と同じ行に入れ、操作のボタンと縦の真ん中をそろえる（題が1行でも2行でも）。 */}
      {action ? <span className={styles.action}>{action}{closeButton}</span> : closeButton}
    </div>
  )
}

/** 色だけに頼らず、保存の状態を印と言葉で伝える。 */
export function NoticeStates({ items }: { items: NonNullable<NoticeProps['states']> }) {
  return <ul className={styles.states} aria-label="保存の状態">
    {items.map(({ label, state }) => <li key={label} className={styles.state}>
      <span className={styles.stateMark} data-state={state} aria-hidden="true">{state === 'done' ? <Check size={16} /> : null}</span>
      {label}
    </li>)}
  </ul>
}

const CLOSED_TODAY_PREFIX = 'lh:notice-closed:'

/**
 * 帯の［閉じる］（`onClose`）を、その端末でその日だけ効かせる。
 * 日本時間で日が変わると、また出る。保存できない端末では、その画面の間だけ閉じる。
 */
export function useNoticeClosedToday(key: string) {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    try { setClosed(localStorage.getItem(CLOSED_TODAY_PREFIX + key) === jstDate()) } catch { setClosed(false) }
  }, [key])
  const close = useCallback(() => {
    setClosed(true)
    try { localStorage.setItem(CLOSED_TODAY_PREFIX + key, jstDate()) } catch { /* この画面の間だけ閉じる */ }
  }, [key])
  return { closed, close }
}
