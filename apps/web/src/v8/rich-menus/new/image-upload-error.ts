import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { ApiError } from '@/lib/api'
import { SIZE_LABEL } from './create-options'

const TOO_LARGE_TEXT = '画像が大きすぎます。1MB以下の画像を選んでください。'

/** 画像エラーのサーバ原文（英語）を日本語に写す。 */
export function imageUploadErrorText(err: unknown): string {
  const fallback = '画像を読み込めませんでした。もう一度お試しください。'
  if (!(err instanceof ApiError)) return fallback
  if (err.status === 413) return TOO_LARGE_TEXT
  if (err.status === 403) return 'このLINEアカウントのリッチメニューを操作する権限がありません。'
  if (err.status === 429) return '操作が混み合っています。少し待ってから、もう一度お試しください。'
  const message =
    err.status === 400 && err.message && !/^API error: /.test(err.message) ? err.message : ''
  if (!message) return fallback
  if (
    message.includes('content-type must be image/png or image/jpeg') ||
    message.includes('unrecognized image format')
  ) {
    return '画像の形式はPNGかJPEGにしてください。'
  }
  if (message.includes('exceeds 1MB limit')) {
    return TOO_LARGE_TEXT
  }
  if (message.includes('dimensions ')) {
    return `画像の大きさが合いません。${SIZE_LABEL.large}（大）か${SIZE_LABEL.compact}（小）の画像を選んでください。`
  }
  return japaneseDetailOf(err) || fallback
}
