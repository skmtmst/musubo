'use client'

import React, { forwardRef, useEffect, useId, useState, useRef } from 'react'
import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactNode,
} from 'react'
import type { FormRequirement } from '@/lib/form-requirement'
import { FieldContext } from './field-context'
import HelpTip from './help-tip'
import { TextArea as BaseTextArea, TextField } from './text-field'
import styles from './form-controls.module.css'

/**
 * 入力欄まわりの共通部品。
 *
 * create-page.tsx から分けてある。あちらは作成画面の骨組み（Crumb / Head /
 * Body / Left / Right の data-design）を持っているので、入力欄だけ使いたい
 * 画面が import すると、その画面が骨組みも持っているように見えてしまい、
 * design-structure.test.ts が誤って落ちる。
 */

/**
 * 「必須」の札。#976 U086: 画面ごとに `（必須）`・`*`・自前の赤丸が
 * 混ざっていたので、必須項目の印はすべてこの1形にそろえる。
 * `<Field required>` を使えば自動で付く。Field を組めない場所
 * （legend や行内のラベル）ではこの部品を直接置く。
 */
export function RequiredBadge({ appearance = 'badge' }: { appearance?: 'badge' | 'text' }) {
  return <span aria-hidden="true" data-required-badge className={styles.required}>必須</span>
}

/**
 * 「任意」の札（・：括弧なし・11px/17・左に6・文と同じ行）。
 * 必須のような丸い地は付けず、薄い灰の文字だけ。
 */
export function OptionalBadge({ appearance }: { appearance?: 'parentheses' } = {}) {
  return <span aria-hidden="true" className={styles.optional} data-appearance={appearance}>{appearance === 'parentheses' ? '（任意）' : '任意'}</span>
}

/** 複合入力欄の下にも、Field と同じ誤りの文を置く（中身が無ければ何も出さない）。 */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return children ? <p id={id} className={styles.error} role="alert">{children}</p> : null
}

/** 補足は1行。長い説明と改行を含む説明はラベル横の「？」へ。 */
export function fieldNoteText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(fieldNoteText).join('')
  if (React.isValidElement<{ children?: ReactNode }>(node)) return fieldNoteText(node.props.children)
  return ''
}
export function fieldNoteIsLong(node: ReactNode): boolean { const text = fieldNoteText(node).trim(); return /\n/.test(text) || [...text].length > 32 }

