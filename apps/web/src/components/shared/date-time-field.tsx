'use client'

import { Calendar, Clock, X } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import DateField, { formatLabel as formatDateLabel, parseDate } from './date-field'
import MenuPortal from './menu-portal'
import Button from './button'
import TimeFieldV8, { type TimeFieldSize } from './time-field-v8'
import { joinDescribedBy, useFieldContext } from './field-context'
import dateStyles from './date-field.module.css'
import styles from './date-time-field.module.css'

/**
 * 日時の選択・時刻の選択。Pencil ★V8（V8.pen）「日時の入力（15分きざみ）」。
 *
 * ブラウザ任せの `<input type="datetime-local">` / `<input type="time">` は、
 * 表示が英語の書式になり、画面ごとに見た目も違った。欄の見た目は DateField と
 * 同じ（高さ36・14px）で、表示は日本語（例：`2026年10月1日（木）10:00`）。
 *
 * 値は今までどおりの文字列で受け渡す（日本時間）。
 * - 日時：`datetime-local` と同じ `YYYY-MM-DDTHH:mm`（空は `''`）。秒付き
 *   （`YYYY-MM-DDTHH:mm:ss`）の既存値も読める。書くときは秒を付けない
 * - 時刻：`time` と同じ `HH:mm`（空は `''`）。秒付きの既存値も読める
 *
 * 使い方は DateField と同じ。`value` を渡すと操作式、`defaultValue` だけなら
 * お任せ式（`name` と組むと隠し欄でそのまま送れる）。`onChange(次の値)`。
 *
 * - 日付をまだ選んでいないとき、時刻だけ先に選んでおける。日付を選ぶと
 *   その時刻で値が決まる（時刻が空のときは `10:00` になる）
 * - キーボード：欄で Enter・↓ で開く／日付は DateField と同じ／時・分は
 *   Tab で移って矢印で選ぶ／Esc で閉じて欄へ戻る
 * - `min`・`max` は日付の範囲だけ見る（`YYYY-MM-DDTHH:mm`）。時刻の前後は
 *   画面側の検証が今までどおり見る
 */
