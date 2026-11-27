'use client'

import { useInsertTokenNames } from '@/lib/use-insert-token-names'

import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useEffect, useRef, useState } from 'react'
import { ListOrdered, Send, Users } from 'lucide-react'
import type { Tag } from '@line-crm/shared'
import { api, type BroadcastApprovalCandidate } from '@/lib/api'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { SingleOperatorFields } from '@/components/broadcasts/broadcast-approval'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import DateTimeField from '@/components/shared/date-time-field'
import { formatNumber } from '@/lib/format'
import { datetimeLocalJstToUtcIso } from '@/lib/jst-datetime'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import styles from './quick-send.module.css'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import InsertTextField, { type InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import MessageInsertRow, { MessageBody, MessageInsertButton } from '@/components/shared/message-insert-row'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockTip } from '@/components/shared/permission-lock-tip'
import { canUseQuickSendNow, captureQuickSendAccess, useQuickSendAccess, type QuickSendOperation } from './quick-send-access'

/*
 * ★V8 一斉配信 かんたんに送る（板 ・小窓 640）。
 *
 * 今の部品（app/broadcasts/quick-send-dialog.tsx。一覧から開く口が無かった）の動きを写して一から書いた。
 * 本文・相手・いつ・人数の見込み・承認の順。1,000人以上に送るときは承認する人を選んで頼む。
 * 口は今と同じ（tags.list・approval.candidates・preflight・create・send・approval.request）。
 * 入口：一斉配信一覧の「配信を作る ▾」の「かんたんに送る」（分け方）。
 */

/** 承認を頼む境目（絵の文どおり）。 */
/** 「名前」を押して入る文字。送るときに友だちの名前へ置き換わる形（{{name}}）。 */
export const QUICK_SEND_NAME_TOKEN = '{{name}}'
export const APPROVAL_THRESHOLD = 1000
export const TEXT_LIMIT = 5000
const ROLE_LABELS: Record<string, string> = { owner: 'オーナー', admin: '管理者', staff: 'スタッフ' }

type Estimate = { count: number; blocked: number; remaining: number | null }

/** 見込みの1文。今月の残りが読めたときだけ足す。 */
export function estimateText(estimate: Estimate): string {
  const base = `${formatNumber(estimate.count)} 人に届く見込み（ブロック中 ${formatNumber(estimate.blocked)} 人を除く）`
  return estimate.remaining === null ? base : `${base}・今月あと ${formatNumber(estimate.remaining)} 通 送れます`
}

/** 元の札の形を保ち、拒否理由だけを共通の吹き出しへつなぐ。 */
function QuickSendChoice({ lockedReason, ...props }: React.ComponentProps<'button'> & { lockedReason?: string }) {
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason)
  return <><button {...props} ref={lock.ref} {...lock.handlers} />{lock.node}</>
}
class QuickSendPermissionChanged extends Error {
  constructor() { super('権限が変わったため、続きの処理を中止しました。配信の状態は一覧で確認してください。') }
}
class QuickSendContextChanged extends Error {}

