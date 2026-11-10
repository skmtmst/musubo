'use client'

import { initialBusinessHours, type HoursProblem, validateBusinessHours, businessHoursSaveError, resourceSaveError } from './hours-validation'
import { notifySaved } from '@/components/shared/toast'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import DateField from '@/components/shared/date-field'
import HelpTip from '@/components/shared/help-tip'
import TextLink from '@/components/shared/text-link'
import { TimeField } from '@/components/shared/date-time-field'
import { TextField } from '@/components/shared/text-field'
import Toggle from '@/components/shared/toggle'
import { RowMenu } from '@/components/shared/row-actions'
import { ApiError, bookingApi, type BookingMenu, type BookingResource, type BookingSettings, type BookingSlotCheckResult, type BookingStaff } from '@/lib/api'
import { slotReasonLabel } from '../lib/slot-reason'
import { AccountIcon, Band, DAYS, StateCard, SkeletonRows, useV8TabEdit, type BusinessHourInterval, type BusinessHoursDay, type LoadStatus } from './shared'
import styles from '../settings.module.css'
import { Field } from '@/components/shared/form-controls'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ListState from '@/components/shared/list-state'
import HoursCopyDialog from './hours-copy-dialog'
import Notice from '@/components/shared/notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

export function HoursTabV8({ accountId, settings, settingsStatus, settingsError, resources, resourcesStatus, resourcesError, canEdit, menus, onSaved, onReload, onResourceSaved, onResourceCreated, onResourceDeleted, onResourcesRetry }: {
  accountId: string
  settings: BookingSettings | null
  settingsStatus: LoadStatus
  settingsError: string | null
  resources: BookingResource[] | null
  resourcesStatus: LoadStatus
  resourcesError: string | null
  canEdit: boolean
  menus: BookingMenu[]
  onSaved: (settings: BookingSettings) => void
  onReload: () => void
  onResourceSaved: (resource: BookingResource) => void
  onResourceCreated: (resource: BookingResource) => void
  onResourceDeleted: (id: string) => void
  onResourcesRetry: () => void
}) {
  const lockedReason = usePermissionLockReason(canEdit)
  const saveErrors = useSaveFormErrors()
  const [draft, setDraft] = useState<BusinessHoursDay[] | null>(null)
  const [copySource, setCopySource] = useState<BusinessHoursDay | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveConflict, setSaveConflict] = useState(false)
  const [badHours, setBadHours] = useState<{ weekday: number; index: number; parts: Array<'start' | 'end' | 'capacity'> } | null>(null)
  const [addingResource, setAddingResource] = useState(false)
  const inFlightRef = useRef(false)

  const saveGenerationRef = useRef(0)
  useEffect(() => {
    saveGenerationRef.current += 1
    setCopySource(null)
    inFlightRef.current = false
    setSaving(false)
    setSaveError(null)
    setSaveConflict(false)
    return () => { saveGenerationRef.current += 1 }
  }, [accountId])

  useEffect(() => {
    if (settings) setDraft(initialBusinessHours(settings))
  }, [settings])

  const dirty = settings?.openingHoursSource === undefined && draft !== null && settings !== null
    && JSON.stringify(draft) !== JSON.stringify(initialBusinessHours(settings))

  useV8TabEdit({
    dirty,
    saving,
    subject: '受付時間への変更',
    saveLabel: settings?.version === 0 ? '受付枠を作る' : '開ける時間を保存',
    saveDisabled: !canEdit || settings?.openingHoursSource !== undefined,
    onSave: () => void submit(),
    onReset: () => { if (settings) { setDraft(initialBusinessHours(settings)); setSaveError(null) } },
  })

  function updateDay(weekday: number, update: (intervals: BusinessHourInterval[]) => BusinessHourInterval[]) {
    if (!canEdit) return
    setDraft((current) => current?.map((day) => day.weekday === weekday
      ? { ...day, intervals: update(day.intervals) }
      : day) ?? current)
    setSaveError(null)
    setBadHours(null)
  }

  const isBad = (weekday: number, index: number, part: 'start' | 'end' | 'capacity') => Boolean(badHours && badHours.weekday === weekday && badHours.index === index && badHours.parts.includes(part))

  async function submit() {
    if (!canEdit || !settings || settings.openingHoursSource !== undefined || !draft || inFlightRef.current) return
    const generation = saveGenerationRef.current
    const alive = () => generation === saveGenerationRef.current
    const validationError = validateBusinessHours(draft)
    if (validationError) {
      setSaveError(validationError.message)
      setBadHours(validationError.at ?? null)
      const at = validationError.at
      const dayLabel = at ? DAYS.find((day) => day.weekday === at.weekday)?.label : undefined
      if (at && dayLabel) {
        const part = at.parts[at.parts.length - 1]
        const target = `${dayLabel}の${part === 'start' ? '開始時刻' : part === 'end' ? '終了時刻' : '同時受付数'}（${at.index + 1}区間目）`
        requestAnimationFrame(() => {
          const el = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find((node) => node.getAttribute('aria-label') === target)
          el?.scrollIntoView?.({ block: 'center' })
          el?.focus({ preventScroll: true })
        })
      }
      return
    }
    setBadHours(null)
    inFlightRef.current = true
    setSaving(true)
    setSaveError(null)
    setSaveConflict(false)
    try {
      const response = await bookingApi.saveSettings(accountId, {
        expectedVersion: settings.version,
        timeZone: settings.timeZone,
        bookingWindowDays: settings.bookingWindowDays,
        cutoffMinutesBefore: settings.cutoffMinutesBefore,
        cancelDeadlineMinutesBefore: settings.cancelDeadlineMinutesBefore,
        maxActiveBookingsPerFriend: settings.maxActiveBookingsPerFriend,
        approvalMode: settings.approvalMode,
        holdMinutes: settings.holdMinutes,
        slotGranularityMinutes: settings.slotGranularityMinutes,
        reminderDayBeforeTime: settings.reminderDayBeforeTime,
        reminderHoursBefore: settings.reminderHoursBefore,
        businessHours: draft,
      })
      if (!alive()) return
      if (!response.success) throw new Error('booking_business_hours_save_failed')
      notifySaved('受付時間を保存しました。')
      onSaved(response.data)
      onReload()
    } catch (error) {
      if (!alive()) return
      setSaveConflict(error instanceof ApiError && error.status === 409)
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure)
      setSaveError(businessHoursSaveError(error)) }
    } finally {
      if (alive()) {
        inFlightRef.current = false
        setSaving(false)
      }
    }
  }

  // WEB053：失敗を先に見る（draft は成功したときだけできる）。
  if (settingsStatus === 'error' || (settingsStatus !== 'loading' && !settings)) {
    return (
      <SaveErrorScope errors={saveErrors}><StateCard
        icon={<AccountIcon />}
        title="受付枠を読み込めませんでした"
        description={settingsError ?? '通信状態を確認して、もう一度お試しください。'}
        action={<Button onClick={onReload}>もう一度読み込む</Button>}
      /></SaveErrorScope>
    )
  }
  if (settingsStatus === 'loading' || draft === null || !settings) return <SaveErrorScope errors={saveErrors}><SkeletonRows rows={7} /></SaveErrorScope>

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.tabStack} data-design="Week">
      {canEdit && settings.openingHoursSource === undefined && copySource ? <HoursCopyDialog key={`${accountId}:${copySource.weekday}`} source={copySource} days={draft}
        onCancel={() => setCopySource(null)} onCopy={(targets) => {
          setDraft((current) => current?.map((day) => targets.includes(day.weekday) && day.intervals.length > 0
            ? { ...day, intervals: copySource.intervals.map((interval) => ({ ...interval })) } : day) ?? current)
          setSaveError(null)
          setBadHours(null)
          setCopySource(null)
        }} /> : null}
      <Notice tone="info">「同時」は1時間に受けられる数ではなく、同じ時間に重ねられる予約の数です。</Notice>
      {settings.openingHoursSource === undefined && !settings.businessHoursConfigured ? (
        <Band tone="warn">まだ週全体の営業時間を保存していません。時間帯がない曜日は現在は担当者の勤務時間どおりに受け付けます。保存すると、その曜日は休業になります。</Band>
      ) : null}

      <Card layout="vertical" padding="roomy" gap="normal">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>営業時間</h2>
          <p className={styles.sectionDesc}>{settings.openingHoursSource === undefined ? '曜日ごとに受付の時間と休憩を決めます' : 'Googleビジネスプロフィールの営業時間を基準にします'}</p>
        </div>
        {settings.openingHoursSource === 'manual' ? <Notice tone="info">Googleビジネスプロフィールを接続すると、通常・特別営業時間が予約と共通機能に反映されます。<TextLink href="/settings/sns">Googleビジネスの接続画面を開く</TextLink></Notice> : null}
        {settings.openingHoursSource === 'google_unavailable' ? <Notice tone="danger">Googleの営業時間を確認できないため、予約枠を閉じています。<TextLink href="/settings/sns">接続状態を確認する</TextLink></Notice> : null}
        {settings.openingHoursSource === 'google_business' ? <>
          <Notice tone="info">営業時間はGoogleビジネスプロフィールから読み込んでいます。予約の定員・担当者・設備はmusuboで設定します。</Notice>
          <div className={styles.dayBody}>{DAYS.map(({ weekday, label }) => {
            const intervals = draft.find(day => day.weekday === weekday)?.intervals ?? []
            return <p key={weekday}>{label}：{intervals.length ? intervals.map(interval => `${interval.start}〜${interval.end}`).join('、') : '休業'}</p>
          })}</div>
          <TextLink href="/settings/google-hours">Googleビジネスの営業時間を開く</TextLink>
        </> : null}
        {settings.openingHoursSource === undefined ? <>
        <div className="contents">
          {DAYS.map(({ weekday, label }) => {
            const day = draft.find((entry) => entry.weekday === weekday)
            const intervals = day?.intervals ?? []
            const isOpen = intervals.length > 0
            const closedText = settings.businessHoursConfigured
              ? '休み（定休日）・お客さまの画面に出ません'
              : '未設定（現在は担当者の勤務時間どおり）'
            return (
              <div key={weekday} className={styles.dayRow}>
                <div className={styles.dayName}>
                  <SaveErrorField names={["isOpen","is_open"]}><Toggle
                    label={`${label}を開ける`}
                    checked={isOpen}
                    disabled={!canEdit || saving}
                    lockedReason={lockedReason}
                    onChange={(next) => updateDay(weekday, () => next ? [{ start: '09:00', end: '18:00', capacity: 1 }] : [])}
                  /></SaveErrorField>
                  <span className={styles.dayLabel}>{label.replace('曜日', '')}</span>
                </div>
                <div className={styles.dayBody}>
                  {intervals.length === 0 ? (
                    <span className={styles.dayOff}>{closedText}</span>
                  ) : null}
                  {intervals.map((interval, index) => (
                  <div key={index} className={styles.intervalLine}>
                    <SaveErrorField names={[`intervals.${index}.start`,"start","interval.start"]}><TimeField
                      disabled={!canEdit || saving}
                      invalid={isBad(weekday, index, 'start')}
                      aria-label={`${label}の開始時刻（${index + 1}区間目）`}
                      value={interval.start}
                      onChange={(value) => updateDay(weekday, (list) => list.map((entry, i) => i === index ? { ...entry, start: value } : entry))}
                      className={styles.timeInput}
                      size="compact"
                      pickerTrigger="field"
                    /></SaveErrorField>
                    <span className={styles.intervalTilde}>〜</span>
                    <SaveErrorField names={[`intervals.${index}.end`,"end","interval.end"]}><TimeField
                      disabled={!canEdit || saving}
                      invalid={isBad(weekday, index, 'end')}
                      aria-label={`${label}の終了時刻（${index + 1}区間目）`}
                      value={interval.end}
                      onChange={(value) => updateDay(weekday, (list) => list.map((entry, i) => i === index ? { ...entry, end: value } : entry))}
                      className={styles.timeInput}
                      size="compact"
                      pickerTrigger="field"
                    /></SaveErrorField>
                    <span className={styles.sameTimeLabel}>同時</span>
                    <SaveErrorField names={[`intervals.${index}.capacity`,"capacity","interval.capacity"]}><NumberInput
                      disabled={!canEdit || saving}
                      aria-label={`${label}の同時受付数（${index + 1}区間目）`}
                      aria-invalid={isBad(weekday, index, 'capacity') || undefined}
                      type="number"
                      min={1}
                      max={1000}
                      note={false}
                      title="1〜1000"
                      value={interval.capacity ?? 1}
                      onChange={(event) => updateDay(weekday, (list) => list.map((entry, i) => i === index ? { ...entry, capacity: Number(event.target.value) } : entry))}
                      className={styles.numInput}
                    /></SaveErrorField>
                    <Button
                      type="button" variant="text" size="inline" disabled={!canEdit || saving} lockedReason={lockedReason}
                      aria-label={`${label}の${index + 1}区間目を削除`}
                      onClick={() => updateDay(weekday, (list) => list.filter((_, i) => i !== index))}
                    >
                      <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" strokeLinecap="round" /></svg>
                    </Button>
                  </div>
                  ))}
                  {isOpen ? <Button variant="text" disabled={!canEdit || saving} lockedReason={lockedReason} aria-label={`${label}の時間をほかの曜日に写す`}
                    onClick={() => { if (canEdit) setCopySource({ weekday, intervals: intervals.map((interval) => ({ ...interval })) }) }}>ほかの曜日に写す</Button> : null}
                  {isOpen && intervals.length < 8 ? (
                    <Button
                      type="button" variant="text" size="inline" disabled={!canEdit || saving} lockedReason={lockedReason}
                      onClick={() => updateDay(weekday, (list) => [...list, { start: '09:00', end: '18:00', capacity: 1 }])}
                    >
                      <Plus size={16} aria-hidden="true" />時間帯を足す
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
        {saveError ? <Notice tone="danger" className="mt-3" >{saveError}{saveConflict ? <Button onClick={onReload}>最新の内容を読み直す</Button> : null}</Notice> : null}
        </> : null}

        {/* 絵 yRPxl：設備と空きの確かめは、開ける時間の白い板の中の入れ子の箱（枠・角12・内側16）。 */}
        <div className={styles.innerStack}>
      <section className={styles.innerSection} aria-labelledby="hours-equip-title">
        <h3 id="hours-equip-title" className={styles.sectionTitle}>設備</h3>
        <div className={styles.innerHeadRow}>
          <p className={styles.sectionDesc}>設備ごとに、同じ時間に使える数を決めます。</p>
          <Button disabled={!canEdit} lockedReason={lockedReason} onClick={() => { if (canEdit) setAddingResource(true) }}>設備を作る</Button>
        </div>
        {resourcesStatus === 'loading' ? <SkeletonRows rows={2} /> : null}
        {resourcesStatus === 'error' ? (
          <StateCard
            icon={<AccountIcon />}
            title="設備を読み込めませんでした"
            description={resourcesError ?? 'もう一度お試しください。'}
            action={<Button onClick={onResourcesRetry}>もう一度読み込む</Button>}
          />
        ) : null}
        {resourcesStatus === 'ready' && resources ? (
          <div className={styles.equipTable}>
            <div className={styles.equipHead} aria-hidden="true">
              <span className={styles.equipName}>設備名</span>
              <span className={styles.equipType}>種類</span>
              <span className={styles.equipCap}>受付上限</span>
              <span className={styles.colMenu} />
            </div>
            {resources.length === 0 ? (
              <p className={styles.noteText}>設備はまだありません。</p>
            ) : resources.map((resource) => (
              <ResourceRowV8
                key={`${accountId}:${resource.id}:${resource.version}`}
                accountId={accountId}
                resource={resource}
                canEdit={canEdit}
                onSaved={onResourceSaved}
                onDeleted={onResourceDeleted}
              />
            ))}
          </div>
        ) : null}
        <ResourceDialog
          open={addingResource}
          onClose={() => setAddingResource(false)}
          accountId={accountId}
          onSaved={(saved) => { setAddingResource(false); onResourceCreated(saved) }}
        />
      </section>

      <SlotCheckV8 accountId={accountId} menus={menus} />
        </div>
      </Card>
    </div></SaveErrorScope>
  )
}

export function ResourceRowV8({ accountId, resource, canEdit, onSaved, onDeleted }: {
  accountId: string
  resource: BookingResource
  canEdit: boolean
  onSaved: (resource: BookingResource) => void
  onDeleted: (id: string) => void
}) {
  const saveErrors = useSaveFormErrors()

  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmScope, setConfirmScope] = useState<{ accountId: string; generation: number; id: string; version: number } | null>(null)
  const targetScope = useRef({ accountId, generation: 0 })
  if (targetScope.current.accountId !== accountId) targetScope.current = { accountId, generation: targetScope.current.generation + 1 }
  const renderedScope = targetScope.current
  const canEditRef = useRef(canEdit); canEditRef.current = canEdit
  const resourceRef = useRef(resource); resourceRef.current = resource
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  const generationRef = useRef(0)
  useEffect(() => {
    generationRef.current += 1
    inFlightRef.current = false
    setBusy(false)
    setError(null)
    setEditing(false)
    setConfirmDelete(false)
    return () => { generationRef.current += 1 }
  }, [accountId])

  async function setActive(nextActive: boolean) {
    if (!canEdit || inFlightRef.current) return
    const generation = generationRef.current
    const alive = () => generation === generationRef.current
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await bookingApi.updateResource(accountId, resource.id, {
        expectedVersion: resource.version,
        isActive: nextActive,
      })
      if (!alive()) return
      onSaved(response.data)
    } catch (cause) {
      if (!alive()) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(resourceSaveError(cause)) }
    } finally {
      if (alive()) { inFlightRef.current = false; setBusy(false) }
    }
  }

  async function remove() {
    if (!confirmScope || !mounted.current || !canEditRef.current || confirmScope.generation !== targetScope.current.generation || confirmScope.id !== resourceRef.current.id || confirmScope.version !== resourceRef.current.version || inFlightRef.current) return
    const generation = generationRef.current
    const alive = () => generation === generationRef.current
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    try {
      await bookingApi.deleteResource(confirmScope.accountId, confirmScope.id, confirmScope.version)
      if (!alive()) return
      setConfirmDelete(false)
      onDeleted(resource.id)
    } catch (cause) {
      if (!alive()) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(resourceSaveError(cause)) }
    } finally {
      if (alive()) { inFlightRef.current = false; setBusy(false) }
    }
  }

  const menuItems: ActionMenuItem[] = canEdit ? [
    {
      id: 'edit',
      label: '中身を編集',
      disabled: busy,
      onSelect: () => setEditing(true),
    },
    {
      id: 'toggle',
      label: resource.isActive ? '受付を停止' : '受付を再開',
      disabled: busy,
      onSelect: () => void setActive(!resource.isActive),
    },
    ...(!resource.usage?.referenced ? [{
      id: 'delete',
      label: '設備を削除する',
      tone: 'danger' as const,
      dividerBefore: true,
      disabled: busy,
      onSelect: () => { if (!mounted.current || !canEditRef.current || renderedScope !== targetScope.current) return; setError(null); setConfirmScope({ ...renderedScope, id: resource.id, version: resource.version }); setConfirmDelete(true) },
    }] : []),
  ] : []

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.equipRow}>
      <span className={styles.equipName} title={`メニュー ${resource.usage?.menuCount ?? '—'}件・予約 ${resource.usage?.bookingCount ?? '—'}件・休業日 ${resource.usage?.exceptionCount ?? '—'}件`}>
        {resource.name}
        {!resource.isActive ? <span className={styles.cellWarn}>（受付停止中）</span> : null}
      </span>
      <span className={styles.equipType}>{resource.type}</span>
      <span className={styles.equipCap}>{resource.capacity}</span>
      <span className={styles.colMenu}>
        {canEdit ? <RowMenu
          appearance="box"
          size="row"
          label={`「${resource.name}」のそのほかの操作`}
          menuLabel={`「${resource.name}」の操作`}
          items={menuItems}
        /> : null}
      </span>
      {error ? <Notice tone="danger" className="w-full" >{error}</Notice> : null}
      <ResourceDialog
        open={editing}
        onClose={() => setEditing(false)}
        accountId={accountId}
        resource={resource}
        onSaved={(saved) => { setEditing(false); onSaved(saved) }}
      />
      <ConfirmDialog
        open={confirmDelete && confirmScope?.generation === targetScope.current.generation}
        title={`「${resource.name}」を削除しますか？`}
        description="削除すると元に戻せません。受付だけ止めたいときは「受付を停止」を使ってください。"
        confirmLabel="削除する"
        destructive
        busy={busy}
        error={error ?? undefined}
        onCancel={() => { if (!busy) setConfirmDelete(false) }}
        onConfirm={() => remove()}
      >{confirmScope ? <OperationTargetSummary accounts={[{ id: confirmScope.accountId }]} /> : null}</ConfirmDialog>
    </div></SaveErrorScope>
  )
}

