'use client'

import { useEffect, useState } from 'react'
import type { MediaItem } from '@line-crm/shared'
import { api } from '@/lib/api'
import Button from './button'
import MediaPickerDialog from './media-picker-dialog'
import MediaThumbnail from './media-thumbnail'
import styles from './registered-image-select.module.css'

/** 登録メディアの画像を選択し、現在の選択と読み込み状態を示す。 */
export default function RegisteredImageSelect({ accountId, imageId, imageName, disabled, onSelect, onRemove }: {
  accountId: string | null
  imageId: string | null
  imageName: string | null
  disabled?: boolean
  onSelect: (image: MediaItem) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false); setOpen(false) }, [accountId, imageId])
  return <div className={styles.root}>
    {imageId && accountId && !failed ? <span className={styles.preview} onErrorCapture={() => setFailed(true)}><MediaThumbnail size="compact" kind="image" src={apiUrl(imageId, accountId)} alt="選択したメニューの画像" /></span> : null}
    <div className={styles.actions}>
      <Button type="button" disabled={!accountId || disabled} disabledReason={!accountId ? '店舗にLINEアカウントを設定すると画像を選べます。' : undefined} onClick={() => setOpen(true)}>登録メディアから選択する</Button>
      {imageId ? <Button type="button" onClick={onRemove} disabled={disabled}>選んだ画像を外す</Button> : null}
    </div>
    <p className={styles.note}>{failed ? '画像を読めません。登録メディアから選び直してください。' : imageId ? imageName ? `選択中：${imageName}` : '選択中の画像名を確認しています' : '画像はまだ選んでいません'}</p>
    <MediaPickerDialog open={open} accountId={accountId} kind="image" accountOnly title="メニューの画像を選ぶ" onClose={() => setOpen(false)} onSelect={image => { setFailed(false); onSelect(image); setOpen(false) }} />
  </div>
}

function apiUrl(id: string, accountId: string) { return api.media.contentUrl(id, accountId) }
