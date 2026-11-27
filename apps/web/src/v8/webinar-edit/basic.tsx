'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { useTestRecipients } from './use-test-recipients'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import { useAccount } from '@/contexts/account-context'
import { describeSaveFailure, webinarApi, type WebinarFolder } from '@/lib/api'
import { folderById, folderCreator } from '@/components/shared/folder-select'
import { BasicForm, BasicPreview, SLUG_PATTERN, type BasicValues } from './basic-form'
import type { EditContext, PaneSaveProps, WizardChrome } from './types'
import styles from './form.module.css'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { formatNumber } from '@/lib/format'

/*
 * ★V8 ウェビナーの編集 ①基本設定（並びは作る  と同じ）。
 * 版のある設定を先に保存し、競合したら基本情報は書き換えない。
 */

export default function BasicPane({ ctx, chrome, onDirtyChange, registerSave }: { ctx: EditContext; chrome: WizardChrome } & PaneSaveProps) {
  const saveErrors = useSaveFormErrors()
  const { webinar, editor, readOnly } = ctx
  const { accounts } = useAccount()
  const accountName = accounts.find((account) => account.id === webinar.accountId)?.displayName ?? accounts.find((account) => account.id === webinar.accountId)?.name ?? '公式アカウント'
  const fromServer = (): BasicValues => ({
    title: webinar.title,
    slug: webinar.slug,
    folderId: webinar.folderId ?? '',
    description: editor.publicDescription ?? '',
    deliveryKind: editor.deliveryKind,
  })
  const [values, setValues] = useState<BasicValues>(fromServer)
  const [saved, setSaved] = useState<BasicValues>(fromServer)
  const [folders, setFolders] = useState<WebinarFolder[]>([])
  const [folderState, setFolderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; slug?: string }>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testConfirm, setTestConfirm] = useState(false)
  const testRecipients = useTestRecipients(webinar.id, testConfirm)
  const [testResult, setTestResult] = useState('')
  const lock = useRef(false)
  const testLock = useRef(false)
  const aliveRef = useRef(true)
  const webinarIdRef = useRef(webinar.id)
  webinarIdRef.current = webinar.id
  const folderRequest = useRef(0)
  const version = useRef(editor.version)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      lock.current = false
      testLock.current = false
    }
  }, [])

  const coreDirty = values.title !== saved.title || values.slug !== saved.slug || values.folderId !== saved.folderId
  const editorDirty = values.description !== saved.description || values.deliveryKind !== saved.deliveryKind
  const dirty = coreDirty || editorDirty

  /* ほかの段で保存しても、この段の未保存の入力は捨てない。 */
  const current = useRef({ coreDirty, editorDirty })
  current.current = { coreDirty, editorDirty }
  useEffect(() => {
    if (current.current.coreDirty) return
    const next = { title: webinar.title, slug: webinar.slug, folderId: webinar.folderId ?? '' }
    setValues((prev) => ({ ...prev, ...next }))
    setSaved((prev) => ({ ...prev, ...next }))
  }, [webinar.title, webinar.slug, webinar.folderId])
  useEffect(() => {
    version.current = editor.version
    if (current.current.editorDirty) return
    const next = { description: editor.publicDescription ?? '', deliveryKind: editor.deliveryKind }
    setValues((prev) => ({ ...prev, ...next }))
    setSaved((prev) => ({ ...prev, ...next }))
  }, [editor.version, editor.publicDescription, editor.deliveryKind])

  const loadFolders = useCallback(async () => {
    const request = ++folderRequest.current
    if (!webinar.accountId) { setFolders([]); setFolderState('ready'); return }
    setFolderState('loading')
    try {
      const response = await webinarApi.folders(webinar.accountId)
      if (request !== folderRequest.current) return
      if (!response.success || !Array.isArray(response.data)) throw new Error('folders')
      setFolders(response.data)
      setFolderState('ready')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (request === folderRequest.current) { if (!fieldFailure) setFolderState('error') }
    }
  }, [webinar.accountId, saveErrors])
  useEffect(() => {
    void loadFolders()
    return () => { folderRequest.current += 1 }
  }, [loadFolders])
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const save = async (): Promise<boolean> => {
    if (lock.current || readOnly) return false
    const titleError = values.title.trim() ? undefined : 'ウェビナー名を入力してください。'
    const slugError = SLUG_PATTERN.test(values.slug.trim()) ? undefined : '公開ページのURLは半角の英小文字・数字・ハイフンで入力してください。'
    setFieldErrors({ title: titleError, slug: slugError })
    if (titleError || slugError) return false
    if (values.folderId !== saved.folderId && folderState !== 'ready') {
      setError('フォルダをもう一度読み込んでから保存してください。')
      return false
    }
    const targetId = webinar.id
    lock.current = true
    setSaving(true)
    setError('')
    try {
      /* 版のある設定を先に保存。競合したら基本情報は書き換えない。 */
      if (editorDirty) {
        const response = await webinarApi.saveEditor(targetId, {
          expectedVersion: version.current,
          publicDescription: values.description.trim(),
          deliveryKind: values.deliveryKind,
        })
        if (!aliveRef.current || webinarIdRef.current !== targetId) return false
        if ((response as { success?: boolean } | null)?.success === false || !response?.data || typeof response.data.version !== 'number') {
          throw new Error('save_editor_failed')
        }
        version.current = response.data.version
        setSaved((prev) => ({ ...prev, description: values.description, deliveryKind: values.deliveryKind }))
        ctx.onEditorChange(response.data)
      }
      if (coreDirty) {
        const response = await webinarApi.update(targetId, { title: values.title.trim(), slug: values.slug.trim(), folderId: values.folderId || null })
        if (!aliveRef.current || webinarIdRef.current !== targetId) return false
        if ((response as { success?: boolean } | null)?.success === false || !response?.data) {
          throw new Error('save_webinar_failed')
        }
        setSaved((prev) => ({ ...prev, title: values.title, slug: values.slug, folderId: values.folderId }))
        ctx.onWebinarSaved(response.data)
      }
      return true
    } catch (cause) {
      if (!aliveRef.current || webinarIdRef.current !== targetId) return false
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(withPermissionFailure(cause, describeSaveFailure(cause), 'store')) }
      return false
    } finally {
      lock.current = false
      if (aliveRef.current) setSaving(false)
    }
  }
  const latestSave = useRef(save)
  latestSave.current = save
  useEffect(() => {
    if (readOnly) { registerSave(null); return }
    registerSave(() => latestSave.current())
    return () => registerSave(null)
  }, [registerSave, readOnly])

  const runTest = async () => {
    if (testLock.current || testing || readOnly || lock.current || !testConfirm || !testRecipients.preview) return
    const targetId = webinar.id
    testLock.current = true
    setTesting(true)
    setError('')
    setTestResult('')
    try {
      if (dirty && !(await save())) return
      if (!aliveRef.current || webinarIdRef.current !== targetId || !testRecipients.isCurrent() || !testRecipients.preview) return
      const response = await webinarApi.testNotifications(targetId, testRecipients.preview.token, testRecipients.preview.confirmationId)
      if (!aliveRef.current || webinarIdRef.current !== targetId) return
      if ((response as { success?: boolean } | null)?.success === false || !response?.data || typeof response.data.sent !== 'number' || typeof response.data.failed !== 'number') {
        throw new Error('test_notifications_failed')
      }
      setTestResult(`通知テスト：成功 ${formatNumber(response.data.sent)} 件・失敗 ${formatNumber(response.data.failed)} 件`)
      setTestConfirm(false)
    } catch (cause) {
      if (!aliveRef.current || webinarIdRef.current !== targetId) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(withPermissionFailure(cause, describeSaveFailure(cause), 'store')) }
    } finally {
      testLock.current = false
      if (aliveRef.current) setTesting(false)
    }
  }

  const testConfirmDisabledReason = testRecipients.error
    ? 'テスト受信者を確認できません。設定を確かめて開き直してください。'
    : !testRecipients.preview
      ? 'テスト受信者を確認しています。'
      : testRecipients.preview.count === 0
        ? 'テスト受信者が登録されていません。設定から追加してください。'
        : undefined

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage dirty={false}
      boardId="j7PP04"
      title={chrome.title}
      actions={chrome.actions}
      identity={chrome.identity}
      steps={chrome.steps}
      help="管理名と公開ページの基本、開催形式を決めます。保存しても、公開中の内容は「確認」で公開し直すまで変わりません。"
      footerActions={chrome.footerActions}
      status={chrome.status}
      preview={<BasicPreview
        title={values.title}
        description={values.description}
        accountName={accountName}
        action={readOnly ? null : <div className={styles.previewActions}><Button disabled={saving || testing} onClick={() => { setError(''); setTestConfirm(true) }}>テストを送る</Button></div>}
      />}
    >
      {readOnly ? <ReadOnlyNotice >閲覧のみで見ています。変えるときはオーナーか管理者に頼んでください。</ReadOnlyNotice> : null}
      <BasicForm
        idPrefix="webinar-basic"
        values={values}
        onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
        folders={folders}
        folderState={folderState}
        onReloadFolders={() => void loadFolders()}
        onCreateFolder={!readOnly && webinar.accountId
          ? folderCreator((name, color) => webinarApi.createFolder(webinar.accountId ?? '', { name, color }), folderById, (created) => setFolders((current) => [...current, created]))
          : undefined}
        audienceLabel={editor.viewingCondition.label || '申込者向け'}
        fieldErrors={fieldErrors}
        disabled={saving || testing}
        readOnly={readOnly}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {testResult ? <p className={styles.previewNote} role="status">{testResult}</p> : null}
      <ConfirmDialog
        open={testConfirm}
        title="通知をテスト送信しますか？"
        description="登録したテスト受信者へ、有効な通知の本文をLINEで送ります。申込者全員には届きません。"
        confirmLabel="テストを送る"
        confirmDisabled={!testRecipients.preview || testRecipients.preview.count === 0}
        confirmDisabledReason={testConfirmDisabledReason}
        busy={saving || testing}
        error={error || undefined}
        onCancel={() => { if (!saving && !testing) setTestConfirm(false) }}
        onConfirm={() => runTest()}
      >
        <OperationTargetSummary accounts={[{ id: webinar.accountId ?? '' }]} />
        <p>{testRecipients.preview ? `テスト受信者 ${testRecipients.preview.count} 人：${testRecipients.preview.recipients.map(person => person.displayName || '名前未設定').join('、')}` : testRecipients.error ? 'テスト受信者を確認できません。設定を確かめて開き直してください。' : 'テスト受信者を確認しています。'}</p>
        {dirty ? <p className={styles.cardNote}>変えた基本設定を保存してから送ります。</p> : null}
      </ConfirmDialog>
    </CreatePage></SaveErrorScope>
  )
}
