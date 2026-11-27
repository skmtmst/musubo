'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { BookingPhoto, BookingPhotoCatalog, BookingPhotoOwner, BookingStorePhotoSlot, BookingStorePhotoVisibility, MediaItem } from '@line-crm/shared'
import { bookingPhotosApi } from '@/lib/api-booking-photos'
import { api } from '@/lib/api'
import Checkbox from '@/components/shared/checkbox'
import Button from '@/components/shared/button'
import ReorderHandle from '@/components/shared/reorder-handle'
import Card, { CardActionRow, CardContent } from '@/components/shared/card'
import ListState, { ListEmptyMessage } from '@/components/shared/list-state'
import MediaThumbnail from '@/components/shared/media-thumbnail'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import SectionHeader from '@/components/shared/section-header'
import TruncatedText from '@/components/shared/truncated-text'
import Notice from '@/components/shared/notice'
import { isSaveConflict } from '@/components/shared/save-conflict'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { ListPageCards } from '@/components/templates/list-page'
import { notifySaved } from '@/components/shared/toast'
import { useV8TabEdit } from './tabs/shared'
import styles from './photos.module.css'

const LABELS = { exterior: '外観', interior: '店内', waiting: '待合' }
type Target = { owner: BookingPhotoOwner; id: string; name: string }
const keyOf = (target: Target) => `${target.owner}:${target.id}`
const ORDER_INSTRUCTIONS = 'つまみをドラッグして順番を変えられます。キーボードではスペースキーで持ち上げ、矢印キーで移動し、スペースキーで置きます。Escキーでやめます。'

function PhotoCard({ name, fieldKey, photo, accountId, editable, changed, busy, disabledReason, onPick, onRemove, onSave, position, sortable, visibilityControl, visibilityLabel }: {
  name: string; fieldKey: string; photo: BookingPhoto | null; accountId: string; editable: boolean; changed: boolean; busy: boolean
  onPick: () => void; onRemove: () => void; onSave?: () => void; position?: React.ReactNode
  sortable?: Pick<ReturnType<typeof useSortable>, 'setNodeRef' | 'transform' | 'transition' | 'isDragging' | 'isOver'>
  disabledReason?: string; visibilityControl?: React.ReactNode; visibilityLabel?: string
}) {
  const controls = <>
    <Button onClick={onPick} disabled={busy} disabledReason={disabledReason} aria-label={`${name}の写真を選択する`}>{photo ? '替える' : '写真を選択する'}</Button>
    {photo || position ? <Button onClick={onRemove} disabled={busy || !photo} disabledReason={disabledReason ?? (!photo ? '写真はありません。' : undefined)} aria-label={`${name}の写真を外す`}>外す</Button> : null}
    {onSave && changed ? <Button variant="primary" onClick={onSave} disabled={busy} disabledReason={disabledReason} aria-label={`${name}の写真を保存する`}>保存する</Button> : null}
  </>
  return <Card ref={sortable?.setNodeRef} layout="vertical" overflow="hidden" aria-label={`${name}の写真`}
    selected={sortable?.isDragging || sortable?.isOver}
    style={sortable ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, position: 'relative', zIndex: sortable.isDragging ? 1 : undefined } : undefined}>
    <div className={styles.photo}>
      {photo ? <MediaThumbnail kind="image" src={api.media.contentUrl(photo.mediaId, accountId)} alt={`${name}の写真`} />
        : <ListEmptyMessage>写真はありません</ListEmptyMessage>}
    </div>
    <CardContent>
      <SectionHeader title={position ? <span className={styles.positionTitle}>{position}<TruncatedText value={name} /></span> : <TruncatedText value={name} />} description={visibilityLabel} />
      {visibilityControl}
      {editable ? <SaveErrorField names={[fieldKey]}><div className={position ? styles.storeActions : styles.actions} role="group" aria-label={`${name}の写真を選ぶ操作`}>
        {position ? <CardActionRow>{controls}</CardActionRow> : controls}
      </div></SaveErrorField> : null}
    </CardContent>
  </Card>
}

