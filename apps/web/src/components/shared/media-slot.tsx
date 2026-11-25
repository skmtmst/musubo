'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { FileAudio,File as FileIcon,FileUp,Loader,Link2,Images } from 'lucide-react'
import {
useCallback,
useEffect,
useRef,
useState,
type ButtonHTMLAttributes,
type ClipboardEvent,
type DragEvent,
type KeyboardEvent,
type MouseEvent,
type ReactNode,
type RefObject,
} from 'react'
import { joinDescribedBy,useFieldContext } from './field-context'
import HelpTip from './help-tip'
import Button from './button'
import { usePermissionLockTip } from './permission-lock-tip'
import styles from './media-slot.module.css'
import { TextField } from './text-field'
export { MediaLimitNote } from './media-slot-limit'


/**
 * 画像・動画・ファイルを入れる所。Pencil ★V8 の採用案 Z7vd2（「画像を追加する所」）。
 *
 * - 薄い灰の地＋薄い線 1px・角丸 12。真ん中に灰色のファイルの印（上向き矢印）→太字の題
 *   「〇〇を追加」→小さい説明「ドラッグ＆ドロップ／またはクリックしてファイルをアップロード」
 *   →制限（1ファイル〇メガバイト以内・形式）→（あるときだけ）文字リンク「URL で入れる」「登録メディアから選ぶ」
 * - 枠全体が押せる（［ファイルを選ぶ］ボタンは置かない）。キーボードは題のボタンで開く
 * - 状態：空・ドラッグ中（線と印が青・地が薄い青）・アップロード中（％）・入った（枠いっぱいに出し、
 *   右上に［差し替える］［消す］）・失敗（赤い線と理由1行）
 * - `size="compact"` は小さい所（カルーセルのカード 180×140 など）。文字を減らした形
 *
 * 送り先は呼ぶ側が `upload` で渡す（API はこの部品の中で選ばない）。`upload` を渡さず
 * `onFile` を渡すと、検査を通ったファイルをそのまま渡す（取り込みは呼ぶ側が持つ）。
 * あとから選んだ画像・消す・`scope` が変わったあとに遅れて返った取り込みは反映しない。
 */
export type MediaSlotKind = 'image' | 'video' | 'audio' | 'file'

const NOUN: Record<MediaSlotKind, string> = { image: '画像', video: '動画', audio: '音声', file: 'ファイル' }

const FORMAT_NAMES: Record<string, string> = {
  '.jpg': 'JPEG',
  '.jpeg': 'JPEG',
  'image/jpeg': 'JPEG',
  'image/jpg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
  'image/*': '画像',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'video/*': '動画',
  'audio/mpeg': 'MP3',
  'audio/mp4': 'M4A',
  'audio/x-m4a': 'M4A',
  'audio/*': '音声',
  'application/pdf': 'PDF',
}

/** accept の書き方から「JPEG・PNG」のような形式の名前を作る。 */
export function formatNamesOf(accept?: string): string {
  if (!accept) return ''
  const names: string[] = []
  for (const rule of accept.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const name = FORMAT_NAMES[rule] ?? (rule.startsWith('.') ? rule.slice(1).toUpperCase() : '')
    if (name && !names.includes(name)) names.push(name)
  }
  return names.sort((a, b) => ['PNG', 'JPEG', 'GIF', 'WebP', 'MP4', 'MOV', 'MP3', 'M4A', 'PDF'].indexOf(a) - ['PNG', 'JPEG', 'GIF', 'WebP', 'MP4', 'MOV', 'MP3', 'M4A', 'PDF'].indexOf(b)).join('・')
}

/** バイト数を「12.4MB」「800KB」に。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/** 上限の文は、実際に受け付ける形式とバイト数から作る。 */
export function mediaLimitLabel(accept?: string, maxBytes?: number): string {
  return [formatNamesOf(accept), maxBytes ? `${formatBytes(maxBytes)} まで` : ''].filter(Boolean).join('・')
}

