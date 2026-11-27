'use client'
import { useGooglePermission } from './use-google-permission'
import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ImageFrame from '@/components/shared/image-frame'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import StatusBadge from '@/components/shared/status-badge'
import StickyBar from '@/components/shared/sticky-bar'
import { TextArea, TextField } from '@/components/shared/text-field'
import { api, ApiError } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { restaurantGoogleApi, type GooglePhoto, type GoogleProfileData, type GoogleProfileProposal } from '@/lib/restaurant-google-api'
import { errorMessage } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { formatNumber } from '@/lib/format'


type ProfileForm = { title: string; postalCode: string; administrativeArea: string; locality: string; addressLines: string; phone: string; websiteUri: string; description: string }

function formFrom(data: GoogleProfileData): ProfileForm {
  const p = data.profile
  return {
    title: p.title ?? '',
    postalCode: p.address?.postalCode ?? '',
    administrativeArea: p.address?.administrativeArea ?? '',
    locality: p.address?.locality ?? '',
    addressLines: (p.address?.addressLines ?? []).join(' / '),
    phone: p.phone ?? '',
    websiteUri: p.websiteUri ?? '',
    description: p.description ?? '',
  }
}

export function ProfileEditScreen({ accountId, go }: { accountId: string; go: GoogleNav }) {
  const saveErrors = useSaveFormErrors()
  const { allowed: canEdit, lockedReason } = useGooglePermission('manager')
  const submitLock = useRef(false)
  const pickerRequest = useRef(0)
  const [data, setData] = useState<GoogleProfileData | null>(null)
  const [form, setForm] = useState<ProfileForm | null>(null)
  const [photos, setPhotosRaw] = useState<GooglePhoto[] | null>(null)
  const [photosLoading, setPhotosLoading] = useState(false)
  const [photosError, setPhotosError] = useState('')
  const setPhotos = (next: GooglePhoto[]) => { setPhotosRaw(next); setPhotosError('') }
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [photosAttempt, setPhotosAttempt] = useState(0)
  const [adds, setAdds] = useState<MediaItem[]>([])
  const [deletes, setDeletes] = useState<string[]>([])
  const [picker, setPicker] = useState<{ open: boolean; items: MediaItem[]; loading: boolean; error: string }>({ open: false, items: [], loading: false, error: '' })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    restaurantGoogleApi.profile(accountId)
      .then((response) => { if (alive) { setData(response); setForm(formFrom(response)) } })
      .catch((err) => { if (alive) setLoadError(errorMessage(err, 'プロフィールを読み込めませんでした。')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false; pickerRequest.current += 1 }
  }, [accountId, profileAttempt])

  useEffect(() => {
    let alive = true
    setPhotosLoading(true)
    restaurantGoogleApi.photos(accountId)
      .then((response) => { if (alive) setPhotos(response.photos) })
      .catch((err) => { if (alive) { setPhotos([]); setPhotosError(errorMessage(err, '写真を読み込めませんでした。')) } })
      .finally(() => { if (alive) setPhotosLoading(false) })
    return () => { alive = false }
  }, [accountId, photosAttempt])

  const base = data ? formFrom(data) : null
  const changedFields = form && base ? (Object.keys(form) as Array<keyof ProfileForm>).filter((k) => form[k].trim() !== base[k].trim()) : []
  const addressChanged = changedFields.some((k) => k === 'postalCode' || k === 'administrativeArea' || k === 'locality' || k === 'addressLines')
  const dirty = changedFields.length > 0 || adds.length > 0 || deletes.length > 0
  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({ dirty, busy })

  const openPicker = async () => {
    if (!canEdit || busy || data?.closed) return
    const request = ++pickerRequest.current
    setPicker({ open: true, items: [], loading: true, error: '' })
    try {
      const response = await api.media.list(accountId, { kind: 'image', limit: 60, sort: 'newest' })
      if (request !== pickerRequest.current) return
      if (!response.success) throw new ApiError(500, response.error)
      setPicker({ open: true, items: response.data.items, loading: false, error: '' })
    } catch (err) {
      if (request !== pickerRequest.current) return
      setPicker({ open: true, items: [], loading: false, error: errorMessage(err, '登録メディアを読み込めませんでした。') })
    }
  }

  const submit = async () => {
    if (!form || !data || submitLock.current || !canEdit || data.closed || !dirty || form.description.length > 750) return
    submitLock.current = true
    setBusy(true)
    setActionError('')
    const proposals: GoogleProfileProposal[] = []
    if (changedFields.includes('title')) proposals.push({ field: 'title', value: form.title.trim() })
    if (addressChanged) proposals.push({ field: 'address', value: { postalCode: form.postalCode.trim(), administrativeArea: form.administrativeArea.trim(), locality: form.locality.trim(), addressLines: form.addressLines.split(' / ').map((l) => l.trim()).filter(Boolean) } })
    if (changedFields.includes('phone')) proposals.push({ field: 'phone', value: form.phone.trim() })
    if (changedFields.includes('websiteUri')) proposals.push({ field: 'websiteUri', value: form.websiteUri.trim() })
    if (changedFields.includes('description')) proposals.push({ field: 'description', value: form.description.trim() })
    for (const m of adds) proposals.push({ field: 'photo', action: 'add', mediaId: m.id })
    for (const name of deletes) proposals.push({ field: 'photo', action: 'delete', mediaName: name })
    const ids: string[] = []
    try {
      for (const proposal of proposals) {
        const response = await restaurantGoogleApi.proposeProfile(accountId, proposal)
        ids.push(response.change.id)
      }
      setAdds([]); setDeletes([]); setForm(formFrom(data))
      disarm()
      go({ tab: 'profile', view: 'confirm', id: ids.join(',') })
    } catch (err) {
      saveErrors.capture(err)
      setActionError(`${errorMessage(err, '変更案を作れませんでした。')}${ids.length ? `（${formatNumber(ids.length)}件は作成済みです。変更履歴から確認できます）` : ''}`)
    } finally {
      submitLock.current = false
      setBusy(false)
    }
  }

  if (loading) return <ListState kind="loading" title="プロフィールを読み込んでいます" />
  if (loadError || !data || !form) return <ListState kind="error" title="プロフィールを表示できませんでした" description={loadError} onRetry={() => { setProfileAttempt((n) => n + 1); if (photos === null || photosError) setPhotosAttempt((n) => n + 1) }} />

  const set = (key: keyof ProfileForm) => (value: string) => setForm({ ...form, [key]: value })
  const storeName = data.profile.title ?? data.store.name
  const visiblePhotos = (photos ?? []).filter((p) => !deletes.includes(p.name))
  const photoTotal = visiblePhotos.length + adds.length

  const editable = canEdit && !data.closed && !busy
  const closePicker = () => { pickerRequest.current += 1; setPicker((value) => ({ ...value, open: false, loading: false })) }
  return (
    <SaveErrorScope errors={saveErrors}><>
      <SectionHeader title="プロフィールを編集" note={<StatusBadge tone="warning">まだ反映していません</StatusBadge>} />
      <p className={styles.muted}>対象店舗：{storeName} / 変更した項目だけをGoogleへ送ります。送信前に確認画面を表示します。</p>
      {data.closed ? <Notice tone="danger">Google側で「臨時休業」または「閉業」になっているため、いまは変更できません。</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
        <Field label="店舗名" htmlFor="gb-title" note="Googleに表示される名前です。屋号以外の宣伝文句は入れないでください。">
          <SaveErrorField names={["title"]}><TextField id="gb-title" value={form.title} onChange={(e) => set('title')(e.target.value)} maxLength={100} disabled={!editable} /></SaveErrorField>
        </Field>
        <Notice tone="warn">住所を変えると、Googleが本人確認（はがきの郵送など）を求めることがあります。その間、変更は保留になります。</Notice>
        <Field label="郵便番号" htmlFor="gb-postal"><SaveErrorField names={["postalCode","address.postalCode"]}><TextField id="gb-postal" placeholder="150-0001" value={form.postalCode} onChange={(e) => set('postalCode')(e.target.value)} maxLength={8} disabled={!editable} /></SaveErrorField></Field>
        <Field label="都道府県" htmlFor="gb-region"><SaveErrorField names={["administrativeArea","address.administrativeArea"]}><TextField id="gb-region" placeholder="東京都" value={form.administrativeArea} onChange={(e) => set('administrativeArea')(e.target.value)} maxLength={20} disabled={!editable} /></SaveErrorField></Field>
        <Field label="市区町村" htmlFor="gb-locality"><SaveErrorField names={["locality","address.locality"]}><TextField id="gb-locality" placeholder="渋谷区神宮前" value={form.locality} onChange={(e) => set('locality')(e.target.value)} maxLength={40} disabled={!editable} /></SaveErrorField></Field>
        <Field label="番地・建物" htmlFor="gb-address"><SaveErrorField names={["addressLines","address.addressLines"]}><TextField id="gb-address" placeholder="1-2-3 こもれびビル 1F" value={form.addressLines} onChange={(e) => set('addressLines')(e.target.value)} maxLength={160} disabled={!editable} /></SaveErrorField></Field>
        <Field label="電話番号" htmlFor="gb-phone" note="ハイフンありで入力できます。"><SaveErrorField names={["phone"]}><TextField id="gb-phone" inputMode="tel" value={form.phone} onChange={(e) => set('phone')(e.target.value)} maxLength={20} disabled={!editable} /></SaveErrorField></Field>
        <Field label="ウェブサイト" htmlFor="gb-website"><SaveErrorField names={["websiteUri","website_uri"]}><TextField id="gb-website" inputMode="url" placeholder="https://" value={form.websiteUri} onChange={(e) => set('websiteUri')(e.target.value)} maxLength={200} disabled={!editable} /></SaveErrorField></Field>
        <Field label="店舗紹介文" htmlFor="gb-description" count={{ value: form.description.length, max: 750 }}>
          <SaveErrorField names={["description"]}><TextArea id="gb-description" rows={7} value={form.description} onChange={(e) => set('description')(e.target.value)} maxLength={750} disabled={!editable} /></SaveErrorField>
        </Field>
      </Card>
      <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label="写真">
        <SectionHeader size="small" title={`写真（${photos === null || Boolean(photosError) ? (adds.length ? `追加 ${formatNumber(adds.length)}枚` : '—') : `${formatNumber(photoTotal)}枚`}）`} actions={<Button lockedReason={lockedReason} onClick={() => void openPicker()} disabled={!canEdit || picker.loading || !editable}>登録メディアから追加する</Button>} />
        {photosError ? <Notice tone="warn" action={<Button variant="text" size="inline" onClick={() => { if (!photosLoading) setPhotosAttempt((n) => n + 1) }} disabled={photosLoading} busy={photosLoading}>写真を読み直す</Button>}>{photosError}</Notice> : null}
        <div className={styles.pickerGrid}>
          {visiblePhotos.map((p, index) => <div key={p.name} className={styles.imageSlot} role="group" aria-label={`既存の写真${index + 1}`}>
            <ImageFrame title="店舗写真" value={p.thumbnailUrl ?? p.googleUrl ?? null} previewAlt={`既存の写真${index + 1}`} readOnly />
            <Button lockedReason={lockedReason} variant="text" onClick={() => { if (editable) setDeletes((values) => [...values, p.name]) }} disabled={!editable} aria-label={`写真${index + 1}を削除`}>削除する</Button>
          </div>)}
          {adds.map((m) => <div key={m.id} className={styles.imageSlot}>
            <ImageFrame title="追加する写真" value={m.url} previewAlt={m.filename} readOnly />
            <span className={styles.imageName} title={m.filename}>{m.filename}（追加）</span>
            <Button variant="text" onClick={() => setAdds((values) => values.filter((x) => x.id !== m.id))} disabled={!editable} aria-label={`${m.filename} の追加をやめる`}>追加をやめる</Button>
          </div>)}
        </div>
        {deletes.length ? <Notice tone="warn" action={<Button variant="text" onClick={() => setDeletes([])} disabled={busy}>削除をやめる</Button>}>{formatNumber(deletes.length)}枚を削除します。</Notice> : null}
        {picker.open ? <Card appearance="outlined" padding="compact" layout="vertical" gap="normal" role="group" aria-label="登録メディアから写真を選ぶ">
          <SectionHeader size="small" title="登録メディアの画像" actions={<Button onClick={closePicker}>閉じる</Button>} />
          {picker.loading ? <ListState kind="loading" title="登録メディアを読み込んでいます" /> : null}
          {picker.error ? <ListState kind="error" title="登録メディアを読み込めませんでした" description={picker.error} onRetry={() => void openPicker()} /> : null}
          {!picker.loading && !picker.error && picker.items.length === 0 ? <ListState kind="empty" title="登録メディアに画像がありません" description="先に「登録メディア」で画像を追加してください。" emptyPreset="readonly" /> : null}
          <div className={styles.pickerGrid}>{picker.items.filter((m) => !adds.some((a) => a.id === m.id)).map((m) => <Button key={m.id} variant="text" size="thumbnail" title={m.filename} aria-label={`${m.filename} を追加`} disabled={!editable} onClick={() => setAdds((values) => [...values, m])}><img width={120} height={120} src={m.url} alt="" /></Button>)}</div>
        </Card> : null}
        <p className={styles.muted}>追加・削除した写真はGoogleの審査後に反映されます。人物の顔や個人情報が写った写真は追加しないでください。</p>
      </Card>
      <StickyBar actions={<>
        <Button lockedReason={lockedReason} onClick={() => { setForm(formFrom(data)); setAdds([]); setDeletes([]); setActionError('') }} disabled={!canEdit || busy || !dirty}>入力をクリア</Button>
        <Button lockedReason={lockedReason} variant="primary" onClick={() => void submit()} disabled={!canEdit || busy || !dirty || data.closed || form.description.length > 750} busy={busy} busyLabel="確認中…">変更内容を確認する</Button>
      </>} />
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="プロフィールの変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </></SaveErrorScope>
  )
}
