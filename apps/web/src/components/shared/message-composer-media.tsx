'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Play, Pause, Upload } from 'lucide-react'
import type { BroadcastBubble, MediaItem } from '@line-crm/shared'
import { api } from '@/lib/api'
import { hqAudioContent, hqMediaApi } from '@/lib/api/helpers/hq-media'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import { extractMediaMetadata, putMediaFile, validateMediaFile } from '@/v8/contents/public/media-direct-upload/index'
import { emptyMessageKindState, type MessageKindState } from '@/components/scenarios/message-kind-fields'
import Button from './button'
import { japaneseDetailOf } from './api-error-message'
import FileDropzone from './file-drop'
import MediaSlot from './media-slot'
import { TextField } from './text-field'
import styles from './message-composer.module.css'

function AudioPreview({ url, duration, name, disabled }: { url: string; duration: string; name: string; disabled?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(false)
  const seconds = Math.max(0, Number(duration) || 0)
  const clock = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
  const toggle = async () => {
    setError(false)
    if (!audio.current) return
    if (playing) audio.current.pause()
    else try { await audio.current.play() } catch { setError(true) }
  }
  return <div className={styles.audioAttachment}>
    <Button size="composer" disabled={disabled} className={styles.audioIcon} aria-label={playing ? '音声を停止する' : '音声を再生する'} onClick={() => void toggle()}>{playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}</Button>
    <div className={styles.audioTrack}><strong title={name}>{name}</strong><progress aria-label="音声の再生位置" value={elapsed} max={seconds || 1} />{error ? <span role="alert">再生できませんでした。音声のURLを確認してください。</span> : null}</div>
    <span>{clock(playing || elapsed ? elapsed : seconds)}</span>
    <audio ref={audio} src={url} hidden onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)} />
  </div>
}

