'use client'

/*
 * ★V8 会話の中の動画・ファイル（・API-15）。
 * 口は動画を {originalContentUrl, previewImageUrl}、ファイルを {attachmentId, filename, size, url, expiresAt}
 * の JSON で残す。そのまま文字で出さず、動画は再生できる枠、ファイルは名前・大きさ・期限の札にする。
 * 読めない形のときは今までどおり文字で出す（親が null を見て決める）。
 */
import { Download, FileText } from 'lucide-react'
import { useState } from 'react'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { formatExpiry, formatSize, parseSentAttachment } from './attachments'
import styles from './inbox-chat.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import TextLink from '@/components/shared/text-link'

export default function AttachmentMessage({ messageType, content }: { messageType: string; content: string }) {
  const view = parseSentAttachment(messageType, content)
  if (!view) return <span>{messageType === 'video' ? '[動画]' : '[ファイル]'}</span>
  if (view.kind === 'video') return <VideoAttachment key={view.url} url={view.url} previewUrl={view.previewUrl} />
  const expiry = formatExpiry(view.expiresAt)
  const sub = [view.size !== null ? formatSize(view.size) : null, expiry ? `ダウンロード ${expiry}` : null].filter(Boolean).join('・')
  const body = (
    <>
      <FileText aria-hidden className={styles.sentFileIcon} />
      <span className={styles.sentFileText}>
        <span className={styles.sentFileName} ><TruncatedText value={String(view.name ?? '')} /></span>
        {sub ? <span className={styles.sentFileSub}>{sub}</span> : null}
      </span>
      {view.url ? <Download aria-hidden className={styles.sentFileIcon} /> : null}
    </>
  )
  return view.url ? (
    <TextLink external className={styles.sentFile} href={view.url}   aria-label={`${view.name} を開く`}>{body}</TextLink>
  ) : (
    <span className={styles.sentFile}>{body}</span>
  )
}


function VideoAttachment({ url, previewUrl }: { url: string; previewUrl: string | null }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <div className={styles.sentVideo}><Notice tone="warn" action={<Button variant="text" onClick={() => setFailed(false)}>動画を読み込み直す</Button>}><TruncatedText value="動画を読み込めませんでした" /></Notice></div>
  return <video className={styles.sentVideo} src={url} poster={previewUrl ?? undefined} controls preload="metadata" aria-label="送った動画" onError={() => setFailed(true)} />
}
