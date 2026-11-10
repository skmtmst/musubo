'use client'

import { Ban, FileText, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ClipboardEventHandler, type ReactNode } from 'react'
import Button from './button'
import IconButton from './icon-button'
import { usePermissionLockTip } from './permission-lock-tip'
import styles from './file-drop.module.css'

/**
 * ファイルを落とす場所。Pencil ★V8（V8.pen）「ファイルを落とす欄」。
 *
 * 受信箱の返信欄・配信の画像・登録メディアの取り込みでばらばらだった見せ方をそろえる。
 * 形の手本は kobra.systems の Attachment・Magnetic Dropzone
 * （コードは写していない）。
 * 引き寄せる動きは採らない（控えめに）。大きさは状態が変わっても変えない。
 *
 * - ボタン（「ファイルを選ぶ」）でも選べる。キーボード・スマホはここから
 * - ファイルを持って上に来たら縁と地を緑に（motion-fast）。形式が違う物は先に断る
 * - 取り込み中は場所を空けたまま進みを出す。「この画面を閉じても止まりません」は
 *   背景で続く処理のときだけ `busyNote` に書く
 * - 動きを減らす設定では globals.css の決まりで一瞬になる
 */
export default function FileDropzone({
  previewState,
  icon,
  invalid = false,
  variant = 'default',
  title,
  hint,
  accept,
  multiple = false,
  disabled = false,
  lockedReason,
  busy = false,
  busyTitle = '取り込んでいます…',
  busyNote,
  rejectTitle = 'このファイルは追加できません',
  rejectHint,
  chooseLabel = 'ファイルを選ぶ',
  secondary,
  onFiles,
  onPaste,
  className,
  'aria-label': ariaLabel,
}: {
  /** 見本・検証用にドラッグ状態を固定する。指定時はドラッグ操作で見た目が変わらない。 */
  icon?: ReactNode
  invalid?: boolean
  /** upload は欄全体がファイル選択の入口（内側のボタンを出さない）。 */
  variant?: 'default' | 'video' | 'composer' | 'upload'
  previewState?: 'active' | 'reject'
  /** 見出し（「ここに画像を落とす」など）。 */
  title: string
  /** 受け付ける種類の短い説明（「JPEG・PNG、10MB まで」など）。 */
  hint?: ReactNode
  /** input の accept と同じ書き方（「image/jpeg,image/png」「.csv,text/csv」など）。 */
  accept?: string
  multiple?: boolean
  disabled?: boolean
  /** 権限による選択・ドロップ・貼り付けの拒否理由。secondary の操作は呼び出し側で制御する。 */
  lockedReason?: string
  /** 取り込み中。押せなくなり、進みの表示に切り替わる。 */
  busy?: boolean
  busyTitle?: string
  busyNote?: ReactNode
  /** 形式が違う物を持って来たときの見出し（「動画は追加できません」など）。 */
  rejectTitle?: string
  rejectHint?: ReactNode
  chooseLabel?: string
  /** 欄の中に添える別の入れ方（「ライブラリから選ぶ」など）。押しても欄のファイル選びは開かない。 */
  secondary?: ReactNode
  /** 選ばれた・落とされたファイル。形式の検査は呼び出し側で行う。 */
  onFiles: (files: File[]) => void
  /** 貼り付け（Cmd+V）も受けるときに渡す。渡さなければ貼り付けは無視される。 */
  onPaste?: ClipboardEventHandler<HTMLDivElement>
  className?: string
  'aria-label'?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragCount = useRef(0)
  const [drag, setDrag] = useState<'idle' | 'active' | 'reject'>('idle')
  const interactive = !disabled && !busy && !lockedReason
  const wholeZonePicker = variant === 'composer' || variant === 'upload'
  const lock = usePermissionLockTip<HTMLDivElement>(wholeZonePicker ? lockedReason : undefined)
  const { disabled: _nativeDisabled, ...zoneLockHandlers } = lock.handlers ?? {}
  useEffect(() => {
    if (lockedReason) { dragCount.current = 0; setDrag('idle') }
  }, [lockedReason])

  const openPicker = () => {
    if (interactive) inputRef.current?.click()
  }

  // 見本固定があればそれを見せ、無ければ今のドラッグ状態を見せる。
  const shown = lockedReason ? 'idle' : previewState ?? drag

  const checkDrag = (event: React.DragEvent) => {
    event.preventDefault()
    if (!interactive) return
    if (event.type === 'dragenter') dragCount.current += 1
    const items = [...event.dataTransfer.items].filter((item) => item.kind === 'file')
    if (items.length === 0) {
      setDrag('active')
      return
    }
    setDrag(items.every((item) => matchesAccept(item, accept)) ? 'active' : 'reject')
  }

  const leaveDrag = (event: React.DragEvent) => {
    event.preventDefault()
    if (event.type === 'dragleave') {
      dragCount.current = Math.max(0, dragCount.current - 1)
      if (dragCount.current > 0) return
    }
    setDrag('idle')
  }

  const dropFiles = (event: React.DragEvent) => {
    event.preventDefault()
    dragCount.current = 0
    setDrag('idle')
    if (!interactive) return
    const files = [...event.dataTransfer.files]
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1))
  }

  return (<>
    <div
      ref={lock.ref}
      role={variant === 'upload' ? disabled && !lockedReason ? 'group' : 'button' : variant === 'composer' ? 'button' : 'group'}
      aria-disabled={variant === 'upload' && !interactive || undefined}
      aria-label={ariaLabel ?? title}
      aria-busy={busy || undefined}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
      data-input-field
      data-design-node="NQMnx"
      data-variant={variant}
      data-drag={shown}
      data-busy={busy || undefined}
      data-disabled={disabled || Boolean(lockedReason) || undefined}
      className={[styles.zone, className].filter(Boolean).join(' ')}
      tabIndex={wholeZonePicker && (interactive || lockedReason) ? 0 : undefined}
      onKeyDown={(event) => { if (wholeZonePicker && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openPicker() } }}
      onClick={(event) => {
        // input 自身の click はここへ泡立ってくる。拾うと input.click が再帰する。
        if ((event.target as HTMLElement | null)?.closest('input[type="file"]')) return
        openPicker()
      }}
      onDragEnter={checkDrag}
      onDragOver={checkDrag}
      onDragLeave={leaveDrag}
      onDrop={dropFiles}
      onPaste={lockedReason ? (event) => { event.preventDefault(); event.stopPropagation() } : onPaste}
      {...zoneLockHandlers}
    >
      {busy ? (
        <>
          <LoaderCircle aria-hidden="true" size={20} className={styles.spin} />
          <p className={styles.zoneTitle}>{busyTitle}</p>
          {busyNote ? <p className={styles.zoneHint}>{busyNote}</p> : null}
        </>
      ) : shown === 'reject' ? (
        <>
          <Ban aria-hidden="true" size={20} className={styles.rejectIcon} />
          <p className={styles.rejectTitle}>{rejectTitle}</p>
          {rejectHint ? <p className={styles.zoneHint}>{rejectHint}</p> : null}
        </>
      ) : (
        <>
          {icon ?? <Upload aria-hidden="true" size={20} className={shown === 'active' ? styles.activeIcon : styles.idleIcon} />}
          <p className={shown === 'active' ? styles.activeTitle : styles.zoneTitle}>
            {shown === 'active' ? '離すと追加します' : title}
          </p>
          {shown === 'active' || variant === 'video' ? null : hint ? <p className={styles.zoneHint}>{hint}</p> : null}
          {shown === 'active' || !secondary ? null : (
            <span className={styles.secondary} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>{secondary}</span>
          )}
          {shown === 'active' || wholeZonePicker ? null : (
            <Button
              type="button"
              disabled={!interactive}
              lockedReason={lockedReason}
              onClick={(event) => {
                event.stopPropagation()
                openPicker()
              }}
            >
              {variant === 'video' ? <Upload size={16} aria-hidden="true" /> : null}
              {chooseLabel}
            </Button>
          )}
        </>
      )}
      {variant === 'video' && hint && shown === 'idle' && !busy ? <p className={styles.zoneHint}>{hint}</p> : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={!interactive}
        tabIndex={-1}
        aria-hidden="true"
        className={styles.input}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          // 同じファイルを選び直せるよう、毎回空に戻す。
          event.target.value = ''
          if (lockedReason) return
          if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1))
        }}
      />
    </div>
    {lock.node}
  </>)
}