export default function QuickSendV8({
  open,
  accountId,
  onClose,
  onSent,
}: {
  open: boolean
  accountId: string | null
  onClose: () => void
  /** 送った・予約した・承認を頼んだあと、一覧を読み直す。 */
  onSent: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const access = useQuickSendAccess()
  const context = useRef({ open, accountId, active: true })
  const tokenNames = useInsertTokenNames(open ? accountId : null)
  if (context.current.open !== open || context.current.accountId !== accountId) context.current = { open, accountId, active: true }
  const renderedContext = context.current
  useEffect(() => { const current = context.current; current.active = true; return () => { current.active = false } }, [open, accountId])
  const [text, setText] = useState('')
  const [target, setTarget] = useState<'unselected' | 'all' | 'tag'>('unselected')
  const [tags, setTags] = useState<Tag[]>([])
  const [tagId, setTagId] = useState('')
  const [when, setWhen] = useState<'unselected' | 'now' | 'scheduled'>('unselected')
  const [scheduledValue, setScheduledValue] = useState('')
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateFailed, setEstimateFailed] = useState(false)
  const [estimateRetry, setEstimateRetry] = useState(0)
  const [candidates, setCandidates] = useState<BroadcastApprovalCandidate[]>([])
  const [approverId, setApproverId] = useState('')
  const [approvalConfig, setApprovalConfig] = useState<{threshold: number; singleOperator: boolean} | null>(null)
  const [configLoadFailed, setConfigLoadFailed] = useState(false)
  const [configRetry, setConfigRetry] = useState(0)
  const [countInput, setCountInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const estimateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ id: string; scheduledAt: string | null; needsApproval: boolean } | null>(null)
  const sendingRef = useRef<object | null>(null)
  const [pending, setPending] = useState(false)
  const guard = useUnsavedGuard({ dirty: open && (text !== '' || scheduledValue !== ''), busy, onDiscard: onClose })
  const textRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement | null>(null)

  // 開いたら入力を空に戻し、タグと承認する人の候補を読む。
  useEffect(() => {
    let cancelled = false
    if (!open) return
    setApprovalConfig(null)
    setConfigLoadFailed(false)
    setCountInput('')
    setTags([])
    setCandidates([])
    pendingRef.current = null
    sendingRef.current = null
    setPending(false)
    setText('')
    setTarget('unselected')
    setTagId('')
    setWhen('unselected')
    setScheduledValue('')
    setEstimate(null)
    setApproverId('')
    setBusy(false)
    setError(null)
    if (!accountId) return
    void api.tags.list({ accountId }).then((res) => {
      if (!cancelled && res.success) setTags(res.data)
    }).catch(() => undefined)
    void api.broadcasts.approval.candidates(accountId).then((res) => {
      if (!cancelled && res.success) setCandidates(res.data)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [open, accountId])

  useEffect(() => {
    let cancelled = false
    if (!open || !accountId) return
    setConfigLoadFailed(false)
    void api.broadcasts.approval.config(accountId)
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setApprovalConfig(res.data)
          setConfigLoadFailed(false)
        } else {
          setConfigLoadFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setConfigLoadFailed(true)
      })
    return () => { cancelled = true }
  }, [open, accountId, configRetry])

  // 本文・相手が変わったら人数を見積もる（少し待ってから1回だけ）。
  useEffect(() => {
    let cancelled = false
    setEstimating(false)
    setEstimateFailed(false)
    if (!open || !accountId || !access.preflight) return
    setEstimate(null)
    setCountInput('')
    const current = context.current
    const permitted = captureQuickSendAccess()
    const available = () => !cancelled && current === context.current && current.active && permitted('preflight')
    if (estimateTimer.current) clearTimeout(estimateTimer.current)
    if (!text.trim() || target === 'unselected' || (target === 'tag' && !tagId)) {
      setEstimate(null)
      return
    }
    estimateTimer.current = setTimeout(() => {
      void (async () => {
        if (!available()) return
        setEstimating(true)
        try {
          const res = await api.broadcasts.preflight({
            targetType: target,
            targetTagId: target === 'tag' ? tagId || null : null,
            lineAccountId: accountId,
            messageContent: text,
            messageCount: 1,
          })
          if (available() && res.success) {
            setEstimate({ count: res.data.audienceCount, blocked: res.data.hiddenExcluded, remaining: res.data.quota?.remaining ?? null })
          } else if (available()) setEstimateFailed(true)
        } catch (saveFailure) {
          if (available() && !saveErrors.capture(saveFailure)) setEstimateFailed(true)
          // 人数を確認できるまで送信は止め、入力は保つ。
        } finally {
          if (available()) setEstimating(false)
        }
      })()
    }, 500);

    return () => {
      cancelled = true
      if (estimateTimer.current) clearTimeout(estimateTimer.current)
    }
  }, [open, accountId, text, target, tagId, saveErrors, access.identity, access.session, access.preflight, estimateRetry])

  const needsCountConfirmation = estimate !== null && approvalConfig !== null && estimate.count >= approvalConfig.threshold && approvalConfig.singleOperator
  const needsApproval = estimate !== null && approvalConfig !== null && estimate.count >= approvalConfig.threshold && !approvalConfig.singleOperator
  const countMatched = countInput.trim() !== '' && Number(countInput) === estimate?.count
  const scheduledAt = when === 'scheduled' && scheduledValue ? datetimeLocalJstToUtcIso(scheduledValue) : null
  const selectionKey = JSON.stringify([target, tagId, when, scheduledValue])
  const latestSelection = useRef(selectionKey)
  latestSelection.current = selectionKey
  const selectionReady = target !== 'unselected' && when !== 'unselected'
  const currentAttempt = pendingRef.current
  const operation: QuickSendOperation = currentAttempt?.needsApproval || (!currentAttempt && needsApproval) ? 'approval'
    : (currentAttempt ? currentAttempt.scheduledAt : when === 'scheduled') ? 'schedule' : 'send'
  const operationAllowed = selectionReady ? canUseQuickSendNow(operation) && (currentAttempt !== null || access.create) : access.create
  const operationReason = access.reason(operationAllowed ? undefined : operation === 'send' && access.session?.impersonation ? 'send' : !currentAttempt && !access.create ? 'create' : operation)
  const editReason = access.reason('create')
  const changeInput = <T,>(change: (value: T) => void) => (value: T) => { if (canUseQuickSendNow('create')) change(value) }
  const canSend = selectionReady && operationAllowed && text.trim().length > 0
    && text.length <= TEXT_LIMIT
    && (target === 'all' || (target === 'tag' && tagId !== ''))
    && (when === 'now' || (when === 'scheduled' && scheduledAt !== null))
    && (!needsApproval || approverId !== '')
    && approvalConfig !== null
    && estimate !== null
    && (!needsCountConfirmation || countMatched)
    && !busy
  const sendDisabledReason = !text.trim() ? '送る本文を入力してください。'
    : text.length > TEXT_LIMIT ? `本文は${TEXT_LIMIT}文字以内で入力してください。`
      : target === 'unselected' ? '送る相手を選んでください。'
        : when === 'unselected' ? '送る時間を選んでください。'
      : target === 'tag' && !tagId ? '送る相手のタグを選んでください。'
        : when === 'scheduled' && !scheduledAt ? '送る日時を選んでください。'
          : needsApproval && !approverId ? '承認を頼む相手を選んでください。'