export function ResourceDialog({ open, onClose, accountId, resource, onSaved }: {
  open: boolean
  onClose: () => void
  accountId: string
  resource?: BookingResource
  onSaved: (resource: BookingResource) => void
}) {
  const saveErrors = useSaveFormErrors()

  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [capacity, setCapacity] = useState('1')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  const generationRef = useRef(0)
  useEffect(() => {
    generationRef.current += 1
    inFlightRef.current = false
    setSaving(false)
    setError(null)
    return () => { generationRef.current += 1 }
  }, [accountId])

  useEffect(() => {
    if (!open) return
    setName(resource?.name ?? '')
    setType(resource?.type ?? '')
    setCapacity(String(resource?.capacity ?? 1))
    setError(null)
  }, [open, resource, accountId])

  async function submit() {
    if (inFlightRef.current) return
    const generation = generationRef.current
    const alive = () => generation === generationRef.current
    const parsedCapacity = Number(capacity)
    if (!name.trim() || name.trim().length > 100 || !type.trim() || type.trim().length > 50
      || !Number.isInteger(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 1000) {
      if (!saveErrors.fail("name", '設備名は1〜100文字、種類は1〜50文字、受付上限は1〜1000の整数で入力してください。'))
      setError('設備名は1〜100文字、種類は1〜50文字、受付上限は1〜1000の整数で入力してください。')
      return
    }
    inFlightRef.current = true
    setSaving(true)
    setError(null)
    try {
      if (resource) {
        const response = await bookingApi.updateResource(accountId, resource.id, {
          expectedVersion: resource.version,
          name: name.trim(),
          type: type.trim(),
          capacity: parsedCapacity,
          isActive: resource.isActive,
        })
        if (!alive()) return
        onSaved(response.data)
      } else {
        const response = await bookingApi.createResource(accountId, {
          name: name.trim(), type: type.trim(), capacity: parsedCapacity,
        })
        if (!alive()) return
        onSaved(response.data)
      }
    } catch (cause) {
      if (!alive()) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)

      setError(resourceSaveError(cause)) }
    } finally {
      if (alive()) { inFlightRef.current = false; setSaving(false) }
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open={open}
      title={resource ? `「${resource.name}」を編集` : '設備を作る'}
      onCancel={() => { if (!saving) onClose() }}
      busy={saving}
      footer={<DialogActions>
          <Button onClick={() => { if (!saving) onClose() }} disabled={saving}>キャンセル</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving} busy={saving}>保存する</Button>
        </DialogActions>}
    >
      <div className="grid gap-3">
        <Field label="設備名"><SaveErrorField names={["name"]}><TextField aria-label="設備名" value={name} onChange={(event) => setName(event.target.value)} disabled={saving} maxLength={100} /></SaveErrorField></Field>
        <Field label="種類"><SaveErrorField names={["type"]}><TextField aria-label="種類" value={type} onChange={(event) => setType(event.target.value)} disabled={saving} maxLength={50} placeholder="例：部屋・席・機器" /></SaveErrorField></Field>
        <Field label="受付上限"><SaveErrorField names={["capacity"]}><NumberInput aria-label="受付上限" type="number" min={1} max={1000} value={capacity} onChange={(event) => setCapacity(event.target.value)} disabled={saving} /></SaveErrorField></Field>
        {error ? <Notice tone="danger" marker="dot" heading="失敗：設備を保存できませんでした">{error}</Notice> : null}

      </div>
    </Dialog></SaveErrorScope>
  )
}

