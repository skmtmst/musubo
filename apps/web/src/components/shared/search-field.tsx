'use client'

import { inputPlaceholder } from './input-placeholder'
import { LoaderCircle, Search, X } from 'lucide-react'
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { guardCompositionEnter } from './composition-enter'
import { fitListSearchPlaceholder } from './search-field-size.mjs'
import styles from './search-field.module.css'

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'aria-label' | 'width'> {
  /**
   * #976 U087: 検索欄は見た目に常設ラベルがないので、placeholder だけだと
   * 入力後に「何を探す欄か」が残らず、読み上げでも名前を取れない。
   * 呼び出し側に名前を必須にする。「友だちを検索」のように目的語まで書く。
   */
  'aria-label': string
  /** 外枠の幅。見本が長い欄は、文字と印を含めた幅を渡す。 */
  width?: number | string
  loading?: boolean
  onChange: (value: string) => void
  onClear?: () => void
  /** 入力直後にCSVなどへ同じ条件を渡す画面だけ、待たずに値を通知する。 */
  updateMode?: 'debounced' | 'immediate'
  /** @deprecated ⌘K は探す窓専用。古い呼び出しでも印や合図を出さない。 */
  shortcut?: string
}

/** Pencil V5 `phlR1` を正本にした検索欄。 */
const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, width, style, disabled, hidden, loading = false, onChange, onClear, updateMode = 'debounced', shortcut: _shortcut, value, onKeyDown, ...props },
  ref,
) {
  const { width: styleWidth, ...inputStyle } = style ?? {}
  const [draft, setDraft] = useState(String(value ?? ''))
  const lastExternalValue = useRef(String(value ?? ''))
  const callback = useRef(onChange)
  callback.current = onChange
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composing = useRef(false)
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const schedule = (next: string) => {
    cancel()
    if (updateMode === 'immediate') callback.current(next)
    else timer.current = setTimeout(() => { timer.current = null; callback.current(next) }, 300)
  }
  useEffect(() => {
    const next = String(value ?? '')
    if (next === lastExternalValue.current) return
    lastExternalValue.current = next
    cancel()
    setDraft(next)
  }, [value])
  useEffect(() => cancel, [])
  const hasValue = draft.length > 0
  const innerRef = useRef<HTMLInputElement>(null)
  // : the list owns the slot, while the control knows its real text and chrome.
  // Keep the placeholder readable without changing either the query or its scope.
  useLayoutEffect(() => {
    const input = innerRef.current
    const slot = input?.closest<HTMLElement>('[data-toolbar-search]')
    const control = input?.parentElement
    if (!input || !slot || !control || !props.placeholder) return
    let active = true
    const measure = () => {
      if (active) fitListSearchPlaceholder(input)
    }
    let frame = 0
    const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue)
    observer?.observe(slot)
    measure()
    void document.fonts?.ready.then(measure)
    return () => { active = false; cancelAnimationFrame(frame); observer?.disconnect(); slot.style.removeProperty('--list-search-content-min') }
  }, [props.placeholder])
  const setRefs = (node: HTMLInputElement | null) => {
    innerRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }
  return (
    <div
      className={[styles.search, disabled ? styles.disabled : null, className]
        .filter(Boolean)
        .join(' ')}
      style={width !== undefined || styleWidth !== undefined ? { width: width ?? styleWidth, maxWidth: '100%', flexShrink: 0 } : undefined}
      aria-busy={loading || undefined}
      hidden={hidden}
      data-design-node="phlR1"
      data-input-field
      data-search-field
    >
      <Search className={styles.searchIcon} aria-hidden="true" />
      <input
        ref={setRefs}
        type="search"
        value={draft}
        disabled={disabled}
        className={styles.input}
        style={inputStyle}
        onChange={(event) => { const next = event.target.value; setDraft(next); if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) schedule(next) }}
        {...props}
        placeholder={inputPlaceholder(props.placeholder)}
        onKeyDown={guardCompositionEnter(onKeyDown)}
        onCompositionStart={(event) => { composing.current = true; cancel(); props.onCompositionStart?.(event) }}
        onCompositionEnd={(event) => { composing.current = false; schedule(event.currentTarget.value); props.onCompositionEnd?.(event) }}
      />
      {loading ? (
        <LoaderCircle className={styles.loadingIcon} aria-label="検索中" />
      ) : hasValue && onClear ? (
        <button type="button" className={styles.clear} onClick={() => { cancel(); setDraft(''); onClear?.() }} aria-label="検索語を消す">
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
})

export default SearchField
