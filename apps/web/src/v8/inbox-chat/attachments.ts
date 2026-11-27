/*
 * ★V8 受信箱の添付（「7. 添付（左下のクリップから開く）」I7Skn・）。
 *
 * 書く欄の左下のクリップから「画像・動画」「ファイル」を選ぶ。選ぶ前（ここ）で
 * 形式と大きさを確かめ、送れないものはその場で理由を出す（アップロードしない）。
 *
 * - 画像：JPEG・PNG・1MB まで（今までの画像の準備をそのまま使う。LINE のプレビュー画像は 1MB まで）
 * - 動画：MP4・200MB まで（API-15：受信箱の添付の直接アップロード）
 * - ファイル：PDF・Word・Excel・PowerPoint・ZIP・10MB まで。LINE にはファイルのメッセージが
 *   無いので、期限30日のダウンロードのリンクとして届く（API-15）
 */
import { formatDate as polishFormatDate } from '@/lib/format'
import {
  CHAT_FILE_MAX_BYTES,
  CHAT_FILE_TYPES,
  CHAT_VIDEO_MAX_BYTES,
  type ChatAttachment,
  type ChatSendInput,
} from '@line-crm/shared'
import { japaneseDetailOf } from '@/components/shared/api-error-message'

export type AttachSlot = 'media' | 'file'
export type AttachKind = 'image' | 'video' | 'file'

/** 画像は今までの準備（uploads.image）と同じ上限。元画像とプレビューに同じ URL を渡すため。 */
export const CHAT_IMAGE_PICK_MAX_BYTES = 1024 * 1024

export const MEDIA_ACCEPT = 'image/jpeg,image/png,video/mp4,.mp4'
export const FILE_ACCEPT = [
  ...Object.keys(CHAT_FILE_TYPES),
  ...Object.values(CHAT_FILE_TYPES).map((ext) => `.${ext}`),
].join(',')

/** 書く欄の左下の注（絵：画像・動画・ファイルを添付）。 */
export const ATTACH_NOTE = '画像・動画・ファイルを添付'
/** 注の title（全文）。上限を読めるようにする。 */
export const ATTACH_NOTE_TITLE = '画像は JPEG・PNG（1MB まで）、動画は MP4（200MB まで）、ファイルは PDF・Word・Excel・PowerPoint・ZIP（10MB まで・期限30日のリンクで届く）'

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/** ブラウザが種類を空・octet-stream で渡すときは拡張子から読む（api の upload と同じ決め方）。 */
export function mimeOf(file: Pick<File, 'name' | 'type'>): string {
  const ext = extensionOf(file.name)
  if (file.type && !['application/octet-stream', 'application/x-zip-compressed'].includes(file.type)) return file.type
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  return Object.entries(CHAT_FILE_TYPES).find(([, e]) => e === ext)?.[0] ?? file.type
}

/** 大きさを人が読める形に（1.2MB・340KB）。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1024 * 1024) {
    const mb = bytes / 1024 / 1024
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10}MB`
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

export type AttachCheck =
  | { ok: true; kind: AttachKind; mimeType: string }
  | { ok: false; reason: string }

/**
 * 選んだ・落としたファイルを確かめる。`slot` は押した口（画像・動画／ファイル）。
 * ドラッグで落としたときは slot を渡さず、形式から決める。
 */
