import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { imageUploadErrorText } from './image-upload-error'

describe('rich-menus/new/image-upload-error の 413・403・429 分類ガード', () => {
  it('HTTP 413・403・429 を一般的な失敗文に潰さず、次の行動が分かる日本語へ変換する', () => {
    expect(imageUploadErrorText(new ApiError(413, 'Payload Too Large')))
      .toBe('画像が大きすぎます。1MB以下の画像を選んでください。')
    expect(imageUploadErrorText(new ApiError(403, 'Forbidden')))
      .toBe('このLINEアカウントのリッチメニューを操作する権限がありません。')
    expect(imageUploadErrorText(new ApiError(429, 'Too Many Requests')))
      .toBe('操作が混み合っています。少し待ってから、もう一度お試しください。')
  })

  it('400 の形式・寸法エラーや 500 の既定文は前どおり安全に返す', () => {
    expect(imageUploadErrorText(new ApiError(400, 'content-type must be image/png or image/jpeg')))
      .toBe('画像の形式はPNGかJPEGにしてください。')
    expect(imageUploadErrorText(new ApiError(500, 'D1_ERROR: internal')))
      .toBe('画像を読み込めませんでした。もう一度お試しください。')
  })
})