function StorePhotoCard({ slot, index, disabled, ...props }: Omit<React.ComponentProps<typeof PhotoCard>, 'position' | 'sortable'> & {
  slot: BookingStorePhotoSlot; index: number; disabled: boolean
}) {
  const sortable = useSortable({ id: slot, disabled, attributes: { roleDescription: '写真の順番' } })
  return <PhotoCard {...props} sortable={sortable} position={<span className={styles.position}>
    {props.editable && !disabled ? <ReorderHandle {...sortable.attributes} {...sortable.listeners} look="icon" label={`${props.name}の写真`}
      ariaLabel={`${props.name}の写真を並べ替え`} title={ORDER_INSTRUCTIONS} className={styles.reorderHandle} /> : null}
    <span className={styles.positionNumber} data-photo-position={index + 1} title={`${index + 1}番目`}>{index + 1}</span>
  </span>} />
}

export default function PhotosTab({ accountId, canEditMenus, canEditSettings, onSaved }: {
  accountId: string; canEditMenus: boolean; canEditSettings: boolean; onSaved?: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const [catalog, setCatalog] = useState<BookingPhotoCatalog | null>(null)
  const [drafts, setDrafts] = useState<Record<string, BookingPhoto | null>>({})
  const [order, setOrder] = useState<BookingStorePhotoSlot[] | null>(null)
  const [visibilityDraft, setVisibilityDraft] = useState<Partial<BookingStorePhotoVisibility>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<Target | null>(null)
  const generation = useRef(0)
  const savingRef = useRef(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    try {
      const result = await bookingPhotosApi.list(accountId)
      if (request !== generation.current) return
      setCatalog(result.data)
      setConflict(false)
      setError('')
    } catch {
      if (request === generation.current) setError('写真を読み込めませんでした。入力は残しています。')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [accountId])
  useEffect(() => {
    setCatalog(null); setDrafts({}); setOrder(null); setVisibilityDraft({}); setPicker(null); setBusy(false); savingRef.current = false
    saveErrors.reset()
    void load()
    return () => { generation.current += 1 }
  }, [load, saveErrors])

  const store = catalog?.store
  const storeOrder = order ?? store?.order ?? []
  const visibility: BookingStorePhotoVisibility = { exterior: false, interior: false, waiting: false, ...store?.visibility, ...visibilityDraft }
  const dirty = Object.keys(drafts).length > 0 || order !== null || Object.keys(visibilityDraft).length > 0
  const reset = () => { setDrafts({}); setOrder(null); setVisibilityDraft({}); setConflict(false); setError(''); saveErrors.reset() }
  useV8TabEdit({ dirty, saving: busy, subject: '写真の変更', showBar: false, onReset: reset, onSave: () => {} })

  const value = (target: Target, saved: BookingPhoto | null) => Object.hasOwn(drafts, keyOf(target)) ? drafts[keyOf(target)]! : saved
  const change = (target: Target, next: BookingPhoto | null) => {
    saveErrors.clear(keyOf(target))
    if (target.owner === 'store') saveErrors.clear('store:')
    setDrafts(current => ({ ...current, [keyOf(target)]: next }))
  }
  const selected = (item: MediaItem) => {
    if (!picker || busy) return
    if (picker.owner === 'menu' ? !canEditMenus : !canEditSettings) return
    if (item.lineAccountId !== accountId || item.kind !== 'image' || item.archivedAt) {
      setError('このアカウントの画像を選んでください。'); return
    }
    change(picker, { mediaId: item.id, url: item.url })
    setPicker(null)
  }

  async function save(target: Target) {
    if (!catalog || savingRef.current || conflict || loading) return
    if (target.owner === 'menu' ? !canEditMenus : !canEditSettings) return
    saveErrors.clear(keyOf(target))
    if (target.owner === 'store') for (const slot of storeOrder) { saveErrors.clear(`store:${slot}`); saveErrors.clear(`store:visibility:${slot}`) }
    savingRef.current = true; setBusy(true); setError('')
    const request = generation.current
    try {
      if (target.owner === 'store' && store) {
        const photos = {
          exterior: value({ owner: 'store', id: 'exterior', name: LABELS.exterior }, store.photos.exterior),
          interior: value({ owner: 'store', id: 'interior', name: LABELS.interior }, store.photos.interior),
          waiting: value({ owner: 'store', id: 'waiting', name: LABELS.waiting }, store.photos.waiting),
        }
        const result = await bookingPhotosApi.saveStore(accountId, {
          expectedVersion: store.version, order: storeOrder, visibility,
          photos: { exterior: photos.exterior?.mediaId ?? null, interior: photos.interior?.mediaId ?? null, waiting: photos.waiting?.mediaId ?? null },
        })
        if (request !== generation.current) return
        setCatalog(current => current ? { ...current, store: { ...store, photos, order: storeOrder, visibility, version: result.data.version } } : current)
        setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith('store:'))))
        setOrder(null); setVisibilityDraft({})
      } else if (target.owner !== 'store') {
        const owner = target.owner === 'menu' ? 'menus' : 'staff'
        const item = catalog[owner].find(row => row.id === target.id)
        if (!item) return
        const photo = value(target, item.photo)
        const body = { expectedVersion: item.version, mediaId: photo?.mediaId ?? null }
        const result = target.owner === 'menu' ? await bookingPhotosApi.saveMenu(accountId, target.id, body) : await bookingPhotosApi.saveStaff(accountId, target.id, body)
        if (request !== generation.current) return
        setCatalog(current => current ? { ...current, [owner]: current[owner].map(row => row.id === target.id ? { ...row, photo, version: result.data.version } : row) } : current)
        setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== keyOf(target))))
      }
      notifySaved('写真を保存しました')
      onSaved?.()
    } catch (caught) {
      if (request !== generation.current) return
      const status = caught && typeof caught === 'object' && 'status' in caught ? caught.status : undefined
      const problems = readSaveFieldErrors(caught)
      const fields: Record<string, string> = Object.fromEntries(Object.entries(problems).map(([field, message]) => {
        if (target.owner === 'store' && field.startsWith('visibility.') && Object.hasOwn(LABELS, field.slice(11))) return [`store:visibility:${field.slice(11)}`, message]
        if (target.owner === 'store' && field.startsWith('photos.') && Object.hasOwn(LABELS, field.slice(7))) return [`store:${field.slice(7)}`, message]
        if (field === 'expectedVersion' || field === 'mediaId' || (target.owner === 'store' && (field === 'order' || field === 'photos' || field === 'visibility'))) return [keyOf(target), message]
        return [field, message]
      }))
      if ((status === 400 || status === 422) && !Object.keys(fields).length) fields[keyOf(target)] = '写真の選び方を確かめて、もう一度保存してください。'
      saveErrors.capture({ status, fields })
      if (isSaveConflict(caught)) {
        setConflict(true)
        setError('ほかの人が更新しました。入力を残して最新の写真を読み直し、確認してから保存してください。')
      } else setError('写真を保存できませんでした。入力は残しています。')
    } finally {
      if (request === generation.current) { savingRef.current = false; setBusy(false) }
    }
  }

  if (loading && !catalog) return <ListState kind="loading" title="写真を読み込んでいます" />
  if (!catalog) return <ListState kind="error" title="写真を読み込めませんでした" onRetry={() => void load()} />
  const disabled = busy || loading || conflict
  const disabledReason = conflict ? '最新の写真を読み直してから保存してください。' : busy ? '写真を保存しています。' : loading ? '写真を読み直しています。' : undefined
  const storeChanged = Object.keys(visibilityDraft).length > 0 || order !== null || Object.keys(drafts).some(key => key.startsWith('store:'))
  const positionOf = (id: unknown) => storeOrder.indexOf(id as BookingStorePhotoSlot) + 1
  const photoName = (id: unknown) => LABELS[id as BookingStorePhotoSlot] ?? '写真'
  const announcements: Announcements = {
    onDragStart: ({ active }) => `${photoName(active.id)}の写真を持ち上げました。${positionOf(active.id)}番目です。`,
    onDragOver: ({ active, over }) => over ? `${photoName(active.id)}の写真を${positionOf(over.id)}番目へ移動します。` : '写真の外です。置いても順番は変わりません。',
    onDragEnd: ({ active, over }) => over ? `${photoName(active.id)}の写真を${positionOf(over.id)}番目に置きました。保存すると反映されます。` : '順番は変わりませんでした。',
    onDragCancel: () => '並べ替えをやめました。順番は変わりません。',
  }
  const reorder = ({ active, over }: DragEndEvent) => {
    if (!canEditSettings || disabled || !over || active.id === over.id) return
    const from = storeOrder.indexOf(active.id as BookingStorePhotoSlot), to = storeOrder.indexOf(over.id as BookingStorePhotoSlot)
    if (from < 0 || to < 0) return
    saveErrors.clear('store:')
    setOrder(arrayMove(storeOrder, from, to))
  }
  return <SaveErrorScope errors={saveErrors}><div className={styles.root} aria-busy={busy}>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {error ? <Button onClick={() => void load()} disabled={busy || loading} disabledReason={busy ? '写真を保存しています。' : '写真を読み直しています。'}>入力を残して読み直す</Button> : null}
    <SaveErrorField names={['store:']}><section className={styles.section} aria-label="お店の写真">
      <SectionHeader title="お店" description={canEditSettings ? '外観・店内・待合を各1枚。つまみで順番を入れ替え、保存すると反映されます。' : '外観・店内・待合を各1枚。番号の順に表示されます。'}
        actions={canEditSettings && storeChanged ? <Button variant="primary" onClick={() => void save({ owner: 'store', id: '', name: 'お店' })} disabled={disabled} disabledReason={disabledReason}>お店の写真を保存する</Button> : undefined} />
      <DndContext key={accountId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}
        accessibility={{ announcements, screenReaderInstructions: { draggable: ORDER_INSTRUCTIONS } }}>
      <SortableContext items={storeOrder} strategy={rectSortingStrategy}>
      <ListPageCards>
        {storeOrder.map((slot, index) => {
          const target = { owner: 'store' as const, id: slot, name: LABELS[slot] }
          return <StorePhotoCard key={slot} slot={slot} index={index} disabled={!canEditSettings || disabled} name={target.name} fieldKey={keyOf(target)} photo={value(target, store?.photos[slot] ?? null)} accountId={accountId} editable={canEditSettings}
            changed={storeChanged} busy={disabled} disabledReason={disabledReason} onPick={() => setPicker(target)} onRemove={() => change(target, null)}
            visibilityLabel={canEditSettings ? undefined : visibility[slot] ? 'お客さまの予約画面に出す' : 'お客さまの予約画面に出さない'}
            visibilityControl={canEditSettings ? <SaveErrorField names={[`store:visibility:${slot}`]}><Checkbox
              aria-label={`${target.name}をお客さまの予約画面に出す`} checked={visibility[slot]} disabled={disabled}
              onCheckedChange={next => { saveErrors.clear('store:'); saveErrors.clear(`store:visibility:${slot}`); setVisibilityDraft(current => ({ ...current, [slot]: next })) }}
            >お客さまの予約画面に出す</Checkbox></SaveErrorField> : null}
            />
        })}
      </ListPageCards>
      </SortableContext>
      </DndContext>
    </section></SaveErrorField>
    {(['menu', 'staff'] as const).map(owner => {
      const rows = owner === 'menu' ? catalog.menus : catalog.staff
      const label = owner === 'menu' ? 'メニュー' : 'スタッフ'
      return <section key={owner} className={styles.section} aria-label={`${label}の写真`}>
        <SectionHeader title={label} description={owner === 'menu' ? 'メニューごとに1枚を登録できます。' : 'スタッフごとに1枚を登録できます。'} />
        {rows.length ? <ListPageCards columns={owner === 'menu' ? 4 : 3}>
          {rows.map(item => {
            const target = { owner, id: item.id, name: item.name }
            return <PhotoCard key={item.id} name={item.name} fieldKey={keyOf(target)} photo={value(target, item.photo)} accountId={accountId}
              editable={owner === 'menu' ? canEditMenus : canEditSettings} changed={Object.hasOwn(drafts, keyOf(target))} busy={disabled} disabledReason={disabledReason}
              onPick={() => setPicker(target)} onRemove={() => change(target, null)} onSave={() => void save(target)} />
          })}
        </ListPageCards> : <ListState kind="empty" title={`${label}はまだありません`} />}
      </section>
    })}
    <Notice tone="info">使っている写真は、先にここから外して保存するまで登録メディアから削除できません。</Notice>
    <MediaPickerDialog open={picker !== null && (picker.owner === 'menu' ? canEditMenus : canEditSettings)} accountId={accountId} kind="image" accountOnly
      title={`${picker?.name ?? ''}の写真を選ぶ`} onClose={() => setPicker(null)} onSelect={selected} />
  </div></SaveErrorScope>
}
