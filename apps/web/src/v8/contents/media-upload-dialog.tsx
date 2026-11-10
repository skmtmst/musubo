'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'


import type { Folder } from '@line-crm/shared'
import { api } from '@/lib/api'
import Button from '@/components/shared/button'
import Chip from '@/components/shared/chip'
import { AttachmentRow } from '@/components/shared/file-drop'
import MediaSlot, { formatBytes, formatNamesOf } from '@/components/shared/media-slot'
import Notice from '@/components/shared/notice'
import Disclosure from '@/components/shared/disclosure'
import Progress from '@/components/shared/progress'
import FolderSelect, { folderById, type FolderSelectCreate } from '@/components/shared/folder-select'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { MEDIA_ACCEPT, extractMediaMetadata, mediaFileLimitBytes, putMediaFile, validateMediaFile } from './media-direct-upload'
import { formatMediaSize } from './media-usage-display'
import { formatNumber } from '@/lib/format'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import MediaPreviewOverlay from './media-preview-overlay'



type UploadState = 'ready' | 'preparing' | 'uploading' | 'verifying' | 'done' | 'error'

type UploadEntry = {
  file: File
  state: UploadState
  message: string
  retryable: boolean
  progress: number
  previewUrl?: string
  mediaId?: string | null
  /** 検査の状態。確かめ終わるまで中身は出さない。 */
  scanStatus?: 'pending' | 'clean' | 'rejected' | 'quarantined' | null
}

function scanChipProps(status: NonNullable<UploadEntry['scanStatus']>): { tone: 'info' | 'ok' | 'danger' | 'warn'; label: string } {
  if (status === 'clean') return { tone: 'ok', label: '使えます' }
  if (status === 'rejected') return { tone: 'danger', label: '使えません' }
  if (status === 'quarantined') return { tone: 'warn', label: '確認のため使えません' }
  return { tone: 'info', label: '確かめています' }
}

const LIMITS = [
  { label: '写真', types: 'image/jpeg,image/png,image/gif,image/webp', example: 'image/png' },
  { label: '動画', types: 'video/mp4', example: 'video/mp4' },
  { label: '音声', types: 'audio/mpeg,audio/mp4', example: 'audio/mpeg' },
  { label: 'PDF', types: 'application/pdf', example: 'application/pdf' },
]
const MAX_FILES = 10