export default function ComposerMedia({ bubble, accountId, onChange, disabled, onBusyChange }: { bubble: BroadcastBubble; accountId: string | null; onChange: (content: Record<string, unknown>) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const audio = bubble.type === 'audio'
  const video = bubble.type === 'video'
  const state = (bubble.content.state as MessageKindState | undefined) ?? emptyMessageKindState()
  const url = audio ? state.audio.originalContentUrl : String(bubble.content.originalContentUrl ?? '')
  const select = (item: MediaItem) => {
    const formats = audio ? ['audio/mp4', 'audio/mpeg'] : video ? ['video/mp4'] : ['image/jpeg', 'image/png']
    if (item.kind !== (audio ? 'audio' : video ? 'video' : 'image') || !formats.includes(item.mimeType) || item.sizeBytes > (audio || video ? 200 : 10) * 1024 * 1024) { setError('このメッセージで使える形式のメディアを選んでください。'); return }
    if (!item.url) { setError('選んだメディアのURLを確認できませんでした。時間をおいて、もう一度お試しください。'); return }
    if (audio) {
      const durationMs = item.durationMs
      if (!durationMs || durationMs <= 0) { setError('音声の長さを確認できませんでした。登録メディアで確認してください。'); return }
      onChange({ ...bubble.content, fileName: item.filename, state: { ...state, audio: { originalContentUrl: item.url, duration: String(durationMs / 1000) } } })
    } else onChange({ ...bubble.content, fileName: item.filename, originalContentUrl: item.url, previewImageUrl: video ? String(bubble.content.previewImageUrl ?? '') : item.url })
    setPicker(false); setError('')
  }
  const upload = async (file: File) => {
    if (lock.current || disabled) return
    const allowed = audio ? ['audio/mp4', 'audio/mpeg'] : video ? ['video/mp4'] : ['image/jpeg', 'image/png']
    const invalid = validateMediaFile(file)
    if (!allowed.includes(file.type) || invalid) { setError(invalid || '選べる形式を確かめてください。'); return }
    if (audio && !accountId && !file.name.toLowerCase().endsWith('.m4a')) { setError('統括の音声は M4A を選んでください。'); return }
    lock.current = true; setBusy(true); onBusyChange?.(true); setError('')
    try {
      if (audio && !accountId) {
        /* 統括：テンプレートの置き場（API-hq-media）へ送り、URLと長さはファイルから入る。手で入れる欄は置かない。 */
        const media = await hqMediaApi.upload(file, 'audio')
        const content = hqAudioContent(media)
        if (live.current) onChange({ ...bubble.content, fileName: file.name, state: { ...state, audio: { ...state.audio, ...content.state.audio, duration: String(content.state.audio.duration) } } })
      } else if (audio && accountId) {
        const metadata = await extractMediaMetadata(file)
        if (!metadata.durationMs) throw new Error('音声の長さを読み取れませんでした。ファイルを確認してください。')
        const prepared = await api.media.prepareUploads({ accountId, files: [{ filename: file.name, mimeType: file.type, sizeBytes: file.size, metadata }] })
        if (!prepared.success || prepared.data.sessions.length !== 1) throw new Error('音声を送る準備ができませんでした。時間をおいて、もう一度お試しください。')
        const session = prepared.data.sessions[0]
        const etag = await putMediaFile(session, file, () => {})
        const completed = await api.media.completeUpload(session.id, { accountId, etag })
        if (!completed.success || completed.data.status !== 'completed' || !completed.data.mediaId) throw new Error('音声の登録を完了できませんでした。時間をおいて、もう一度お試しください。')
        const result = await api.media.detail(completed.data.mediaId, accountId)
        if (!result.success || result.data.item.kind !== 'audio') throw new Error('登録した音声を確認できませんでした。時間をおいて、もう一度お試しください。')
        if (live.current) select(result.data.item)
      } else {
        const result = await api.broadcastMessageAssets.upload(file, accountId)
        if (!result.success) throw new Error(result.error || 'アップロードできませんでした。時間をおいて、もう一度お試しください。')
        if (live.current) onChange({ ...bubble.content, fileName: file.name, originalContentUrl: result.data.url, previewImageUrl: video ? String(bubble.content.previewImageUrl ?? '') : result.data.url })
      }
    } catch (cause) { if (live.current) setError(japaneseDetailOf(cause) || (describeApiFailure(cause, '画像の登録'))) }
    finally { lock.current = false; if (live.current) setBusy(false); onBusyChange?.(false) }
  }
  return <>
    {audio ? <>
      <div className={styles.mediaChoices}>
        {accountId ? <Button className={styles.mediaPick} disabled={busy || disabled} onClick={() => setPicker(true)}><FolderOpen size={20} aria-hidden /><strong>登録メディアから選択する</strong><small>登録メディア一覧の音声から</small></Button> : null}
        <FileDropzone variant="composer" icon={<Upload size={20} aria-hidden />} className={styles.mediaPick} title="ファイルを選ぶ・ここへドラッグ" hint={accountId ? 'm4a・mp3 ／ 200MB まで ／ 長さは自動で入ります' : 'm4a ／ 200MB まで ／ 長さは自動で入ります'} accept={accountId ? 'audio/mp4,audio/mpeg' : 'audio/mp4'} busy={busy} disabled={disabled} onFiles={(files) => void upload(files[0])} />
      </div>
      {url ? <div className={styles.attachment}><AudioPreview key={url} url={url} duration={state.audio.duration} name={String(bubble.content.fileName ?? '選んだ音声')} disabled={busy || disabled} /><Button size="composer-small" disabled={busy || disabled} onClick={() => onChange({ state: { ...state, audio: { originalContentUrl: '', duration: '' } } })}>外す</Button></div> : null}
    </> : (
      /* 画像・動画は共通の「画像を追加する所」（MediaSlot・Z7vd2・）。送り先と形式の検査はこの欄が持つ。 */
      <MediaSlot
        kind={video ? 'video' : 'image'}
        title={video ? '動画を追加' : '画像を追加'}
        previewAlt={video ? '動画のプレビュー' : '画像のプレビュー'}
        value={url || null}
        valueName={String(bubble.content.fileName ?? '') || undefined}
        accept={video ? 'video/mp4' : 'image/jpeg,image/png'}
        limitText={video ? '1ファイル200メガバイト以内・MP4' : '1ファイル10メガバイト以内・JPEG・PNG'}
        busy={busy}
        error={error}
        disabled={disabled}
        onFile={(file) => void upload(file)}
        onRemove={() => onChange({})}
        onMediaPick={accountId ? () => setPicker(true) : undefined}
      />
    )}
    {video ? <TextField aria-label="動画のプレビュー画像のURL" value={String(bubble.content.previewImageUrl ?? '')} placeholder="プレビュー画像のURL（必須・https・JPEG/PNG・1MBまで）" disabled={busy || disabled} onChange={(event) => onChange({ ...bubble.content, previewImageUrl: event.target.value })} /> : null}
    {audio && error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <MediaPickerDialog open={picker} accountId={accountId} kind={audio ? 'audio' : video ? 'video' : 'image'} onClose={() => setPicker(false)} onSelect={select} />
  </>
}
