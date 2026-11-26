'use client'
import { createPageReturnHref } from '@/components/shared/create-page'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowRight } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import { notifySaved } from '@/components/shared/toast'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole } from '@/lib/staff-role'
import { describeSaveFailure, webinarApi, type WebinarFolder } from '@/lib/api'
import { BackLink, WizardSteps } from './chrome'
import { folderById, folderCreator } from '@/components/shared/folder-select'
import { BasicForm, BasicPreview, SLUG_PATTERN, type BasicValues } from './basic-form'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8 ウェビナーを作る ①基本設定（Pencil 。入口 app/webinars/new/page.tsx。この画面に固定）。
 * 下書きとして作り、「動画の設定へ」で編集の ②動画へ進む。
 * 口・確かめ・離れる前の確かめは BEHAVIOR.md に記録。
 */

const FOLDERS_BLOCKED = 'フォルダを読み込めていないため、下書きを保存できません。フォルダをもう一度読み込んでください。'
const TITLE_EMPTY = 'ウェビナー名を入力してください'
const SLUG_BAD = '公開ページのURLは、半角の英小文字・数字・-（ハイフン）だけで入力してください'

function titleProblem(value: string): string | undefined {
  return value.trim() ? undefined : TITLE_EMPTY
}
/** 空欄は自動で付けるので問題なし。 */
function slugProblem(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase()
  return trimmed && !SLUG_PATTERN.test(trimmed) ? SLUG_BAD : undefined
}

export default function WebinarNewV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <NewInner />
    </Suspense>
  )
}

