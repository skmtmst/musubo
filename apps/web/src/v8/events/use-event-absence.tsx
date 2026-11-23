'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { eventsApi, type EventMakeupRule } from '@/lib/api'
import { bookingMakeupApi } from '@/lib/api/helpers/gap2'
import { useStaffRole } from '@/lib/staff-role'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useFormErrors } from '@/lib/use-form-errors'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { describeApiFailure } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import { TextArea } from '@/components/shared/text-field'
import { ToggleField } from '@/components/shared/toggle'
import { readMakeupRule } from './makeup-rule'

export type AbsenceTarget = { bookingId: string; eventId: string; name: string; startsAt: string }
const subscribeSession = (listener: () => void) => {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}

export function absenceNotice(grant: boolean, credit: unknown, reason: string | null): string {
  if (credit) return '欠席を受け付け、振替を1回渡しました。振替先は後で選べます。'
  if (!grant) return '欠席を受け付けました。振替は渡していません。'
  // 店が理由を付けて締め切り後に渡す場合も、APIはcutoff_passedを返す。渡す指定で付かなかった時は月上限。
  if (reason === 'monthly_cap' || reason === 'cutoff_passed') return '欠席を受け付けました。今月の振替の上限に達しているため、振替は付きません。'
  return '欠席を受け付けました。振替は付いていません。'
}

/** 欠席の窓と結果を、名簿の入口が変わっても同じ形で扱う。 */
export function useEventAbsence({ accountId, scope, onSaved }: { accountId: string; scope: string; onSaved: () => void }) {
  const role = useStaffRole()
  const canWrite = role === 'owner' || role === 'admin' || role === 'staff'
  const permissionLock = usePermissionLockReason(canWrite)
  const session = useSyncExternalStore(subscribeSession, readPermissionSessionSnapshot, () => null)
  const lockedReason = session?.impersonation ? '代理ログイン中は欠席を受け付けられません。代理ログインを終了してください。'
    : role === null ? '操作する権限を確認しています。' : permissionLock
  const allowed = canWrite && !lockedReason && Boolean(accountId)
  const [target, setTarget] = useState<AbsenceTarget | null>(null)
  const [notice, setNotice] = useState('')
  const context = JSON.stringify([accountId, scope])
  const currentContext = useRef({ context })
  if (currentContext.current.context !== context) currentContext.current = { context }
  const openedContext = currentContext.current
  const [renderedContext, setRenderedContext] = useState(context)
  if (renderedContext !== context) { setRenderedContext(context); setTarget(null); setNotice('') }
  return {
    lockedReason, allowed,
    open: (next: AbsenceTarget) => { if (allowed && !target) { setNotice(''); setTarget(next) } },
    notice: notice ? <Notice tone="info" role="status">{notice}</Notice> : null,
    dialog: target ? <AbsenceDialog key={`${context}:${target.bookingId}`} accountId={accountId} target={target}
      allowed={allowed} lockedReason={lockedReason} onCancel={() => setTarget(null)} onSaved={message => {
        if (currentContext.current !== openedContext) return
        setTarget(null); setNotice(message); onSaved()
      }} /> : null,
  }
}

