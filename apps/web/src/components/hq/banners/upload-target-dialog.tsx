'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Select from '@/components/shared/select'
import { api } from '@/lib/api'
import { readFileAsBase64, type BannerProject } from '@/lib/hq-banners'
import { BANNER_UPLOAD_ACCEPT, BANNER_UPLOAD_MAX_BYTES } from './upload-button'

/**
 * 画像ライブラリの「画像を取り込む」。Pencil 35-3 `Lveyd`。
 *
 * 画像はプロジェクトに属するので、先にどのプロジェクトへ入れるかを選ぶ。
 * 取り込めたら、そのプロジェクトの詳細へ移る。
 */
export default function UploadTargetDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  /** 取り込みが済んだら、そのプロジェクトIDを返す。 */
  onPick: (projectId: string) => void
}) {
  const uid = useId()
  const [projects, setProjects] = useState<BannerProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  /** 選んだファイル。選んでから「取り込む」を押すまで送らない。 */
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setFile(null)
    setUploading(false)
    void api.hqBanners.projects
      .list()
      .then((res) => {
        if (cancelled) return
        if (!res.success) throw new Error(res.error)
        setProjects(res.data)
        setProjectId((cur) => cur || res.data[0]?.id || '')
      })
      .catch(() => {
        if (!cancelled) setError('プロジェクトを読み込めませんでした。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  /** ファイルを選ぶ（置く・選ぶのどちらも）。形式と大きさを手元で確かめる。 */
  const pickFile = (next: File | undefined) => {
    if (!next) return
    if (!BANNER_UPLOAD_ACCEPT.includes(next.type)) {
      setError('画像は PNG・JPEG・WebP のみ取り込めます')
      return
    }
    if (next.size > BANNER_UPLOAD_MAX_BYTES) {
      setError('ファイルが大きすぎます（上限 10MB）')
      return
    }
    setError('')
    setFile(next)
  }

  const takeIn = async () => {
    if (!file || !projectId || uploading) return
    setUploading(true)
    setError('')
    try {
      const data = await readFileAsBase64(file)
      const res = await api.hqBanners.projects.upload(projectId, { filename: file.name, mimeType: file.type, data })
      if (!res.success) throw new Error(res.error)
      onPick(projectId)
    } catch (caught) {
      setError(describeApiFailure(caught, '取り込み', { scope: 'hq' }))
    } finally {
      setUploading(false)
    }
  }

  const projectField = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${uid}-project`} className="text-label font-medium text-ink">入れるプロジェクト</label>
      <Select
        aria-label="入れるプロジェクト"
        size="full"
        id={`${uid}-project`}
        className="w-full"
        value={projectId}
        disabled={loading}
        onChange={(value) => setProjectId(value)}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
      />
    </div>
  )

  return (
    <Dialog
      open={open}
      title="画像を取り込む"
      description="手持ちの画像をプロジェクトへ入れます。PNG・JPEG・WebP、10MB まで。取り込んだ画像も生成した画像と同じようにアカウントへ渡せます。"
      onCancel={onClose}
      error={error || undefined}
      designNode="AnwtH"
      footer={
        <DialogActions>
          <Button onClick={onClose} disabled={uploading}>キャンセル</Button>
          <Button
            variant="primary"
            onClick={() => void takeIn()}
            disabled={!file || !projectId || loading || uploading}
            busy={uploading}
            busyLabel="取り込み中…"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            取り込む
          </Button>
        </DialogActions>
      }
    >
      {projects.length === 0 && !loading ? (
        <p className="text-caption text-ink-secondary">まずプロジェクトを作ってください。画像はプロジェクトの中に入ります。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {projectField}
          <div
            role="button"
            tabIndex={0}
            aria-label="取り込むファイルを選ぶ"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') fileRef.current?.click()
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              pickFile(event.dataTransfer.files?.[0])
            }}
            className={`flex flex-col items-center gap-2 rounded-control border border-dashed px-4 py-8 text-center ${dragging ? 'border-accent bg-accent-soft' : 'border-hairline bg-canvas-sunken'}`}
          >
            <Upload aria-hidden="true" className="h-6 w-6 text-ink-faint" />
            {file ? (
              <>
                <p className="max-w-full truncate text-label font-medium text-ink" title={file.name}>{file.name}</p>
                <span className="text-caption text-action">選び直す</span>
              </>
            ) : (
              <>
                <p className="text-label text-ink-secondary">ここへドラッグ、または</p>
                <Button onClick={(event) => { event.stopPropagation(); fileRef.current?.click() }}>
                  <Upload aria-hidden="true" className="h-4 w-4" />
                  ファイルを選択する
                </Button>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={BANNER_UPLOAD_ACCEPT.join(',')}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                pickFile(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </div>
        </div>
      )}
    </Dialog>
  )
}

UploadTargetDialog.Trigger = function UploadTargetTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      <Upload aria-hidden="true" className="h-4 w-4" />
      画像を取り込む
    </Button>
  )
}
