'use client'

import { useRef, useState } from 'react'
import { RESTAURANT_COURSE_PHOTO_LIMIT, type RestaurantCoursePhoto } from '@line-crm/shared'
import { Plus } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import { TextField } from '@/components/shared/text-field'
import { api } from '@/lib/api'
import CoursePhotoPicker from './course-photo-picker'
import styles from './course-photos.module.css'

type Props = {
  accountId: string | null
  photos: RestaurantCoursePhoto[]
  disabled: boolean
  error: string | null
  onChange: (photos: RestaurantCoursePhoto[]) => void
}

export default function CoursePhotos({ accountId, photos, disabled, error, onChange }: Props) {
  const [pickingAccountId, setPickingAccountId] = useState<string | null>(null)
  const [adjustingState, setAdjustingState] = useState<{ accountId: string | null; photo: RestaurantCoursePhoto } | null>(null)
  const [unavailableState, setUnavailableState] = useState<{ accountId: string | null; ids: string[] }>({ accountId, ids: [] })
  const dragging = useRef<number | null>(null)
  const picking = Boolean(accountId) && !disabled && pickingAccountId === accountId
  const unavailable = unavailableState.accountId === accountId ? unavailableState.ids : []
  const adjusting = !disabled && adjustingState && adjustingState.accountId === accountId && photos.some(photo => photo.mediaId === adjustingState.photo.mediaId)
    ? adjustingState.photo
    : null
  const index = adjusting ? photos.findIndex(photo => photo.mediaId === adjusting.mediaId) : -1
  const markUnavailable = (mediaId: string) => setUnavailableState(current => {
    const ids = current.accountId === accountId ? current.ids : []
    return ids.includes(mediaId) ? { accountId, ids } : { accountId, ids: [...ids, mediaId] }
  })
  const image = (photo: RestaurantCoursePhoto, alt: string) => accountId && !unavailable.includes(photo.mediaId)
    ? <img className={styles.image} src={api.media.contentUrl(photo.mediaId, accountId)} alt={alt}
        draggable={false} style={{ objectPosition: `${photo.x}% ${photo.y}%` }}
        onError={() => markUnavailable(photo.mediaId)} />
    : <span className={styles.imageUnavailable}>画像なし</span>
  const remove = (mediaId: string) => {
    if (disabled) return
    onChange(photos.filter(photo => photo.mediaId !== mediaId))
    setUnavailableState(current => ({
      accountId,
      ids: (current.accountId === accountId ? current.ids : []).filter(id => id !== mediaId),
    }))
    setAdjustingState(null)
  }
  const move = (from: number, to: number) => {
    if (disabled || from === to || from < 0 || to < 0 || to >= photos.length) return
    const next = photos.slice()
    const [photo] = next.splice(from, 1)
    if (!photo) return
    next.splice(to, 0, photo)
    onChange(next)
  }

  return <Card variant="form" gap="tight" aria-label="写真">
    <div className={styles.heading}><strong>写真</strong><span>最大5枚・正方形で表示</span></div>
    <ul className={styles.photos} aria-label="コースの写真">
      {photos.map((photo, position) => (
        <li key={photo.mediaId} className={position === 0 ? `${styles.tile} ${styles.cover}` : styles.tile}
          draggable={!disabled}
          onDragStart={event => { dragging.current = position; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(position)) }}
          onDragEnd={() => { dragging.current = null }}
          onDragOver={event => { if (dragging.current !== null) event.preventDefault() }}
          onDrop={event => {
            event.preventDefault()
            if (dragging.current !== null) move(dragging.current, position)
            dragging.current = null
          }}>
          <Button variant="text" size="thumbnail" aria-label={`写真 ${position + 1} の表示範囲を調整`}
            disabled={disabled} onClick={() => setAdjustingState({ accountId, photo })}>
            {image(photo, '')}
            {position === 0 ? <span className={styles.badge}>表紙</span> : null}
          </Button>
        </li>
      ))}
      {photos.length < RESTAURANT_COURSE_PHOTO_LIMIT ? <li className={styles.tile}>
        <Button variant="text" size="thumbnail" aria-label="写真を追加" disabled={disabled || !accountId}
          onClick={() => setPickingAccountId(accountId)}>
          <span className={styles.addLabel}><Plus size={16} aria-hidden="true" />追加</span>
        </Button>
      </li> : null}
    </ul>
    <p className={styles.note}>ドラッグで並べ替え（先頭が表紙）。写真をタップすると表示範囲を調整できます。元の写真はそのまま残ります。</p>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {photos.some(photo => unavailable.includes(photo.mediaId)) ?
      <Notice tone="warn">画像を読めません。読めない写真を外し、登録メディアから選び直してください。</Notice> : null}
    {picking && accountId ? <CoursePhotoPicker key={accountId} accountId={accountId}
      existing={photos.map(photo => photo.mediaId)} onClose={() => setPickingAccountId(null)}
      onAdd={ids => {
        if (disabled) return
        setPickingAccountId(null)
        const added = [...new Set(ids)].filter(id => !photos.some(photo => photo.mediaId === id))
        onChange([...photos, ...added.map(mediaId => ({ mediaId, x: 50, y: 50 }))].slice(0, RESTAURANT_COURSE_PHOTO_LIMIT))
      }} /> : null}
    {adjusting ? <Dialog open title="写真の表示範囲を調整" onCancel={() => setAdjustingState(null)}
      footer={<DialogActions>
        <Button variant="text" disabled={disabled} onClick={() => remove(adjusting.mediaId)}>写真を外す</Button>
        <Button onClick={() => setAdjustingState(null)}>キャンセル</Button>
        <Button variant="primary" disabled={disabled} onClick={() => {
          if (disabled) return
          onChange(photos.map(photo => photo.mediaId === adjusting.mediaId ? adjusting : photo))
          setAdjustingState(null)
        }}>この範囲にする</Button>
      </DialogActions>}>
      <div className={styles.preview}>{image(adjusting, `写真 ${index + 1} の表示見本`)}</div>
      <div className={styles.adjust}>
        <Field label="左右の位置" optional={false}>
          <TextField type="range" min={0} max={100} value={adjusting.x}
            onChange={event => setAdjustingState({ accountId, photo: { ...adjusting, x: Number(event.target.value) } })} />
        </Field>
        <Field label="上下の位置" optional={false}>
          <TextField type="range" min={0} max={100} value={adjusting.y}
            onChange={event => setAdjustingState({ accountId, photo: { ...adjusting, y: Number(event.target.value) } })} />
        </Field>
      </div>
      <DialogActions>
        <Button disabled={disabled || index <= 0} onClick={() => move(index, index - 1)}>前へ移動</Button>
        <Button disabled={disabled || index < 0 || index === photos.length - 1} onClick={() => move(index, index + 1)}>後ろへ移動</Button>
      </DialogActions>
    </Dialog> : null}
  </Card>
}
