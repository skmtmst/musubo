'use client'

/*
 * ★V8 物を作る・直す画面の「どのフォルダに入れるか」を選ぶ欄（Pencil V8.pen 共通部品
 * dLffh「選ぶ欄/開いた/フォルダ（作れる）」・iBuZH「選ぶ欄/開いた/フォルダ（名前を入れる）」。
 * オーナー 2026-10-08）。
 *
 * - 開いた中身は StFE7 の形（shared/select-menu）。各行の前にフォルダの色の点。
 *   一番下に区切りの線と「＋ 新しいフォルダを作る」（緑・600）。
 * - 押すと同じ板が「新しいフォルダ」に替わる：名前の欄（自動で焦点）・横の色ボタン・［やめる］［作って選ぶ］。
 *   Enter で作る（日本語の変換中は作らない）。Esc・［やめる］で一覧へ戻る。
 * - 作ると、その画面のフォルダの受け口（onCreate）で作り、一覧に足して、そのフォルダを選んで閉じる。
 *   作っている間は押せない。失敗したら板の中に理由と［もう一度試す］。入れた名前は残す。
 * - onCreate を渡さない（閲覧のみ・フォルダを作る権限が無い）ときは「＋ 新しいフォルダを作る」を出さない。
 * - 一覧の絞り込みの「フォルダ：すべて」には使わない（作る・直す画面の置き場だけ）。
 *
 * 画面ごとに作り方を書かない。各画面は自分の種類のフォルダの受け口を onCreate に渡すだけ。
 */
import { inputPlaceholder } from './input-placeholder'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import FolderDot from './folder-dot'
import Select, { type SelectCreateContext, type SelectProps } from './select'
import { isImeComposing } from './ime'
import { describeApiFailure, japaneseDetailOf } from './api-error-message'
import { ApiError, describeSaveFailure } from '@/lib/api'
import styles from './folder-select.module.css'
import FolderColorButton from './folder-color-button'
import { FOLDER_SELECT_COLORS } from '@line-crm/shared'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
export { FOLDER_SELECT_COLORS } from '@line-crm/shared'

/** 選べるフォルダ1つ。value は画面が保存に使う値（多くは id。名前で持つ画面は名前）。 */
export interface FolderSelectFolder {
  value: string
  label: string
  /** フォルダの色（#RRGGBB）。無いフォルダは名前から共通の9色で塗る。 */
  color?: string | null
}

export type FolderSelectCreate = (name: string, color: string | null) => Promise<FolderSelectFolder>

export type FolderDraftGuard = (action: () => void) => void

export interface FolderSelectProps extends Pick<SelectProps, 'aria-label' | 'label' | 'className' | 'disabled' | 'error' | 'id' | 'name' | 'size' | 'width' | 'defaultOpen' | 'lockedReason'> {
  folders: ReadonlyArray<FolderSelectFolder>
  value: string
  onChange: (value: string) => void
  /** 絞り込みの「すべて」に戻す行。所属の選択では渡さない。 */
  allOption?: { value: string; label: string }
  /**
   * 「未分類」（フォルダに入れない）の行。既定は value '' の「未分類」。
   * null で出さない。label を変えたいとき（「（選ばない）」など）は渡す。
   */
  unfiled?: { value: string; label: string } | null
  /**
   * 新しいフォルダを作る受け口。作れたフォルダを返す。失敗は Error（message を板に出す）。
   * 渡さないと「＋ 新しいフォルダを作る」を出さない（閲覧のみ・権限なし）。
   */
  onCreate?: FolderSelectCreate
  /** false のときは色のボタンを出さず、作成時に null を渡す。 */
  colors?: boolean
  /** ＋行だけを入力・状態の理由で止める。既存フォルダは選べる。 */
  createDisabled?: boolean
  /** ＋行だけの権限理由。既存フォルダは選べる。 */
  createLockedReason?: string
  /** 親の保存で作りかけのフォルダ名を捨てる前にも確認する。 */
  draftGuardRef?: MutableRefObject<FolderDraftGuard | null>
  /** 作成中は親の保存を止め、理由を出す。 */
  onCreatingChange?: (creating: boolean) => void
}

/** API の答え（{ success, data } / { success: false, error }）を、作れたフォルダか Error に直す。 */
/** 受け口が { success: false, error } で答えたとき。reason は板に出す理由（日本語のときだけ）。 */
export class FolderCreateError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'FolderCreateError'
    this.reason = /[ぁ-んァ-ヶ一-龠]/u.test(reason) ? reason : ''
  }
}

export function folderCreateResult<T>(
  response: { success: true; data: T } | { success: false; error: string },
  toFolder: (data: T) => FolderSelectFolder,
): FolderSelectFolder {
  if (!response.success) throw new FolderCreateError(response.error ?? '')
  return toFolder(response.data)
}

