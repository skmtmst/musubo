'use client'

import { storedStringList } from '@/lib/stored-json'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check } from 'lucide-react'
import { CreatePage } from '@/components/templates/create-page'
import PreviewLauncher from '@/components/templates/preview-launcher'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import PageResourceScope, { usePageResourceTask } from '@/components/shell/page-resource-scope'
import { resolveResourceTitle } from '@/lib/resource-title'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import DateTimeField from '@/components/shared/date-time-field'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import NumberInput from '@/components/shared/number-field'
import Select from '@/components/shared/select'
import TargetMissing from '@/components/shared/target-missing'
import { Field, TextArea } from '@/components/shared/form-controls'
import RegisteredImageSelect from '@/components/shared/registered-image-select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { TextField } from '@/components/shared/text-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifySaved } from '@/components/shared/toast'
import { emptyValue } from '@/components/shared/empty-value'
import { useAccount } from '@/contexts/account-context'
import { api, ApiError, fetchApi } from '@/lib/api'
import { formatDateTime as polishFormatDateTime, formatYen } from '@/lib/format'
import { datetimeLocalJstToUtcIso } from '@/lib/jst-datetime'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { restaurantTestApi, type RestaurantMenuItem } from '@/lib/restaurant-test-api'
import { MenuPaymentFields, PaymentConflictError, PaymentSideCard, useMenuPayment } from '@/v8/booking-payments/public/menu-payment/index'
import styles from './edit.module.css'

/*
 * ★V8 メニュー管理 › コース・単品の編集（修正案 f4bLF の mauOC）。1枚の編集ページ＋右の説明カード。
 * 前の「追加・変更の窓」は消し、一覧の［変更］［メニューを追加する］はここへ来る。
 * 受け付ける指定：?id=<品目>（変更）・?store=<店舗>（追加）。
 * 送る形は前の窓と同じ（createMenu／updateMenu。価格変更は確認後に確定）。お支払いはコースだけ。
 * 「受ける人数」は今のデータに無いので置かない（口待ち）。所要時間は読むだけ。
 */

type Period = 'lunch' | 'dinner' | 'both'
type Draft = { kind: 'course' | 'a_la_carte'; name: string; price: string; period: Period; effectiveAt: string; allergens: string; description: string; imageMediaId: string | null; status: 'draft' | 'active' }
const LIST_HREF = '/restaurant-test/menu'


function periodLabel(periods: string[]): string {
  return periods.map((period) => (period === 'lunch' ? 'ランチ' : 'ディナー')).join('・') || emptyValue('unknown')
}
function draftOf(item: RestaurantMenuItem | null): Draft {
  if (!item) return { kind: 'course', name: '', price: '', period: 'dinner', effectiveAt: '', allergens: '', description: '', imageMediaId: null, status: 'draft' }
  const periods = storedStringList(item.service_periods_json)
  return {
    kind: item.kind, name: item.name, price: String(item.price),
    period: periods.length > 1 ? 'both' : periods[0] === 'lunch' ? 'lunch' : 'dinner',
    effectiveAt: '', allergens: storedStringList(item.allergens_json).join(', '), description: item.description ?? '', imageMediaId: item.image_media_id ?? null, status: item.status === 'draft' ? 'draft' : 'active',
  }
}