function NewInner() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('ウェビナー')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const router = useRouter()
  const { selectedAccountId, selectedAccount } = useAccount()
  const role = useStaffRole()
  const readOnly = !useFeatureAccess('webinars')
  const [values, setValues] = useState<BasicValues>({ title: '', slug: '', folderId: '', description: '', deliveryKind: 'on_demand' })
  const [folders, setFolders] = useState<WebinarFolder[]>([])
  const [folderState, setFolderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; slug?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<false | 'list' | 'video'>(false)
  const savingRef = useRef(false)
  const folderRequest = useRef(0)
  const saveScope = useRef({ accountId: selectedAccountId, generation: 0, mounted: true })
  if (saveScope.current.accountId !== selectedAccountId) { saveScope.current.accountId = selectedAccountId; saveScope.current.generation++ }
  useEffect(() => { saveScope.current.mounted = true; return () => { saveScope.current.mounted = false } }, [])
  useEffect(() => { savingRef.current = false; setSaving(false) }, [selectedAccountId])

  const dirty = values.title.trim() !== '' || values.slug.trim() !== '' || values.description.trim() !== '' || values.deliveryKind !== 'on_demand' || values.folderId !== ''
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving !== false })

  const loadFolders = useCallback(async () => {
    if (!selectedAccountId) { setFolders([]); setValues((prev) => ({ ...prev, folderId: '' })); setFolderState('ready'); return }
    const request = ++folderRequest.current
    setFolderState('loading')
    try {
      const response = await webinarApi.folders(selectedAccountId)
      if (request !== folderRequest.current) return
      if (!response.success || !Array.isArray(response.data)) throw new Error('folders_not_loaded')
      setFolders(response.data)
      setFolderState('ready')
      setError((previous) => (previous === FOLDERS_BLOCKED ? null : previous))
    } catch (saveFailure) {
      if (request !== folderRequest.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setFolders([])
      { if (!fieldFailure)
      setFolderState('error')
    }
  }
  }, [selectedAccountId, saveErrors])
  useEffect(() => {
    void loadFolders();

    return () => { folderRequest.current += 1 }
  }, [loadFolders])

  const save = async (next: 'list' | 'video') => {
    if (savingRef.current || readOnly) return
    if (!selectedAccountId) { setError('上のバーでLINE公式アカウントを選んでください'); return }
    if (folderState === 'error') { setError(FOLDERS_BLOCKED); return }
    const problems = { title: titleProblem(values.title), slug: slugProblem(values.slug) }
    if (problems.title || problems.slug) {
      setFieldErrors(problems)
      setError(problems.title ?? problems.slug ?? null)
      return
    }
    const generation = saveScope.current.generation
    const current = () => saveScope.current.mounted && saveScope.current.generation === generation
    savingRef.current = true
    setSaving(next)
    setError(null)
    setFieldErrors({})
    const slug = values.slug.trim().toLowerCase()
    try {
      const created = await webinarApi.create({
        accountId: selectedAccountId,
        title: values.title.trim(),
        status: 'draft',
        slug: slug || `webinar-${Date.now()}`,
        videoPrefix: null,
        durationSeconds: 120 * 60,
        schedule: [],
        cta: null,
        folderId: values.folderId || null,
        deliveryKind: values.deliveryKind === 'scheduled' ? 'scheduled' : 'on_demand',
        viewingCondition: { kind: 'registered', label: '申込者向け' },
        publicDescription: values.description.trim() || undefined,
      })
      if (!current()) return
      if (('success' in created && created.success === false) || !created.data?.id) throw new Error('save failed')
      notifySaved('ウェビナーの下書きを作成しました。')
      router.push(next === 'video' ? `/webinars/edit?id=${created.data.id}&pane=video` : createPageReturnHref('/webinars', created.data.id))
    } catch (cause) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(withPermissionFailure(cause, describeSaveFailure(cause), 'store')) }
      savingRef.current = false
      setSaving(false)
    }
  }

  const blocked = saving !== false || folderState !== 'ready'
  const blockedReason = folderState === 'error' ? 'フォルダを読み込めていないため保存できません' : undefined
  const accountName = selectedAccount?.displayName ?? selectedAccount?.name ?? '公式アカウント'

  return (
    <SaveErrorScope errors={saveErrors}><>
      <CreatePage
        boardId="j7PP04"
        readOnly={readOnly}
        notice={readOnly ? <ReadOnlyNotice>閲覧のみで見ています。ウェビナーを作るのはオーナーか管理者です。</ReadOnlyNotice> : undefined}
        title="ウェビナーを作る"
        identity={<BackLink />}
        steps={<WizardSteps current="basic" stateOf={(key) => (key === 'basic' ? 'current' : 'todo')} />}
        help="管理名と公開ページの基本、開催形式を決めます。保存しても、まだ誰にも公開されません。"
        status="下書き（まだ誰にも公開されません）"
        footerActions={<>
          <Button href="/webinars">キャンセル</Button>
          {readOnly ? null : <>
            <Button disabled={blocked} title={blockedReason} busy={saving === 'list'} onClick={() => save('list')}>下書きを保存</Button>
            <Button variant="primary" disabled={blocked} title={blockedReason} busy={saving === 'video'} onClick={() => save('video')}>動画の設定へ<ArrowRight size={16} aria-hidden="true" /></Button>
          </>}
        </>}
        preview={<BasicPreview title={values.title} description={values.description} accountName={accountName} />} dirty={false}
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {/* 閲覧のみと分かったら、押せない入力の欄は置かず閲覧のみの帯だけを出す（作る画面なので見せる中身は無い。2026-10-06 オーナー決定）。 */}
        {readOnly ? null : <BasicForm
          idPrefix="webinar-new"
          values={values}
          onChange={(patch) => {
            setValues((prev) => ({ ...prev, ...patch }))
            if (patch.title !== undefined && fieldErrors.title !== undefined) setFieldErrors((prev) => ({ ...prev, title: titleProblem(patch.title ?? '') }))
            if (patch.slug !== undefined && fieldErrors.slug !== undefined) setFieldErrors((prev) => ({ ...prev, slug: slugProblem(patch.slug ?? '') }))
          }}
          onBlurTitle={() => setFieldErrors((prev) => ({ ...prev, title: titleProblem(values.title) }))}
          onBlurSlug={() => setFieldErrors((prev) => ({ ...prev, slug: slugProblem(values.slug) }))}
          folders={folders}
          folderState={folderState}
          onReloadFolders={() => void loadFolders()}
          onCreateFolder={selectedAccountId
            ? folderCreator((name, color) => webinarApi.createFolder(selectedAccountId, { name, color }), folderById, (created) => setFolders((current) => [...current, created]))
            : undefined}
          audienceLabel="申込者向け"
          fieldErrors={fieldErrors}
          disabled={saving !== false}
        />}
      </CreatePage>
      <UnsavedLeaveDialog open={leaveTarget !== null} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}