export function SlotCheckV8({ accountId, menus }: { accountId: string; menus: BookingMenu[] }) {
  const activeMenus = useMemo(() => menus.filter((menu) => menu.is_active), [menus])
  const [menuId, setMenuId] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [staffId, setStaffId] = useState('')
  const [staffError,setStaffError]=useState(false)
  const [staffRetry,setStaffRetry]=useState(0)
  const [staffOptions, setStaffOptions] = useState<BookingStaff[]>([])
  const staffRows = useMemo(() => staffOptions.map((person) => ({ id: person.id, name: person.display_name })), [staffOptions])
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [result, setResult] = useState<BookingSlotCheckResult | null>(null)
  const requestRef = useRef(0)
  /* WEB054：条件・アカウントを変えたら、確かめている途中の結果を捨てる（古い条件の結果を新しい条件の下に出さない）。 */
  const changeCriteria = () => {
    requestRef.current += 1
    setResult(null)
    setChecking(false)
    setCheckError(null)
  }

  useEffect(() => {
    requestRef.current += 1
    setResult(null)
    setChecking(false)
    setCheckError(null)
  }, [accountId,staffRetry])

  useEffect(() => {
    let cancelled = false
    void bookingApi.listStaff(accountId)
      .then((res) => {
        if (!cancelled) {setStaffOptions(res.staff.filter((person) => person.is_active));setStaffError(false)}
      })
      .catch(() => { if (!cancelled) setStaffError(true) })
    return () => { cancelled = true }
  }, [accountId,staffRetry])

  useEffect(() => {
    if (!menuId && activeMenus.length > 0) setMenuId(activeMenus[0].id)
  }, [activeMenus, menuId])

  async function run() {
    if (staffError || !menuId || !date || !time) return
    const requestId = ++requestRef.current
    setChecking(true)
    setCheckError(null)
    try {
      const response = await bookingApi.checkAvailability(accountId, { menuId, staffId: staffId || undefined, date, time })
      if (requestId !== requestRef.current) return
      setResult(response)
    } catch (error) {
      if (requestId !== requestRef.current) return
      setResult(null)
      setCheckError(error instanceof ApiError && error.status === 403
        ? permissionDeniedMessage('store')
        : '空き状況を確かめられませんでした。もう一度お試しください。')
    } finally {
      if (requestId === requestRef.current) setChecking(false)
    }
  }

  const canRun = Boolean(menuId && date && time) && !checking

  return (
    <section className={styles.innerSection} aria-labelledby="hours-check-title">
      {/* 絵 yRPxl は題だけ。説明の1行は行を高くするので「？」の中へ。 */}
      <div className={styles.innerTitleRow}>
        <h3 id="hours-check-title" className={styles.sectionTitle}>空きを確かめる</h3>
        <HelpTip label="空きを確かめるの説明">お客さまの画面と同じ条件で、その日時に受けられるか確かめます。確かめても予約は作られません。<TextLink href="/booking/staff">予約の担当者</TextLink>・<TextLink href="/staff">ログインユーザー</TextLink>の設定も確かめられます。</HelpTip>
      </div>
      <div className={styles.checkGrid}>
        {staffError?<ListState kind="error" title="担当を読み込めませんでした" onRetry={()=>setStaffRetry(n=>n+1)}/>:null}
        <SaveErrorField names={["menuId"]}><EntityKindField
          kind="booking_menu"
          label="確かめるメニュー"
          options={activeMenus}
          value={menuId}
          onChange={(value) => { setMenuId(value); changeCriteria() }}
          placeholder={activeMenus.length === 0 ? '（受付中のメニューがありません）' : '（メニューを選ぶ）'}
          meta={() => undefined}
        /></SaveErrorField>
        <Field label="日付"><SaveErrorField names={["date"]}><DateField aria-label="確かめる日付" value={date} onChange={(value) => { setDate(value); changeCriteria() }} className="mt-1" /></SaveErrorField></Field>
        <Field label="開始時刻"><SaveErrorField names={["time"]}><TimeField aria-label="確かめる開始時刻" size="field" value={time} onChange={(value) => { setTime(value); changeCriteria() }} className="mt-1" /></SaveErrorField></Field>
        <SaveErrorField names={["staffId"]}><EntityKindField
          kind="staff"
          label="確かめる担当"
          options={staffRows}
          value={staffId}
          onChange={(value) => { setStaffId(value); changeCriteria() }}
          clearable
          placeholder="（担当：指名なし）"
          meta={() => undefined}
        /></SaveErrorField>
      </div>
      <div className={styles.checkAction}>
        {/* 絵 yRPxl：虫めがね付きの白いボタン */}
        <Button variant="secondary" onClick={() => void run()} disabled={!canRun} title={!menuId ? '確かめるメニューを選んでください' : !date ? '確かめる日付を入力してください' : !time ? '開始時刻を入力してください' : undefined} busy={checking}><Search size={16} aria-hidden="true" />確かめる</Button>
        {result ? (
          <div className={`${styles.checkResult} ${result.bookable ? styles.checkOk : styles.checkNg}`} role="status">
            {result.bookable ? (
              <p>空いています。{result.per_staff?.length ? `${result.per_staff.map((entry) => entry.display_name).join('・')}が受けられます。` : ''}</p>
            ) : (
              <div>
                <p>この日時は受けられません。</p>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {result.reasons.map((reason) => <li key={reason}>{slotReasonLabel(reason)}</li>)}
                </ul>
              </div>
            )}
            {result.per_staff?.map((entry) => entry.remaining !== null && entry.capacity !== null ? <p key={entry.staff_id}>{entry.display_name}: 残り {entry.remaining}/{entry.capacity}</p> : null)}
          </div>
        ) : null}
      </div>
      {checkError ? <Notice tone="danger" className="mt-2" >{checkError}</Notice> : null}
    </section>
  )
}
