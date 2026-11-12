'use client'

import { jstDate } from '@/lib/jst-datetime'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import MenuPortal from './menu-portal'
import Button from './button'
import selectStyles from './select-menu.module.css'
import styles from './date-field.module.css'
import { joinDescribedBy, useFieldContext } from './field-context'

/**
 * 日付の選択。Pencil ★V8（V8.pen）「日付の入力（カレンダー）」。
 *
 * ブラウザ任せの `<input type="date">` は、表示が英語の書式になり、画面ごとに見た目も違った。
 * 値は今までどおり `YYYY-MM-DD` の文字列（空は ''）で受け渡すので、`type="date"` の
 * `value` / `onChange(event.target.value)` をそのまま置き換えられる。
 *
 * - 表示は「2026年9月23日（水）」。暦は6週を常に出す（月によって高さが変わらない）
 * - キーボード：欄で Enter・↓ で開く／矢印で1日・1週／PageUp・PageDown で月／Home・End で週の端／
 *   Enter・Space で仮選択／確定で反映／Esc で破棄して欄へ戻る
 * - 動き：暦は motion-fast で欄の下から出る。月送りは段が 12px 横から薄く入る（motion-base）
 */
export default function DateField({
  value,
  onChange,
  inline = false,
  min,
  max,
  disabled = false,
  invalid = false,
  size = 'standard',
  displayFormat = 'full',
  clearable = true,
  placeholder = '日付を選ぶ',
  id,
  name,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string
  /** 日時選択などの窓内に暦だけを表示する。 */
  inline?: boolean
  onChange: (value: string) => void
  min?: string
  max?: string
  disabled?: boolean
  invalid?: boolean
  size?: 'standard' | 'compact' | 'hours'
  /** 狭い道具欄では月日だけを表示。年を含む全文はtitleと暦に残す。 */
  displayFormat?: 'full' | 'short' | 'day'
  /** false で「日付を消す」の×を出さない（日付が必ず要る欄。業種ダッシュボードの日付の段）。既定は出す。 */
  clearable?: boolean
  placeholder?: string
  id?: string
  name?: string
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}) {
  // Field の中に置くと、欄の誤り（赤）と説明の読み上げを受け取る。
  const field = useFieldContext()
  invalid = invalid || Boolean(field?.invalid)
  const autoId = useId()
  const fieldId = id ?? field?.controlId ?? autoId
  const dialogId = `${fieldId}-calendar`
  const selected = parseDate(value)
  const [open, setOpen] = useState(inline)
  const [draftValue, setDraftValue] = useState(value)
  const openedValue = useRef(value)
  const [focused, setFocused] = useState<Date>(() => selected ?? today())
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  /*
   * 暦は最上層（MenuPortal）へ遅れて装着される。開いた直後の effect では
   * まだ節が無く焦点を移せないので、付いた時点で選んだ日へ焦点を移す。
   * 月送りの付け替えは下の effect（[open, focused]）が担う。
   */
  const gridCallbackRef = useCallback((node: HTMLDivElement | null) => {
    gridRef.current = node
    if (node && openRef.current) {
      node.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus()
    }
  }, [])

  const month = useMemo(() => new Date(focused.getFullYear(), focused.getMonth(), 1), [focused])
  const days = useMemo(() => sixWeeks(month), [month])
  const minDate = parseDate(min ?? '')
  const maxDate = parseDate(max ?? '')
  const isDisabled = (day: Date) => Boolean((minDate && day < minDate) || (maxDate && day > maxDate))
  const draftDate = parseDate(draftValue)
  const draftInvalid = Boolean(draftValue && (!draftDate || isDisabled(draftDate)))
  const stale = value !== openedValue.current
  const confirmDisabled = disabled || stale || draftInvalid
  const confirmReason = stale ? 'ほかで日付が変わりました。開き直してください。' : draftInvalid ? '選んだ日付を確認してください。' : disabled ? '日付を変更できません。' : undefined

  useEffect(() => {
    if (inline) setDraftValue(value)
  }, [inline, value])

  // 外側を押したときの扱いは MenuPortal に任せる（箱の中の日付押しで閉じない）。

  useEffect(() => {
    if (!open) return
    gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus()
  }, [open, focused])

  useEffect(() => {
    if (!open || inline) return
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || document.getElementById(dialogId)?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    return () => document.removeEventListener('pointerdown', dismissOutside, true)
  }, [open, dialogId, inline])

  const openCalendar = () => {
    if (disabled) return
    openedValue.current = value
    setDraftValue(value)
    setFocused(selected ?? today())
    setSlide(null)
    setOpen(true)
  }

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  // Esc は欄へ戻すため、箱の中に焦点があっても欄側で閉じる。
  useEffect(() => {
    if (!open || inline) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, inline])

  const moveTo = (next: Date) => {
    if (next.getFullYear() !== focused.getFullYear() || next.getMonth() !== focused.getMonth()) {
      setSlide(next > focused ? 'next' : 'prev')
    }
    setFocused(next)
  }

  const choose = (day: Date) => {
    if (isDisabled(day)) return
    setDraftValue(formatValue(day))
    if (inline) onChange(formatValue(day))
    moveTo(day)
  }

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      PageUp: () => addMonths(focused, -1),
      PageDown: () => addMonths(focused, 1),
      Home: () => addDays(focused, -focused.getDay()),
      End: () => addDays(focused, 6 - focused.getDay()),
    }
    if (step[event.key]) {
      event.preventDefault()
      moveTo(step[event.key]())
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(focused)
    }
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open && !inline) {
      event.preventDefault()
      close()
    }
  }

  const calendar = (
        <div
          id={dialogId}
          role={inline ? 'group' : 'dialog'}
          aria-label="日付を選ぶ"
          className={[styles.popover, inline ? styles.inlineCalendar : undefined].filter(Boolean).join(' ')}
          // 最上層では absolute 指定を無効にする（位置は器が決める）。
          style={{ position: 'static' }}
          // 箱の中の押下はここで止める。呼び出し側が `<label>` で欄全体を包んでいると、
          // 箱の中の押下がラベル経由で欄本体へ再送達して開閉が裏返る。
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.header}>
            <button type="button" className={styles.nav} aria-label="前の月" onClick={() => moveTo(addMonths(focused, -1))}>
              <ChevronLeft aria-hidden="true" />
            </button>
            <p className={styles.month} aria-live="polite">{`${month.getFullYear()}年${month.getMonth() + 1}月`}</p>
            <button type="button" className={styles.nav} aria-label="次の月" onClick={() => moveTo(addMonths(focused, 1))}>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className={styles.weekdays} aria-hidden="true">
            {WEEKDAYS.map((label, index) => (
              <span key={label} data-weekday={index === 0 ? 'sun' : index === 6 ? 'sat' : undefined}>{label}</span>
            ))}
          </div>
          <div
            ref={gridCallbackRef}
            role="grid"
            aria-label={`${month.getFullYear()}年${month.getMonth() + 1}月`}
            className={styles.grid}
            data-slide={slide ?? undefined}
            key={formatValue(month)}
            onKeyDown={onGridKeyDown}
          >
            {[0, 1, 2, 3, 4, 5].map((week) => (
              <div role="row" key={week} className={styles.week}>
                {days.slice(week * 7, week * 7 + 7).map((day) => {
                  const inMonth = day.getMonth() === month.getMonth()
                  const draftDate = parseDate(draftValue)
                  const isSelected = Boolean(draftDate && sameDay(day, draftDate))
                  const isToday = sameDay(day, today())
                  const off = isDisabled(day)
                  return (
                    <div role="gridcell" key={formatValue(day)} aria-selected={isSelected || undefined}>
                      <button
                        type="button"
                        tabIndex={sameDay(day, focused) ? 0 : -1}
                        className={styles.day}
                        data-outside={inMonth ? undefined : true}
                        data-selected={isSelected || undefined}
                        data-today={isToday || undefined}
                        aria-disabled={off || undefined}
                        aria-label={`${formatLabel(day)}${isToday ? '、今日' : ''}`}
                        onClick={() => choose(day)}
                      >
                        {day.getDate()}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {!inline ? <div className={styles.footer}>
            <div className={styles.footerGroup}>
              <Button type="button" size="inline" variant="text" textTone="accent" disabled={isDisabled(today())} onClick={() => choose(today())}>今日</Button>
              <Button type="button" size="inline" variant="text" textTone="quiet" onClick={() => setDraftValue('')}>消す</Button>
            </div>
            <div className={styles.footerGroup}>
              <Button type="button" size="compact" variant="secondary" onClick={close}>キャンセル</Button>
              <Button type="button" size="compact" variant="primary" disabled={confirmDisabled} disabledReason={confirmReason} onClick={() => { if (confirmDisabled) return; onChange(draftValue); close() }}>確定</Button>
            </div>
          </div> : <div className={styles.footer}><Button type="button" size="inline" variant="text" textTone="accent" disabled={isDisabled(today())} onClick={() => choose(today())}>今日</Button></div>}
        </div>
  )

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(' ')} onKeyDown={onRootKeyDown}>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      {!inline ? <><button
        ref={triggerRef}
        id={fieldId}
        type="button"
        className={styles.field}
        data-input-field
        data-size={size}
        data-clearable={selected && !disabled && clearable || undefined}
        disabled={disabled}
        data-invalid={invalid || undefined}
        // 狭い欄で切れても、重ねれば全文が読める（短い文字列は1行省略＋titleの決まり）。
        title={selected ? formatLabel(selected) : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={field?.required || undefined} aria-invalid={invalid || undefined}
        aria-describedby={joinDescribedBy(ariaDescribedBy, field?.describedBy)}
        data-open={open || undefined}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            openCalendar()
          }
        }}
      >
        <Calendar aria-hidden="true" className={styles.icon} />
        <span className={selected ? styles.value : styles.placeholder}>{selected ? displayFormat === 'short' ? `${selected.getMonth() + 1}/${selected.getDate()}（${WEEKDAYS[selected.getDay()]}）` : displayFormat === 'day' ? `${selected.getMonth() + 1}月${selected.getDate()}日（${WEEKDAYS[selected.getDay()]}）` : formatLabel(selected) : placeholder}</span>
        <ChevronDown aria-hidden="true" className={styles.chevron} />
      </button>
      {selected && !disabled && clearable ? (
        <button type="button" className={styles.clear} aria-label="日付を消す" onClick={() => onChange('')}>
          <X aria-hidden="true" />
        </button>
      ) : null}

      </> : null}
      {inline ? calendar : open ? (
        <MenuPortal
          open={open}
          align="start"
          getAnchor={() => triggerRef.current}
          onClose={() => setOpen(false)}
          className={selectStyles.surface}
        >
{calendar}
        </MenuPortal>
      ) : null}
    </div>
  )
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function today(): Date {
  return parseDate(jstDate())!
}

/** `YYYY-MM-DD`（`YYYY-MM-DDTHH:mm` の日付部分も可）を、その日の 0 時の Date にする。 */
export function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 「2026年9月23日（水）」 */
export function formatLabel(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last))
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** その月の1日を含む週の日曜から、6週・42日。 */
function sixWeeks(month: Date): Date[] {
  const start = addDays(month, -month.getDay())
  return Array.from({ length: 42 }, (_, index) => addDays(start, index))
}
