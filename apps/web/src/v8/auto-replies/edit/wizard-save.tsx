'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors';
import { notifyToast } from '@/components/shared/toast';
import { ApiError,api,describeSaveFailure } from '@/lib/api';
import type {
AutoReplyDraftInput,
AutoReplyDryRunResult,
AutoReplyValidationResult
} from '@line-crm/shared';
import type { Dispatch,RefObject,SetStateAction } from 'react';
import { InputIssue,WizardForm,WizardStep } from './wizard-model';
import { canEditWizardNow } from './wizard-access'

type SaveWizardDraftContext = {
  autoReplyId: string | null
  buildInput: () => AutoReplyDraftInput | InputIssue
  createKeyRef: RefObject<string>
  form: WizardForm
  router: ReturnType<typeof import('@/components/shared/list-navigation').useListNavigationRouter>
  savedSnapshotRef: RefObject<string>
  savedVersionRef: RefObject<number | null>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  setAutoReplyId: Dispatch<SetStateAction<string | null>>
  setConfirmState: Dispatch<SetStateAction<"error" | "idle" | "loading" | "ready">>
  setDryRun: Dispatch<SetStateAction<AutoReplyDryRunResult | null>>
  setError: Dispatch<SetStateAction<string>>
  setInputIssue: Dispatch<SetStateAction<InputIssue | null>>
  setLifecycleStatus: Dispatch<SetStateAction<string>>
  setMatchedAccountId: Dispatch<SetStateAction<string | null>>
  setSaveConflict: Dispatch<SetStateAction<boolean>>
  setSaveNotice: Dispatch<SetStateAction<string>>
  setSaving: Dispatch<SetStateAction<boolean>>
  setValidation: Dispatch<SetStateAction<AutoReplyValidationResult | null>>
  setVersionNumber: Dispatch<SetStateAction<number | null>>
  setWeekdayNotice: Dispatch<SetStateAction<string>>
  showInputIssue: (issue: InputIssue) => void
  step: WizardStep
  stepDataRequested: RefObject<Set<string>>
  versionNumber: number | null
}

export async function saveWizardDraft({ autoReplyId, buildInput, createKeyRef, form, router, savedSnapshotRef, savedVersionRef, saveErrors, setAutoReplyId, setConfirmState, setDryRun, setError, setInputIssue, setLifecycleStatus, setMatchedAccountId, setSaveConflict, setSaveNotice, setSaving, setValidation, setVersionNumber, setWeekdayNotice, showInputIssue, step, stepDataRequested, versionNumber }: SaveWizardDraftContext): Promise<{ id: string; accountId: string | null } | null> {
    if (!canEditWizardNow()) return null
    if (form.weekdays.length === 0) { setWeekdayNotice('反応する曜日を1つ以上選んでください。'); return null }
    const body = buildInput()
    if ('error' in body) {
      showInputIssue(body)
      return null
    }
    setInputIssue(null)
    setSaving(true)
    setError('')
    setSaveNotice('')
    try {
      let savedId = autoReplyId
      if (autoReplyId) {
        if (versionNumber == null) {
          throw new Error('下書きの版情報を確認できません。画面を読み直してください')
        }
        const res = await api.autoReplies.saveDraft(autoReplyId, {
          ...body,
          expectedVersion: versionNumber,
        })
        if (!res.success) throw new Error(res.error || 'save failed')
        if (!Number.isSafeInteger(res.data?.versionNumber) || res.data.versionNumber < 1) throw new Error('保存結果を確認できません。画面を読み直してください。')
        savedVersionRef.current = res.data.versionNumber
        setVersionNumber(res.data.versionNumber)
      } else {
        const res = await api.autoReplies.createDraft(body, createKeyRef.current)
        if (!res.success) throw new Error(res.error || 'create failed')
        savedId = res.data.autoReplyId
        setAutoReplyId(res.data.autoReplyId)
        savedVersionRef.current = res.data.versionNumber
        setVersionNumber(res.data.versionNumber)
        setMatchedAccountId(res.data.settings.lineAccountId || null)
        setLifecycleStatus('draft')
        // URL に id を乗せる。戻る・再読込でも下書きに戻れるように。
        const query = new URLSearchParams()
        query.set('id', res.data.autoReplyId)
        query.set('step', step)
        router.replace(`/auto-replies/edit?${query.toString()}`)
      }
      savedSnapshotRef.current = JSON.stringify(form)
      notifyToast('下書きを保存しました')
      // 保存で中身が変わったので、以前の試験・チェックは古いものとして捨てる。
      setSaveConflict(false)
      setDryRun(null)
      setValidation(null)
      setConfirmState('idle')
      stepDataRequested.current.delete(`confirm:${savedId}`)
      stepDataRequested.current.delete(`priority:${savedId}`)
      return { id: savedId!, accountId: body.lineAccountId }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        // 帯（頭の下）が知らせるので、本文の上に同じ知らせを重ねない。
        setSaveConflict(true)
      } else {
        { if (!fieldFailure)
        setError(describeSaveFailure(caught)) }
      }
      return null
    } finally {
      setSaving(false)
    }
  }