export function checkAttachment(file: Pick<File, 'name' | 'type' | 'size'>, slot?: AttachSlot): AttachCheck {
  const mimeType = mimeOf(file)
  const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png'
  const isVideo = mimeType === 'video/mp4'
  const isFile = Object.prototype.hasOwnProperty.call(CHAT_FILE_TYPES, mimeType)
  if (!Number.isSafeInteger(file.size)) return { ok: false, reason: `「${file.name}」の大きさを確認できません。選び直してください` }
  if (file.size <= 0) return { ok: false, reason: `「${file.name}」は中身が空です` }
  if (slot !== 'file' && isImage) {
    if (file.size > CHAT_IMAGE_PICK_MAX_BYTES) return { ok: false, reason: `画像は1MBまでです（「${file.name}」は${formatSize(file.size)}）` }
    return { ok: true, kind: 'image', mimeType }
  }
  if (slot !== 'file' && isVideo) {
    if (file.size > CHAT_VIDEO_MAX_BYTES) return { ok: false, reason: `動画は200MBまでです（「${file.name}」は${formatSize(file.size)}）` }
    return { ok: true, kind: 'video', mimeType }
  }
  if (slot !== 'media' && isFile) {
    if (file.size > CHAT_FILE_MAX_BYTES) return { ok: false, reason: `ファイルは10MBまでです（「${file.name}」は${formatSize(file.size)}）` }
    return { ok: true, kind: 'file', mimeType }
  }
  if (slot === 'media') return { ok: false, reason: `「${file.name}」は送れない形式です。画像は JPEG・PNG、動画は MP4 を選んでください` }
  if (slot === 'file') return { ok: false, reason: `「${file.name}」は送れない形式です。PDF・Word・Excel・PowerPoint・ZIP を選んでください` }
  return { ok: false, reason: `「${file.name}」は送れない形式です。画像は JPEG・PNG、動画は MP4、ファイルは PDF・Word・Excel・PowerPoint・ZIP です` }
}

/** 送る口（send・schedule）に渡す形。画像は今までの画像の送り方で別に送る。 */
export function attachmentSendInput(attachment: ChatAttachment): Pick<ChatSendInput, 'messageType' | 'content'> {
  if (attachment.kind === 'video') {
    return { messageType: 'video', content: JSON.stringify({ originalContentUrl: attachment.url }) }
  }
  return { messageType: 'file', content: JSON.stringify({ attachmentId: attachment.id }) }
}

/** 一覧の最後のひとこと（楽観表示）。 */
export function attachmentPreviewLabel(kind: 'video' | 'file'): string {
  return kind === 'video' ? '[動画]' : '[ファイル]'
}

/** 送った動画・ファイルの吹き出しに出す中身。content は口が保存した JSON。 */
export type SentAttachmentView =
  | { kind: 'video'; url: string; previewUrl: string | null }
  | { kind: 'file'; name: string; size: number | null; url: string | null; expiresAt: string | null }

export function parseSentAttachment(messageType: string, content: string): SentAttachmentView | null {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(content) as unknown
    if (!value || typeof value !== 'object') return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  if (messageType === 'video') {
    if (typeof parsed.originalContentUrl !== 'string') return null
    return {
      kind: 'video',
      url: parsed.originalContentUrl,
      previewUrl: typeof parsed.previewImageUrl === 'string' ? parsed.previewImageUrl : null,
    }
  }
  if (messageType === 'file') {
    return {
      kind: 'file',
      name: typeof parsed.filename === 'string' && parsed.filename ? parsed.filename : 'ファイル',
      size: typeof parsed.size === 'number' ? parsed.size : null,
      url: typeof parsed.url === 'string' ? parsed.url : null,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
    }
  }
  return null
}

/** ダウンロードの期限（日本時間 10月8日 まで）。 */
export function formatExpiry(iso: string | null): string | null {
  const day = polishFormatDate(iso, { style: 'day', fallback: '' })
  return day ? `${day}まで` : null
}

/**
 * 準備（アップロード）の失敗を人の言葉にする。相手への送信はまだ始まっていない。
 * 口が日本語の理由（形式・大きさ・期限）を返したらそれを出し、機械の文は出さない。
 */
export function describeUploadFailure(error: unknown): string {
  return japaneseDetailOf(error) || '準備できませんでした。通信を確かめて、もう一度試してください'
}

/** 予約の一覧の「送るもの」。画像・動画・ファイルは JSON のまま出さない。 */
export function scheduledContentLabel(messageType: string, content: string): string {
  if (messageType === 'image') return '画像 1枚'
  if (messageType === 'video') return '動画'
  if (messageType === 'file') {
    const view = parseSentAttachment('file', content)
    return view?.kind === 'file' && view.name !== 'ファイル' ? `ファイル「${view.name}」` : 'ファイル'
  }
  return content
}