/** 板に出す理由。API の答え（同じ名前がある など）を日本語で出し、英語・内部の文は出さない。 */
function reasonOf(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 409) {
    return japaneseDetailOf(caught) || '同じ名前のフォルダがあります。別の名前で作ってください。'
  }
  if (caught instanceof ApiError && caught.status >= 500) {
    const message = describeSaveFailure(caught)
    const trackingId = caught.trackingId
    return trackingId && /^[a-zA-Z0-9_-]{1,128}$/.test(trackingId)
      ? `${message}（追跡番号 ${trackingId}）`
      : message
  }
  return describeApiFailure(caught, 'フォルダの作成')
}

/**
 * 各画面のフォルダの受け口を onCreate の形にする。
 * call：その画面の種類のフォルダを作る API。toFolder：答えを選択肢に直す。onCreated：画面の一覧に足す。
 */
export function folderCreator<T>(
  call: (name: string, color: string | null) => Promise<{ success: true; data: T } | { success: false; error: string }>,
  toFolder: (data: T) => FolderSelectFolder,
  onCreated?: (data: T) => void,
): FolderSelectCreate {
  return async (name, color) => {
    const response = await call(name, color)
    const folder = folderCreateResult(response, toFolder)
    if (response.success) onCreated?.(response.data)
    return folder
  }
}

/** 汎用フォルダ（api.folders）の答えを選択肢に直す。value は id。 */
export const folderById = (folder: { id: string; name: string; color?: string | null }): FolderSelectFolder => ({ value: folder.id, label: folder.name, color: folder.color ?? null })
/** 名前で保存する画面（テンプレートのリッチ・クーポン・リサーチ、友だち追加）。value は名前。 */
export const folderByName = (folder: { name: string; color?: string | null }): FolderSelectFolder => ({ value: folder.name, label: folder.name, color: folder.color ?? null })

/**
 * 別の入口（統括のひな形など）が渡す口から名前と色で作る。
 * 口が無い・閲覧のみなら作らせない。
 */
export function hostFolderCreate(host: {
  createFolder?: FolderSelectCreate
  readOnly?: boolean
}): FolderSelectCreate | undefined {
  const create = host.createFolder
  if (!create || host.readOnly) return undefined
  return (name, color) => create(name, color)
}

export default function FolderSelect({
  folders,
  value,
  onChange,
  allOption,
  unfiled = { value: '', label: '未分類' },
  onCreate,
  colors = true,
  createDisabled,
  createLockedReason,
  draftGuardRef,
  onCreatingChange,
  ...selectProps
}: FolderSelectProps) {
  // 作ったフォルダは、画面が一覧を読み直す前でも選べて名前が出るよう、ここでも持つ。
  const [created, setCreated] = useState<FolderSelectFolder[]>([])
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(FOLDER_SELECT_COLORS[0].value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openCreateSignal, setOpenCreateSignal] = useState(0)
  useLayoutEffect(() => {
    onCreatingChange?.(busy)
    return () => onCreatingChange?.(false)
  }, [busy, onCreatingChange])
  const busyRef = useRef(false)
  const sessionRef = useRef(0)
  const guardAction = useRef<FolderDraftGuard | null>(null)
  const clearDraft = () => {
    setName('')
    setColor(FOLDER_SELECT_COLORS[0].value)
    setError('')
  }
  const dirty = name.length > 0 || (colors && color !== FOLDER_SELECT_COLORS[0].value)
  const all = useMemo(() => {
    const known = new Set(folders.map((folder) => folder.value))
    return [...folders, ...created.filter((folder) => !known.has(folder.value))]
  }, [folders, created])
  const options = [
    ...(allOption ? [{ ...allOption, leading: undefined }] : []),
    ...(unfiled ? [{ value: unfiled.value, label: unfiled.label, leading: <FolderDot /> }] : []),
    ...all.map((folder) => ({ value: folder.value, label: folder.label, leading: <FolderDot folder={{ name: folder.label, color: folder.color }} /> })),
  ]
  return (
    <>
    {(dirty || busy) && <FolderCreationGuard busy={busy} onDiscard={clearDraft} actionRef={guardAction} draftGuardRef={draftGuardRef} />}
    <Select
      {...selectProps}
      openCreateSignal={openCreateSignal}
      value={value}
      onChange={onChange}
      options={options}
      icon={options.find((option) => option.value === value)?.leading}
      // 絵（dLffh）は開いた中身の上に「フォルダ」。閉じたボタンに頭を付けたい画面は label を渡す。
      menuHeading="フォルダ"
      createAction={onCreate ? {
        label: '新しいフォルダを作る',
        disabled: createDisabled,
        lockedReason: createLockedReason,
        render: (context) => (
          <FolderCreatePanel
            context={context}
            colors={colors}
            name={name} setName={setName} color={color} setColor={setColor}
            busy={busy} setBusy={setBusy} busyRef={busyRef} sessionRef={sessionRef} error={error} setError={setError}
            onBack={() => { if (guardAction.current) guardAction.current(context.back); else context.back() }}
            clearDraft={clearDraft}
            onCreate={async (name, color) => {
              const folder = await onCreate(name, color)
              setCreated((current) => [...current.filter((item) => item.value !== folder.value), folder])
              return folder
            }}
          />
        ),
      } : undefined}
    />
    {busy ? <span className={styles.draftNote} role="status">フォルダを作成しています…</span> : dirty ? (
      <span className={styles.draftNote}>
        <span>{name ? '作りかけのフォルダ名があります。' : 'フォルダの色を変更しています。'}</span>{' '}
        <button type="button" className={styles.draftLink} disabled={selectProps.disabled || !onCreate || createDisabled || Boolean(createLockedReason)} onClick={() => setOpenCreateSignal(value => value + 1)}>フォルダの入力を確認</button>
      </span>
    ) : null}
    </>
  )
}

