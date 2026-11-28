"use client"

import { useEffect, useRef, useState } from 'react'
import { ApiError, api, describeSaveFailure, type CommonActionResources, type IncomingWebhookDetail } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ActionList from '@/components/shared/action-list'
import { EntityPickerField } from '@/components/shared/entity-picker'
import { useWebhookWriteAccess, canManageWebhooksNow } from './write-access'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { notifyToast } from '@/components/shared/toast'
import { Bookmark, FileText, Play, Send, Tag, Workflow, Zap, Target, type LucideIcon } from 'lucide-react'

type Ref = IncomingWebhookDetail['actions'][number]
const KINDS = [
  { id: 'tag', label: 'タグを付ける', resource: 'tags' },
  { id: 'support_mark', label: '対応マークを付ける', resource: 'supportMarks' },
  { id: 'template', label: 'テンプレートを送る', resource: 'templates' },
  { id: 'scenario', label: 'シナリオを始める', resource: 'scenarios' },
  { id: 'outgoing_webhook', label: '別のサービスへ知らせる', resource: 'webhooks' },
  { id: 'common_action', label: '共通アクションを動かす', resource: 'commonActions' },
] as const
/* 行の印は種類ごとに変える（全部同じ印だと見分けられない）。 */
const KIND_ICONS: Record<string, LucideIcon> = Object.assign(Object.create(null), { tag: Tag, support_mark: Bookmark, template: FileText, scenario: Play, outgoing_webhook: Send, common_action: Workflow, automation: Zap, conversion: Target })
const LEGACY_KIND_LABELS: Record<string, string> = Object.assign(Object.create(null), { automation: 'オートメーションを動かす', conversion: '成果を記録する' })

/** 既存の版付き config の口につなぐ。照合設定・未対応の既存参照は保持する。 */
export default function IncomingActions({ detail, accountId, readOnly, onSaved, onGuardReady }: { detail: IncomingWebhookDetail; accountId: string; readOnly: boolean; onSaved: () => void; onGuardReady: (guard: ((action: () => void) => void) | null) => void }) {
  const saveErrors = useSaveFormErrors()
  const access = useWebhookWriteAccess()
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const canChangeNow = () => !readOnlyRef.current && canManageWebhooksNow()
  const [draft, setDraft] = useState(detail.actions)
  const [resources, setResources] = useState<CommonActionResources | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    setResources(null); setLoadError(false)
    if (readOnly) return
    let current = true
    Promise.resolve().then(() => api.commonActions.resources(accountId)).then(res => { if (!res.success) throw new Error('resources'); if (current) setResources(res.data) })
      .catch(() => { if (current) setLoadError(true) })
    return () => { current = false }
  }, [accountId, readOnly, attempt])
  const items = (kind: string) => {
    const key = KINDS.find(item => item.id === kind)?.resource
    return key ? resources?.[key] ?? [] : []
  }
  const target = (action: Ref, id: string): Ref => ({ ...action, refId: id, displayName: items(action.refKind).find(item => item.id === id)?.name ?? '未設定',
    refVersionId: action.refKind === 'common_action' ? resources?.commonActions.find(item => item.id === id)?.currentPublishedVersionId ?? null : null })
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.actions)
  const guard = useUnsavedGuard({ dirty, busy, subject: '行うことの変更', onDiscard: () => setDraft(detail.actions) })
  useEffect(() => { onGuardReady(guard.guarded); return () => onGuardReady(null) }, [onGuardReady, guard.guarded])
  const save = async () => {
    if (!canChangeNow()) { setError(access.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    if (lock.current || readOnly) return
    lock.current = true; setBusy(true); setError('')
    try {
      const res = await api.webhooks.incoming.saveConfig(detail.id, accountId, { expectedVersion: detail.version, identityMatching: detail.identityMatching,
        actions: draft.map(({ refKind, refId, refVersionId }) => ({ refKind, refId, refVersionId })) })
      if (!res.success) throw new ApiError(422, res.error, undefined, undefined, undefined, undefined, res.fields)
      if (active.current) { guard.disarm(); notifyToast('保存しました'); onSaved() }
    } catch (cause) { if (active.current && !saveErrors.capture(cause)) setError(describeSaveFailure(cause)) }
    finally { lock.current = false; if (active.current) setBusy(false) }
  }
  return <SaveErrorScope errors={saveErrors}>
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="行うことの変更" busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    {loadError ? <Notice tone="danger" message="動きの対象を読み込めませんでした。" action={<Button onClick={() => setAttempt(n => n + 1)}>もう一度読み込む</Button>} /> : null}
    <ActionList<Ref> value={draft} onChange={setDraft} disabled={busy || (!access.allowed && !access.reason)} lockedReason={access.reason} canChangeNow={canChangeNow} idOf={(_, index) => String(index)} titleOf={action => action.displayName} iconOf={action => KIND_ICONS[action.refKind]} kindOf={action => KINDS.find(kind => kind.id === action.refKind)?.label ?? (LEGACY_KIND_LABELS[action.refKind] ?? '登録済みの操作')}
      choices={draft.length >= 20 ? [] : KINDS.map(kind => ({ id: kind.id, label: kind.label, disabled: !resources, disabledReason: loadError ? '候補を読み直してください' : '候補を読み込んでいます', make: () => ({ refKind: kind.id, refId: '', refVersionId: null, displayName: kind.label }),
        picker: { title: `${kind.label}対象を選ぶ`, items: items(kind.id), apply: targetFromIds } }))}
      renderEditor={(action, update, index) => <SaveErrorField names={[`actions.${index}.refId`, "refId", "actions"]}><EntityPickerField label="操作の対象" noun="対象" disabled={!access.allowed && !access.reason} lockedReason={access.reason} canChangeNow={canChangeNow} items={items(action.refKind)} value={action.refId} onChange={id => update(target(action, id))} /></SaveErrorField>} />
    {error ? <Notice tone="danger" action={<Button onClick={() => guard.guarded(onSaved)}>最新の内容を読み込む</Button>}>{error}</Notice> : null}
    {/* 保存は変えたときだけ出す（変えていない間は絵どおり、行と［行うことを足す］だけ）。 */}
    {!dirty ? null : <Button disabled={busy || !access.allowed} lockedReason={access.reason} busy={busy} onClick={() => void save()}>行うことを保存する</Button>}
  </SaveErrorScope>
  function targetFromIds(action: Ref, ids: string[]) { return target(action, ids[0]) }
}