export default function MediaUploadDialog({
  open,
  accountId,
  folders,
  initialFolderId,
  onCreateFolder,
  onClose,
  onComplete,
}: {
  open: boolean
  accountId: string | null
  folders: Folder[]
  initialFolderId: string
  /** 入れるフォルダを選ぶ欄からその場で作る（dLffh）。閲覧のみは渡さない。 */
  onCreateFolder?: FolderSelectCreate
  onClose: () => void
  onComplete: () => void
}) {
  const inputId = useId()
  const [entries, setEntries] = useState<UploadEntry[]>([])
  const [folderId, setFolderId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<UploadEntry | null>(null)
  const previewUrls = useRef(new Set<string>())
  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url)
    previewUrls.current.clear()
  }, [])
  useEffect(() => {
    const active = new Set(entries.map((entry) => entry.previewUrl).filter((url): url is string => Boolean(url)))
    for (const url of previewUrls.current) {
      if (active.has(url)) continue
      URL.revokeObjectURL(url)
      previewUrls.current.delete(url)
    }
  }, [entries])
  const pendingFiles = entries.some(entry => entry.state !== 'done')
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: open && (pendingFiles || busy), busy: open && busy, onDiscard: onClose })
  const current = useRef({ open, accountId, busy, target: guard.leaveTarget })
  current.current = { open, accountId, busy, target: guard.leaveTarget }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (!open) guard.cancelLeave() }, [open, guard.cancelLeave])
  useEffect(() => { guard.cancelLeave() }, [accountId, guard.cancelLeave])
  const discardAndLeave = () => {
    const target = guard.leaveTarget
    if (!alive.current || !current.current.open || current.current.accountId !== accountId || current.current.busy || !target || current.current.target !== target) return
    current.current.target = null
    guard.disarm(); guard.confirmLeave()
  }


  useEffect(() => {
    if (!open) return
    setEntries([])
    setFolderId(initialFolderId === '__ungrouped__' ? '' : initialFolderId)
    setBusy(false)
    setError('')
    setPreview(null)
  }, [initialFolderId, open])

  const readyCount = useMemo(
    () => entries.filter((entry) => entry.state === 'ready').length,
    [entries],
  )
  const errorCount = entries.filter((entry) => entry.state === 'error').length
  const doneCount = entries.filter((entry) => entry.state === 'done').length
  const allDone = entries.length > 0 && doneCount === entries.length
  const uploadPercent = entries.length === 0 ? 0 : entries.reduce((sum, entry) => {
    if (entry.state === 'done') return sum + 100
    if (entry.state === 'uploading' || entry.state === 'verifying') return sum + Math.min(99, Math.max(0, entry.progress))
    return sum
  }, 0) / entries.length
  /*
    全体の進みは実測だけ出す。登録を押す前（すべて登録待ち）は棒を出さない。
    一度でも登録を実行した（完了か、登録中の失敗がある）ときだけ
    Active（登録中）／Done／Partial を出す。
  */
  const attempted = entries.some((entry) => entry.state === 'done' || (entry.state === 'error' && entry.retryable))
  const uploadErrorCount = entries.filter((entry) => entry.state === 'error' && entry.retryable).length
  const selectedCountLabel = `選択したファイル（${formatNumber(entries.length)} / ${MAX_FILES}件）`
  const firstPhoto = entries.find((entry) => entry.previewUrl)

  function removeEntry(index: number) {
    setEntries((current) => current.filter((_, entryIndex) => entryIndex !== index))
  }

  function stage(files: File[]) {
    const next = files.slice(0, MAX_FILES).map((file) => {
      const message = validateMediaFile(file)
      const previewUrl = !message && file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : undefined
      if (previewUrl) previewUrls.current.add(previewUrl)
      return { file, state: message ? 'error' : 'ready', message, retryable: false, progress: 0, previewUrl } satisfies UploadEntry
    })
    setEntries(next)
    setPreview(null)
    setError(files.length > MAX_FILES ? '一度に登録できるのは10件までです。先頭の10件を表示しています。' : '')
  }

  async function uploadReady() {
    if (!accountId || readyCount === 0 || busy) return
    setBusy(true)
    setError('')
    let completed = 0
    const pending = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.state === 'ready')
    setEntries((current) => current.map((entry) => (
      entry.state === 'ready' ? { ...entry, state: 'preparing', message: '送信を準備しています', progress: 0 } : entry
    )))
    for (const { index, entry } of pending) {
      try {
        // 大きなファイルを順番に送っても、後続の署名URLが待機中に失効しない。
        const prepared = await api.media.prepareUploads({
          accountId,
          files: [{
            filename: entry.file.name,
            mimeType: entry.file.type,
            sizeBytes: entry.file.size,
            folderId: folderId || null,
            metadata: await extractMediaMetadata(entry.file),
          }],
        })
        const session = prepared.success ? prepared.data.sessions[0] : null
        if (!session) throw new Error('送信の準備結果を確認できませんでした。時間をおいて、もう一度お試しください。')
          setEntries((current) => current.map((item, entryIndex) => (
            entryIndex === index ? { ...item, state: 'uploading', message: '送信中 0%', progress: 0 } : item
          )))
          const etag = await putMediaFile(session, entry.file, (progress) => {
            setEntries((current) => current.map((item, entryIndex) => (
              entryIndex === index
                ? { ...item, progress, message: `送信中 ${progress}%` }
                : item
            )))
          })
          setEntries((current) => current.map((item, entryIndex) => (
            entryIndex === index ? { ...item, state: 'verifying', message: '中身を確認しています', progress: 100 } : item
          )))
          const response = await api.media.completeUpload(session.id, { accountId, etag })
          if (!response.success || response.data.status !== 'completed') throw new Error('登録を完了できませんでした。時間をおいて、もう一度お試しください。')
          completed += 1
          const mediaId = response.data.mediaId ?? null
          setEntries((current) => current.map((item, entryIndex) => (
            entryIndex === index
              ? { ...item, state: 'done', message: '入りました', retryable: false, progress: 100, mediaId, scanStatus: 'pending' }
              : item
          )))
          // 検査の状態を読む。確かめ終わるまで配信・公開には出さない。
          if (mediaId) {
            try {
              const scan = await api.fileScan.forMedia(mediaId, accountId)
              const status = scan.success ? scan.data.scan?.status ?? null : null
              setEntries((current) => current.map((item, entryIndex) => (
                entryIndex === index ? { ...item, scanStatus: status ?? 'pending' } : item
              )))
            } catch {
              // 読めなくても登録自体は済んでいる。確かめ中として置く。
            }
          }
      } catch (caught) {
        const message = describeApiFailure(caught, '登録')
        setEntries((current) => current.map((item, entryIndex) => (
          entryIndex === index ? { ...item, state: 'error', message, retryable: true } : item
        )))
      }
    }
    setBusy(false)
    if (completed > 0) onComplete()
  }

  if (!open) return null

  return <><Dialog contentLayout="form" open={open} dirty={pendingFiles} title="ファイルを入れる" onCancel={onClose} busy={busy} error={error || undefined} designNode="eXAJP" designWidth={720} footer={(<DialogActions leadingAction={<p className={errorCount > 0 ? 'text-danger text-xs font-semibold' : 'text-ink-faint text-xs'}>
            {errorCount > 0 ? `${formatNumber(errorCount)}件は登録できません` : allDone ? `${formatNumber(doneCount)}件を登録しました` : `${entries.length}件を選択中`}
          </p>}>

          <>
            {allDone && !busy ? <Button type="button" variant="primary" onClick={onClose}>完了</Button> : <Button type="button" variant="primary" onClick={() => void uploadReady()} disabled={busy || readyCount === 0 || !accountId} busy={busy} busyLabel="登録しています…">
              {`${formatNumber(readyCount)}件を登録する`}
            </Button>}
          </>
        </DialogActions>)}>{}
        <div className="space-y-4 p-6">
        <MediaSlot kind="file"
          title="ファイルを選ぶ・ここにドラッグ"
          size="compact"
          accept={MEDIA_ACCEPT}
          busy={busy}
          onFiles={stage}
        />
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-secondary" aria-label="ファイルのサイズ上限">
          {LIMITS.map((limit) => <span key={limit.label}>
            {limit.label}{limit.label === 'PDF' ? '' : ` ${formatNamesOf(limit.types)}`}：{formatBytes(mediaFileLimitBytes({ type: limit.example })!)}まで
          </span>)}
        </div>

        {entries.length > 0 ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-ink text-sm font-bold">{selectedCountLabel}</p>
            </div>
            {/* 全体の進みは登録を実行してから出す（実測の完了数だけ）。 */}
            {busy ? (
              <Progress
                state="active"
                title="登録しています"
                percent={uploadPercent}
                countText={`${formatNumber(doneCount)} / ${formatNumber(entries.length)} 件完了`}
                className="mb-3"
              />
            ) : attempted ? (
              <Progress
                state={uploadErrorCount > 0 ? 'partial' : 'done'}
                title={uploadErrorCount > 0
                  ? `${formatNumber(doneCount)} 件を登録し、${formatNumber(uploadErrorCount)} 件は入りませんでした`
                  : `${formatNumber(doneCount)} 件を登録しました`}
                percent={entries.length > 0 ? (doneCount / entries.length) * 100 : 0}
                className="mb-3"
              />
            ) : null}
            {firstPhoto?.previewUrl ? <div>
              <MediaSlot kind="image" title="登録前の写真" value={firstPhoto.previewUrl} previewAlt={`${firstPhoto.file.name}の登録前プレビュー`} fit="contain" readOnly />
              <Button type="button" variant="text" size="inline" textTone="accent" onClick={() => setPreview(firstPhoto)}>写真を大きく見る</Button>
            </div> : null}
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {entries.map((entry, index) => {
                const sizeText = formatMediaSize(entry.file.size)
                const tone = entry.file.type.startsWith('image/') ? 'photo' as const : 'document' as const
                const thumbnail = entry.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.previewUrl} alt="" className="h-full w-full object-cover" />
                ) : undefined
                if (entry.state === 'uploading' || entry.state === 'preparing' || entry.state === 'verifying') {
                  return (
                    <li key={`${entry.file.name}-${entry.file.size}-${index}`} aria-live="polite">
                      <AttachmentRow
                        name={entry.file.name}
                        status="uploading"
                        percent={entry.progress}
                        uploadingText={entry.message || `送信中 ${entry.progress}%`}
                        tone={tone}
                        thumbnail={thumbnail}
                      />
                    </li>
                  )
                }
                if (entry.state === 'error' && entry.retryable) {
                  return (
                    <li key={`${entry.file.name}-${entry.file.size}-${index}`} aria-live="polite">
                      <AttachmentRow
                        name={entry.file.name}
                        status="error"
                        errorText={entry.message}
                        tone={tone}
                        thumbnail={thumbnail}
                        retryLabel="もう一度試す"
                        onRetry={() => setEntries((current) => current.map((item, entryIndex) => (
                          entryIndex === index ? { ...item, state: 'ready', message: '', retryable: false, progress: 0 } : item
                        )))}
                      />
                    </li>
                  )
                }
                if (entry.state === 'error') {
                  return (
                    <li key={`${entry.file.name}-${entry.file.size}-${index}`} aria-live="polite">
                      <AttachmentRow
                        name={entry.file.name}
                        status="error"
                        errorText={entry.message}
                        tone={tone}
                        thumbnail={thumbnail}
                        onRemove={() => removeEntry(index)}
                      />
                    </li>
                  )
                }
                const scan = entry.state === 'done' ? scanChipProps(entry.scanStatus ?? 'pending') : null
                return (
                  <li key={`${entry.file.name}-${entry.file.size}-${index}`} aria-live="polite">
                    <AttachmentRow
                      name={entry.file.name}
                      meta={entry.state === 'done' ? `${sizeText}・入りました` : `${sizeText}・${entry.message || '登録できます'}`}
                      tone={tone}
                      thumbnail={thumbnail}
                      onRemove={busy ? undefined : () => removeEntry(index)}
                    />
                    {entry.previewUrl ? <Button type="button" variant="text" size="inline" textTone="accent" className="ml-12 mt-1" onClick={() => setPreview(entry)}>写真を大きく見る</Button> : null}
                    {scan ? (
                      <p className="mt-1 flex items-center gap-2">
                        <Chip tone={scan.tone}>{scan.label}</Chip>
                        {entry.scanStatus === 'pending' ? (
                          <span className="text-ink-faint text-xs">確かめ終わるまで配信・公開には出ません</span>
                        ) : null}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}

        <div><Field label="入れるフォルダ" htmlFor={`${inputId}-folder`}><SaveErrorField names={["folderId","folder_id"]}><FolderSelect
            aria-label="入れるフォルダ"
            value={folderId}
            folders={folders.map(folderById)}
            onCreate={onCreateFolder}
            onChange={setFolderId}
          /></SaveErrorField></Field></div>
        <Disclosure appearance="inset" size="compact" title="登録時の注意事項">
          <Notice tone="info">
            <p>PDFはLINEで直接送れません。リンクとして使います。</p>
            <p>大きなファイルも管理画面を経由せず、保存先へ直接送ります。</p>
            <p>中身の形式と拡張子が違うファイルは登録できません。</p>
            <p>公開リンクが作られるため、個人情報の取り扱いに注意してください。</p>
          </Notice>
        </Disclosure>
        </div>
  </Dialog><OverlayDepthContext.Provider value={depth + 1}>
    {preview?.previewUrl ? <MediaPreviewOverlay filename={preview.file.name} kind="image" src={preview.previewUrl} onClose={() => setPreview(null)} /> : null}
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="選択したファイル" busy={busy} onConfirm={discardAndLeave} onCancel={guard.cancelLeave} />
  </OverlayDepthContext.Provider></>
}
