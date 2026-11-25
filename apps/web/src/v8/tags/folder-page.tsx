'use client'
import { Suspense, useContext, useEffect, useRef, useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { FolderCheck, FolderPlus, Trash2 } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import ListState from '@/components/shared/list-state'
import TagsList from './list'
import styles from './create.module.css'
import { TAG_FOLDER_COLORS, DEFAULT_TAG_FOLDER_COLOR } from './folder-colors'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8 タグ「フォルダを追加」（Pencil ）。タグの一覧（src/v8/tags/list）の上に窓を重ねる。
 *
 * 読み込み・保存・削除・クエリの切り替え（古い応答を捨てる）は今の画面（app/tags/folders/new/page.tsx）と同じ。
 * 受け付ける URL：`/tags/folders/new`（タグのフォルダを追加）・`?id=<フォルダ>`（直す・削除）・
 * `?kind=friend_field`（友だち情報欄のフォルダを追加。今の「作成する場所」の切り替えの代わり）。
 * 色は共通部品と同じ名前つきの8色を、名前の横の共通ボタンから選ぶ。
 */

/* 絵の9色。保存する値は色コード、読み上げと見出しは名前。既定は緑（基調色）。 */

export { TAG_FOLDER_COLORS } from './folder-colors'
const DEFAULT_COLOR = DEFAULT_TAG_FOLDER_COLOR

type RequestKey = { editId: string | null; generation: number }
const sameRequest = (a: RequestKey, b: RequestKey) => a.editId === b.editId && a.generation === b.generation

/** 保存の失敗を、運用者が次に取る行動の言葉で返す（API の文言をそのまま出さない）。 */
export function folderSaveError(status?: number): string {
  switch (status) {
    case 400: return '入力内容を確認してください。フォルダ名は60文字以内で入力してください。'
    case 403: return permissionDeniedMessage('store')
    case 404: return 'フォルダが見つかりません。一覧へ戻って最新の状態を確認してください。'
    case 409: return 'ほかの担当者が先に変更しました。最新の内容を読み直してください。'
    default: return '保存できませんでした。時間を置いて、もう一度お試しください。'
  }
}

function folderDeleteError(status?: number): string {
  switch (status) {
    case 400: return '削除できませんでした。フォルダの状態を確認して、もう一度お試しください。'
    case 403: return permissionDeniedMessage('store')
    case 404: return '削除しようとしたフォルダが見つかりません。一覧へ戻って最新の状態を確認してください。'
    case 409: return 'ほかの担当者が先に変更したため、削除できませんでした。最新の内容を読み直してください。'
    default: return '削除できませんでした。時間を置いて、もう一度お試しください。'
  }
}

export default function TagFolderPageV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <TagFolderPage />
    </Suspense>
  )
}