function AbsenceDialog({ accountId, target, allowed, lockedReason, onCancel, onSaved }: {
  accountId: string; target: AbsenceTarget; allowed: boolean; lockedReason?: string
  onCancel: () => void; onSaved: (notice: string) => void
}) {
  const [rule, setRule] = useState<EventMakeupRule | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [initialGrant, setInitialGrant] = useState(false)
  const [grant, setGrant] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  const active = useRef(true)
  const access = useRef(allowed)
  access.current = allowed
  const fields = useFormErrors()
  const saveErrors = useSaveFormErrors()
  const starts = Date.parse(target.startsAt)
  const late = Boolean(rule && starts - Date.now() < rule.cutoffHours * 3600000)
  const missingReason = grant && late && !reason.trim()
  const dirty = grant !== initialGrant || reason !== ''
  const guard = useUnsavedGuard({ dirty, busy, onDiscard: onCancel })
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    setLoadState('loading')
    void eventsApi.getEvent(accountId, target.eventId).then(event => {
      if (!current) return
      const next = readMakeupRule(event.makeup_rule_json)
      if (!next || event.line_account_id !== accountId || !Number.isFinite(starts)) throw new Error('invalid_absence_context')
      const selected = next.enabled && starts - Date.now() >= next.cutoffHours * 3600000
      setRule(next); setInitialGrant(selected); setGrant(selected); setLoadState('ready')
    }).catch(() => { if (current) setLoadState('error') })
    return () => { current = false }
  }, [accountId, target.eventId, starts, attempt])
  fields.define('reason', '振替を渡す理由', () => reason.trim().length > 500 ? '理由は500文字以内で入れてください。'
    : grant && rule && starts - Date.now() < rule.cutoffHours * 3600000 && !reason.trim() ? '締め切り後に振替を渡す理由を入れてください。' : null)
  async function save() {
    if (!access.current || saving.current || readPermissionSessionSnapshot()?.impersonation || loadState !== 'ready' || !rule) return
    if (fields.submit().length) return
    if (starts <= Date.now()) { setError('この回はすでに始まっています。名簿を読み直して出欠を記録してください。'); return }
    saving.current = true; setBusy(true); setError(''); saveErrors.reset()
    try {
      const result = await bookingMakeupApi.absenceByStore(accountId, target.bookingId, { grantMakeup: rule.enabled && grant, ...(reason.trim() ? { reason: reason.trim() } : {}) })
      if (active.current) { guard.disarm(); onSaved(absenceNotice(rule.enabled && grant, result.data.makeupCredit, result.data.reasonIfNone)) }
    } catch (cause) {
      if (active.current && !saveErrors.capture(cause)) setError(describeApiFailure(cause, '欠席の受付'))
    } finally { saving.current = false; if (active.current) setBusy(false) }
  }
  return <SaveErrorScope errors={saveErrors}>
    <Dialog open contentLayout="form" title="欠席を受け付ける" description={`${target.name}の欠席を受け付けます。空いた席はキャンセル待ちの方へ回ります。`}
      confirmLabel="欠席にする" busyLabel="受け付けています…" onCancel={onCancel} onConfirm={() => void save()}
      dirty={dirty} busy={busy} confirmDisabled={!allowed || loadState !== 'ready' || missingReason}
      confirmDisabledReason={missingReason ? '振替を渡す理由を入れると欠席にできます' : undefined} confirmLockedReason={lockedReason} error={error}>
      <OperationTargetSummary accounts={[{ id: accountId }]} />
      {loadState === 'loading' ? <p className="text-body" role="status">振替の決まりを確認しています…</p> : loadState === 'error' ? <Notice tone="warn" message="振替の決まりを読み込めませんでした。欠席はまだ受け付けていません。"
        action={<Button onClick={() => setAttempt(value => value + 1)}>もう一度読み込む</Button>} /> : rule ? <>
        <SaveErrorField names={['grantMakeup', 'grant_makeup']}><ToggleField checked={grant} disabled={!allowed || busy || !rule.enabled} onChange={setGrant}>振替を1回渡す</ToggleField></SaveErrorField>
        <Notice tone="info">{!rule.enabled ? 'このクラスは振替を使いません。' : late ? '連絡の締め切りを過ぎています。振替を渡す場合は理由が必要です。' : '連絡の締め切り内です。振替先は欠席の後に選べます。'}{rule.enabled ? ` 振替の期限は元の回から${rule.validDays}日間です。今月の上限に達している場合は振替が付きません。` : ''}</Notice>
        {rule.enabled && (grant || reason) ? <Field label="振替を渡す理由" required={grant && late} error={fields.error('reason')}>
          <SaveErrorField names={['reason']}><TextArea {...fields.bind('reason')} value={reason} maxLength={500} rows={3} disabled={!allowed || busy} onChange={event => setReason(event.target.value)} /></SaveErrorField>
        </Field> : null}
      </> : null}
    </Dialog>
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="欠席の入力" onCancel={guard.cancelLeave} onConfirm={guard.confirmLeave} />
  </SaveErrorScope>
}
