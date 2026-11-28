'use client'

import { safeNavigationPath } from '@/lib/safe-navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import type { FriendField, Folder } from '@line-crm/shared'
import { api, describeSaveFailure } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import ListState from '@/components/shared/list-state'
import { notifyToast } from '@/components/shared/toast'
import { folderById, folderCreator } from '@/components/shared/folder-select'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import FieldEditor, { type FieldEditorValues } from './field-editor'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8「友だち情報欄を作る」（Pencil ）の入口。
 *
 * 読み込み・重複確認・冪等キー・保存の動きは今の入口（src/v8/tags/field-new.tsx）と同じ。
 * 中身は src/v8 の FieldEditor。受け付ける URL：`/tags/fields/new`・`?back=<戻り先>`。
 */

export default function FieldNew() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const params = useSearchParams()
  const back = safeNavigationPath(params.get('back'))
  const { selectedAccountId } = useAccount()

  const [folders, setFolders] = useState<Folder[]>([])
  // その場でフォルダを作れるのは、左の列の「フォルダを追加」と同じ人（閲覧のみは作れない）。
  const staffRole = useStaffRole()
  const canCreateFolder = canManageRole(staffRole)
  const [foldersState, setFoldersState] = useState<'loading' | 'ready' | 'error'>('loading')
  /* R514: 既存項目が取れていないのに空一覧として扱わない。 */
  const [existing, setExisting] = useState<FriendField[]>([])
  const [existingState, setExistingState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reloading, setReloading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const context = useRef({ account: selectedAccountId, generation: 0 })
  if (context.current.account !== selectedAccountId) context.current = { account: selectedAccountId, generation: context.current.generation + 1 }
  const [existingGeneration, setExistingGeneration] = useState<number | null>(null)
  const [foldersGeneration, setFoldersGeneration] = useState<number | null>(null)
  const existingRequest = useRef(0)
  const folderRequest = useRef(0)
  useEffect(() => { setSaving(false); setReloading(false); setError('') }, [selectedAccountId])

  const loadFolders = useCallback(async () => {
    if (context.current.account !== selectedAccountId) return
    const generation = context.current.generation
    const request = ++folderRequest.current
    setFoldersState('loading'); setReloading(true)
    try {
      const res = await api.folders.list('friend_field')
      if (generation !== context.current.generation || request !== folderRequest.current) return
      if (!res.success) throw new Error(res.error)
      if (!Array.isArray(res.data)) throw new Error('フォルダの応答を確認できません')
      setFolders(res.data); setFoldersGeneration(generation); setFoldersState('ready')
    } catch (failure) {
      if (generation !== context.current.generation || request !== folderRequest.current) return
      if (!saveErrors.capture(failure)) { setFoldersGeneration(generation); setFoldersState('error') }
    } finally {
      if (generation === context.current.generation && request === folderRequest.current) setReloading(false)
    }
  }, [selectedAccountId, saveErrors])

  const loadExisting = useCallback(async () => {
    const account = selectedAccountId
    if (!account || context.current.account !== account) return
    const generation = context.current.generation
    const request = ++existingRequest.current
    setExistingState('loading'); setReloading(true)
    try {
      const res = await api.friendFields.list(account)
      if (generation !== context.current.generation || request !== existingRequest.current) return
      if (!res.success) throw new Error(res.error)
      if (!Array.isArray(res.data)) throw new Error('既存項目の応答を確認できません')
      setExisting(res.data); setExistingGeneration(generation); setExistingState('ready')
    } catch (failure) {
      if (generation !== context.current.generation || request !== existingRequest.current) return
      if (!saveErrors.capture(failure)) { setExistingGeneration(generation); setExistingState('error') }
    } finally {
      if (generation === context.current.generation && request === existingRequest.current) setReloading(false)
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => { void loadFolders() }, [loadFolders])
  useEffect(() => { void loadExisting() }, [loadExisting])

  const save = async (values: FieldEditorValues, requestKey: string) => {
    if (saving || context.current.account !== selectedAccountId) return
    if (!selectedAccountId) return setError('LINE公式アカウントを選んでください')
    const generation = context.current.generation
    if (existingGeneration !== generation || existingState !== 'ready') return setError('既存の項目を読み直してください。')
    if (values.folderId && (foldersGeneration !== generation || foldersState !== 'ready' || !folders.some(folder => folder.id === values.folderId))) return setError('所属フォルダを確認して選び直してください。')
    setSaving(true)
    setError('')
    try {
      const res = await api.friendFields.create(selectedAccountId, {
        name: values.name,
        fieldKey: values.fieldKey,
        type: values.type,
        folderId: values.folderId || null,
        options: values.options,
        // R139: 複数選択は選択肢名の配列で渡す。文字列では422になる。
        defaultValue: values.defaultValue,
        isPersonal: values.isPersonal,
        isStarred: values.isStarred,
        ecIsMaster: values.ecIsMaster,
        ecFieldPath: values.ecIsMaster ? values.ecFieldPath : null,
        // R515: 同じ作成のやり直しは同じ要求キーで送り、二重に作らない。
      }, requestKey)
      if (generation !== context.current.generation) {
        if (res.success) notifyToast(`前のアカウントで「${values.name.trim()}」を作りました`)
        return
      }
      if (!res.success) throw new Error(res.error)
      notifyToast(`「${values.name.trim()}」を作りました`)
      router.push(back ?? `/tags?tab=fields&highlight=${res.data.id}`)
    } catch (reason) {
      if (generation !== context.current.generation) return
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)

      setError(withPermissionFailure(reason, describeSaveFailure(reason), 'store')) }
    } finally {
      if (generation === context.current.generation) setSaving(false)
    }
  }

  if (staffRole !== null && !canManageRole(staffRole)) return <SaveErrorScope errors={saveErrors}><ReadOnlyNotice>閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice></SaveErrorScope>

  const generation = context.current.generation
  return (
    <SaveErrorScope errors={saveErrors}><FieldEditor
      mode="create"
      folders={foldersGeneration === generation ? folders : []}
      foldersState={foldersGeneration === generation ? foldersState : 'loading'}
      foldersReloading={reloading}
      onRetryFolders={() => void loadFolders()}
      onCreateFolder={canCreateFolder
        ? folderCreator((name, color) => {
          if (context.current.generation !== generation) throw new Error('アカウントが変わりました。開き直してください。')
          return api.folders.create({ kind: 'friend_field', name, color, accountId: selectedAccountId })
        }, folderById, created => { if (context.current.generation === generation) setFolders(current => [...current, created]) })
        : undefined}
      siblings={existingGeneration === generation ? existing : []}
      siblingsReady={existingGeneration === generation && existingState === 'ready'}
      saving={saving}
      error={error}
      backHref={back ?? '/tags?tab=fields'}
      /* 既存項目の取得失敗は隠さず、その場で再試行する。入力は残す（R514）。 */
      notices={existingGeneration === generation && existingState === 'error' ? (
        <ListState
          kind="error"
          title="既存の項目を読み込めませんでした"
          description="重複を確認できないため、読み直すまで保存できません。入力内容はそのままです。"
          onRetry={() => void loadExisting()}
          retrying={reloading}
        />
      ) : null}
      onCancel={() => router.push(back ?? '/tags?tab=fields')}
      onSubmit={(values, requestKey) => void save(values, requestKey)}
    /></SaveErrorScope>
  )
}
