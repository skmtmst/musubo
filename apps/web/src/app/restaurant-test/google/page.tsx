'use client'

import GoogleV8, { type MediaUploadHelpers } from '@/v8/restaurant/google/google'
import { extractMediaMetadata, mediaAcceptForKind, putMediaFile, validateMediaFile } from '@/app/contents/media-direct-upload'

/*
 * ★V8 Googleビジネス（板 ほか6枚）。完全切り替え：画面は src/v8/restaurant/google。
 * 営業時間・確認・履歴・編集も V8 の共通部品で出す。
 * 端末からの画像アップロードの道具は src/v8 から @/app を読めないので、ここで渡す。
 */
const MEDIA_UPLOAD: MediaUploadHelpers = {
  accept: mediaAcceptForKind('image'),
  validate: validateMediaFile,
  extractMetadata: extractMediaMetadata,
  put: putMediaFile,
}

export default function Page() {
  return (
    <GoogleV8 mediaUpload={MEDIA_UPLOAD} />
  )
}
