'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { requiredText } from '@/lib/form-requirement'
const projectNameRequirement = requiredText('プロジェクト名を入力してください')

import { Archive, Plus, Upload } from 'lucide-react'
import { useContext, useEffect, useId, useLayoutEffect, useState } from 'react'
import Button from '@/components/shared/button'
import MediaSlot from '@/components/shared/media-slot'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { TextArea, TextField } from '@/components/shared/text-field'
import { api } from '@/lib/api'
import { readFileAsBase64, type BannerProject } from '@/lib/hq-banners'
import BannerDialogFrame from './frame'
import styles from './dialogs.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'

/*
 * ★V8 バナー生成の小さな窓。共通の窓（Dialog）に絵の幅・上からの位置を渡し、中身だけを絵どおりに組む。
 * -  プロジェクトを作る（名前は必須・100文字まで、説明は任意・500文字まで）
 * -  画像を取り込む（入れるプロジェクトを選び、PNG・JPEG・WebP、10MB まで）
 * -  アーカイブの確認・ 一覧から外す確認（プロジェクトの中で使う）
 */

/** 取り込める画像（API と同じ）。 */
export const BANNER_UPLOAD_ACCEPT = ['image/png', 'image/jpeg', 'image/webp']
export const BANNER_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const uploadProjectRequirement = requiredText('入れるプロジェクトを選んでください。')

/** 選んだファイルを手元で確かめる。だめなら理由、よければ null。 */
export function uploadRefusal(file: File): string | null {
  if (!BANNER_UPLOAD_ACCEPT.includes(file.type)) return '画像は PNG・JPEG・WebP のみ取り込めます'
  if (file.size > BANNER_UPLOAD_MAX_BYTES) return 'ファイルが大きすぎます（上限 10MB）'
  return null
}

export function CreateProjectDialogV8({ open, project = null, busy, error, onSubmit, onCancel, onDraftChange, onRequestClose }: {
  open: boolean
  /** 名前と説明を変えるとき。作るときは渡さない。 */
  project?: BannerProject | null
  busy?: boolean
  error?: string
  onSubmit: (input: { name: string; description: string }) => void
  onCancel: () => void
  onDraftChange?: (dirty: boolean) => void
  onRequestClose?: () => void
}) {
  const uid = useId()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [localError, setLocalError] = useState('')
  const depth = useContext(OverlayDepthContext)
  const dirty = name !== (project?.name ?? '') || description !== (project?.description ?? '')
  const guard = useUnsavedGuard({ dirty: !onDraftChange && open && (dirty || Boolean(busy)), busy: open && busy, onDiscard: onCancel })
  const close = () => onRequestClose ? onRequestClose() : guard.guarded(() => { if (!dirty) onCancel() })
  useLayoutEffect(() => { onDraftChange?.(open && dirty) }, [open, dirty, onDraftChange])

  useEffect(() => { if (!open) guard.cancelLeave() }, [open, guard.cancelLeave])

  useEffect(() => {
    if (!open) return
    setName(project?.name ?? '')
    setDescription(project?.description ?? '')
    setLocalError('')
  }, [open, project])

  const submit = () => {
    const trimmed = name.trim()
    if (projectNameRequirement.check(name)) return setLocalError(projectNameRequirement.check(name)!)
    if (trimmed.length > 100) return setLocalError('プロジェクト名は100文字以内で入力してください')
    setLocalError('')
    onSubmit({ name: trimmed, description: description.trim() })
  }

  return (<>
    <BannerDialogFrame
      open={open}
      kind="create" contentLayout="form"
      title={project ? '名前と説明を変える' : 'プロジェクトを作る'}
      description={project ? undefined : '案件やキャンペーンごとに作ります。画像はプロジェクトの中で生成・取り込みします。'}
      busy={busy}
      error={localError || error}
      onClose={close}
      designNode="W7Z57"
      actions={(
          <>
            <Button onClick={close} disabled={busy}>キャンセル</Button>
            {/* W7Z57: 名前が空のまま作らせない。 */}
            <Button widthReserve="idle" variant="primary" onClick={submit} disabled={busy || Boolean(projectNameRequirement.check(name))} title={projectNameRequirement.check(name) ?? undefined} busy={busy} busyLabel="保存しています…">
              {project ? '変更を保存' : <><Plus aria-hidden="true" className={styles.icon} />作って開く</>}
            </Button>
        </>
      )}
    >
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); submit() }}>
          <div className={styles.field}><Field label="プロジェクト名" htmlFor={`${uid}-name`} requirement={projectNameRequirement} error={localError || undefined}><SaveErrorField names={["name"]}><TextField
              id={`${uid}-name`}
              value={name}
              maxLength={100}
              autoFocus
              disabled={busy}
              placeholder="例：春の感謝祭 2周年"
              onChange={(event) => setName(event.target.value)}
              className={styles.full}
            /></SaveErrorField></Field></div>
          <div className={styles.field}>
            <Field label="説明" htmlFor={`${uid}-description`}><SaveErrorField names={["description"]}><TextArea
              id={`${uid}-description`}
              rows={2}
              value={description}
              maxLength={500}
              disabled={busy}
              placeholder="例：餃子・生ビールのキャンペーン告知"
              onChange={(event) => setDescription(event.target.value)}
              className={`${styles.full} ${styles.textarea}`}
            /></SaveErrorField></Field>
          </div>
        </form>
    </BannerDialogFrame>
    <OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={open && guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={busy} /></OverlayDepthContext.Provider>
  </>)
}