function matchesAccept(item: DataTransferItem, accept?: string): boolean {
  if (!accept) return true
  const file = item.getAsFile()
  const type = (file?.type || item.type || '').toLowerCase()
  const name = (file?.name || '').toLowerCase()
  // 種類も名前も分からないときは断らない（落とした後に呼び出し側が検査する）。
  if (!type && !name) return true
  return accept
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1))
      if (rule.startsWith('.')) return name.endsWith(rule)
      return type === rule
    })
}

/**
 * 添付ファイルの行。Pencil ★V8（V8.pen）「ファイルを落とす欄」の添付ファイルの行。
 *
 * - 行の高さ 56・縮小画像 36（画像は 1px の薄い縁）。`thumbnail` に縮小画像を渡す
 * - 名前は 1 行で省略し、全文は `title` で。補足（種類・大きさ）は `meta`
 * - 誤りは何をすれば通るかまで `errorText` に書く。× は「外す」、誤りの行は「選び直す」
 * - 送り途中は細い棒と「送っています 64%」
 */
export function AttachmentRow({
  name,
  meta,
  status = 'ready',
  percent,
  uploadingText,
  errorText,
  onRemove,
  onRetry,
  retryLabel = '選び直す',
  disabled,
  lockedReason,
  thumbnail,
  tone = 'document',
  className,
}: {
  /** ファイル名。1 行で省略し、全文は title で見せる。 */
  name: string
  /** 補足（「JPEG・1.2MB」など）。 */
  meta?: string
  status?: 'ready' | 'uploading' | 'error'
  /** 送り途中の割合（0〜100）。uploading 用。 */
  percent?: number
  uploadingText?: string
  /** 誤りの文（「10MB 以下の画像を選んでください」など、何をすれば通るかまで）。error 用。 */
  errorText?: string
  /** 渡すと ×（「外す」）を出す。 */
  onRemove?: () => void
  /** 渡すと「選び直す」を出す。error 用。 */
  onRetry?: () => void
  /** 再試行が同じファイルを送る場合の操作名。 */
  retryLabel?: string
  disabled?: boolean
  /** 権限による外す・選び直す操作の拒否理由。 */
  lockedReason?: string
  /** 縮小画像（36px に収まる img など）。無いときは書類の印になる。 */
  thumbnail?: ReactNode
  /** 縮小画像の地。写真は薄い緑、書類は薄い灰（設計 NQMnx）。 */
  tone?: 'photo' | 'document'
  className?: string
}) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent ?? 0)))
  const describedId = useId()
  const showDescription = status === 'uploading' || status === 'error'
  const description = status === 'uploading' ? (uploadingText ?? `送っています ${clamped}%`) : (errorText ?? '')

  return (
    <div
      data-design-node="NQMnx"
      data-status={status}
      className={[styles.row, className].filter(Boolean).join(' ')}
    >
      <span aria-hidden="true" className={styles.thumb} data-tone={tone}>
        {thumbnail ?? <FileText size={20} className={styles.thumbIcon} />}
      </span>
      <span className={styles.rowBody}>
        <span className={styles.rowName} title={name}>{name}</span>
        {status === 'uploading' ? (
          <span
            role="progressbar"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={clamped}
            className={styles.miniTrack}
          >
            <span aria-hidden="true" className={styles.miniFill} style={{ transform: `scaleX(${clamped / 100})` }} />
          </span>
        ) : null}
        {showDescription ? (
          <span id={describedId} className={status === 'error' ? styles.rowError : styles.rowMeta}>
            {description}
          </span>
        ) : meta ? (
          <span className={styles.rowMeta}>{meta}</span>
        ) : null}
      </span>
      {status === 'error' && onRetry ? (
        <IconButton aria-label={`「${name}」を${retryLabel}`} aria-describedby={describedId} disabled={disabled} lockedReason={lockedReason} onClick={onRetry}>
          <RotateCcw aria-hidden="true" size={16} />
        </IconButton>
      ) : onRemove ? (
        <IconButton aria-label={`「${name}」を外す`} disabled={disabled} lockedReason={lockedReason} onClick={onRemove}>
          <X aria-hidden="true" size={16} />
        </IconButton>
      ) : null}
    </div>
  )
}
