'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowRight, Check, ClipboardList, Link2, Plus, Workflow } from 'lucide-react'
import type { TagGroup } from '@line-crm/shared'
import { api, type TagDefinition } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import TagPill from '@/components/shared/tag-pill'
import Notice from '@/components/shared/notice'
import FolderSelect, { folderCreateResult, type FolderDraftGuard } from '@/components/shared/folder-select'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import Toggle from '@/components/shared/toggle'
import { TextField } from '@/components/shared/text-field'
import ListState from '@/components/shared/list-state'
import { notifyToast } from '@/components/shared/toast'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { DuplicateNameNote, findDuplicateNames } from '@/components/friend-fields/attribute-kind-guide'
import { definitionsForSave, linkedActionFromDefinition } from '@/components/friend-fields/tag-editor-v4'
import styles from './create.module.css'
import { tagNameProblem } from './tag-name'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import { Field } from '@/components/shared/form-controls'
import Card, { CardHeader } from '@/components/shared/card'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8「タグを作る」（Pencil ）。
 *
 * 型（CreatePage）に、段「基本」（タグ名・所属フォルダ・友だち一覧に出す）と段「付け方（どこで付けるか）」、
 * 右の列「このあと」、下の帯（キャンセル・保存して続けて作る・タグを作る）を渡す。
 * 読み込み・複製元・保存の口は今の作る画面（src/v8/tags/create.tsx）と同じ。
 * 違うのは見せ方：タグ連動（付いたときの動き）は絵のとおり「作ったあとの編集で足す」。
 * 複製して作る（?copy=）ときは、複製元の連動の中身は画面に出さずにそのまま写して作る。
 */

export { tagNameProblem } from './tag-name'

export default function TagCreateV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <TagCreate />
    </Suspense>
  )
}