/** 1行の入力欄。ラベルと説明の付け方を全画面でそろえる。 */
export function Field({
  label,
  size,
  htmlFor,
  required,
  requirement,
  requiredAppearance,
  optional,
  optionalAppearance,
  labelHidden = false,
  labelWrap,
  labelSize = 'standard',
  note,
  error,
  errorId: providedErrorId,
  errorFrame = false,
  spacing,
  help,
  helpLabel,
  helpHref,
  count,
  density,
  grow,
  fill,
  contentGap,
  children,
}: {
  label?: ReactNode
  /** 小さな連携フォームのラベルと間隔。 */
  density?: 'compact' | 'input'
  grow?: boolean
  /** 選ぶ欄の短いラベル（・）。既定の欄は変えない。 */
  size?: 'compact'
  /** 横に並ぶ欄を等分する。 */
  fill?: boolean
  htmlFor?: string
  requirement?: Pick<FormRequirement<unknown>, 'required'>
  required?: boolean
  /** 設定カードの絵で、必須を任意と同じ薄い文字で示す。 */
  requiredAppearance?: 'badge' | 'text'
  /** 任意の入力欄。既存の OptionalBadge をラベルの横に置く。 */
  optional?: boolean
  optionalAppearance?: 'parentheses'
  /** 探す欄など自身に読み上げ名がある欄では、視覚上のラベル行を省く。 */
  labelHidden?: boolean
  labelWrap?: boolean
  labelSize?: 'standard' | 'compact' | 'section'
  note?: ReactNode
  error?: ReactNode
  /** 既存の欄が使っている理由のIDを保つ。省略すると部品が作る。 */
  errorId?: string
  /** 複合入力を1つの欄として確かめる画面だけ、誤りの枠を付ける。 */
  errorFrame?: boolean
  /** カード内の入力と操作を、型の段の間隔で並べる。 */
  spacing?: 'section'
  /**
   * 言葉の意味・単位・いつ時点の値か。ラベルのすぐ右の「？」へ入れる
   * （★管理画面・§2-1b）。必須の印・入力の直し方・失敗は入れない。
   */
  help?: ReactNode
  /** 「？」の見出し。省略時は label。読み上げ名は「{見出し}の説明」。 */
  helpLabel?: string
  /** 長い説明がある場所。渡すと吹き出しに「くわしく」が出る。 */
  helpHref?: string
  /**
   * 文字数の表示（「12/100文字」）。欄の下の右に出し、上限を超えたら赤くする。
   * 読み上げは欄の説明（aria-describedby）につなぐ。
   */
  count?: { value: number; max: number }
  /**
   * 題と中身の間を絵の値（px）にする。既定は 14（題の下 8＋段の間 6）で、
   * 絵の間がそれと違う欄だけ渡す。渡さない欄はいままでの 14 のまま。
   * 画面CSSから共通の欄を上書きしないための任意の引数（★V8 設計の決まり §2）。
   */
  contentGap?: number
  children: ReactNode
}) {
  const baseId = useId()
  const [detectedId, setDetectedId] = useState<string>()
  const controlId = htmlFor ?? detectedId ?? baseId
  const fieldRef = useRef<HTMLDivElement>(null)
  const [autoCount, setAutoCount] = useState<{ value: number; max: number } | undefined>()
  const [autoRequired, setAutoRequired] = useState(false)
  const [countFocused, setCountFocused] = useState(false)
  const [fixedFormat, setFixedFormat] = useState(false)
  const syncControl = () => {
    if (!fieldRef.current || typeof fieldRef.current.querySelector !== 'function') return
    const control = fieldRef.current.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]),textarea')
    if (control) { if (!control.id) control.id = controlId; setDetectedId(control.id); if (!control.hasAttribute('aria-label') && typeof shownLabel === 'string') control.setAttribute('aria-label', shownLabel) }
    setFixedFormat(Boolean(control && (control.type === 'tel' || /^(?:postal-code|one-time-code|cc-)/.test(control.autocomplete) || /郵便番号|電話番号|FAX|ファクス|認証コード|暗証番号/i.test(fieldNoteText(label)))))
    const next = control && !fieldRef.current.querySelector('[data-message-character-count]') && control.maxLength >= 0 ? { value: control.value.length, max: control.maxLength } : undefined
    setAutoCount(previous => previous?.value === next?.value && previous?.max === next?.max ? previous : next)
    setAutoRequired(Boolean(control?.required || control?.getAttribute('aria-required') === 'true'))
  }
  useEffect(syncControl)
  const availableCount = count ?? autoCount
  const actualCount = !fixedFormat && availableCount && (countFocused || availableCount.value >= availableCount.max * 0.9) ? availableCount : undefined
  const actualRequired = requirement?.required ?? required ?? (autoRequired || Boolean(typeof label === 'string' && label.match(/[（(]必須[）)]/u)))
  const shownLabel = typeof label === 'string' ? label.replace(/\s*[（(](任意|必須)[）)]/gu, '').replace(/\s*[*＊]$/, '') : label
  const longNote = fieldNoteIsLong(note)
  const actualHelp = longNote ? <>{help}{help ? <br /> : null}{note}</> : help
  const hasHelp = actualHelp !== undefined && actualHelp !== null
  /*
   * 誤りの見せ方を全画面でそろえる（動きの点検・8）。
   * - 誤りが出た欄で打ち直し始めたら、その場で赤と文を引っ込める（直している最中に赤くし続けない）。
   * - 欄を離れたとき、画面がまだ誤りを持っていれば、もう一度見せる。
   * - 画面が新しい誤りを渡したら（文が変わったら）、すぐ見せる。
   * 打ち始めの瞬間に赤くするかどうかは画面の確かめ方次第だが、出たあとの消え方はここで決める。
   */
  const [quiet, setQuiet] = useState(false)
  const errorKey = typeof error === 'string' ? error : error ? 'node' : ''
  useEffect(() => { setQuiet(false) }, [errorKey])
  const shownError = quiet ? null : error
  /*
   * 読み上げのつなぎ（共通部品の1本化・2026-10-08）。説明・誤りの文・文字数に id を振り、
   * 中の入力欄（TextField・TextArea・TextInput）へ aria-describedby / aria-invalid /
   * aria-required として渡す。画面ごとに書かない。
   */
  const noteId = `${baseId}-note`
  const errorId = providedErrorId ?? `${baseId}-error`
  const countId = `${baseId}-count`
  const showNote = !shownError && Boolean(note) && !longNote
  const over = actualCount ? actualCount.value > actualCount.max : false
  const describedBy = [shownError ? errorId : null, showNote ? noteId : null, actualCount ? countId : null].filter(Boolean).join(' ') || undefined
  useEffect(() => {
    const root = fieldRef.current
    if (!root || typeof root.querySelectorAll !== 'function') return
    for (const control of root.querySelectorAll<HTMLElement>('input:not([type=hidden]),textarea,select')) {
      if (control.closest('[data-form-requirement]') !== root) continue
      // 入力自身の required を読む欄では上書きしない。内側の Field と検出が循環しない。
      if (requirement || required !== undefined) control.setAttribute('aria-required', String(Boolean(actualRequired)))
      const externalError = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).some(id => id !== errorId && document.getElementById(id)?.getAttribute('role') === 'alert' && Boolean(document.getElementById(id)?.textContent))
      const explicitInvalid = control.getAttribute('aria-invalid') === 'true' && !control.hasAttribute('data-field-managed-invalid')
      if (shownError || externalError || explicitInvalid) control.setAttribute('aria-invalid', 'true')
      else if (control.getAttribute('aria-invalid') !== 'false') control.removeAttribute('aria-invalid')
      if (shownError) control.setAttribute('data-field-managed-invalid', '')
      else control.removeAttribute('data-field-managed-invalid')
      const previous = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && ![noteId, errorId, countId].includes(id))
      const ids = [...new Set([...previous, ...(describedBy?.split(/\s+/) ?? [])])].join(' ')
      if (ids) control.setAttribute('aria-describedby', ids)
      else control.removeAttribute('aria-describedby')
    }
  }, [actualRequired, requirement?.required, required, shownError, describedBy, noteId, errorId, countId])
  return (
    <FieldContext.Provider value={{ label: typeof shownLabel === 'string' ? shownLabel : undefined, controlId, describedBy, invalid: Boolean(shownError), required: Boolean(actualRequired) }}>
    <div
      ref={fieldRef}
      className={styles.field}
      data-form-requirement={actualRequired ? 'required' : 'optional'}
      data-field-error={Boolean(shownError) || undefined}
      data-label-size={labelSize}
      data-grow={grow || undefined}
      data-density={density}
      data-spacing={spacing}
      data-field-size={size}
      data-field-fill={fill || undefined}
      data-field-quiet={quiet && error ? '' : undefined}
      data-field-content-gap={contentGap === undefined ? undefined : ''}
      style={contentGap === undefined ? undefined : ({ '--field-content-gap': `${contentGap}px` } as CSSProperties)}
      onInput={() => { syncControl(); if (error && !quiet) setQuiet(true) }}
      onFocus={(event) => { if (event.target.matches('input,textarea')) setCountFocused(true) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setCountFocused(false); if (quiet) setQuiet(false) }}
    >
      {/* 「？」は label の外に置く。中に入れるとラベルがボタンを指してしまい、
          入力欄との結びつき（htmlFor・読み上げ）が壊れる。 */}
      {label && !labelHidden ? <div className={styles.labelRow} data-label-wrap={labelWrap || undefined}>
        <label htmlFor={controlId} className={styles.label} title={fieldNoteText(note) || undefined}>
          {shownLabel}
          {/* 設計は「必須」と字で書いている。* だけだと、色が見えない人には
              何も伝わらない。 */}
        </label>
        {actualRequired && <RequiredBadge />}
        {optional !== false && !actualRequired && <OptionalBadge appearance={optionalAppearance} />}
        {hasHelp ? (
          <HelpTip label={`${helpLabel ?? (typeof shownLabel === 'string' ? shownLabel : 'この欄')}の説明`}>
            {actualHelp}
            {helpHref ? <a href={helpHref} className={styles.helpLink}>くわしく</a> : null}
          </HelpTip>
        ) : null}
      </div> : null}
      {labelHidden && actualRequired ? <RequiredBadge /> : null}
      {errorFrame ? <div className={styles.errorFrame} data-invalid={Boolean(shownError) || undefined} role="group" aria-invalid={Boolean(shownError) || undefined} aria-describedby={describedBy}>{children}</div> : children}
      {shownError ? <p id={errorId} className={styles.error} role="alert">{shownError}</p> : null}
      {showNote || actualCount ? (
        <div className={styles.supportRow} data-field-support>
          {showNote ? <p id={noteId} className={styles.note}>{note}</p> : null}
          {actualCount ? (
            <p id={countId} className={[styles.count, over && styles.countOver].filter(Boolean).join(' ')} data-field-count={over ? 'over' : ''}>
              {actualCount.value.toLocaleString('ja-JP')}/{actualCount.max.toLocaleString('ja-JP')}文字
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
    </FieldContext.Provider>
  )
}

/*
 * 1行・複数行の入力欄の正本は text-field.tsx（★V8 Ume2U・i5BW8b）。
 * ここの TextInput・TextArea は、その部品を呼ぶだけの薄い包み。
 * 足すのは 管理画面 の見た目の差（読み取り専用の地・押せないときの薄さ・複数行の
 * 大きさ固定）だけで、v8 では TextField・TextArea と同じ物になる。
 * 新しく書く画面は text-field.tsx を直接使う。
 */
type TextInputProps = ComponentPropsWithoutRef<typeof TextField>

/** 1行入力（Pencil V5 `ytG7l`）。正本 TextField の包み。 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, ...props },
  ref,
) {
  return (
    <TextField
      ref={ref}
      data-design-node="ytG7l"
      {...props}
      className={[styles.legacyControl, className].filter(Boolean).join(' ')}
    />
  )
})

type TextAreaProps = ComponentPropsWithoutRef<typeof BaseTextArea>

/** 複数行入力（Pencil V5 `keKe3`）。正本 TextArea の包み。 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, ...props },
  ref,
) {
  return (
    <BaseTextArea
      ref={ref}
      data-design-node="keKe3"
      {...props}
      className={[styles.legacyControl, styles.legacyTextarea, className].filter(Boolean).join(' ')}
    />
  )
})

/** 入力欄の見た目。画面ごとに枠線の色が変わらないようにする。 */
export const inputClass =
  'border-hairline rounded-control focus-visible:outline-focus-ring w-full border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2'
