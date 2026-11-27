'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RestaurantInventoryRules, RestaurantInventoryRuleState } from '@line-crm/shared'
import { PageContent } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import DateField from '@/components/shared/date-field'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import { ListToolbarOptional } from '@/components/shared/list-toolbar'
import Notice from '@/components/shared/notice'
import NumberField from '@/components/shared/number-field'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { useStaffRole } from '@/lib/staff-role'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import SectionHeader from '@/components/shared/section-header'
import { SettingsFormCard, SettingsFormRow } from '@/components/shared/settings-form-card'
import Toggle from '@/components/shared/toggle'
import StickyBar from '@/components/shared/sticky-bar'
import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { isSaveConflict, SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { RulesState } from './rules-state'

const SWITCHES = [
  ['stopLine', 'LINEの受付を自動で止める'],
  ['stopSameDay', '当日受付を自動で止める'],
  ['notify', '担当にLINEで知らせる'],
] as const
type Draft = Pick<RestaurantInventoryRules, 'stopLine' | 'stopSameDay' | 'notify'> & { threshold: string }
const toDraft = (rule: RestaurantInventoryRules): Draft => ({ threshold: String(rule.threshold), stopLine: rule.stopLine, stopSameDay: rule.stopSameDay, notify: rule.notify })
const thresholdError = (value: string) => value.trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > 10000 ? '0〜10,000 の数で入れてください' : ''

export default function RulesBoard({ accountId, storeId, today, timezone, canEdit: allowedByRole }: {
  accountId: string; storeId: string; today: string; timezone?: string; canEdit: boolean
}) {
  const role = useStaffRole()
  const lockedReason = usePermissionLockReason(allowedByRole)
  const canEdit = allowedByRole && !lockedReason
  const [saved, setSaved] = useState<RestaurantInventoryRules | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const saveErrors = useSaveFormErrors()
  const [confirm, setConfirm] = useState(false)
  const [validationBlocked, setValidationBlocked] = useState(false)
  useEffect(() => { setValidationBlocked(false) }, [draft])
  const [saving, setSaving] = useState(false)
  const [date, setDate] = useState(today)
  const [state, setState] = useState<RestaurantInventoryRuleState | null>(null)
  const [stateError, setStateError] = useState('')
  const stateRequest = useRef(0)
  const alive = useRef(true)
  const contextKey = JSON.stringify([accountId, storeId])
  const currentContext = useRef({ key: contextKey })
  if (currentContext.current.key !== contextKey) currentContext.current = { key: contextKey }
  const confirmContext = useRef<typeof currentContext.current | null>(null)
  useEffect(() => { setConfirm(false); setSaving(false); setValidationBlocked(false); setSaveError(''); setSaved(null); setDraft(null) }, [contextKey])
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = useCallback(async () => {
    const scope = currentContext.current
    setLoadError('')
    try {
      const response = await restaurantTestApi.inventoryRules(accountId, storeId)
      if (!alive.current || currentContext.current !== scope) return false
      setSaved(response.data); setDraft(toDraft(response.data)); saveErrors.reset()
      return true
    } catch (error) { if (alive.current && currentContext.current === scope) setLoadError(describeApiFailure(error, '読み込み', { scope: 'store' })); return false }
  }, [accountId, storeId, saveErrors])
  const loadState = useCallback(async () => {
    const request = ++stateRequest.current
    setState(null); setStateError('')
    try {
      const response = await restaurantTestApi.inventoryRuleState(accountId, storeId, date)
      if (alive.current && request === stateRequest.current) setState(response.state)
    } catch (error) { if (alive.current && request === stateRequest.current) setStateError(describeApiFailure(error, '読み込み', { scope: 'store' })) }
  }, [accountId, storeId, date])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadState() }, [loadState])
  const conflict = useSaveConflict({
    contextKey: `${accountId}:${storeId}`,
    fetchLatest: async () => (await restaurantTestApi.inventoryRules(accountId, storeId)).data,
    reload: async () => { if (await load()) conflict.clear() },
  })
  const dirty = Boolean(canEdit && draft && saved && JSON.stringify(draft) !== JSON.stringify(toDraft(saved)))
  const guard = useUnsavedGuard({ dirty, busy: saving })
  async function save() {
    if (!canEditRef.current || confirmContext.current !== currentContext.current || !draft || !saved || saving || conflict.conflict || validationBlocked) return
    const scope = currentContext.current
    setSaving(true); setSaveError('')
    try {
      const response = await restaurantTestApi.saveInventoryRules(accountId, { storeId, ...draft, threshold: Number(draft.threshold), expectedVersion: saved.version })
      if (!alive.current || currentContext.current !== scope || !canEditRef.current) return
      setSaved(response.data); setDraft(toDraft(response.data)); setConfirm(false)
      notifyToast('自動で合わせるルールを保存しました')
      void loadState()
      return true
    } catch (error) {
      if (!alive.current || currentContext.current !== scope) return
      if (isSaveConflict(error)) { conflict.mark(); setSaveError('ほかの人が先に保存しました。閉じて最新の内容と比べてください。') }
      else {
        saveErrors.capture(error)
        const reasons = Object.values(readSaveFieldErrors(error))
        setValidationBlocked(reasons.length > 0)
        setSaveError(reasons.length ? `${reasons.join(' ')} 戻って入力を直してください。` : describeApiFailure(error, '保存', { scope: 'store' }))
      }
      return false
    } finally { if (alive.current && currentContext.current === scope) setSaving(false) }
  }
  if (!saved || !draft) return <PageContent><ListState kind={loadError ? 'error' : 'loading'} description={loadError || undefined} onRetry={load} /></PageContent>
  const diff = conflict.latest ? [
    ...(conflict.latest.threshold !== Number(draft.threshold) ? [{ text: `止める基準：入力 ${draft.threshold}席 ／ 最新 ${conflict.latest.threshold}席` }] : []),
    ...SWITCHES.filter(([key]) => conflict.latest![key] !== draft[key]).map(([key, label]) => ({ text: `${label}：入力 ${draft[key] ? '有効' : '停止中'} ／ 最新 ${conflict.latest![key] ? '有効' : '停止中'}` })),
  ] : null
  return <SaveErrorScope errors={saveErrors}><>
    <PageContent>
      {role !== null && !canEdit ? <ReadOnlyNotice /> : null}
      {conflict.conflict ? <SaveConflictBand title="ほかの担当者が先にルールを保存しました" onCompare={conflict.compare} compareBusy={conflict.compareBusy} onReload={conflict.reloadLatest} /> : null}
      {loadError ? <Notice tone="danger" action={<Button onClick={conflict.conflict ? conflict.reloadLatest : load}>もう一度読み込む</Button>}>{loadError}</Notice> : null}
      {saveError ? <Notice tone="danger">{saveError}</Notice> : null}
      <SettingsFormCard id="inventory-rules-form" title="自動で合わせるルール" description="残り席が基準以下になると受付枠を0にし、席が戻れば元の配分に戻します。" onSubmit={(event) => {
        event.preventDefault()
        if (!canEdit || !dirty || saving || validationBlocked) return
        const error = thresholdError(draft.threshold)
        if (error) {
          setFieldError(error); return
        }
        confirmContext.current = currentContext.current; setFieldError(''); setSaveError(''); saveErrors.reset(); setConfirm(true)
      }}>
        <SettingsFormRow layout="columns" columns={3}>
          <Field label="残り席がこの数以下で止める" optional={false} help="0〜10,000 席の範囲で整数を入れます。" error={fieldError}>
            {canEdit ? <SaveErrorField names={['threshold']}><NumberField aria-label="残り席がこの数以下で止める" value={draft.threshold} min={0} max={10000} step={1} unit="席" note={false} disabled={saving} onChange={(event) => { setDraft({ ...draft, threshold: event.target.value }); setFieldError(thresholdError(event.target.value)) }} /></SaveErrorField> : `${saved.threshold}席`}
          </Field>
          {SWITCHES.slice(0, 2).map(([key, label]) => <Field key={key} label={label} optional={false} help={key === 'stopSameDay' ? '当日受付は店頭・電話の枠とは別です。店頭・電話の枠は自動で止めません。' : '初めは停止中です。有効にして保存した店舗だけ、自動で調整します。'}>
            {canEdit ? <SaveErrorField names={[key]}><Toggle label={label} checked={draft[key]} disabled={saving} onChange={(next) => setDraft({ ...draft, [key]: next })} /></SaveErrorField> : saved[key] ? '有効' : '停止中'}
          </Field>)}
        </SettingsFormRow>
        <Field label="担当にLINEで知らせる" optional={false} note="お客さまには届きません。" help="媒体の受付を閉じる・再開する作業を店長や当日の責任者へ知らせます。媒体への自動書き戻しは行いません。">
          {canEdit ? <SaveErrorField names={['notify']}><Toggle label="担当にLINEで知らせる" checked={draft.notify} disabled={saving} onChange={(next) => setDraft({ ...draft, notify: next })} /></SaveErrorField> : saved.notify ? '有効' : '停止中'}
        </Field>
      </SettingsFormCard>
      <SectionHeader title="停止中の枠・戻った記録" help="自動停止中は配分を手で変更できません。席が戻るか停止ルールを外すと、保存していた元の配分へ戻ります。記録は選んだ日の枠が対象です。" helpLabel="自動調整の記録の説明" actions={<ListToolbarOptional>
        <DateField aria-label="自動調整を見る日" value={date} clearable={false} size="compact" onChange={setDate} />
        <Button onClick={loadState}>もう一度読み込む</Button>
      </ListToolbarOptional>} />
      <RulesState state={state} error={stateError} onRetry={loadState} timezone={timezone} />
    </PageContent>
    <StickyBar actions={<>
      <Button lockedReason={lockedReason} disabled={!canEdit || !dirty || saving} onClick={() => { setDraft(toDraft(saved)); setFieldError(''); saveErrors.reset() }}>キャンセル</Button>
      <Button lockedReason={lockedReason} type="submit" form="inventory-rules-form" variant="primary" busy={saving} disabled={!canEdit || !dirty || validationBlocked || Boolean(conflict.conflict)} disabledReason={!canEdit ? undefined : conflict.conflict ? '最新の内容を読み直してください。' : validationBlocked ? '入力を確認してください。' : !dirty ? '変更すると保存できます。' : undefined}>ルールを保存する</Button>
    </>} />
    <ConfirmDialog open={confirm && canEdit && confirmContext.current === currentContext.current} title="自動調整のルールを保存しますか？" description="保存すると、すでにある予約を含めて受付枠を数え直します。受付停止を外すと、保持していた配分へ戻ります。担当への通知を有効にすると、自動通知の対象になります。" confirmLabel="保存する" busy={saving} error={saveError || undefined} onSuccess={() => setConfirm(false)} cancelLabel={validationBlocked ? "戻って直す" : "キャンセル"} confirmDisabled={validationBlocked || Boolean(conflict.conflict)} confirmDisabledReason={validationBlocked ? "戻って入力を直してください。" : "閉じて最新の内容と比べてください。"} onConfirm={save} onCancel={() => { if (!saving) setConfirm(false) }}><OperationTargetSummary accounts={[{ id: accountId }]} store={{ id: storeId }} /></ConfirmDialog>
    <SaveConflictCompareDialog open={conflict.compareOpen} busy={conflict.compareBusy} error={conflict.compareError} lines={diff} onReload={conflict.reloadLatest} onCancel={conflict.closeCompare} />
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="自動調整ルールの変更" busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
  </></SaveErrorScope>
}