function FolderCreationGuard({ busy, onDiscard, actionRef, draftGuardRef }: {
  busy: boolean
  onDiscard: () => void
  actionRef: MutableRefObject<FolderDraftGuard | null>
  draftGuardRef?: MutableRefObject<FolderDraftGuard | null>
}) {
  const [savingParent, setSavingParent] = useState(false)
  const guard = useUnsavedGuard({ dirty: true, busy, onDiscard, subject: '作りかけのフォルダ' })
  useLayoutEffect(() => {
    actionRef.current = guard.guarded
    if (draftGuardRef) draftGuardRef.current = (action) => {
      if (busy) return
      setSavingParent(true)
      guard.guarded(action)
    }
    return () => {
      actionRef.current = null
      if (draftGuardRef) draftGuardRef.current = null
    }
  }, [actionRef, draftGuardRef, busy, guard.guarded])
  return <UnsavedLeaveDialog
    open={guard.leaveTarget !== null}
    subject="作りかけのフォルダ"
    busy={busy}
    description={savingParent ? '作りかけのフォルダを破棄して、画面の内容を保存します。' : undefined}
    discardLabel={savingParent ? 'フォルダを破棄して保存' : undefined}
    onConfirm={() => { setSavingParent(false); guard.confirmLeave() }}
    onCancel={() => { setSavingParent(false); guard.cancelLeave() }}
  />
}

function FolderCreatePanel({
  context,
  colors,
  onCreate, name, setName, color, setColor, busy, setBusy, busyRef, sessionRef, error, setError, onBack, clearDraft,
}: {
  context: SelectCreateContext
  colors: boolean
  onCreate: FolderSelectCreate
  name: string
  setName: (value: string) => void
  color: string
  setColor: (value: string) => void
  busy: boolean
  setBusy: (value: boolean) => void
  busyRef: MutableRefObject<boolean>
  sessionRef: MutableRefObject<number>
  error: string
  setError: (value: string) => void
  onBack: () => void
  clearDraft: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const session = ++sessionRef.current
    return () => {
      if (sessionRef.current === session) sessionRef.current += 1
      // 送信済みの欄を閉じた後は、戻っても別の作成として扱う。
      if (busyRef.current) clearDraft()
    }
    // この板が開いている間の世代だけを記録する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const trimmed = name.trim()
  const submit = async () => {
    if (!trimmed || busyRef.current) return
    const session = sessionRef.current
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const folder = await onCreate(trimmed, colors ? color : null)
      context.finish(folder.value)
      if (session === sessionRef.current) clearDraft()
    } catch (caught) {
      // 入れた名前は残す（もう一度試す・直して作る）。
      if (session === sessionRef.current) {
        setError(reasonOf(caught))
        inputRef.current?.focus()
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div
      className={styles.panel}
      role="group"
      aria-label="新しいフォルダ"
      aria-busy={busy || undefined}
      onKeyDown={(event) => {
        // Esc は一覧へ戻るだけ。窓（ダイアログ）の中に置いても、窓まで閉じない（後ろの聞き手へ渡さない）。
        if (event.key !== 'Escape' || isImeComposing(event)) return
        event.preventDefault()
        event.stopPropagation()
        event.nativeEvent.stopImmediatePropagation()
        if (!busyRef.current) onBack()
      }}
    >
      <div className={styles.heading} aria-hidden="true">新しいフォルダ</div>
      <div className={styles.nameRow}>
        <input
          ref={inputRef}
          type="text"
          data-input-field
          className={styles.field}
          value={name}
          maxLength={100}
          placeholder={inputPlaceholder('フォルダ名')}
          aria-label="新しいフォルダの名前"
          aria-invalid={error ? true : undefined}
          // 作っている間は直せない（焦点は残す。disabled にすると焦点が外れて板が閉じる）。
          readOnly={busy}
          onChange={(event) => {
            setName(event.target.value)
            if (error) setError('')
          }}
          onKeyDown={(event) => {
            // 変換を確定する Enter で書きかけの名前を作らない。
            if (event.key !== 'Enter' || isImeComposing(event)) return
            event.preventDefault()
            void submit()
          }}
        />
        {colors ? (
          <FolderColorButton compact value={color} onChange={(next) => setColor(next ?? FOLDER_SELECT_COLORS[0].value)} disabled={busy} />
        ) : null}
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} disabled={busy} onClick={onBack}>やめる</button>
        <button type="button" className={styles.primary} disabled={busy || !trimmed} onClick={() => void submit()}>
          {busy ? '作っています…' : error ? 'もう一度試す' : '作って選択する'}
        </button>
      </div>
    </div>
  )
}