function TagCreate() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('タグを作る')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'タグ', href: '/tags' }])
  const router = useRouter()
  const params = useSearchParams()
  const { selectedAccountId } = useAccount()
  const staffRole = useStaffRole()
  const canEditFolders = canManageRole(staffRole)
  const copyId = params.get('copy') ?? ''
  /* 直前に作ったタグの名前。URL に残すので再読み込みでも消えない。 */
  const createdName = params.get('created') ?? ''

  const [groups, setGroups] = useState<TagGroup[]>([])
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [foldersReloadKey, setFoldersReloadKey] = useState(0)
  const [copySource, setCopySource] = useState<TagDefinition | null>(null)
  const [copyError, setCopyError] = useState('')
  const [loading, setLoading] = useState(Boolean(copyId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [siblings, setSiblings] = useState<Array<{ id: string; name: string }>>([])
  const [siblingsState, setSiblingsState] = useState<{ account: string; status: 'loading' | 'ready' | 'error' } | null>(null)
  const [siblingsRetry, setSiblingsRetry] = useState(0)

  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const [groupId, setGroupId] = useState('')
  const [isStarred, setIsStarred] = useState(false)
  const folderDraftGuard = useRef<FolderDraftGuard | null>(null)
  const [folderCreating, setFolderCreating] = useState(false)
  const dirty = Boolean(name.trim() || groupId || isStarred)
  const guard = useUnsavedGuard({ dirty, busy: saving })

  useEffect(() => {
    let cancelled = false
    if (!selectedAccountId) {
      setGroups([])
      setFoldersFailed(false)
      return
    }
    setFoldersFailed(false)
    void api.tagGroups.list(selectedAccountId).then((folders) => {
      if (cancelled) return
      if (folders.success) setGroups(folders.data.filter((group) => group.accountId === selectedAccountId))
      else setFoldersFailed(true)
    }).catch(() => { if (!cancelled) setFoldersFailed(true) })
    return () => { cancelled = true }
  }, [selectedAccountId, foldersReloadKey])

  /* 同じ名前のタグがすでにあるとき、保存する前に知らせる。 */
  useEffect(() => {
    if (!selectedAccountId) return
    let cancelled = false
    setSiblings([])
    setSiblingsState({ account: selectedAccountId, status: 'loading' })
    void api.tags.list({ accountId: selectedAccountId }).then(res => {
      if (cancelled) return
      if (!res.success) throw new Error('tags unavailable')
      setSiblings(res.data.map(item => ({ id: item.id, name: item.name })))
      setSiblingsState({ account: selectedAccountId, status: 'ready' })
    }).catch(() => { if (!cancelled) setSiblingsState({ account: selectedAccountId, status: 'error' }) })
    return () => { cancelled = true }
  }, [selectedAccountId, siblingsRetry])
  const visibleSiblings = siblingsState?.account === selectedAccountId && siblingsState.status === 'ready' ? siblings : []
  const duplicates = useMemo(() => findDuplicateNames(visibleSiblings, name, null), [visibleSiblings, name])

  useEffect(() => {
    let cancelled = false
    setCopySource(null)
    setCopyError('')
    if (!copyId || !selectedAccountId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void api.tags.definition(copyId, selectedAccountId).then((definition) => {
      if (cancelled) return
      if (definition?.success) {
        setCopySource(definition.data)
        setName(`${definition.data.tag.name} のコピー`)
        setGroupId(definition.data.tag.groupId ?? '')
        setIsStarred(definition.data.tag.isStarred ?? false)
      } else setCopyError('複製元のタグを読み込めませんでした')
    }).catch(() => {
      if (!cancelled) setCopyError('複製元のタグを読み込めませんでした')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [copyId, selectedAccountId])

  const save = async (andAnother: boolean) => {
    if (saving || !canManageRole(staffRole)) return
    const problem = tagNameProblem(name)
    if (problem) {
      setNameError(problem)
      setError('')
      nameRef.current?.focus()
      nameRef.current?.scrollIntoView({ block: 'center' })
      return
    }
    setNameError('')
    if (!selectedAccountId) {
      setError('LINE公式アカウントを選んでください')
      return
    }
    setSaving(true)
    setError('')
    const trimmed = name.trim()
    /* 複製のときは連動（マイル・動き）も写す。ふつうに作るときは連動なし（作ったあとの編集で足す）。 */
    const source = copySource?.tag
    const linked = Boolean(source?.linkedEnabled)
    try {
      const created = await api.tags.createDefinition(selectedAccountId, {
        name: trimmed,
        groupId: groupId || null,
        isStarred,
        manualAssignmentAllowed: true,
        reapplyPolicy: source?.reapplyPolicy ?? 'first_only',
        linkedEnabled: linked,
        mileage: linked
          ? { self: source?.mileageReward ?? 0, referrer: source?.referralMileageReward ?? 0, multiplier: source?.mileageMultiplierBps ?? null, priority: source?.mileageMultiplierPriority ?? 0 }
          : { self: 0, referrer: 0, multiplier: null, priority: 0 },
        actions: linked && copySource
          ? definitionsForSave((copySource.automation?.actions ?? []).map((action) => linkedActionFromDefinition(
            action,
            copySource.tag.linkedActions?.find((saved) => saved.id === action.id),
          )))
          : [],
      })
      if (!created.success) throw new Error(created.error)
      guard.disarm()
      notifyToast(`「${trimmed}」を作りました`)
      if (andAnother) {
        const next = new URLSearchParams()
        if (copyId) next.set('copy', copyId)
        next.set('created', trimmed)
        setName('')
        setGroupId('')
        setIsStarred(false)
        router.push(`/tags/new?${next}`)
      } else {
        router.push(`/tags?highlight=${created.data.tag.id}`)
      }
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)

      setError(describeApiFailure(reason, '保存')) }
    } finally {
      setSaving(false)
    }
  }

  const requestSave = (andAnother: boolean) => {
    const submit = () => { void save(andAnother) }
    if (folderDraftGuard.current) folderDraftGuard.current(submit)
    else submit()
  }

  if (loading) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="複製元を読み込んでいます…" /></SaveErrorScope>

  if (!canManageRole(staffRole)) return <CreatePage boardId="d9xoI" title="タグを作る" help="友だちを分類するタグを作ります。作ったあとで、タグを付ける条件や動きを決められます。" readOnly footerActions={<Button onClick={() => router.push('/tags')}>一覧へ戻る</Button>}>{null}</CreatePage>

  const back = <></>
  const groupFolders = groups.map((group) => ({ value: group.id, label: group.name, color: group.color }))
  // その場でタグのフォルダを作る（dLffh）。左の列の「フォルダを追加」と同じ受け口・同じ権限。
  const createGroup = async (name: string, color: string | null) => {
    const response = await api.tagGroups.create({ name, color, accountId: selectedAccountId })
    const created = folderCreateResult(response, (group: TagGroup) => ({ value: group.id, label: group.name, color: group.color }))
    if (response.success) setGroups((current) => [...current, response.data])
    return created
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      <CreatePage
        boardId="d9xoI"
        title="タグを作る"
        help="友だちを分類するタグを作ります。作ったあとで、タグを付ける条件や動きを決められます。"
        identity={back}
        previewLabel="設定内容を見る"
        previewTitle="タグの設定"
        previewSurface="plain"
        preview={(
          <Card variant="aside" gap="normal">
            <h2 className={styles.asideTitle}>できあがるタグ</h2>
            <TagPill name={name || 'タグ名'} color={(() => { const group = groups.find((group) => group.id === groupId); return group ? folderDisplayColor(group) : null })()} />
            <h2 className={styles.asideTitle}>このあと</h2>
            <p className={styles.asideText}>作ると、すぐに友だちへ付けられます。タグ連動（付いたときの動き）は作ったあとの編集で足します。</p>
          </Card>
        )}
        footerActions={<>
          <Button type="button" onClick={() => requestUnsavedAction(() => router.push('/tags'))} disabled={saving || folderCreating} disabledReason={folderCreating ? 'フォルダを作成中です。' : saving ? 'タグを作っています。終わるまでお待ちください。' : undefined}>キャンセル</Button>
          <Button type="button" onClick={() => requestSave(true)} disabled={saving} busy={saving || folderCreating} busyLabel={folderCreating ? "フォルダ作成中" : "処理中…"}><Plus size={16} aria-hidden="true" />保存して続けて作る</Button>
          <Button type="button" variant="primary" onClick={() => requestSave(false)} busy={saving || folderCreating} busyLabel={folderCreating ? "フォルダ作成中" : "作っています…"}><Check size={16} aria-hidden="true" />タグを作る</Button>
        </>} dirty={false}
      >
        {createdName ? <Notice tone="success" message={`「${createdName}」を作成しました。続けて新しいタグを作れます。`} /> : null}
        {error || copyError ? <Notice tone="danger" message={error || copyError} /> : null}

        <Card variant="form" gap="normal" aria-labelledby="tag-new-basic">
          <CardHeader size="stacked" title="基本" titleId="tag-new-basic" />
          <Field label="タグ名" required><SaveErrorField names={["name"]}><TextField
              ref={nameRef}
              aria-label="タグ名"
              invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'tag-name-error' : undefined}
              value={name}
              maxLength={80}
              placeholder="例：定期購入者"
              aria-required="true"
              onChange={(event) => { setName(event.target.value); setNameError('') }}
            /></SaveErrorField>
{nameError ? <p id="tag-name-error" className={styles.fieldError} role="alert">{nameError}</p> : null}
<DuplicateNameNote duplicates={duplicates} kindLabel="タグ" />
{siblingsState?.account === selectedAccountId && siblingsState.status === 'error' ? <Notice tone="warn">同じ名前のタグを確認できませんでした。 <Button variant="text" size="inline" onClick={() => setSiblingsRetry(value => value + 1)}>重複を確認し直す</Button></Notice> : null}</Field>
          <Field label="所属フォルダ">
            <span className={styles.selectBox}>
              <SaveErrorField names={["groupId","group_id"]}><FolderSelect draftGuardRef={folderDraftGuard} onCreatingChange={setFolderCreating} size="full" aria-label="所属フォルダ" value={groupId} onChange={setGroupId} folders={groupFolders} onCreate={canEditFolders && selectedAccountId ? createGroup : undefined} /></SaveErrorField>
            </span>
            {foldersFailed ? (
              <div className={styles.inlineRetry}>
                <Notice tone="danger" className={styles.fieldErrorNoticePlacement} >フォルダを読み込めませんでした。未分類のまま作れます。</Notice>
                <Button type="button" variant="text" onClick={() => setFoldersReloadKey((key) => key + 1)}>フォルダを読み直す</Button>
              </div>
            ) : null}
          </Field>
          <div className={styles.switchRow}>
            <span className={styles.switchText}>
              <span className={styles.switchTitle}>友だち一覧に出す</span>
              <span className={styles.switchNote}>オンにすると、友だち一覧の名前の下にこのタグが出ます</span>
            </span>
            <SaveErrorField names={["isStarred","is_starred"]}><Toggle checked={isStarred} onChange={setIsStarred} label="友だち一覧に出す" /></SaveErrorField>
          </div>
        </Card>

        <Card variant="form" gap="normal" aria-labelledby="tag-new-ways">
          <CardHeader size="stacked" title="付け方（どこで付けるか）" titleId="tag-new-ways" meta="作ったあとに、回答フォーム・オートメーション・タグ連動からこのタグを付けられます" />
          <div className={styles.waysRow}>
            <Link href="/form-submissions" className={styles.wayLink} data-pressable-card><Card surface="muted" padding="compact" layout="vertical" gap="tight">
              <span className={styles.wayIconRow}><ClipboardList className={styles.wayIcon} aria-hidden="true" /><ArrowRight data-link-indicator size={16} aria-hidden="true" /></span>
              <span className={styles.wayTitle}>回答フォーム</span>
              <span className={styles.wayNote}>答えに合わせて付ける</span>
            </Card></Link>
            <Link href="/automations" className={styles.wayLink} data-pressable-card><Card surface="muted" padding="compact" layout="vertical" gap="tight">
              <span className={styles.wayIconRow}><Workflow className={styles.wayIcon} aria-hidden="true" /><ArrowRight data-link-indicator size={16} aria-hidden="true" /></span>
              <span className={styles.wayTitle}>オートメーション</span>
              <span className={styles.wayNote}>決まりで自動に付ける</span>
            </Card></Link>
            <Card surface="muted" padding="compact" layout="vertical" gap="tight">
              <Link2 className={styles.wayIcon} aria-hidden="true" />
              <span className={styles.wayTitle}>タグ連動</span>
              <span className={styles.wayNote}>付いたら次の動きをする</span>
            </Card>
          </div>
        </Card>
      </CreatePage>
      <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="入力したタグ" onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    </></SaveErrorScope>
  )
}
