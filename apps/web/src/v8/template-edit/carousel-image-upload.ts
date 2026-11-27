import { api } from '@/lib/api'
import { extractMediaMetadata, putMediaFile, validateMediaFile } from '@/v8/contents/public/media-direct-upload/index'

export function validateCarouselImage(file: File, maxMB = 10): string {
  if (!['image/jpeg', 'image/png'].includes(file.type)) return 'JPEG・PNGの画像を選んでください。'
  const invalid = validateMediaFile(file)
  if (invalid) return invalid
  if (file.size > maxMB * 1024 * 1024) return `統括の画像は${maxMB}MBまでです。小さくして選び直してください。`
  return ''
}

/** 登録メディアと同じ「準備→直接送信→登録完了」の口。URLは完了後の正本から読む。 */
export async function uploadCarouselImage(file: File, accountId: string): Promise<string> {
  const invalid = validateCarouselImage(file)
  if (invalid) throw new Error(invalid)
  const prepared = await api.media.prepareUploads({ accountId, files: [{
    filename: file.name, mimeType: file.type, sizeBytes: file.size,
    folderId: null, metadata: await extractMediaMetadata(file),
  }] })
  if (!prepared.success) throw new Error(prepared.error || '画像を送る準備ができませんでした。時間をおいて、もう一度お試しください。')
  if (prepared.data.sessions.length !== 1) throw new Error('画像を送る準備ができませんでした。時間をおいて、もう一度お試しください。')
  const session = prepared.data.sessions[0]
  const etag = await putMediaFile(session, file, () => {})
  const completed = await api.media.completeUpload(session.id, { accountId, etag })
  if (!completed.success) throw new Error(completed.error || '画像の登録を完了できませんでした。時間をおいて、もう一度お試しください。')
  if (completed.data?.status !== 'completed' || typeof completed.data.mediaId !== 'string' || !completed.data.mediaId.trim()) throw new Error('画像の登録を完了できませんでした。時間をおいて、もう一度お試しください。')
  const media = await api.media.detail(completed.data.mediaId, accountId)
  if (!media.success) throw new Error(media.error || '登録した画像を確認できませんでした。登録メディアから選び直してください。')
  if (media.data?.item?.kind !== 'image' || typeof media.data.item.url !== 'string' || !media.data.item.url.trim()) throw new Error('登録した画像を確認できませんでした。登録メディアから選び直してください。')
  return media.data.item.url
}