/**
 * 画像を取り込む。画像はプロジェクトに属するので、先に入れる先を選ぶ。
 * `projectId` を渡すとそのプロジェクトを最初に選んでおく（プロジェクトの中から開くとき）。
 * 取り込めたら、そのプロジェクトの ID を返す。
 */
export function UploadDialogV8({ open, onClose, onDone, projectId: initialProjectId }: {
  open: boolean
  onClose: () => void
  onDone: (projectId: string) => void
  projectId?: string
}) {
  const uid = useId()
  const [projects, setProjects] = useState<BannerProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  // 選んだファイル。選んでから「取り込む」を押すまで送らない。
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const dirty = file !== null
  const guard = useUnsavedGuard({ dirty: open && (dirty || uploading), busy: open && uploading, onDiscard: onClose })
  const close = () => guard.guarded(() => { if (!dirty) onClose() })
  useEffect(() => { if (!open) guard.cancelLeave() }, [open, guard.cancelLeave])
  // 選んだ画像の見本（取り込む前に枠いっぱいに見せる）。閉じる・選び直すと手放す。
  const [filePreview, setFilePreview] = useState<string | null>(null)
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') { setFilePreview(null); return }
    const url = URL.createObjectURL(file)
    setFilePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!open) return
    setError('')
    setFile(null)
    setUploading(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    void api.hqBanners.projects.list()
      .then((res) => {
        if (cancelled) return
        if (!res.success) throw new Error(res.error)
        setProjects(res.data)
        setProjectId(initialProjectId && res.data.some((p) => p.id === initialProjectId) ? initialProjectId : res.data[0]?.id ?? '')
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([])
          setProjectId('')
          setLoadError('プロジェクトを読み込めませんでした。')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, initialProjectId, retryCount])

  const pickFile = (next: File | undefined) => {
    if (!next) return
    const refusal = uploadRefusal(next)
    if (refusal) return setError(refusal)
    setError('')
    setFile(next)
  }

  const takeIn = async () => {
    if (!file || loadError || uploadProjectRequirement.check(projectId) || uploading) return
    setUploading(true)
    setError('')
    try {
      const data = await readFileAsBase64(file)
      const res = await api.hqBanners.projects.upload(projectId, { filename: file.name, mimeType: file.type, data })
      if (!res.success) throw new Error(res.error)
      onDone(projectId)
    } catch (caught) {
      setError(describeApiFailure(caught, '取り込み', { scope: 'hq' }))
    } finally {
      setUploading(false)
    }
  }

  const noProject = !loading && !loadError && projects.length === 0
  return (<>
    <BannerDialogFrame
      open={open}
      kind="upload"
      contentLayout="form"
      title="画像を取り込む"
      description="手持ちの画像をプロジェクトへ入れます。PNG・JPEG・WebP、10MB まで。取り込んだ画像も生成した画像と同じようにアカウントへ渡せます。"
      onClose={close}
      busy={uploading}
      error={error || undefined}
      designNode="AnwtH"
      actions={(
          <>
            <Button onClick={close} disabled={uploading}>キャンセル</Button>
            <Button variant="primary" onClick={() => void takeIn()} disabled={!file || Boolean(loadError) || Boolean(uploadProjectRequirement.check(projectId)) || loading || uploading} title={loading ? 'プロジェクトを読み込んでいます。' : loadError ? 'プロジェクトを読み込んでから取り込んでください。' : uploadProjectRequirement.check(projectId) ?? (!file ? '取り込む画像を選んでください。' : undefined)} busy={uploading} busyLabel="取り込み中…">
              <Upload aria-hidden="true" className={styles.icon} />取り込む
            </Button>
        </>
      )}
    >
        {loadError ? (
          <Notice
            tone="danger"
            action={
              <Button
                variant="text"
                size="inline"
                data-notice-inline-action
                type="button"
                disabled={loading}
                onClick={() => setRetryCount((value) => value + 1)}
              >
                もう一度読み込む
              </Button>
            }
          >
            {loadError}
          </Notice>
        ) : noProject ? (
          <p className={styles.note}>まずプロジェクトを作ってください。画像はプロジェクトの中に入ります。</p>
        ) : (
          <>
            <div className={styles.field}><Field label="入れるプロジェクト" requirement={uploadProjectRequirement} htmlFor={`${uid}-project`}><div className={styles.full}>
                <SaveErrorField names={["projectId","project_id"]}><EntitySelect
                  aria-label="入れるプロジェクト"
                  size="full"
                  id={`${uid}-project`}
                  value={projectId}
                  disabled={loading}
                  onChange={setProjectId}
                  options={projects.map((p) => ({ ...entityOptionMetadata(p), value: p.id, label: p.name }))}
                /></SaveErrorField>
              </div></Field></div>
            <SaveErrorField names={["filePreview","file_preview"]}><MediaSlot
              title="画像を追加"
              previewAlt={file?.name}
              value={filePreview}
              fit="contain"
              accept={BANNER_UPLOAD_ACCEPT.join(',')}
              /* 絵 ：大きさの上限も形式と同じ行に書く（「？」に隠さない）。 */
              maxBytes={BANNER_UPLOAD_MAX_BYTES}
              busy={uploading}
              onFile={(next) => pickFile(next)}
              onRemove={() => setFile(null)}
            /></SaveErrorField>
            {file ? <p className={styles.dropText} ><TruncatedText value={String(file.name ?? '')} /></p> : null}
          </>
        )}
    </BannerDialogFrame>
    <OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={open && guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={uploading} /></OverlayDepthContext.Provider>
  </>)
}

/**
 * 確かめる窓（ アーカイブ・ 一覧から外す）。見出し・説明・区切り線・真ん中にボタン2つ。
 * 危ない操作（一覧から外す）は赤いボタン。
 */
export function BannerConfirmDialogV8({ open, title, description, confirmLabel, tone, busy, error, onConfirm, onCancel, designNode }: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  tone: 'primary' | 'danger'
  busy?: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
  designNode: string
}) {
  return (
    <BannerDialogFrame
      open={open}
      kind="confirm"
      title={title}
      description={description}
      onClose={onCancel}
      busy={busy}
      error={error || undefined}
      designNode={designNode}
      role={tone === 'danger' ? 'alertdialog' : 'dialog'}
      actions={(
        <>
          <Button onClick={onCancel} disabled={busy}>キャンセル</Button>
          <Button variant={tone} onClick={onConfirm} disabled={busy} busy={busy} busyLabel="処理中…">
            {tone === 'primary' ? <Archive aria-hidden="true" className={styles.icon} /> : null}{confirmLabel}
          </Button>
        </>
      )}
    />
  )
}