export default function DateTimeField({
  value,
  defaultValue = '',
  size = 'default',
  onChange,
  min,
  max,
  disabled = false,
  readOnly = false,
  invalid = false,
  required = false,
  placeholder = '日時を選ぶ',
  labelFormat = 'full',
  clearable = true,
  minuteStep = 1,
  id,
  name,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: {
  value?: string
  defaultValue?: string
  /** 細い欄（32px）。既定は日付と同じ36px（ほかの欄と同じ・）。 */
  size?: 'default' | 'compact'
  onChange?: (value: string) => void
  min?: string
  max?: string
  disabled?: boolean
  /** 閲覧のみ。値を字で見せるだけ（押せないボタンを置かない決まり）。 */
  readOnly?: boolean
  invalid?: boolean
  /** お任せ式の検証用。見た目は変えず、読み上げにだけ必須と伝える。 */
  required?: boolean
  placeholder?: string
  /** ★V8 の時刻の列の分のきざみ（分）。既定は 1。 */
  minuteStep?: number
  /** 表の中の狭い欄は「10/2（木）14:00」（年を省く）。全文は title で読める。 */
  labelFormat?: 'full' | 'short'
  /** 空にできない欄（登録者の基準日など）は「日時を消す」を置かない。 */
  clearable?: boolean
  id?: string
  name?: string
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}) {
  const field = useFieldContext()
  invalid = invalid || Boolean(field?.invalid)
  ariaDescribedBy = joinDescribedBy(ariaDescribedBy, field?.describedBy)

  const autoId = useId()
  const fieldId = id ?? autoId
  const dialogId = `${fieldId}-datetime-dialog`
  const [inner, setInner] = useState(defaultValue)
  const current = value ?? inner
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(current)
  const openedValue = useRef(current)
  /** 日付より先に時刻だけ選んだときの置き場所。開くたびに今の値へ戻す。 */
  const [timeDraft, setTimeDraft] = useState<{ hours: number; minutes: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const parsed = parseDateTime(current)
  const draftParsed = parseDateTime(draft)
  const datePart = draftParsed ? draft.slice(0, 10) : ''
  const shownTime = timeDraft ?? (draftParsed ? { hours: draftParsed.hours, minutes: draftParsed.minutes } : null)
  const comparable = (dateTime: string) => dateTime.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00$/, '$1')
  const confirmReason = comparable(current) !== comparable(openedValue.current) ? 'ほかで日時が変わりました。開き直してください。'
    : !datePart && (timeDraft || !clearable) ? '日付を選んでください。' : undefined

  const emit = (next: string) => {
    if (value === undefined) setInner(next)
    onChange?.(next)
  }

  // 外側を押したときの扱いは MenuPortal に任せる（箱の中の日付押しで閉じない）。


  const openDialog = () => {
    if (disabled) return
    openedValue.current = current
    setDraft(current)
    setTimeDraft(null)
    setOpen(true)
  }

  const close = () => {
    setOpen(false)
    setTimeDraft(null)
    triggerRef.current?.focus()
  }

  const chooseDate = (date: string) => {
    if (!date) {
      setDraft('')
      return
    }
    const time = timeDraft ?? (draftParsed ? { hours: draftParsed.hours, minutes: draftParsed.minutes } : { hours: 10, minutes: 0 })
    setDraft(`${date}T${pad(time.hours)}:${pad(time.minutes)}`)
  }

  const chooseTime = (hours: number, minutes: number) => {
    setTimeDraft({ hours, minutes })
    if (datePart) setDraft(`${datePart}T${pad(hours)}:${pad(minutes)}`)
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  if (readOnly) {
    return (
      <div className={[dateStyles.root, className].filter(Boolean).join(' ')}>
        {name ? <input type="hidden" name={name} value={current} /> : null}
        <input
          id={fieldId}
          readOnly
          className={[dateStyles.field, size === 'compact' ? styles.compactField : undefined].filter(Boolean).join(' ')}
          data-size={size}
          data-readonly=""
          value={parsed ? (labelFormat === 'short' ? formatShortDateTimeLabel(parsed) : formatDateTimeLabel(parsed)) : ''}
          placeholder="—"
          title={parsed ? formatDateTimeLabel(parsed) : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
        />
      </div>
    )
  }

  return (
    <div ref={rootRef} className={[dateStyles.root, className].filter(Boolean).join(' ')} onKeyDown={onRootKeyDown}>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <button
        ref={triggerRef}
        id={fieldId}
        type="button"
        className={[dateStyles.field, size === 'compact' ? styles.compactField : undefined, parsed && clearable && !disabled ? styles.clearableField : undefined].filter(Boolean).join(' ')}
        data-size={size}
        data-no-clear={clearable ? undefined : ''}
        data-clearable={parsed && clearable && !disabled ? '' : undefined}
        disabled={disabled}
        data-invalid={invalid || undefined}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        // 狭い欄で切れても、重ねれば全文が読める（短い文字列は1行省略＋titleの決まり）。
        title={parsed ? formatDateTimeLabel(parsed) : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-open={open || undefined}
        onClick={() => (open ? close() : openDialog())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            openDialog()
          }
        }}
      >
        <Calendar aria-hidden="true" className={dateStyles.icon} />
        <span className={parsed ? dateStyles.value : dateStyles.placeholder}>
          {parsed ? (labelFormat === 'short' ? formatShortDateTimeLabel(parsed) : formatDateTimeLabel(parsed)) : placeholder}
        </span>
      </button>
      {parsed && !disabled && clearable ? (
        <button
          type="button"
          className={dateStyles.clear}
          aria-label="日時を消す"
          onClick={() => {
            emit('')
            setTimeDraft(null)
          }}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}

      {open ? (
        <MenuPortal
          open={open}
          align="start"
          getAnchor={() => triggerRef.current}
          onClose={() => { setOpen(false); setTimeDraft(null) }}
          onReady={() => popoverRef.current?.querySelector<HTMLElement>('[role="grid"] button[tabindex="0"]')?.focus({ preventScroll: true })}
        >
        <div
          ref={popoverRef}
          id={dialogId}
          role="dialog"
          aria-label="日時を選ぶ"
          className={styles.popover}
          // 最上層では absolute 指定を無効にする（位置は器が決める）。
          style={{ position: 'static' }}
          // 箱の中の押下はここで止める。呼び出し側が `<label>` で欄全体を包んでいると、
          // 箱の中の押下がラベル経由で欄本体へ再送達して開閉が裏返る（公開日時の試験で発生）。
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.dateWrap}>
            <DateField
              inline
              value={datePart}
              onChange={chooseDate}
              min={min?.slice(0, 10)}
              max={max?.slice(0, 10)}
              aria-label="日付"
            />
          </div>
          {(
            // ★V8：時刻の部分は時刻の欄（打つ＋2列から選ぶ・提案 YCOoR）と同じ部品。
            <div className={styles.timeV8}>
              <span className={styles.timeV8Label} id={`${fieldId}-time-label`}>時刻</span>
              <TimeFieldV8
                aria-labelledby={`${fieldId}-time-label`}
                size="field"
                minuteStep={minuteStep}
                value={shownTime ? `${pad(shownTime.hours)}:${pad(shownTime.minutes)}` : ''}
                onChange={(next) => {
                  if (next === '') {
                    setTimeDraft(null)
                    if (clearable) setDraft('')
                    return
                  }
                  const time = parseTime(next)
                  if (time) chooseTime(time.hours, time.minutes)
                }}
              />
            </div>
          )}
          <div className={styles.footer}>
            {clearable ? <button type="button" className={styles.clearBtn} onClick={() => { setDraft(''); setTimeDraft(null) }}>消す</button> : null}
            <button type="button" className={styles.closeBtn} onClick={close}>キャンセル</button>
            <Button type="button" size="compact" variant="primary" disabled={Boolean(confirmReason)} disabledReason={confirmReason} onClick={() => { if (confirmReason) return; if (comparable(draft) !== comparable(current)) emit(draft); close() }}>確定</Button>
          </div>
        </div>
        </MenuPortal>
      ) : null}
    </div>
  )
}

type TimeFieldProps = {
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  /** `type="time"` と同じ秒の刻み（300 で 5分）。V8 では分の列のきざみになる。 */
  step?: number
  /** 分のきざみ（分）。`step` より優先。分の刻みを決める。 */
  minuteStep?: number
  /** ★V8 の欄の高さ。`field`＝36（日付の欄と並ぶ）、`compact`＝32（表の中の細い欄）。 */
  size?: TimeFieldSize
  pickerTrigger?: 'clock' | 'field'
  disabled?: boolean
  /** 閲覧のみ。値を見せて打てない・時計を出さない。 */
  readOnly?: boolean
  invalid?: boolean
  /** お任せ式の検証用。見た目は変えず、読み上げにだけ必須と伝える。 */
  required?: boolean
  placeholder?: string
  id?: string
  name?: string
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}

/**
 * 時刻の選択。`time` の置き換え。値は `HH:mm`（空は `''`・日本時間）で受け渡す。
 *
 * - ★V8（`data-theme="v8"`）：数字を打てる欄＋時と分の2列から選ぶ（time-field-v8.tsx・
 *   Pencil 提案 YCOoR）。分のきざみは `minuteStep`（分）か `step`（秒）
 */
export function TimeField(props: TimeFieldProps) {
  const { step, minuteStep, placeholder, size, ...rest } = props
  void placeholder
  return <TimeFieldV8 {...rest} size={size} minuteStep={minuteStep ?? stepSecondsToMinutes(step)} />
}

function stepSecondsToMinutes(step?: number): number {
  if (!step || step < 60 || step % 60 !== 0) return 1
  return step / 60
}

export type ParsedDateTime = { date: Date; hours: number; minutes: number }

/** `YYYY-MM-DDTHH:mm`（秒付きも可）を読み解く。読めなければ null。 */
export function parseDateTime(value: string): ParsedDateTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!match) return null
  const date = parseDate(value)
  const hours = Number(match[4])
  const minutes = Number(match[5])
  if (!date || hours > 23 || minutes > 59) return null
  return { date, hours, minutes }
}

/** 「2026年10月1日（木）10:00」 */
/** 年を省いた短い形（例：10/2（木）14:00）。 */
export function formatShortDateTimeLabel(parsed: ParsedDateTime): string {
  const d = parsed.date
  return `${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}）${pad(parsed.hours)}:${pad(parsed.minutes)}`
}

export function formatDateTimeLabel(parsed: ParsedDateTime): string {
  return `${formatDateLabel(parsed.date)}${pad(parsed.hours)}:${pad(parsed.minutes)}`
}

export type ParsedTime = { hours: number; minutes: number }

/** `HH:mm`（秒付きも可）を読み解く。読めなければ null。 */
export function parseTime(value: string): ParsedTime | null {
  const match = /^(\d{2}):(\d{2})/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return { hours, minutes }
}

/** 「10:00」 */
export function formatTimeLabel(parsed: ParsedTime): string {
  return `${pad(parsed.hours)}:${pad(parsed.minutes)}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
