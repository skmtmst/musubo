'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'


import { Field } from '@/components/shared/form-controls'
import { useEffect, useState } from 'react'

import { BOOKING_STAFF_LIMITS, parseBookingStaffInput, type StaffMember } from '@line-crm/shared'
import {useAccount} from '@/contexts/account-context'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import ImageUploader from '@/components/shared/image-uploader'
import Select from '@/components/shared/select'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Dialog from '@/components/shared/dialog'
import { api, type BookingStaff } from '@/lib/api'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { AffixedTextField, TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { formatNumber } from '@/lib/format'

/*
 * 予約スタッフの作成・編集の窓。管理画面 一覧（staff/page.tsx）と V8 予約設定の
 * 担当スタッフタブ（menus/settings-v8.tsx）の両方から使う。
 * 見た目・入力検査（parseBookingStaffInput）・紐づけ候補の取り方は変えない。
 */

export function StaffEditModal({
  staff,
  onSave,
  onClose,
}: {
  staff: Partial<BookingStaff>
  onSave: (s: Partial<BookingStaff>) => Promise<void>
  onClose: () => void
}) {
  const {selectedAccountId} = useAccount()
  const [mediaOpen, setMediaOpen] = useState(false)
  const saveErrors = useSaveFormErrors()
  const [form, setForm] = useState<Partial<BookingStaff>>(staff)
  const [saving, setSaving] = useState(false)
  /* V8 のときだけボタンの内側の保存中表示へ。互換経路は従来の文字のまま。 */
  const busySave = saving
  const [err, setErr] = useState<string | null>(null)
  // 保存の途中で窓だけ消えないよう、送信中はEscapeを止める。
  // N-411 本人勤務: 予約スタッフをログインユーザーへ紐づけるための一覧。
  const [members, setMembers] = useState<StaffMember[]>([])
  const [membersStatus, setMembersStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [membersAttempt, setMembersAttempt] = useState(0)
  /* 指名料（B9）。変えられるのはオーナー・管理者だけ。ほかの人の保存には載せない（口が断るため）。 */
  const canEditFee = canManageRole(useStaffRole())
  const savedFee = staff.nomination_fee ?? 0
  const [fee, setFee] = useState(String(savedFee))

  useEffect(() => {
    let cancelled = false
    setMembersStatus('loading')
    setMembers([])
    if (!selectedAccountId) return () => { cancelled = true }
    api.staff.list(selectedAccountId)
      .then((res) => {
        if (cancelled) return
        if (!res.success) { setMembersStatus('error'); return }
        setMembers(res.data.filter((m) => m.isActive))
        setMembersStatus('ready')
      })
      .catch(() => { if (!cancelled) setMembersStatus('error') })
    return () => { cancelled = true }
  }, [membersAttempt, selectedAccountId])

  function set<K extends keyof BookingStaff>(k: K, v: BookingStaff[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  async function submit() {
    setErr(null)
    const nextFee = Number(fee.trim() || '0')
    const withFee = canEditFee && nextFee !== savedFee ? { ...form, nominationFee: nextFee } : form
    const parsed = parseBookingStaffInput(withFee, form.id ? 'update' : 'create')
    if (!parsed.ok) {
      setErr(parsed.error)
      return
    }
    setSaving(true)
    try {
      await onSave(form.id ? { id: form.id, ...parsed.value } : parsed.value)
    } catch (e) {
      saveErrors.capture(e)
      setErr(describeApiFailure(e, '保存'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog open title={form.id ? 'スタッフ編集' : '新規スタッフ'} onCancel={onClose} onConfirm={() => void submit()} confirmLabel="保存する" busy={saving} designWidth={560}>
        <div className="px-6 py-4 space-y-4">
          <Field label="内部名（管理用）" required>
            <SaveErrorField names={["name","form.name"]}><SharedTextField
              type="text"
              value={form.name ?? ''}
              onChange={(e) => set('name', e.target.value)}
              maxLength={BOOKING_STAFF_LIMITS.name}
              className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="例：yamada-taro"
            /></SaveErrorField>
          </Field>
          <Field label="表示名" required>
            <SaveErrorField names={["display_name","form.display_name"]}><SharedTextField
              type="text"
              value={form.display_name ?? ''}
              onChange={(e) => set('display_name', e.target.value)}
              maxLength={BOOKING_STAFF_LIMITS.displayName}
              className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="顧客に表示される名前"
            /></SaveErrorField>
          </Field>
          <Field label="役職">
            <SaveErrorField names={["role","form.role"]}><SharedTextField
              type="text"
              value={form.role ?? ''}
              onChange={(e) => set('role', e.target.value)}
              maxLength={BOOKING_STAFF_LIMITS.role}
              className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="例：トップスタイリスト"
            /></SaveErrorField>
          </Field>
          <ImageUploader
            mode="url" onMediaPick={() => setMediaOpen(true)}
            value={form.profile_image_url ? { mode: 'url', url: form.profile_image_url } : null}
            onChange={(v) => set('profile_image_url', v?.mode === 'url' ? v.url : '')}
            label="プロフィール画像"
            title="プロフィール画像を追加"
          />
          <p className="text-ink-faint -mt-3 text-xs">
            http:// または https:// で始まるURLを入力してください。
          </p>
          <Field label="紹介文">
            <SaveErrorField names={["bio","form.bio"]}><SharedTextArea
              value={form.bio ?? ''}
              onChange={(e) => set('bio', e.target.value)}
              maxLength={BOOKING_STAFF_LIMITS.bio}
              className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-y"
              rows={2}
            /></SaveErrorField>
          </Field>
          <Field label="並び順">
            <SaveErrorField names={["sort_order","form.sort_order"]}><NumberInput
              type="number"
              value={form.sort_order ?? 0}
              onChange={(e) => set('sort_order', Number(e.target.value))}
              min={BOOKING_STAFF_LIMITS.sortOrderMin}
              max={BOOKING_STAFF_LIMITS.sortOrderMax}
              step={1}
              className="w-full border border-hairline rounded-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums"
            /></SaveErrorField>
          </Field>
          <Field label="指名料" note="お客さまが指名したときだけ掛かります。指名なしで自動で割り当てたときは掛かりません。">
            <SaveErrorField names={["nominationFee","nomination_fee"]}>{canEditFee ? <AffixedTextField layout="field" startAdornment="¥"
              type="number" min={0} step={1} inputMode="numeric" aria-label="指名料（円）"
              value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0"
            /> : <AffixedTextField layout="field" startAdornment="¥" readOnly aria-label="指名料（円・変えられるのはオーナー・管理者だけ）" value={formatNumber(savedFee)} />}</SaveErrorField>
          </Field>
          <SaveErrorField names={["is_designation_optional","form.is_designation_optional"]}><Checkbox
            checked={Boolean(form.is_designation_optional)}
            onCheckedChange={(checked) => set('is_designation_optional', checked ? 1 : 0)}
          >「指名なし」枠（仮想スタッフ）</Checkbox></SaveErrorField>
          <SaveErrorField names={["is_active","form.is_active"]}><Checkbox
            checked={Boolean(form.is_active)}
            onCheckedChange={(checked) => set('is_active', checked ? 1 : 0)}
          >有効（顧客に表示する）</Checkbox></SaveErrorField>
          <Field note={<>
              紐づけると、そのログインユーザーが「本人の勤務」としてこの担当者のシフト・休憩・外部連携を管理できます。
            </>} label="ログインユーザー（本人の勤務）">
            <SaveErrorField names={["staff_member_id","form.staff_member_id"]}><EntitySelect
              aria-label="ログインユーザーとの紐づけ"
              size="full"
              value={form.staff_member_id ?? ''}
              disabled={membersStatus !== 'ready'}
              onChange={(v) => set('staff_member_id', v || null)}
              options={[
                { value: '', label: '紐づけない' },
                ...(membersStatus !== 'ready' && form.staff_member_id ? [{ value: form.staff_member_id, label: '紐づけ済み（確認中）' }] : []),
                ...members.map((m) => ({ ...entityOptionMetadata(m), value: m.id, label: `${m.name}${m.email ? `（${m.email}）` : ''}` })),
              ]}
            /></SaveErrorField>
            {membersStatus === 'loading' ? <p role="status">ログインユーザーを読み込んでいます。</p> : null}
            {membersStatus === 'error' ? <><p role="status">ログインユーザーを読み込めませんでした。ほかの項目は編集できます。</p><Button type="button" variant="secondary" onClick={() => setMembersAttempt(value => value + 1)}>ログインユーザーを読み直す</Button></> : null}
          </Field>
          {err && <p className="text-xs text-danger">{err}</p>}
        </div>
    </Dialog><MediaPickerDialog open={mediaOpen} accountId={selectedAccountId} kind="image" onClose={() => setMediaOpen(false)} onSelect={(item) => { set('profile_image_url', item.url); setMediaOpen(false) }} /></SaveErrorScope>
  )
}

export const EMPTY_STAFF: Partial<BookingStaff> = {
  name: '',
  display_name: '',
  role: '',
  profile_image_url: '',
  bio: '',
  sort_order: 0,
  is_designation_optional: 0,
  is_active: 1,
}