/** ファイルが accept に合うか。種類も名前も分からないときは断らない。 */
export function fileMatchesAccept(file: { type?: string; name?: string }, accept?: string): boolean {
  if (!accept) return true
  const type = (file.type || '').toLowerCase()
  const name = (file.name || '').toLowerCase()
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

/** 受け取りの失敗理由。日本語の理由だけを出し、「API error: 500」などの英語は案内文に置き換える。 */
function reasonOf(caught: unknown): string {
  return describeApiFailure(caught, '画像の登録')
}

/** 未指定なら元の素のボタンをそのまま描く。権限の理由だけ共通の吹き出しにつなぐ。 */
function MediaSlotButton({ lockedReason, canPressNow, onClick, onKeyDown, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { lockedReason?: string; canPressNow: () => boolean }) {
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, props['aria-describedby'])
  return <><button {...props} ref={lock.ref} {...lock.handlers} onClick={(event) => {
    if (!canPressNow()) { event.preventDefault(); event.stopPropagation(); return }
    onClick?.(event)
  }} onKeyDown={(event) => { lock.handlers?.onKeyDown(event); if (!event.defaultPrevented) onKeyDown?.(event) }} />{lock.node}</>
}

export interface MediaSlotProps {
  id?: string
  invalid?: boolean
  'aria-describedby'?: string
  /** 何を入れるか。印・言葉・入ったときの見せ方が変わる。 */
  kind?: MediaSlotKind
  /** 太字の題（「メイン画像を追加」など）。読み上げの名前にもなる。 */
  title: string
  /** 今入っているもの（URL）。空なら空の形。 */
  value?: string | null
  /** 入ったときに URL の代わりに見せる名前（動画・ファイル）。 */
  valueName?: string
  /** 入った画像の代わりの文。 */
  previewAlt?: string
  /** 入った画像の収め方。既定は枠いっぱい（cover）。 */
  fit?: 'cover' | 'contain'
  /** input の accept と同じ書き方。 */
  accept?: string
  /** 上限の大きさ（バイト）。超えたら送らずに理由を出す。 */
  maxBytes?: number
  /** 制限の行を自分で書くとき（「1ファイル10メガバイト以内・JPEG・PNG」など。括弧は部品が付ける）。 */
  /** @deprecated 上限はacceptとmaxBytesから出す。形式以外の説明はhelpへ。 */
  limitText?: string
  help?: ReactNode
  renderTrigger?: (choose: () => void) => ReactNode
  fileInputRef?: RefObject<HTMLInputElement | null>
  onFiles?: (files: File[]) => void
  /** 呼ぶ側の検査。理由を返すと送らない。 */
  validate?: (file: File) => string | Promise<string>
  /** 送り先。返した URL を `onChange` へ渡す。進みは `progress(0〜100)` で知らせる。 */
  upload?: (file: File, progress: (percent: number) => void) => Promise<string>
  /** 入った・消した。 */
  onChange?: (url: string | null) => void
  /** `upload` を渡さないとき、検査を通ったファイルを受け取る。 */
  onFile?: (file: File) => void
  /** 消す。渡さなければ `onChange(null)`。 */
  onRemove?: () => void
  /** false で［消す］を出さない（登録済みで外せないものなど。差し替えはできる）。 */
  removable?: boolean
  /** 渡すと「URL で入れる」を出す（押したときの動きは呼ぶ側）。 */
  onUrl?: () => void
  /**
   * 渡すと「URL で入れる」を出し、押すと枠の下に URL の欄を開く（部品が持つ）。
   * `open` を渡すと最初から開く（URL だけが入っているときなど）。
   */
  urlEntry?: { id?: string; value: string; onChange: (url: string) => void; label: string; placeholder?: string; open?: boolean }
  /** 渡すと「登録メディアから選ぶ」を出す。 */
  onMediaPick?: () => void
  /** 呼ぶ側が持つ取り込み中（`onFile` のとき）。 */
  busy?: boolean
  /** 呼ぶ側が持つ進み（0〜100）。 */
  progress?: number
  /** 呼ぶ側が持つ失敗の理由。 */
  error?: string
  /** 取り込み中が変わったら知らせる（保存を止めるなど）。 */
  onBusyChange?: (busy: boolean) => void
  /** これが変わったら、前の取り込みの返事を反映しない（カード・アカウントの切り替え）。 */
  scope?: string
  /** 読み取りのみ。押せる口を出さない。 */
  readOnly?: boolean
  disabled?: boolean
  /** 隠さず灰色にし、選択・消去・URL・登録メディアの操作を理由付きで拒む。children/renderTrigger の表示は呼ぶ側が持つ。 */
  lockedReason?: string
  /** 値を変える直前と非同期処理の前後で確認する。以前の処理を失効させる時は、その処理が握る callback も false を返すこと。未指定は従来どおり。 */
  canChangeNow?: () => boolean
  /** 小さい所（カルーセルのカードなど）。文字を減らす。 */
  size?: 'regular' | 'compact'
  /** 決まった縦横（「1 / 1」「20 / 13」など）。 */
  aspectRatio?: string
  /** 固定した小さい画像枠では、URL・登録済みの操作を枠の下に置く。 */
  controlsBelow?: boolean
  /** 選択済み画像に操作を重ねない。 */
  previewActionsBelow?: boolean
  framePart?: 'image-frame'
  /** 貼り付け（Cmd+V）でも受ける。 */
  acceptPaste?: boolean
  /** 枠の下に足す補足（URL の入力欄など）。 */
  children?: ReactNode
  'data-testid'?: string
}

export default function MediaSlot({
  id, invalid, 'aria-describedby': saveDescription,
  kind = 'image',
  title,
  value,
  valueName,
  previewAlt,
  fit = 'cover',
  accept,
  maxBytes,
  limitText,
  help,
  renderTrigger,
  fileInputRef,
  onFiles,
  validate,
  upload,
  onChange,
  onFile,
  onRemove,
  removable = true,
  onUrl,
  urlEntry,
  onMediaPick,
  busy: busyProp,
  progress: progressProp,
  error: errorProp,
  onBusyChange,
  scope,
  readOnly = false,
  disabled = false,
  lockedReason,
  canChangeNow,
  size = 'regular',
  aspectRatio,
  controlsBelow = false,
  previewActionsBelow = false,
  framePart,
  acceptPaste = false,
  children,
  'data-testid': testId,
}: MediaSlotProps) {
  const field = useFieldContext()
  id = id ?? field?.controlId
  invalid = invalid || field?.invalid
  saveDescription = joinDescribedBy(saveDescription, field?.describedBy)
  const permissionBlocked = Boolean(readOnly || disabled || lockedReason || canChangeNow?.() === false)
  const permissionRef = useRef({ blocked: permissionBlocked, epoch: 0, canChangeNow, lockedReason, readOnly, disabled })
  if (permissionRef.current.blocked !== permissionBlocked) permissionRef.current.epoch += 1
  Object.assign(permissionRef.current, { blocked: permissionBlocked, canChangeNow, lockedReason, readOnly, disabled })
  const permissionEpoch = permissionRef.current.epoch
  const hasPermissionGate = lockedReason !== undefined || canChangeNow !== undefined
  const canChange = useCallback(() => {
    // 任意の口が無ければ既存の処理を変えない。口がある処理は古い世代へ戻って再開しない。
    const latest = permissionRef.current
    if (!hasPermissionGate && latest.canChangeNow === undefined && latest.lockedReason === undefined) return true
    return permissionEpoch === latest.epoch && !readOnly && !disabled && !lockedReason && canChangeNow?.() !== false
      && !latest.readOnly && !latest.disabled && !latest.lockedReason && latest.canChangeNow?.() !== false
  }, [hasPermissionGate, permissionEpoch, readOnly, disabled, lockedReason, canChangeNow])
  const inputRef = useRef<HTMLInputElement>(null)
  const dragCount = useRef(0)
  const gen = useRef(0)
  const alive = useRef(true)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const busyChange = useRef(onBusyChange)
  busyChange.current = onBusyChange
  const [drag, setDrag] = useState<'idle' | 'active' | 'reject'>('idle')
  const [ownBusy, setOwnBusy] = useState(false)
  const [ownProgress, setOwnProgress] = useState<number | null>(null)
  const [ownError, setOwnError] = useState('')
  const [urlOpen, setUrlOpen] = useState(Boolean(urlEntry?.open))
  /** ファイルを受け取る口があるか。無ければ URL・登録メディアだけの形。 */
  const canFile = Boolean(upload || onFile || onFiles)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      gen.current += 1
      busyChange.current?.(false)
    }
  }, [])

  // 取り込み中に外から値が変わった（URL を手で入れた・ほかで選んだ）ら、遅れて返る取り込みは捨てる。
  const busyRef = useRef(false)
  const firstValue = useRef(true)
  useEffect(() => {
    if (firstValue.current) {
      firstValue.current = false
      return
    }
    if (!busyRef.current) return
    gen.current += 1
    busyRef.current = false
    setOwnBusy(false)
    setOwnProgress(null)
    busyChange.current?.(false)
  }, [value])

  // 場所（カード・アカウント）が変わったら、前の取り込みの失敗の理由は消す。
  useEffect(() => {
    setOwnError('')
  }, [scope])

  const busy = Boolean(busyProp) || ownBusy
  const progress = progressProp ?? ownProgress
  const error = errorProp || ownError
  const interactive = !readOnly && !disabled && !busy && canFile && !permissionBlocked
  const compact = size === 'compact'
  const dropHint = compact ? 'またはクリック' : 'またはクリックしてファイルをアップロード'
  const noun = NOUN[kind]
  const formats = formatNamesOf(accept)
  const legacyMax = limitText?.match(/([\d.]+)\s*(?:MB|MiB|メガバイト)/)?.[1]
  const limit = mediaLimitLabel(accept, maxBytes ?? (legacyMax ? Number(legacyMax) * 1024 * 1024 : undefined))
  const extraHelp = help ?? (limitText && !legacyMax ? limitText : undefined)

  const setBusy = useCallback((next: boolean) => {
    busyRef.current = next
    setOwnBusy(next)
    busyChange.current?.(next)
  }, [])

  useEffect(() => {
    if (!hasPermissionGate || !permissionBlocked) return
    gen.current += 1
    dragCount.current = 0
    setDrag('idle')
    setBusy(false)
    setOwnProgress(null)
  }, [hasPermissionGate, permissionBlocked, setBusy])

  const send = useCallback(
    async (file: File, ticket: number, sendFile: NonNullable<MediaSlotProps['upload']>) => {
      const requestedScope = scopeRef.current
      setOwnProgress(null)
      setBusy(true)
      try {
        const url = await sendFile(file, (percent) => {
          if (ticket === gen.current && alive.current && canChange()) setOwnProgress(Math.min(100, Math.max(0, Math.round(percent))))
        })
        if (ticket !== gen.current || !alive.current || !canChange()) return
        if (scopeRef.current !== requestedScope) {
          setOwnError(`編集中の場所が変わったため、${NOUN[kind]}を反映しませんでした。選び直してください。`)
          return
        }
        onChange?.(url)
      } catch (caught) {
        if (ticket !== gen.current || !alive.current || !canChange()) return
        setOwnError(reasonOf(caught) || `${NOUN[kind]}を取り込めませんでした。もう一度選んでください。`)
      } finally {
        if (ticket === gen.current && alive.current) {
          setBusy(false)
          setOwnProgress(null)
        }
      }
    },
    [kind, onChange, setBusy, canChange],
  )

  const take = useCallback(
    (file: File) => {
      if (readOnly || disabled || !canChange()) return
      setOwnError('')
      if (!fileMatchesAccept(file, accept)) {
        setOwnError(formats ? `${formats} の${noun}を選んでください` : `この${noun}は入れられません`)
        return
      }
      if (maxBytes && file.size > maxBytes) {
        setOwnError(`${noun}が大きすぎます（${formatBytes(file.size)}）`)
        return
      }
      const ticket = ++gen.current
      const start = (reason: string) => {
        if (ticket !== gen.current || !alive.current || !canChange()) return
        if (reason) {
          setOwnError(reason)
          return
        }
        if (!upload) {
          onFile?.(file)
          return
        }
        void send(file, ticket, upload)
      }
      // 検査が同期なら、その場で送り始める（続けて選んだ順を崩さない）。
      const checked = validate ? validate(file) : ''
      if (typeof checked === 'string') start(checked)
      else void checked.then(start, () => start(`この${noun}は入れられません`))
    },
    [accept, disabled, formats, maxBytes, noun, onFile, readOnly, upload, validate, send, canChange],
  )

  const openPicker = () => {
    if (interactive && canChange()) inputRef.current?.click()
  }

  const clear = () => {
    if (!canChange()) return
    gen.current += 1
    if (ownBusy) setBusy(false)
    setOwnProgress(null)
    setOwnError('')
    if (onRemove) onRemove()
    else onChange?.(null)
  }

  const checkDrag = (event: DragEvent) => {
    event.preventDefault()
    if (!interactive || !canChange()) return
    if (event.type === 'dragenter') dragCount.current += 1
    const items = [...(event.dataTransfer?.items ?? [])].filter((item) => item.kind === 'file')
    const ok = items.every((item) => {
      const file = item.getAsFile()
      return fileMatchesAccept({ type: file?.type || item.type, name: file?.name }, accept)
    })
    setDrag(ok ? 'active' : 'reject')
  }
  const leaveDrag = (event: DragEvent) => {
    event.preventDefault()
    dragCount.current = Math.max(0, dragCount.current - 1)
    if (dragCount.current === 0) setDrag('idle')
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    dragCount.current = 0
    setDrag('idle')
    if (!interactive || !canChange()) return
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (onFiles) onFiles(files)
    else if (files[0]) void take(files[0])
  }
  const paste = (event: ClipboardEvent) => {
    if (!acceptPaste || readOnly || disabled || !canChange()) return
    const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.kind === 'file' || entry.type.startsWith(`${kind}/`))
    const file = item?.getAsFile()
    if (file) {
      event.preventDefault()
      void take(file)
    }
  }

  const filled = Boolean(value) && !busy
  const state = busy
    ? 'busy'
    : drag === 'active'
      ? 'drag'
      : drag === 'reject' || error
        ? 'error'
        : filled
          ? 'filled'
          : 'empty'

  const stop = (event: MouseEvent) => event.stopPropagation()
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ') event.stopPropagation()
  }

  const links =
    !readOnly && !busy && (onUrl || urlEntry || onMediaPick) ? (
      <span className={styles.links}>
        {onUrl || urlEntry ? (
          <Button lockedReason={lockedReason} variant="text" size="inline" textTone="accent"
            type="button"
            disabled={disabled || permissionBlocked}
            aria-expanded={urlEntry ? urlOpen : undefined}
            onClick={(event) => { stop(event); if (!canChange()) return; if (onUrl) onUrl(); else setUrlOpen((open) => !open) }}
          >
            <Link2 size={14} aria-hidden="true" />URL で入れる
          </Button>
        ) : null}
        {onMediaPick ? (
          <Button lockedReason={lockedReason} variant="text" size="inline" textTone="accent" type="button" disabled={disabled || permissionBlocked} onClick={(event) => { stop(event); if (canChange()) onMediaPick() }}>
            <Images size={14} aria-hidden="true" />登録メディアから選択する
          </Button>
        ) : null}
      </span>
    ) : null

  const filledActions = readOnly ? null : (
    <span className={styles.actions}>
      {canFile ? (
        <MediaSlotButton lockedReason={lockedReason} canPressNow={canChange} type="button" className={styles.pill} disabled={disabled || permissionBlocked} onClick={(event) => { stop(event); openPicker() }}>
          差し替える
        </MediaSlotButton>
      ) : null}
      {removable ? (
        <MediaSlotButton lockedReason={lockedReason} canPressNow={canChange} type="button" className={styles.pill} disabled={disabled || permissionBlocked} onClick={(event) => { stop(event); clear() }}>
          消す
        </MediaSlotButton>
      ) : null}
    </span>
  )

  let body: ReactNode
  if (busy) {
    body = (
      <span className={styles.center} role="status">
        <Loader aria-hidden="true" className={styles.spin} />
        <span className={styles.title}>{progress == null ? 'アップロード中…' : `アップロード中… ${progress}%`}</span>
        {compact ? null : <span className={styles.desc}>アップロードが終わるまでお待ちください</span>}
      </span>
    )
  } else if (filled && drag === 'idle') {
    body = (
      <>
        {kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img width={320} height={240} className={styles.preview} data-fit={fit} src={value ?? ''} alt={previewAlt ?? title.replace(/を追加$/, '')} />
        ) : kind === 'video' ? (
          <video className={styles.preview} data-fit={fit} src={value ?? ''} preload="metadata" muted aria-label={previewAlt ?? valueName ?? noun} />
        ) : (
          <span className={styles.center}>
            {kind === 'audio' ? <FileAudio aria-hidden="true" className={styles.icon} /> : <FileIcon aria-hidden="true" className={styles.icon} />}
            <span className={styles.fileName} title={valueName ?? value ?? ''}>{valueName ?? value}</span>
          </span>
        )}
        {!previewActionsBelow ? filledActions : null}
        {error && !controlsBelow ? <span className={styles.filledError} role="alert">{error}</span> : null}
      </>
    )
  } else {
    const inner = (
      <>
        <FileUp aria-hidden="true" className={styles.icon} />
        <span className={styles.title}>{readOnly ? `${noun}はありません` : title}</span>
        {/* 枠の下に理由を出す形（controlsBelow）は、枠の中に理由を重ねず説明と上限を出したままにする。 */}
        {readOnly ? null : drag === 'reject' && !controlsBelow ? (
          <span className={styles.reason}>{formats ? `${formats} の${noun}を選んでください` : `この${noun}は入れられません`}</span>
        ) : error && !controlsBelow ? (
          <>
            <span className={styles.reason} role="alert">{error}</span>
            {limit ? <span className={`${styles.desc} ${styles.limit}`} title={limit}>{limit}</span> : null}
          </>
        ) : !canFile ? (
          limit ? <span className={`${styles.desc} ${styles.limit}`} title={limit}>{compact ? limit : `（${limit}）`}</span> : null
        ) : (
          <>
            <span className={`${styles.desc} ${styles.dropHint}`} title={`ドラッグ＆ドロップ ${dropHint}`}>
              ドラッグ＆ドロップ
              <br />
              {dropHint}
            </span>
            {limit ? <span className={`${styles.desc} ${styles.limit}`} title={limit}>{compact ? limit : `（${limit}）`}</span> : null}
          </>
        )}
      </>
    )
    body = (
      <span className={styles.center}>
        {readOnly || !canFile ? (
          inner
        ) : (
          <MediaSlotButton data-input-hit lockedReason={lockedReason} canPressNow={canChange} type="button" className={styles.hit} disabled={!interactive} onClick={(event) => { stop(event); openPicker() }} onKeyDown={onKey}>
            {inner}
          </MediaSlotButton>
        )}
        {drag === 'idle' && !controlsBelow ? links : null}
      </span>
    )
  }

  const picker = (
        <input
          ref={(node) => { inputRef.current = node; if (fileInputRef) fileInputRef.current = node }}
          type="file"
          multiple={Boolean(onFiles)}
          accept={accept}
          disabled={!interactive}
          tabIndex={-1}
          aria-hidden="true"
          aria-label={`${title}（ファイル）`}
          className={styles.input}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            // 同じファイルを選び直せるよう、毎回空に戻す。
            event.target.value = ''
            if (!canChange()) return
            if (onFiles) onFiles(files)
            else if (files[0]) void take(files[0])
          }}
        />
  )
  if (renderTrigger) return <>{renderTrigger(openPicker)}{picker}{error ? <p role="alert">{error}</p> : null}</>

  return (
    <div id={id} className={styles.root} data-has-help={extraHelp ? true : undefined} data-controls-below={controlsBelow || undefined} data-preview-actions-below={previewActionsBelow || undefined} data-testid={testId} aria-invalid={invalid || undefined} aria-describedby={saveDescription}>
      {extraHelp ? <HelpTip className={styles.help} label={`${title}の補足`}>{extraHelp}</HelpTip> : null}
      <div
        role="group"
        aria-label={title}
        aria-busy={busy || undefined}
        aria-invalid={invalid || state === 'error' || undefined}
        data-input-field
        data-design-node="Z7vd2"
        data-media-slot=""
        data-shared-part={framePart}
        data-image-frame={framePart === 'image-frame' || undefined}
        data-state={state}
        data-size={size}
        data-kind={kind}
        data-readonly={readOnly || undefined}
        data-disabled={disabled || (hasPermissionGate && permissionBlocked) || undefined}
        className={styles.frame}
        style={aspectRatio ? { aspectRatio } : undefined}
        tabIndex={acceptPaste && interactive ? -1 : undefined}
        onClick={() => {
          if (!filled) openPicker()
        }}
        data-file={canFile || undefined}
        onDragEnter={checkDrag}
        onDragOver={checkDrag}
        onDragLeave={leaveDrag}
        onDrop={drop}
        onPaste={paste}
      >
        {body}
        {picker}
      </div>
      {previewActionsBelow && filled && !busy && drag === 'idle' ? filledActions : null}
      {controlsBelow && !readOnly && (error || drag === 'reject') ? <span className={styles.reason} role="alert">{error ?? (formats ? `${formats} の${noun}を選んでください` : `この${noun}は入れられません`)}</span> : null}
      {/* 説明と上限は枠の中（絵 J60utH・e875x・D6fh3）。枠の下は「URL で入れる」「登録メディアから選ぶ」だけを左にそろえて縦に並べる。 */}
      {controlsBelow && drag === 'idle' ? links : null}
      {urlEntry && urlOpen && !readOnly ? (
        <TextField
          id={urlEntry.id}
          type="url"
          aria-label={urlEntry.label}
          value={urlEntry.value}
          disabled={disabled || permissionBlocked}
          placeholder={urlEntry.placeholder ?? 'https://…'}
          onChange={(event) => { if (canChange()) urlEntry.onChange(event.target.value) }}
        />
      ) : null}
      {children}
    </div>
  )
}
