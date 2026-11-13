'use client'
import { usePermissionAccess } from '@/lib/use-feature-access'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import ImageUploader from '@/components/shared/image-uploader'
import { useEffect, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Smartphone } from 'lucide-react'
import { BOOKING_STAFF_LIMITS, parseBookingStaffInput, type StaffMember } from '@line-crm/shared'
import { api, bookingApi, type BookingMenu, type BookingStaff } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Toggle from '@/components/shared/toggle'
import ListState from '@/components/shared/list-state'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { describeApiFailure, isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { createPageReturnHref } from '@/components/shared/create-page'
import { PhoneStaffStep, priceLabel } from './phone'
import { CreatePage } from '@/components/templates/create-page'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { TextField, TextArea } from '@/components/shared/text-field'
import NumberInput from '@/components/shared/number-field'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

/*
 * ★V8「予約スタッフを登録」（板 ）。
 *
 * 白い板1枚：頭（← 担当スタッフへ・題・説明）→ 中身（左＝4つのカード
 * 「お客さまに見える情報」「予約を受けられるメニュー」「受付と表示」
 * 「ログインユーザーとのひも付け」＋キャンセル・登録、右＝LIFF の担当選びの見本）。
 *
 * 動き（登録→担当メニューの割当、割当だけ失敗したときの「割当をやり直す」、
 * 未保存の離脱確認、権限が無いときの案内、読み込み失敗の言い分け）は
 * 今までの app/booking/staff/new（管理画面・staff-new-v8）から写した。BEHAVIOR.md を参照。
 */

export default function StaffNewV8() {
  const saveErrors = useSaveFormErrors()
  const [mediaOpen, setMediaOpen] = useState(false)
  const { selectedAccountId, selectedAccount } = useAccount()
  const router = useRouter()
  // /booking/staff/new はメニューの接頭辞に当たらず上部バーが空になるため、画面名を明示する。
  usePageTitle('予約スタッフを登録')
  /* 板の頭の「← 〇〇へ」は 2026-10-08 に無くした。一覧へは上の帯のパンくずで戻る。 */
  usePageCrumbs([{ label: '予約設定', href: '/booking/menus?tab=staff' }])
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [bio, setBio] = useState('')
  const [isDesignationOptional, setIsDesignationOptional] = useState(false)
  const [isActive, setIsActive] = useState(true)
  /* 指名料（B9）。決められるのはオーナー・管理者だけ。ほかの人の登録には載せない（口が断るため）。 */
  const canEditFee = canManageRole(useStaffRole())
  const [nominationFee, setNominationFee] = useState('0')
  const [menus, setMenus] = useState<BookingMenu[]>([])
  const [offered, setOffered] = useState<Set<string>>(new Set())
  // N-411 本人勤務: 登録と同時にログインユーザーへひも付けられるようにする。
  const [staffMemberId, setStaffMemberId] = useState('')
  const [members, setMembers] = useState<StaffMember[]>([])
  // 右のスマホの見本に出す、登録済みの担当。
  const [staffList, setStaffList] = useState<BookingStaff[]>([])
  const [staffPreviewError,setStaffPreviewError]=useState(false)
  const [staffPreviewLoading,setStaffPreviewLoading]=useState(true)
  const [staffPreviewRetry,setStaffPreviewRetry]=useState(0)
  /**
   * R310: 登録は済んだが担当メニューの設定が残っているスタッフのID。
   * ここにIDがある間は createStaff を二度と呼ばず、残りの割当だけをやり直す。
   */
  const [createdStaffId, setCreatedStaffId] = useState<string | null>(null)
  const createdInput = useRef<string | null>(null)
  const accountRef = useRef(selectedAccountId)
  const accountGeneration = useRef(0)
  if (accountRef.current !== selectedAccountId) accountGeneration.current += 1
  accountRef.current = selectedAccountId
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // R310: 控えた登録済みIDは作ったアカウントのもの。切替後は使い回さない。
  useEffect(() => {
    setCreatedStaffId(null)
    createdInput.current = null
    setSaving(false)
  }, [selectedAccountId])

  /* R578: 担当メニューの取得失敗と本当の0件を言い分ける。失敗しても入力は残る。 */
  const [menusLoading, setMenusLoading] = useState(true)
  const [menusError, setMenusError] = useState<unknown>(null)
  const [menusReloadKey, setMenusReloadKey] = useState(0)

  useEffect(() => {
    if (!selectedAccountId) {
      setMenusLoading(false)
      return
    }
    let alive = true
    setMenusLoading(true)
    setMenusError(null)
    bookingApi
      .listMenus(selectedAccountId)
      .then((r) => {
        if (!alive) return
        setMenus(r.menus)
        setMenusError(null)
        setMenusLoading(false)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setMenusError(error)
        setMenusLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selectedAccountId, menusReloadKey])

  /* ログインユーザー一覧の取得失敗と「誰もいない」を言い分ける。 */
  const [membersLoading, setMembersLoading] = useState(true)
  const [membersError, setMembersError] = useState<unknown>(null)
  const [membersReloadKey, setMembersReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setMembersLoading(true)
    setMembersError(null)
    api.staff
      .list()
      .then((res) => {
        if (!alive) return
        if (res.success) setMembers(res.data.filter((m) => m.isActive))
        setMembersError(null)
        setMembersLoading(false)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setMembersError(error)
        setMembersLoading(false)
      })
    return () => {
      alive = false
    }
  }, [membersReloadKey])

  /* 見本の取得失敗と空を分ける。登録中の入力は残して読み直す。 */
  useEffect(() => {
    if (!selectedAccountId) return
    let alive = true
    setStaffPreviewError(false)
    setStaffPreviewLoading(true)
    bookingApi
      .listStaff(selectedAccountId)
      .then((r) => {
        if (alive) {setStaffList(r.staff);setStaffPreviewLoading(false)}
      })
      .catch(() => {
        if (alive) {setStaffPreviewError(true);setStaffPreviewLoading(false)}
      })
    return () => {
      alive = false
    }
  }, [selectedAccountId,staffPreviewRetry])

  // N-411: 予約スタッフ登録は 'booking.settings' の実効 permission 必須。
  const canManageStaff = usePermissionAccess('booking.settings')
  const staffLockedReason = usePermissionLockReason(canManageStaff)

  /* 登録途中の離脱確認。どれかに手を付けていたら、キャンセルや左メニューで確認窓を出す。 */
  const dirty = Boolean(
    name || displayName || role || imageUrl || bio || staffMemberId ||
    isDesignationOptional || !isActive || offered.size > 0 || (nominationFee.trim() !== '' && nominationFee.trim() !== '0'),
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty })

  const shownName = displayName.trim() || name.trim() || 'スタッフ'
  const staffInput = () => ({
    name,
    display_name: displayName.trim() || name,
    role,
    profile_image_url: imageUrl,
    bio,
    is_designation_optional: isDesignationOptional,
    is_active: isActive,
    staff_member_id: staffMemberId || null,
    ...(canEditFee && Number(nominationFee.trim() || '0') !== 0 ? { nominationFee: Number(nominationFee.trim()) } : {}),
  })

  function validate(): string | null {
    if (!selectedAccountId) return '先に上部でLINEアカウントを選んでください'
    const parsed = parseBookingStaffInput(staffInput(), 'create')
    if (!parsed.ok) return parsed.error
    if (offered.size === 0) return '担当メニューを1つ以上選んでください。0だと予約画面に表示されません'
    return null
  }

  /* 名前欄1欄の直し方。保存時と同じ判定のうち名前欄の分だけ出す。 */
  function nameFieldError(value: string): string | null {
    const parsed = parseBookingStaffInput({ ...staffInput(), name: value, display_name: displayName.trim() || value }, 'create')
    if (!parsed.ok && parsed.field === 'name') return parsed.error
    return null
  }
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; menus?: string }>({})
  const formRef = useRef<HTMLDivElement>(null)
  const focusInvalid = useRef(false)
  useEffect(() => {
    if (!focusInvalid.current) return
    focusInvalid.current = false
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    field?.focus(); field?.scrollIntoView?.({ block: 'center' })
  }, [fieldErrors])


  async function save() {
    if (!canManageStaff || staffLockedReason || saving) return

    const validationError = validate()
    if (validationError) {
      focusInvalid.current = true
      const nameError = nameFieldError(name)
      const menusError = offered.size === 0 ? '担当メニューを1つ以上選んでください。' : null
      setSaveError(nameError || menusError ? null : validationError)
      setFieldErrors({ ...(nameError ? { name: nameError } : {}), ...(menusError ? { menus: menusError } : {}) })
      return
    }
    const accountId = selectedAccountId!
    const parsed = parseBookingStaffInput(staffInput(), 'create')
    if (!parsed.ok) return
    const inputSnapshot = JSON.stringify(parsed.value)
    const generation = accountGeneration.current
    const current = () => accountRef.current === accountId && accountGeneration.current === generation
    setSaving(true)
    setSaveError(null)
    setFieldErrors({})
    try {
      // R310: 割当だけ失敗して戻ってきた再試行では、スタッフを作り直さない。
      let staffId = createdStaffId
      if (staffId == null) {
        const res = await bookingApi.createStaff(accountId, parsed.value)
        if (!current()) return
        staffId = res.id
        setCreatedStaffId(staffId)
        createdInput.current = inputSnapshot
      } else if (createdInput.current !== inputSnapshot) {
        await bookingApi.updateStaff(accountId, staffId, parsed.value)
        if (!current()) return
        createdInput.current = inputSnapshot
      }
      // 担当メニューは staff_menus に入る。作ってから流し込む。
      try {
        await bookingApi.putStaffMenus(
          accountId,
          staffId,
          menus.map((m) => ({ menu_id: m.id, is_offered: offered.has(m.id), override_duration_minutes: null, override_price: null })),
        )
      } catch (saveFailure) {
        if (!current()) return
        saveErrors.capture(saveFailure)
        setCreatedStaffId(staffId)
        throw new Error('スタッフは登録できましたが、担当メニューの設定に失敗しました。入力は残っています。「割当をやり直す」を押してください。')
      }
      if (!current())

 return
      setCreatedStaffId(null)
      createdInput.current = null
      router.push(createPageReturnHref('/booking/menus?tab=staff', staffId))
    } catch (e) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(e)
      { if (!fieldFailure)
      setSaveError(describeApiFailure(e, '登録')) }
    } finally {
      if (current()) setSaving(false)
    }
  }

  const workerBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const previewUrl = selectedAccount?.liffId
    ? `${workerBase}/o?liffId=${encodeURIComponent(selectedAccount.liffId)}&page=salon-book`
    : null

  if (!canManageStaff) {
    return <CreatePage title="予約スタッフを登録" boardId="CcA4k" readOnly dirty={false}
      footerActions={<><Button href="/booking/menus?tab=staff">キャンセル</Button><Button variant="primary" disabled lockedReason={staffLockedReason}>スタッフを登録する</Button></>}>
      {staffLockedReason ? <ListState kind="forbidden" title="予約設定の変更権限がありません" description={staffLockedReason} /> : <ListState kind="loading" />}
    </CreatePage>
  }

  /* 右のスマホ：登録中のスタッフも見本に混ぜて、出方を確かめられるようにする。 */
  const draftStaff: BookingStaff | null = (displayName.trim() || name.trim()) ? {
      id: '__new__',
      name: name.trim() || 'スタッフ',
      display_name: shownName,
      role: role.trim() || null,
      profile_image_url: imageUrl.trim() || null,
      bio: bio.trim() || null,
      sort_order: -1,
      is_designation_optional: isDesignationOptional ? 1 : 0,
      is_active: isActive ? 1 : 0,
      nomination_fee: canEditFee ? Number(nominationFee.trim() || '0') || 0 : 0,
    } : null
  const previewStaff = staffList
  // お客さまの画面の「指名なし」は、指名なしの枠に入る担当が1人でもいれば出る。
  const designationFree = (isActive && isDesignationOptional) || previewStaff.some((s) => s.is_active && s.is_designation_optional)
  const previewMenu = menus.find((m) => m.is_active && offered.has(m.id))
    ?? menus.find((m) => m.is_active)
    ?? menus[0]
    ?? null
  const memberLabel = (m: StaffMember) => `${m.name}${m.email ? `（${m.email}）` : ''}`

  return (
    <SaveErrorScope errors={saveErrors}>
      <div ref={formRef}>
        <CreatePage title="予約スタッフを登録" boardId="CcA4k" dirty={false} busy={saving}
          help="お客さまが予約するときに指名できる担当者を登録します。"
          contentDisabled={saving} contentLabel="登録するスタッフ"
          previewLabel="予約画面での見え方を見る" previewTitle="予約画面での見え方"
          preview={<>
            {previewUrl ? <Button href={previewUrl} external><Smartphone size={16} aria-hidden="true" />お客さまに見える画面を確かめる</Button> : null}
            <CardHeader size="stacked" title="予約画面での見え方" />
            {staffPreviewError ? <ListState kind="error" title="担当の見本を読み込めませんでした" onRetry={() => setStaffPreviewRetry(value => value + 1)} /> : null}
            <PhoneStaffStep menu={previewMenu} staff={previewStaff} draft={draftStaff} designationFree={designationFree}
              status={menusLoading || staffPreviewLoading ? 'loading' : menusError || staffPreviewError ? 'error' : 'ready'} />
            {previewUrl ? null : <Notice tone="info">このアカウントには予約画面のURLがまだありません</Notice>}
          </>}
          footerActions={<>
            <Button href="/booking/menus?tab=staff">キャンセル</Button>
            <Button variant="primary" onClick={() => save()} disabled={saving} busy={saving} busyLabel="登録しています…">
              {createdStaffId ? '割当をやり直す' : 'スタッフを登録する'}
            </Button>
          </>}
        >
          <Card variant="form" gap="normal" aria-labelledby="bs-card-info">
            <CardHeader size="stacked" title="お客さまに見える情報" titleId="bs-card-info" />
            <SettingsFormRow layout="columns">
              <Field label="スタッフ名（管理画面での呼び名）" htmlFor="bs-name" required error={fieldErrors.name}
                count={{ value: name.length, max: BOOKING_STAFF_LIMITS.name }}>
                <SaveErrorField names={["name"]}><TextField id="bs-name" value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (fieldErrors.name !== undefined) setFieldErrors({ name: nameFieldError(e.target.value) ?? undefined })
                  }}
                  onBlur={() => setFieldErrors({ name: nameFieldError(name) ?? undefined })}
                  maxLength={BOOKING_STAFF_LIMITS.name} placeholder="例：見本 170" />
                </SaveErrorField>
              </Field>
              <Field label="お客さま向けの表示名（空欄なら上の名前）" htmlFor="bs-display" optional
                count={{ value: displayName.length, max: BOOKING_STAFF_LIMITS.displayName }}>
                <SaveErrorField names={["displayName", "display_name"]}><TextField id="bs-display" value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)} maxLength={BOOKING_STAFF_LIMITS.displayName} placeholder="例：みさき" />
                </SaveErrorField>
              </Field>
              <Field label="肩書き" htmlFor="bs-role" optional count={{ value: role.length, max: BOOKING_STAFF_LIMITS.role }}>
                <SaveErrorField names={["role"]}><TextField id="bs-role" value={role} onChange={(e) => setRole(e.target.value)}
                  maxLength={BOOKING_STAFF_LIMITS.role} placeholder="例：トリミング担当" /></SaveErrorField>
              </Field>
              <SaveErrorField names={["imageUrl"]}><ImageUploader mode="url" onMediaPick={() => setMediaOpen(true)} size="compact"
                label="顔写真（正方形・1MB まで）" title="顔写真を追加" maxMB={1}
                value={imageUrl ? { mode: 'url', url: imageUrl } : null}
                onChange={(next) => setImageUrl(next?.mode === 'url' ? next.url.slice(0, BOOKING_STAFF_LIMITS.profileImageUrl) : '')} />
              </SaveErrorField>
            </SettingsFormRow>
            <Field label="紹介文" htmlFor="bs-bio" optional count={{ value: bio.length, max: BOOKING_STAFF_LIMITS.bio }}>
              <SaveErrorField names={["bio"]}><TextArea id="bs-bio" rows={1} size="single-row" value={bio}
                onChange={(e) => setBio(e.target.value)} maxLength={BOOKING_STAFF_LIMITS.bio} placeholder="例：トリミング歴10年。小型犬が得意です。" /></SaveErrorField>
            </Field>
          </Card>

          <Card variant="form" gap="normal" aria-labelledby="bs-card-menus">
            <CardHeader size="stacked" title="予約を受けられるメニュー" titleId="bs-card-menus" />
            <Notice tone="info">選んだメニューだけ、このスタッフを指名できます。1つも選ばないと予約画面に出ません。</Notice>
            {menusLoading ? <span aria-busy="true"><span className="sr-only">メニューを読み込んでいます</span>
              <DelayedSkeleton loading skeleton={<Skeleton width="100%" height={36} />} /></span>
            : menusError !== null ? <ListState kind="error" title="メニューを読み込めませんでした"
              description={isForbiddenOrRateLimited(menusError) ? undefined : '通信の不具合などでメニュー一覧を読み込めませんでした。入力した内容はそのまま残っています。「もう一度読み込む」を押してください。'}
              error={menusError} onRetry={() => setMenusReloadKey(value => value + 1)} />
            : menus.length === 0 ? <Notice tone="info" action={<Button variant="text" size="inline" href="/booking/menus">メニューへ →</Button>}>まだメニューがありません。先に予約設定の「メニュー」から登録してください。</Notice>
            : <Field label="予約を受けられるメニュー" required error={fieldErrors.menus && offered.size === 0 ? fieldErrors.menus : undefined}>
                <EntitySelect aria-label="予約を受けられるメニュー" noun="予約メニュー" size="full" values={[...offered]}
                  onChange={(ids) => setOffered(new Set(ids))} invalid={!!fieldErrors.menus && offered.size === 0}
                  options={menus.map(m => ({ value: m.id, label: m.name, description: `${m.duration_minutes}分・${priceLabel(m)}` }))} />
              </Field>}
          </Card>

          <Card variant="form" gap="normal" aria-labelledby="bs-card-accept">
            <CardHeader size="stacked" title="受付と表示" titleId="bs-card-accept" />
            <Notice tone="info">最初は店舗の営業時間に合わせます。個別に変えるときは、登録後に「勤務とシフト」で調整できます。</Notice>
            <Field label="「指名なし」の枠にも含める" note="お客さまが担当者を選ばなかったときの割り当て先になります。"><SaveErrorField names={["isDesignationOptional", "is_designation_optional"]}>
              <Toggle checked={isDesignationOptional} onChange={setIsDesignationOptional} label="「指名なし」の枠にも含める" disabled={saving} />
            </SaveErrorField></Field>
            <Field label="登録したらすぐ予約を受ける" note="オフにすると予約画面に出ません。"><SaveErrorField names={["isActive", "is_active"]}>
              <Toggle checked={isActive} onChange={setIsActive} label="登録したらすぐ予約を受ける" disabled={saving} />
            </SaveErrorField></Field>
            <Notice tone="info">予約枠の色は現在グリーンで固定です。カレンダーでの見分けに使います。</Notice>
            {canEditFee ? (
              <Field label="指名料" htmlFor="bs-fee" optional note="お客さまが指名したときだけ掛かります。指名なしで自動で割り当てたときは掛かりません。">
                <SaveErrorField names={["nominationFee", "nomination_fee"]}><NumberInput id="bs-fee" short unit="円" aria-label="指名料"
                  type="number" min={0} step={1} inputMode="numeric" value={nominationFee} placeholder="0"
                  onChange={(e) => setNominationFee(e.target.value)} /></SaveErrorField>
              </Field>
            ) : (
              <Field label="指名料" note="決められるのはオーナー・管理者だけです。登録のあとで頼んでください。">
                <NumberInput short unit="円" readOnly aria-label="指名料（円）" value="0" />
              </Field>
            )}
          </Card>

          <Card variant="form" gap="normal" aria-labelledby="bs-card-member">
            <CardHeader size="stacked" title="ログインユーザーとのひも付け" titleId="bs-card-member" />
            <Notice tone="info">ひも付けると、その人が左メニュー「自分の勤務」で、このスタッフのシフト・休憩・Google カレンダーを決められます。</Notice>
            {membersLoading ? <span aria-busy="true"><span className="sr-only">ログインユーザーを読み込んでいます</span>
              <DelayedSkeleton loading skeleton={<Skeleton width="100%" height={36} />} /></span>
            : membersError !== null ? <ListState kind="error" title="ログインユーザーを読み込めませんでした"
              description={isForbiddenOrRateLimited(membersError) ? undefined : '通信の不具合などでログインユーザー一覧を読み込めませんでした。入力した内容はそのまま残っています。「もう一度読み込む」を押してください。'}
              error={membersError} onRetry={() => setMembersReloadKey(value => value + 1)} />
            : <Field label="ログインユーザー" optional>
                <SaveErrorField names={["staffMemberId", "staff_member_id"]}><EntitySelect aria-label="ログインユーザーとの紐づけ" id="bs-member" size="full"
                  value={staffMemberId} onChange={setStaffMemberId} options={[{ value: '', label: '紐づけない' }, ...members.map(m => ({ ...entityOptionMetadata(m), value: m.id, label: memberLabel(m) }))]} />
                </SaveErrorField>
              </Field>}
          </Card>

          {createdStaffId ? <Notice tone="warn" role="status">スタッフは登録済みです。担当メニューの設定が残っています。</Notice> : null}
          {saveError ? <Notice tone="danger">{saveError}</Notice> : null}
        </CreatePage>
        <MediaPickerDialog open={mediaOpen} accountId={selectedAccountId} kind="image" onClose={() => setMediaOpen(false)} onSelect={(item) => { setImageUrl(item.url); setMediaOpen(false) }} />
        <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力したスタッフ" onConfirm={confirmLeave} onCancel={cancelLeave} />
      </div>
    </SaveErrorScope>
  )
}
