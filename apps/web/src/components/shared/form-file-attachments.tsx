'use client'
import { useEffect, useState } from 'react'
import { FileText, Lock } from 'lucide-react'
import type { FormFileAnswer, FormInputBlock } from '@line-crm/shared'
import { formAnswerText } from '@/lib/form-answer'
import { fetchApiBlob } from '@/lib/api'
import Button from './button'
import Dialog from './dialog'
import styles from './form-file-attachments.module.css'
export function isFormFiles(value: unknown): value is FormFileAnswer[] {
  return Array.isArray(value) && value.some(v => v && typeof v === 'object' && typeof v.fileId === 'string')
}
function Attachment({ file }: { file: FormFileAnswer }) {
  const [url, setUrl] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (file.state !== 'ready') return;
    let active = true; let objectUrl: string | null = null
    void fetchApiBlob(`/api/form-files/${encodeURIComponent(file.fileId)}/content`).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (active) setError('書類を開けませんでした') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file.fileId, file.state])
  if (file.state === 'expired') return <span>期限で消しました</span>
  if (file.state === 'restricted') return <span><Lock size={16} aria-hidden />見る権限がありません</span>
  if (file.state === 'quarantined') return <span>危ないファイルのため開けません</span>
  if (file.state === 'rejected') return <span>安全を確認できませんでした。別のファイルを選んでください</span>
  if (file.state !== 'ready') return <span>検査中です</span>
  const pdf = file.mimeType === 'application/pdf'
  return <>
    <Button size="compact" onClick={() => setOpen(true)} aria-label={`${file.filename || '書類'}を開く`}>
      {pdf ? <FileText size={16} aria-hidden /> : url ? <img width={32} height={32} src={url} alt="添付の小さな見本" className={styles.thumbnail} /> : null}
      {file.filename || '書類'}
    </Button>
    <Dialog open={open} title={file.filename || '書類'} designWidth={720} onCancel={() => setOpen(false)} cancelLabel="閉じる">
      {error ? <p className="text-body" role="alert">{error}</p> : url ? pdf ? <iframe src={url} title={file.filename || 'PDF'} className={styles.document} /> : <img src={url} alt={file.filename || '書類'} className={styles.image} /> : <p className="text-body">読み込んでいます…</p>}
    </Dialog>
  </>
}
export default function FormFileAttachments({ value, block }: { value: unknown; block?: FormInputBlock }) {
  if (!isFormFiles(value)) return <>{formAnswerText(value, block)}</>
  return <span className={styles.files}>{value.map(file => <Attachment key={file.fileId} file={file} />)}</span>
}