function MenuEditBody() {
  const captureResource = usePageResourceTask()
  const params = useSearchParams()
  const id = params.get('id')
  const storeParam = params.get('store')
  const router = useRouter()
  const saveErrors = useSaveFormErrors()
  const { selectedAccountId } = useAccount()
  const contextKey = JSON.stringify([selectedAccountId, id, storeParam])
  const currentContext = useRef(contextKey)
  currentContext.current = contextKey
  const loadSequence = useRef(0)
  const canEdit = canManageRole(useStaffRole())
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [item, setItem] = useState<RestaurantMenuItem | null>(null)
  const [storeId, setStoreId] = useState<string | null>(null)
  const [storeIdentity, setStoreIdentity] = useState<{ accountId: string; id: string; name: string | null } | null>(null)
  const [storeAccountId, setStoreAccountId] = useState<string | null>(null)
  const [mediaName, setMediaName] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(draftOf(null))
  const [saved, setSaved] = useState<Draft>(draftOf(null))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuConflict, setMenuConflict] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingPrice, setConfirmingPrice] = useState(false)
  const [confirmingPublish, setConfirmingPublish] = useState(false)

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const sequence = ++loadSequence.current
    setState('loading')
    try {
      const response = await restaurantTestApi.snapshot(selectedAccountId)
      if (sequence !== loadSequence.current || currentContext.current !== contextKey) return
      const found = id ? response.data.menuItems.find((row) => row.id === id) ?? null : null
      setItem(found)
      const nextStoreId = found?.store_id ?? storeParam ?? response.data.stores[0]?.id ?? null
      setStoreId(nextStoreId)
      setStoreIdentity(nextStoreId ? { accountId: selectedAccountId, id: nextStoreId, name: response.data.stores.find(store => store.id === nextStoreId)?.name ?? null } : null)
      setStoreAccountId(response.data.stores.find(store => store.id === nextStoreId)?.line_account_id ?? null)
      setDraft(draftOf(found)); setSaved(draftOf(found))
      setMenuConflict(false); setError(null)
      setState('ready')
    } catch {
      if (sequence === loadSequence.current && currentContext.current === contextKey) setState('error')
    }
  }, [selectedAccountId, id, storeParam, contextKey])
  useEffect(() => { void load(); return () => { loadSequence.current++ } }, [load])

  useEffect(() => {
    let active = true
    setMediaName(null)
    if (draft.imageMediaId && storeAccountId) void api.media.detail(draft.imageMediaId, storeAccountId)
      .then(result => { if (active) setMediaName(result.success ? result.data.item.filename : '画像名を確認できませんでした') })
      .catch(() => { if (active) setMediaName('画像名を確認できませんでした') })
    return () => { active = false }
  }, [draft.imageMediaId, storeAccountId])

  const editing = item
  const course = draft.kind === 'course'
  const payment = useMenuPayment('course', selectedAccountId, editing && editing.kind === 'course' ? editing.id : null)
  const priceChanged = Boolean(editing && draft.price !== '' && Number(draft.price) !== editing.price)
  const priceStartsAt = draft.effectiveAt ? new Date(datetimeLocalJstToUtcIso(draft.effectiveAt)) : null
  const priceStartsLater = Boolean(priceStartsAt && priceStartsAt.getTime() > Date.now())
  const dirty = state === 'ready' && (JSON.stringify(draft) !== JSON.stringify(saved) || payment.dirty)
  const pendingTitle = id ? 'メニューを編集' : course ? 'コースを追加する' : 'メニューを追加する'
  const title = resolveResourceTitle({ name: editing?.name, loaded: state === 'ready', pendingTitle })
  usePageTitle(title)
  usePageCrumbs([{ label: 'メニュー管理', href: LIST_HREF }])
  const exceedsPriceLimit = (!editing || priceChanged) && Number(draft.price) > 1_000_000
  const valid = draft.name.trim() !== '' && draft.price !== '' && Number.isInteger(Number(draft.price)) && Number(draft.price) >= 0 && !exceedsPriceLimit
  const priceError = draft.price === '' ? undefined : Number(draft.price) < 0 ? '値段は0円以上で入れてください。' : exceedsPriceLimit ? '値段は1,000,000円以下で入れてください。' : !Number.isInteger(Number(draft.price)) ? '値段は整数で入れてください。' : undefined

  const [confirmationScope, setConfirmationScope] = useState('')
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null)
  const confirmationVersion = useRef({ key: contextKey, generation: 0 })
  if (confirmationVersion.current.key !== contextKey) confirmationVersion.current = { key: contextKey, generation: confirmationVersion.current.generation + 1 }
  const currentConfirmationScope = JSON.stringify([contextKey, confirmationVersion.current.generation])
  const mutationContext = useRef<{ key: string; menuSignature: string | null }>({ key: contextKey, menuSignature: null })
  if (mutationContext.current.key !== contextKey) mutationContext.current = { key: contextKey, menuSignature: null }
  useEffect(() => { setBusy(false); setDeleting(false); setConfirmingPrice(false); setConfirmingPublish(false); setMenuConflict(false); setError(null) }, [contextKey])

  async function save(version = confirmedRevision) {
    if (!canEdit || !selectedAccountId || !valid || menuConflict) return
    if (editing && (!dirty || !Number.isSafeInteger(version) || !version)) return
    const isCurrent = captureResource()
    if (!isCurrent()) return
    const attempt = mutationContext.current
    const stillHere = () => isCurrent() && mutationContext.current === attempt
    setBusy(true); setError(null); setImageError(null)
    const body = {
      kind: draft.kind, name: draft.name, price: Number(draft.price),
      description: draft.description.trim() || null, ...(editing && draft.imageMediaId === (editing.image_media_id ?? null) ? {} : { imageMediaId: draft.imageMediaId }),
      effectiveAt: draft.effectiveAt ? datetimeLocalJstToUtcIso(draft.effectiveAt) : null,
      allergens: draft.allergens.split(',').map((part) => part.trim()).filter(Boolean),
      servicePeriods: draft.period === 'both' ? ['lunch', 'dinner'] : [draft.period],
    }
    try {
      if (editing) {
        const updateBody = { ...body, expectedVersion: version!, ...(editing.status === 'draft' && draft.status === 'active' ? { status: 'active' } : {}) }
        const signature = JSON.stringify([editing.id, updateBody])
        if (attempt.menuSignature !== signature) {
          await restaurantTestApi.updateMenu(selectedAccountId, editing.id, updateBody)
          attempt.menuSignature = signature
        }
        if (editing.kind === 'course') await payment.save(editing.id)
        if (!stillHere()) return
        notifySaved(priceChanged ? (priceStartsLater ? '価格変更を確定しました。指定した開始日時に反映します。' : '価格を変更しました。') : 'メニューを更新しました。')
      } else {
        if (!storeId) throw new Error('store_missing')
        await restaurantTestApi.createMenu(selectedAccountId, { storeId, ...body, status: draft.status })
        if (!stillHere()) return
        notifySaved(draft.status === 'draft' ? '下書きのメニューを追加しました。' : 'メニューを公開しました。')
      }
      if (!stillHere()) return
      setSaved(draft)
      router.push(LIST_HREF)
      return true
    } catch (cause) {
      if (!stillHere()) return
      if (cause instanceof ApiError && cause.code === 'menu_confirmation_conflict') {
        setDeleting(false); setConfirmingPrice(false); setConfirmingPublish(false); setConfirmedRevision(null)
        setMenuConflict(true)
        setError('ほかの人が変更しました。最新を読み込むと入力は消えます。')
        return false
      }
      /* お支払いの版が古い（409）ときは共通の帯と比べる窓で選んでもらう。ページの中身は保存済み。 */
      if (cause instanceof PaymentConflictError) { setSaved(draft); setError('メニュー本体は保存しました。お支払いの設定は、閉じて最新の内容と比べてください。'); return false }
      saveErrors.capture(cause)
      if (cause instanceof ApiError && cause.code === 'MENU_IMAGE_UNAVAILABLE') setImageError('選択した画像を利用できません。登録メディアから選び直してください。')
      setError('保存できませんでした。入力を確かめて、もう一度お試しください。')
      return false
    } finally {
      if (stillHere()) setBusy(false)
    }
  }

  async function remove() {
    if (menuConflict || !editing || !selectedAccountId || !Number.isSafeInteger(confirmedRevision) || !confirmedRevision) return
    const isCurrent = captureResource()
    if (!isCurrent()) return
    const attempt = mutationContext.current
    const stillHere = () => isCurrent() && mutationContext.current === attempt
    setBusy(true); setError(null)
    try {
      await fetchApi(`/api/restaurant-test/menus/${encodeURIComponent(editing.id)}?account_id=${encodeURIComponent(selectedAccountId)}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: confirmedRevision }) })
      if (!stillHere()) return
      notifySaved('メニューを削除しました。')
      setSaved(draft)
      router.push(LIST_HREF)
      return true
    } catch (error) {
      if (!stillHere()) return
      if (error instanceof ApiError && error.code === 'menu_confirmation_conflict') {
        setDeleting(false); setConfirmedRevision(null); setMenuConflict(true)
        setError('ほかの人が変更しました。最新を読み込むと入力は消えます。')
        return false
      }
      setError(japaneseDetailOf(error) || '削除できませんでした。')
      return false
    } finally {
      if (stillHere()) setBusy(false)
    }
  }

  const side = useMemo(() => (
    <div className={styles.side}>
      <PaymentSideCard title="決済をつないでいない店のとき">「お支払い」の段は出さず、この 1 行だけ出します（押せない形にしない）。</PaymentSideCard>
      <PaymentSideCard title="お客さまの見え方">予約の 5 段目に「お支払い」が出て、Stripe の支払いページへ進みます。払い終わると予約が決まります。払われないと仮の予約は取り消します。</PaymentSideCard>
    </div>
  ), [])

  if (!selectedAccountId) return <ListState kind="empty" title="アカウントを選択してください。" />
  if (state === 'loading') return <ListState kind="loading" title="メニューを読み込んでいます" />
  if (state === 'error') return <ListState kind="error" title="メニューを読み込めませんでした" onRetry={() => void load()} />
  if (id && !editing) return <TargetMissing kind="unspecified" title="このメニューは見つかりません" description="一覧から、変更するメニューを選び直してください。" backHref={LIST_HREF} backLabel="メニュー管理へ戻る" />

  const draftItem = editing?.status === 'draft'
  return (
    <SaveErrorScope errors={saveErrors}>
      <CreatePage
        boardId="mauOC"
        dirty={dirty && !busy}
        busy={busy}
        readOnly={!canEdit}
        title={title}
        help={<>コースと単品の名前・値段・提供時間・アレルギーと、お支払いの方法を決めます。価格変更は確認して保存すると確定します。</>}
        preview={side}
        previewSurface="plain"
        previewToggle={<PreviewLauncher title="お支払いの説明" label="お支払いの説明を見る">{side}</PreviewLauncher>}
        destructive={canEdit && editing ? <Button variant="text" textTone="danger" onClick={() => { setConfirmationScope(currentConfirmationScope); setConfirmedRevision(editing.confirmation_revision); setError(null); setDeleting(true) }} disabled={busy || menuConflict}>削除する</Button> : undefined}
        footerActions={<>
          <Button onClick={() => router.push(LIST_HREF)} disabled={busy}>キャンセル</Button>
          {canEdit ? <Button variant="primary" busy={busy} disabled={menuConflict || !valid || (Boolean(editing) && !dirty)} disabledReason={!valid ? priceError ? '値段を確認してください。' : '名前と値段を入力してください。' : editing && !dirty ? '変更していません' : undefined} onClick={() => { setConfirmationScope(currentConfirmationScope); setConfirmedRevision(editing?.confirmation_revision ?? null); setError(null); if ((!editing || draftItem) && draft.status === 'active') setConfirmingPublish(true); else if (priceChanged) setConfirmingPrice(true); else void save(editing?.confirmation_revision ?? null) }}><Check size={16} aria-hidden="true" />{editing ? '保存する' : '保存して追加する'}</Button> : null}
        </>}
      >
        {error ? <Notice tone="danger" role="alert">{error}{menuConflict ? <Button onClick={() => { void load() }}>最新を読み込む</Button> : null}</Notice> : null}
        {canEdit ? (
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="基本" />
            {!editing || draftItem ? <Field label="保存する状態" help="下書きは、お客さまに見せるメニューには出ません。内容を確かめてから公開できます。">
              <SaveErrorField names={['status', 'draft.status']}><Select aria-label="保存する状態" size="full" value={draft.status} onChange={(value) => setDraft({ ...draft, status: value === 'active' ? 'active' : 'draft' })} options={[{ value: 'draft', label: '下書き' }, { value: 'active', label: '公開' }]} /></SaveErrorField>
            </Field> : null}
            <SettingsFormRow layout="columns" columns={3}>
              <Field label={course ? 'コースの名前' : 'メニューの名前'} htmlFor="rs-menu-name" required>
                <SaveErrorField names={['name', 'draft.name']}><TextField id="rs-menu-name" aria-label="メニュー名" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></SaveErrorField>
              </Field>
              <Field label={course ? '1名の値段' : '値段'} htmlFor="rs-menu-price" required error={priceError}>
                <SaveErrorField names={['price', 'draft.price']}><NumberInput id="rs-menu-price" aria-label="価格（税込）" unit="円" type="number" min={0} required value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} /></SaveErrorField>
              </Field>
              <Field label="所要時間（変更不可）" htmlFor="rs-menu-duration" optional={false}>
                <TextField id="rs-menu-duration" aria-label="時間" disabled value={editing?.duration_minutes ? `${editing.duration_minutes} 分` : emptyValue('unknown')} />
              </Field>
            </SettingsFormRow>
            <SettingsFormRow layout="columns" columns={3}>
              <Field label="種類">
                <SaveErrorField names={['kind', 'draft.kind']}><Select aria-label="種類" size="full" value={draft.kind} onChange={(value) => setDraft({ ...draft, kind: value === 'a_la_carte' ? 'a_la_carte' : 'course' })} options={[{ value: 'course', label: 'コース' }, { value: 'a_la_carte', label: '単品' }]} /></SaveErrorField>
              </Field>
              <Field label="出す時間帯">
                <SaveErrorField names={['period', 'draft.period']}><Select aria-label="提供時間" size="full" value={draft.period}
                  onChange={(value) => setDraft({ ...draft, period: value === 'lunch' ? 'lunch' : value === 'both' ? 'both' : 'dinner' })}
                  options={[{ value: 'lunch', label: 'ランチ' }, { value: 'dinner', label: 'ディナー' }, { value: 'both', label: 'ランチ・ディナー' }]} /></SaveErrorField>
              </Field>
              <Field label={editing ? '新しい価格の開始日時' : '価格の開始日時'} htmlFor="rs-menu-effective">
                <SaveErrorField names={['effectiveAt', 'draft.effectiveAt', 'effective_at', 'draft.effective_at']}><DateTimeField id="rs-menu-effective" aria-label={editing ? '新しい価格の開始日時' : '価格の開始日時'} value={draft.effectiveAt} onChange={(next) => setDraft({ ...draft, effectiveAt: next })} /></SaveErrorField>
              </Field>
            </SettingsFormRow>
            <Field label="メニューの説明" htmlFor="rs-menu-description" note="2,000文字まで">
              <SaveErrorField names={['description', 'draft.description']}><TextArea id="rs-menu-description" aria-label="メニューの説明" rows={3} maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></SaveErrorField>
            </Field>
            <Field label="メニューの画像" error={imageError ?? undefined}>
              <RegisteredImageSelect accountId={storeAccountId} imageId={draft.imageMediaId} imageName={mediaName} disabled={busy}
                onSelect={media => { setImageError(null); setDraft(current => ({ ...current, imageMediaId: media.id })); setMediaName(media.filename) }}
                onRemove={() => { setImageError(null); setDraft(current => ({ ...current, imageMediaId: null })) }} />
            </Field>
            <Field label="アレルギー（カンマ区切り）" htmlFor="rs-menu-allergens">
              <SaveErrorField names={['allergens', 'draft.allergens']}><TextField id="rs-menu-allergens" value={draft.allergens} onChange={(event) => setDraft({ ...draft, allergens: event.target.value })} /></SaveErrorField>
            </Field>
            <p className={styles.note}>{editing
              ? `価格を変える場合は保存時に確認します。開始日時を空欄にすると保存後すぐに反映します。現在の価格は${formatYen(editing.price)}です。`
              : '追加したメニューは予約台帳で使います。説明と画像は管理画面で確認できます。'}</p>
          </Card>
        ) : (
          <CreateSummaryCard title="メニューの内容" description={editing?.pendingPrice != null ? (editing.priceChangeStatus === 'approved' ? '確定した新価格は指定した開始日時に反映します。' : '以前の価格変更申請が残っています。メニュー一覧から確認してください。') : undefined} rows={[
            { label: '種類', value: draft.kind === 'course' ? 'コース' : '単品' },
            { label: 'メニュー名', value: draft.name || emptyValue('unconfigured') },
            { label: '価格（税込）', value: editing ? formatYen(editing.price) : emptyValue('unconfigured') },
            ...(editing?.pendingPrice != null ? [{ label: '変更予定の価格', value: formatYen(editing.pendingPrice) }] : []),
            { label: '提供時間', value: editing ? periodLabel(storedStringList(editing.service_periods_json)) : emptyValue('unknown') },
            { label: '所要時間', value: editing?.duration_minutes ? `${editing.duration_minutes}分` : emptyValue('unknown') },
            { label: '説明', value: draft.description || emptyValue('unconfigured') },
            { label: '画像', value: draft.imageMediaId ? (mediaName || '画像名を確認中') : emptyValue('unconfigured') },
            { label: 'アレルギー', value: draft.allergens || emptyValue('none') },
            { label: '変更後の価格の開始日時', value: editing?.pendingEffectiveAt ? polishFormatDateTime(new Date(editing.pendingEffectiveAt)) : emptyValue('unconfigured') },
          ]} />
        )}
        {course && editing ? (
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="お支払い" help={<HelpTip label="お支払いの説明">先払いのときは、予約の最後に Stripe の支払いページへ進みます。</HelpTip>} />
            <MenuPaymentFields state={payment} name="course" price={draft.price === '' ? editing.price : Number(draft.price)} people={1} readOnly={!canEdit} />
          </Card>
        ) : course && canEdit ? <p className={styles.note}>お支払いの方法は、コースを追加したあとにこのページで決められます。</p> : null}
      </CreatePage>
      <ConfirmDialog open={deleting && confirmationScope === currentConfirmationScope} title="このメニューを削除しますか？" description={`「${editing?.name ?? ''}」を削除します。予約や設定で使われていないメニューだけ削除できます。元に戻せません。`}
        confirmLabel="削除する" destructive busy={busy} onCancel={() => setDeleting(false)} error={error || undefined} onSuccess={() => setDeleting(false)} onConfirm={() => confirmationScope === JSON.stringify([confirmationVersion.current.key, confirmationVersion.current.generation]) ? remove() : false}><OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: storeId ?? '', name: storeIdentity?.accountId === selectedAccountId && storeIdentity.id === storeId ? storeIdentity.name : null }} /></ConfirmDialog>
      <ConfirmDialog open={confirmingPrice && confirmationScope === currentConfirmationScope} title="価格変更を確定しますか？"
        description={`${editing?.name ?? 'メニュー'}の価格を${formatYen(editing?.price ?? 0)}から${formatYen(Number(draft.price))}へ変更します。${priceStartsLater && priceStartsAt ? `${polishFormatDateTime(priceStartsAt)}に新価格を反映します。` : '保存後すぐに新価格を反映します。'}`}
        confirmLabel="確定して保存する" busy={busy} onCancel={() => setConfirmingPrice(false)} error={error || undefined} confirmDisabled={Boolean(payment.conflict.conflict)} confirmDisabledReason="閉じてお支払いの最新の内容と比べてください。" onSuccess={() => setConfirmingPrice(false)} onConfirm={() => confirmationScope === JSON.stringify([confirmationVersion.current.key, confirmationVersion.current.generation]) ? save() : false}><OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: storeId ?? '', name: storeIdentity?.accountId === selectedAccountId && storeIdentity.id === storeId ? storeIdentity.name : null }} /></ConfirmDialog>
      <ConfirmDialog open={confirmingPublish && confirmationScope === currentConfirmationScope} title="このメニューを公開しますか？" description="保存すると、予約などで使えるメニューになります。名前・価格・提供時間を確かめてください。価格の変更は指定した開始日時から反映されます。"
        confirmLabel={editing ? '公開して保存する' : '公開して追加する'} busy={busy} error={error || undefined} onCancel={() => setConfirmingPublish(false)} onSuccess={() => setConfirmingPublish(false)} onConfirm={() => { if (confirmationScope !== JSON.stringify([confirmationVersion.current.key, confirmationVersion.current.generation])) return false; if (priceChanged) { setConfirmingPrice(true); return true }; return save() }}><OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: storeId ?? '', name: storeIdentity?.accountId === selectedAccountId && storeIdentity.id === storeId ? storeIdentity.name : null }} /></ConfirmDialog>
    </SaveErrorScope>
  )
}

export default function RestaurantMenuEditPage() {
  return <Suspense fallback={<ListState kind="loading" />}><PageResourceScope queryKeys={['id', 'store']}><MenuEditBody /></PageResourceScope></Suspense>
}
