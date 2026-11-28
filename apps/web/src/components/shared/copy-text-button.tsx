'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import Button from './button'
import styles from './copy-text-button.module.css'

/**
 * 省略表示される識別子（差し込みキー・フォーム名など）を1操作で全文
 * コピーする小さなボタン（監査6 #665）。
 *
 * `title` 属性は「見える」だけで「取れない」。一覧で `…` に切れた値を
 * 配信文面などへ貼るには、コピーの口を列へ添える必要がある。
 * 成功すると「コピー済み」へ一時的に変わって結果が画面上で分かる。
 *
 * `navigator.clipboard` が使えない環境（非HTTPS・権限拒否）では、省略
 * 表示のままでは全文を取り出せないので、読み取り専用の欄へ切り替えて
 * 選んでコピーできるようにする（ブラウザの入力窓は使わない）。
 */
export default function CopyTextButton({
  value = '',
  getValue,
  role,
  label = 'コピー',
  icon,
  'aria-label': ariaLabel,
  disabled = false,
  variant = 'text',
  size,
  feedbackDurationMs = 1500,
}: {
  /** クリップボードへ書き込む全文。表示用文字列ではなく取り出したい値。 */
  value?: string
  getValue?: () => Promise<string>
  feedbackDurationMs?: 1500 | 1600
  label?: string
  icon?: ReactNode
  role?: 'button' | 'menuitem'
  disabled?: boolean
  /** コードの下など、本文の操作は共通Buttonの形を使う。行内は文字操作のまま。 */
  variant?: 'text' | 'primary' | 'secondary'
  /** 本文の操作は共通Buttonの小さいリンクの形でそろえる。 */
  size?: 'inline'
  /** 何をコピーするボタンか。一覧では行の名前を含めて特定できるようにする。 */
  'aria-label': string
}) {
  const [copiedValue, setCopiedValue] = useState(getValue ? '' : value)
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  const generationRef = useRef(0)


  useEffect(
    () => {
      generationRef.current += 1
      pendingRef.current = false
      setState('idle')
      setCopiedValue(getValue ? '' : value)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      return () => {
        generationRef.current += 1
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      }
    },
    [value],
  )

  const copy = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    const generation = generationRef.current
    try {
      const text = getValue ? await getValue() : value
      await navigator.clipboard.writeText(text)
      setCopiedValue(text)
      if (generation !== generationRef.current) return
      setState('copied')
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setState('idle'), feedbackDurationMs)
    } catch {
      if (generation === generationRef.current) setState('failed')
    } finally {
      if (generation === generationRef.current) pendingRef.current = false
    }
  }

  if (state === 'failed') {
    /*
     * 隣の表示は `truncate` で切れているため、そのままでは全文を選べない。
     * 失敗したときだけ全文入りの読み取り専用欄を出し、手動で選べるようにする。
     */
    return (
      <span className="block min-w-0">
        <input
          readOnly
          value={copiedValue}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={ariaLabel}
          className="border-hairline bg-canvas-sunken text-ink w-full rounded-mini border px-2 py-1 text-xs"
        />
        <span role="alert" className="text-danger mt-1 block text-xs">
          コピーできませんでした。上の欄の文字を選択してコピーしてください。
        </span>
      </span>
    )
  }

  if (variant !== 'text' || size === 'inline') {
    return (
      <Button
        variant={variant}
        size={size}
        className={size === 'inline' ? styles.button : undefined}
        textTone={role === 'menuitem' ? 'ink' : size === 'inline' && state === 'copied' ? 'accent' : undefined}
        role={role}
        disabled={disabled}
        onClick={(event) => { event.stopPropagation(); void copy() }}
        aria-label={ariaLabel}
        title={state === 'copied' ? 'コピーしました' : label}
      >
        {state === 'copied' ? <Check size={16} aria-hidden /> : icon}
        {state === 'copied' ? 'コピーしました' : label}
      </Button>
    )
  }

  /*
   * 表の中の「編集」「削除」と同じく枠なしの文字操作にそろえる。
   * 「コピー」と「コピー済み」で幅が変わると列が揺れるので、
   * 長いほうに合わせて共通の幅を予約する。表の操作列も同じ幅を読む。
   */
  return (
    <button
      type="button"
      role={role}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); void copy() }}
      aria-label={ariaLabel}
      title={state === 'copied' ? 'コピーしました' : label}
      className={`${styles.button} shrink-0 cursor-pointer px-1 py-0.5 text-center text-xs ${
        state === 'copied'
          ? 'text-success font-semibold'
          : 'text-action hover:underline'
      }`}
    >
      {state === 'copied' ? <Check size={16} aria-hidden /> : icon}
      {state === 'copied' ? 'コピーしました' : label}
    </button>
  )
}