function TagFolderPage() {
  const saveErrors = useSaveFormErrors()
  const staffRole = useStaffRole()
  const router = useRouter()
  const params = useSearchParams()
  const { selectedAccountId } = useAccount()
  const editId = params.get('id')
  const scope: 'tag' | 'friend_field' = !editId && params.get('kind') === 'friend_field' ? 'friend_field' : 'tag'
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [folderAccountId, setFolderAccountId] = useState<string | null>(selectedAccountId)
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const deleteLock = useRef(false)
  const currentAccount = useRef(selectedAccountId)
  currentAccount.current = selectedAccountId
  const [error, setError] = useState('')
  const activeRef = useRef<RequestKey>({ editId, generation: 0 })
  /* 直すとき、ready になるまで名前も色も本物ではない。空のまま保存して元の名前を消さない。 */
  const [loadState, setLoadState] = useState<'ready' | 'loading' | 'error' | 'forbidden'>(editId ? 'loading' : 'ready')
  const baseline = useRef({ name: '', color: DEFAULT_COLOR })
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({
    dirty: (loadState === 'ready' && (name !== baseline.current.name || color !== baseline.current.color)) || saving,
    busy: saving,
    onDiscard: () => { setName(baseline.current.name); setColor(baseline.current.color) },
  })

  const close = () => router.push(scope === 'tag' ? '/tags' : '/tags?tab=fields')

  const loadFolder = () => {
    const request = { editId, generation: activeRef.current.generation + 1 }
    activeRef.current = request
    deleteTicket.current = null
    setDeleteOpen(false)
    setError('')
    setNameError('')
    setSaving(false)
    if (!editId) {
      baseline.current = { name: '', color: DEFAULT_COLOR }
      setName('')
      setColor(DEFAULT_COLOR)
      setFolderAccountId(selectedAccountId)
      setLoadState('ready')
      return
    }
    setName('')
    setColor(DEFAULT_COLOR)
    setLoadState('loading')
    void api.tagGroups.list(selectedAccountId)
      .then((result) => {
        if (!sameRequest(activeRef.current, request)) return
        if (!result.success) { setLoadState('error'); return }
        const group = result.data.find((item) => item.id === editId)
        if (!group) { setLoadState('error'); return }
        baseline.current = { name: group.name, color: folderDisplayColor(group) }
        setName(group.name)
        setColor(folderDisplayColor(group))
        setFolderAccountId(group.accountId)
        setLoadState('ready')
      })
      .catch((reason: unknown) => {
        if (!sameRequest(activeRef.current, request)) return
        const status = (reason as { status?: number } | null)?.status
        setLoadState(status === 403 ? 'forbidden' : 'error')
      })
  }
  useEffect(loadFolder, [editId, selectedAccountId])

  const save = async () => {
    if (saving || loadState !== 'ready') return
    if (!name.trim()) { setNameError('フォルダ名を入力してください'); nameRef.current?.focus(); nameRef.current?.scrollIntoView({ block: 'center' }); return }
    setNameError('')
    const request = { ...activeRef.current }
    setSaving(true)
    setError('')
    try {
      if (scope === 'tag') {
        const result = editId
          ? await api.tagGroups.update(editId, { name: name.trim(), color, accountId: folderAccountId })
          : await api.tagGroups.create({ name: name.trim(), color, accountId: selectedAccountId })
        if (!result.success) throw new Error('save_failed')
      } else {
        const result = await api.folders.create({ kind: 'friend_field', name: name.trim(), color, accountId: selectedAccountId })
        if (!result.success) throw new Error('save_failed')
      }
      if (!sameRequest(activeRef.current, request)) return
      guard.disarm()
      close()
    } catch (reason) {
      if (!sameRequest(activeRef.current, request)) return
      const fieldFailure = saveErrors.capture(reason)
      { if (!fieldFailure)

      setError(folderSaveError(reason instanceof ApiError ? reason.status : undefined)) }
    } finally {
      if (sameRequest(activeRef.current, request)) setSaving(false)
    }
  }

  const remove = async () => {
    if (!editId || saving || loadState !== 'ready' || !renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current || deleteLock.current || selectedAccountId !== currentAccount.current) return false
    const request = { ...activeRef.current }
    deleteLock.current = true
    setSaving(true)
    setError('')
    try {
      const result = await api.tagGroups.delete(editId, folderAccountId)
      if (!result.success) throw new Error('delete_failed')
      if (!sameRequest(activeRef.current, request) || renderedDeleteTicket !== deleteTicket.current || selectedAccountId !== currentAccount.current) return false
      deleteTicket.current = null
      guard.disarm()
      router.push('/tags')
      return true
    } catch (reason) {
      if (!sameRequest(activeRef.current, request) || renderedDeleteTicket !== deleteTicket.current || selectedAccountId !== currentAccount.current) return false
      const fieldFailure = saveErrors.capture(reason)
      { if (!fieldFailure)

      setError(folderDeleteError(reason instanceof ApiError ? reason.status : undefined)) }
      return false
    } finally {
      deleteLock.current = false
      if (sameRequest(activeRef.current, request)) setSaving(false)
    }
  }

  if (staffRole !== null && !canManageRole(staffRole)) return <SaveErrorScope errors={saveErrors}><ReadOnlyNotice>閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice></SaveErrorScope>

  /* 止まっている理由は押せない見た目だけにせず、ボタンの title と本文に出す。 */
  const blockedReason =
    loadState === 'loading' ? '読み込んでいます'
      : loadState === 'error' ? '読み込めませんでした'
        : loadState === 'forbidden' ? permissionDeniedMessage('store')
          : null
  const title = editId ? 'フォルダを直す' : scope === 'friend_field' ? '友だち情報欄のフォルダを追加する' : 'フォルダを追加する'

  return (
    <SaveErrorScope errors={saveErrors}><>
      <TagsList accountId={selectedAccountId} />
      <FolderEditorDialog
        open
        designNode="IjVpM"
        designTop={300}
        title={title}
        name={name} nameError={nameError} nameRef={nameRef} onNameChange={(next) => { setName(next); setNameError('') }} color={color} onColorChange={(next) => setColor(next ?? DEFAULT_COLOR)}
        colors={TAG_FOLDER_COLORS} maxLength={60} disabled={loadState !== 'ready'}
        onConfirm={() => save()}
        busy={saving}
        error={error || undefined}
        onCancel={close}
        footer={(
          <>
            {editId ? (
              <Button type="button" variant="text" textTone="danger" disabled={saving || loadState !== 'ready'} disabledReason={blockedReason} title={blockedReason ?? undefined} onClick={() => { deleteTicket.current = {}; setError(''); setDeleteOpen(true) }}>
                <Trash2 size={16} aria-hidden="true" />削除する
              </Button>
            ) : null}
            <span className={styles.dialogFooterEnd}>
              <Button type="button" disabled={saving} onClick={close}>キャンセル</Button>
              <Button type="button" variant="primary" disabled={saving || blockedReason !== null} title={blockedReason ?? undefined}  onClick={() => save()} busy={saving}>
                {editId ? <FolderCheck size={16} aria-hidden="true" /> : <FolderPlus size={16} aria-hidden="true" />}
                {editId ? 'フォルダを保存する' : 'フォルダを作る'}
              </Button>
            </span>
          </>
        )}
      >
        <>
          {loadState === 'forbidden' ? <p className={styles.fieldNote}>{permissionDeniedMessage('store')}</p> : null}
          {loadState === 'loading' ? <p className={styles.fieldNote}>読み込んでいます</p> : null}
          {loadState === 'error' ? (
            <div className={styles.inlineRetry}>
              <p className={styles.fieldError}>読み込めませんでした</p>
              <Button type="button" variant="text" onClick={loadFolder}>もう一度読み込む</Button>
            </div>
          ) : null}
        </>
      </FolderEditorDialog>
      <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
      <ConfirmDialog
        open={deleteOpen}
        title={`「${name}」を削除しますか？`}
        description="フォルダだけを削除します。中にあるタグは削除されず、未分類へ戻ります。"
        confirmLabel="このフォルダを削除する"
        destructive
        busy={saving}
        onCancel={() => { if (!saving && !deleteLock.current) { deleteTicket.current = null; setDeleteOpen(false) } }}
        error={error || undefined} onSuccess={() => { deleteTicket.current = null; setDeleteOpen(false) }} onConfirm={() => remove()}
      ><OperationTargetSummary accounts={[{ id: folderAccountId ?? '' }]} /></ConfirmDialog>
    </></SaveErrorScope>
  )
}
