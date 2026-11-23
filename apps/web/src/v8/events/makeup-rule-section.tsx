'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { eventsApi, type EventDetail, type EventListItem, type EventMakeupRule } from '@/lib/api'
import { bookingMakeupApi } from '@/lib/api/helpers/gap2'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { useFormErrors } from '@/lib/use-form-errors'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import FormSection from '@/components/shared/form-section'
import { Field } from '@/components/shared/form-controls'
import NumberField from '@/components/shared/number-field'
import Select from '@/components/shared/select'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { ToggleField } from '@/components/shared/toggle'
import Notice from '@/components/shared/notice'
import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { isSaveConflict, SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { makeupRuleSummary, readMakeupRule } from './makeup-rule'

const subscribeSession = (listener: () => void) => {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}

export function MakeupRuleSection({ accountId, event, busy, onSaved, onEditState }: {
  accountId: string; event: EventDetail; busy: boolean
  onEditState: (state: { dirty: boolean; busy: boolean }) => void
  onSaved: (rule: EventMakeupRule, revision: number, previousRevision: number) => void
}) {
  const role = useStaffRole()
  const manager = canManageRole(role)
  const roleLock = usePermissionLockReason(manager, 'manager')
  const session = useSyncExternalStore(subscribeSession, readPermissionSessionSnapshot, () => null)
  const ownerAccount = event.line_account_id === accountId
  const lock = session?.impersonation ? '代理ログイン中は変更できません。代理ログインを終了してから操作してください。'
    : !ownerAccount ? 'このクラスを持つLINE公式アカウントで編集してください。' : roleLock
  const rule = readMakeupRule(event.makeup_rule_json)
  const [open, setOpen] = useState(false)
  const allowed = manager && !lock && Boolean(rule) && Number.isInteger(event.version) && event.version! >= 1 && !busy
  return <FormSection id="event-makeup-rule" title="振替の決まり" description="欠席した方に渡す振替の条件を設定します。"
    action={<Button lockedReason={lock} disabled={!allowed} onClick={() => { if (allowed) setOpen(true) }}>振替の決まりを編集する</Button>}>
    {rule ? <p className="text-body">{rule.enabled ? makeupRuleSummary(rule) : '使わない'}</p> : <Notice tone="warn" message="振替の決まりを読み戻せませんでした。イベントを読み直してから設定してください。" />}
    {open && rule ? <MakeupRuleDialog key={`${accountId}:${event.id}`} accountId={accountId} event={event} initial={rule}
      lockedReason={lock} allowed={allowed} onEditState={onEditState} onCancel={() => setOpen(false)} onSaved={(saved, revision, previousRevision) => {
        onSaved(saved, revision, previousRevision); setOpen(false); notifyToast('振替の決まりを保存しました')
      }} /> : null}
  </FormSection>
}

function MakeupRuleDialog({ accountId, event, initial, allowed, lockedReason, onCancel, onSaved, onEditState }: {
  accountId: string; event: EventDetail; initial: EventMakeupRule; allowed: boolean; lockedReason?: string
  onEditState: (state: { dirty: boolean; busy: boolean }) => void
  onCancel: () => void; onSaved: (rule: EventMakeupRule, revision: number, previousRevision: number) => void
}) {
  const [rule, setRule] = useState(initial)
  const [numbers, setNumbers] = useState({ cutoffHours: String(initial.cutoffHours), validDays: String(initial.validDays), monthlyCap: String(initial.monthlyCap) })
  const [revision, setRevision] = useState(event.version!)
  const [saved, setSaved] = useState(initial)
  const [classes, setClasses] = useState<EventListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  const savingRef = useRef(false)
  const access = useRef(allowed)
  access.current = allowed
  const fields = useFormErrors()
  const saveErrors = useSaveFormErrors()
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    setLoading(true); setLoadError(false)
    void (async () => {
      const rows: EventListItem[] = []
      for (let page = 1; ; page++) {
        const response = await eventsApi.listEvents(accountId, { page, limit: 100 })
        if (!current) return
        if (!Array.isArray(response.items) || !Number.isFinite(response.total) || (!response.items.length && rows.length < response.total)) throw new Error('invalid_class_list')
        rows.push(...response.items)
        if (rows.length >= response.total) break
      }
      if (current) setClasses(rows.filter(item => item.line_account_id === accountId))
    })().catch(() => { if (current) setLoadError(true) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [accountId, retry])
  const conflict = useSaveConflict({ contextKey: `${accountId}:${event.id}`, fetchLatest: () => eventsApi.getEvent(accountId, event.id), reload: async () => {
    try {
      const latest = await eventsApi.getEvent(accountId, event.id)
      const next = readMakeupRule(latest.makeup_rule_json)
      if (!next || !Number.isInteger(latest.version)) throw new Error('invalid_makeup_rule')
      setRule(next); setSaved(next); setRevision(latest.version!)
      setNumbers({ cutoffHours: String(next.cutoffHours), validDays: String(next.validDays), monthlyCap: String(next.monthlyCap) })
      fields.reset(); saveErrors.reset(); setError(''); conflict.clear()
    } catch { setError('振替の決まりを読み直せませんでした。もう一度お試しください。') }
  } })
  const ranges = { cutoffHours: [0, 168, '欠席連絡の締め切り', '時間前'], validDays: [1, 366, '振替の期限', '日間'], monthlyCap: [1, 52, '1か月に渡す上限', '回'] } as const
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const [min, max, label] = ranges[key]
    fields.define(key, label, () => numbers[key] !== '' && Number.isInteger(Number(numbers[key])) && Number(numbers[key]) >= min && Number(numbers[key]) <= max ? null : `${min}〜${max}の整数を入れてください`)
  }
  fields.define('targetIds', '指定のクラス', () => rule.target !== 'list' ? null : !rule.targetIds.length ? '振替先を1つ以上選んでください'
    : rule.targetIds.length > 100 ? '振替先は100クラス以内で選んでください'
      : !loading && !loadError && rule.targetIds.some(id => !classes.some(item => item.id === id)) ? '使えなくなったクラスがあります。振替先を選び直してください' : null)
  async function save() {
    if (!access.current || savingRef.current || readPermissionSessionSnapshot()?.impersonation || conflict.conflict) return
    if (fields.submit().length || (rule.target === 'list' && (loading || loadError))) return
    savingRef.current = true; setSaving(true); setError('')
    const next = { ...rule, cutoffHours: Number(numbers.cutoffHours), validDays: Number(numbers.validDays), monthlyCap: Number(numbers.monthlyCap), targetIds: rule.target === 'same_kind' ? [] : [...new Set(rule.targetIds)] }
    try {
      const response = await bookingMakeupApi.rule(accountId, event.id, next, revision)
      if (active.current) onSaved(response.data.rule, response.data.revision, revision)
    } catch (cause) {
      if (active.current) { if (isSaveConflict(cause)) conflict.mark(); else if (!saveErrors.capture(cause)) setError(describeApiFailure(cause, '振替の決まりの保存')) }
    } finally { savingRef.current = false; if (active.current) setSaving(false) }
  }
  const candidateOptions = classes.map(item => ({ value: item.id, label: item.name, ...entityOptionMetadata(item) }))
  const missingOptions = rule.targetIds.filter(id => !candidateOptions.some(item => item.value === id)).map(id => ({ value: id, label: '利用できないクラス（選び直してください）', disabled: true }))
  const dirty = JSON.stringify(rule) !== JSON.stringify(saved) || Object.entries(numbers).some(([key, value]) => value !== String(saved[key as keyof typeof numbers]))
  useEffect(() => { onEditState({ dirty, busy: saving }) }, [dirty, saving, onEditState])
  useEffect(() => () => { onEditState({ dirty: false, busy: false }) }, [onEditState])
  return <SaveErrorScope errors={saveErrors}><Dialog open title="振替の決まりを編集" onCancel={onCancel} onConfirm={() => void save()} confirmLabel="保存する" busyLabel="保存中…" busy={saving} dirty={dirty}
    confirmLockedReason={lockedReason} confirmDisabled={!allowed || Boolean(conflict.conflict) || rule.target === 'list' && (loading || loadError)} error={error}>
    {conflict.conflict ? <SaveConflictBand title="ほかの人が先にクラスを保存しました" compareBusy={conflict.compareBusy} onCompare={() => void conflict.compare()} onReload={() => void conflict.reloadLatest()} /> : null}
    <SaveErrorField names={["enabled", "rule.enabled"]}><ToggleField checked={rule.enabled} disabled={!allowed || saving} onChange={enabled => setRule(value => ({ ...value, enabled }))}>振替を使う</ToggleField></SaveErrorField>
    {(Object.keys(ranges) as Array<keyof typeof ranges>).map(key => <Field key={key} label={ranges[key][2]} error={fields.error(key)} required>
      <SaveErrorField names={[key, `rule.${key}`]}><NumberField {...fields.bind(key)} min={ranges[key][0]} max={ranges[key][1]} unit={ranges[key][3]} value={numbers[key]} disabled={!allowed || saving}
        onChange={change => setNumbers(value => ({ ...value, [key]: change.target.value }))} /></SaveErrorField>
    </Field>)}
    <Field label="振替先"><SaveErrorField names={["target", "rule.target"]}><Select aria-label="振替先" value={rule.target} disabled={!allowed || saving} options={[{ value: 'same_kind', label: '同じクラスの種類' }, { value: 'list', label: '指定のクラス' }]}
      onChange={target => setRule(value => ({ ...value, target: target as EventMakeupRule['target'] }))} /></SaveErrorField></Field>
    {rule.target === 'list' ? <Field label="指定のクラス" required error={fields.error('targetIds')}>
      <div {...fields.bind('targetIds')}><SaveErrorField names={["targetIds", "rule.targetIds"]}><EntitySelect aria-label="指定のクラス" kind="event" noun="クラス" values={rule.targetIds} options={[...candidateOptions, ...missingOptions]} loading={loading}
        disabled={!allowed || saving || loading || loadError} onChange={targetIds => setRule(value => ({ ...value, targetIds }))} /></SaveErrorField></div>
    </Field> : null}
    {loadError ? <Notice tone="warn" message="振替先のクラスを読み込めませんでした。指定のクラスを保存する前に読み直してください。" action={<Button onClick={() => setRetry(value => value + 1)}>もう一度読み込む</Button>} /> : null}
    <SaveConflictCompareDialog open={conflict.compareOpen} busy={conflict.compareBusy} error={conflict.compareError}
      lines={conflict.latest ? [{ text: `保存されている内容：${readMakeupRule(conflict.latest.makeup_rule_json) ? makeupRuleSummary(readMakeupRule(conflict.latest.makeup_rule_json)!) : '読み出せません'}` }, { text: `いまの入力：${makeupRuleSummary({ ...rule, cutoffHours: Number(numbers.cutoffHours), validDays: Number(numbers.validDays), monthlyCap: Number(numbers.monthlyCap) })}` }] : null}
      onCancel={conflict.closeCompare} onReload={() => void conflict.reloadLatest()} />
  </Dialog></SaveErrorScope>
}
