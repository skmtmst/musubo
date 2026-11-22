'use client'
import type { BroadcastSendMode } from './broadcast-schedule'
import { SEND_TIME_MISSING_MESSAGE } from './broadcast-step-gate'
import { broadcastAbSendProblem } from './broadcast-ab-send-guard'

import type { BroadcastStepKey } from '@/components/broadcasts/broadcast-steps'


import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { api,describeSaveFailure,type ApiBroadcast,type BroadcastBubble } from '@/lib/api'
import { broadcastAbApi } from '@/v8/broadcast-ab/public/api/index'
import { useBroadcastAb } from '@/v8/broadcast-ab/public/use-ab/index'
import type { Dispatch,RefObject,SetStateAction } from 'react'

type SaveBroadcastContext = {
  ab: ReturnType<typeof useBroadcastAb>
  approvalConfigState: "error" | "idle" | "loading" | "ready"
  approvalCountInput: string
  approvalCountMatched: boolean
  approvalNote: string
  approverId: string
  deliveryLimited?: boolean
  audienceCount: number | null
  bubbles: BroadcastBubble[]
  currentStep: BroadcastStepKey | null
  needsApproval: boolean
  needsApprovalSingle: boolean
  onSuccess: (broadcast: ApiBroadcast) => void
  persistDraft: (scheduledAt: string | null, saveAsDraft?: boolean, confirmedCount?: number, autosaveStep?: BroadcastStepKey | null) => Promise<ApiBroadcast | null>
  rejectValidation: (validationError: string) => void
  saveErrors: ReturnType<typeof useSaveFormErrors>
  saving: boolean
  scheduledAtIso: () => string | null
  selectedAccountIdRef: RefObject<string | null>
  sendProblem?: () => string | null
  sendMode: BroadcastSendMode
  setConfirmOpen: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setSaving: Dispatch<SetStateAction<boolean>>
  submittingRef: RefObject<boolean>
  validate: () => string
}

export async function saveBroadcast({ ab, approvalConfigState, approvalCountInput, approvalCountMatched, approvalNote, approverId, audienceCount, deliveryLimited, bubbles, currentStep, needsApproval, needsApprovalSingle, onSuccess, persistDraft, rejectValidation, saveErrors, saving, scheduledAtIso, selectedAccountIdRef, sendMode, sendProblem, setConfirmOpen, setError, setSaving, submittingRef, validate }: SaveBroadcastContext) {
    if (saving || submittingRef.current) return
    if (ab.enabled) { setError('A/B配信は確認画面から開始してください。'); return }
    const abProblem = broadcastAbSendProblem(ab.enabled, audienceCount)
    if (abProblem) { setError(abProblem); return }
    const scheduleProblem = sendProblem?.()
    if (scheduleProblem) { rejectValidation(scheduleProblem); return }
    if (sendMode === 'unselected' || sendMode === 'optimal') { rejectValidation(SEND_TIME_MISSING_MESSAGE); return }
    if (currentStep && approvalConfigState !== 'ready') { setError('承認の設定を確認できません。確認画面を開き直してください'); return }
    const validationError = validate(); if (validationError) { rejectValidation(validationError); return }
    if (needsApproval && !needsApprovalSingle && approverId === '') {
      setError('承認をお願いする人を選んでください')
      return
    }
    if (needsApprovalSingle && !approvalCountMatched) {
      setError('人数を入れて一致させてください')
      return
    }
    submittingRef.current = true
    setSaving(true); setError('')
    const requestAccountId = selectedAccountIdRef.current || null
    try {
      const saved = await persistDraft(
        scheduledAtIso(),
        false,
        needsApprovalSingle ? Number(approvalCountInput) : deliveryLimited ? audienceCount ?? undefined : undefined,
      )
      // R626: 待っている間にアカウントが変わっていたら今の画面へ混ぜない。
      if ((selectedAccountIdRef.current || null) !== requestAccountId) return
      if (!saved) return
      /* G1：A・B 案と A/B の設定を送る（送る・承認の依頼の前に）。版は配信の lock_version。 */
      const abVersion = await ab.persist(saved.id, Number((saved as { version?: number }).version ?? 0), bubbles)
      // 承認が要るときは、保存のあと承認の依頼まで続ける。依頼までが1つの操作。
      if (needsApproval && !needsApprovalSingle) {
        const requested = await api.broadcasts.approval.request(saved.id, {
          approverStaffId: approverId,
          ...(deliveryLimited ? {expectedVersion:abVersion,confirmedRecipientCount:audienceCount!} : {}),
          note: approvalNote.trim() || undefined,
        })
        if (!requested.success) {
          setError(requested.error)
          return
        }
      }
      if ((selectedAccountIdRef.current || null) !== requestAccountId) return
      if (currentStep && sendMode === 'now' && (!needsApproval || needsApprovalSingle)) {
        /* G1：A/B の配信は組2 の今の段では模擬送信だけ（testMode。本物の LINE には送らない）。 */
        if (ab.enabled && audienceCount !== null) {
          const started = await broadcastAbApi.startMock(saved.id, abVersion, audienceCount, typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ab-${Date.now()}`)
          if ((selectedAccountIdRef.current || null) !== requestAccountId) return
          if (!started.success) { setError('A/B の試しを始められませんでした'); return }
          setConfirmOpen(false)
          onSuccess(saved)
          return
        }
        const sent = await api.broadcasts.send(saved.id, deliveryLimited ? { expectedVersion:abVersion, confirmedRecipientCount:audienceCount! } : needsApprovalSingle ? { confirmedRecipientCount: Number(approvalCountInput) } : undefined)
        if ((selectedAccountIdRef.current || null) !== requestAccountId) return
        if (!sent.success) { setError(sent.error); return }
        setConfirmOpen(false)
        onSuccess(sent.data)
        return
      }
      setConfirmOpen(false)
      // 単頁の保存でも知らせを出す。予約の申込みは遷移先が状態を出すので出さない。
      if (!scheduledAtIso()) notifyToast('下書きを保存しました。')
      onSuccess(saved)
    } catch (caught) {
      // R626: 古いアカウントの失敗を今の画面の文言へ混ぜない。
      if ((selectedAccountIdRef.current || null) !== requestAccountId) return
      const fieldFailure = saveErrors.capture(caught)
      { if (!fieldFailure)

      setError(describeSaveFailure(caught)) }
    } finally { submittingRef.current = false; setSaving(false) }
  }
