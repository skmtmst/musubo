'use client'

import type { BroadcastStepKey } from '@/components/broadcasts/broadcast-steps'


import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api,type ApiBroadcast } from '@/lib/api'
import { commonVarFailureNames } from '@/components/shared/common-var-test-failure'
import { notifyToast } from '@/components/shared/toast'
import { formatTime } from '@/lib/format'
import type { Dispatch,SetStateAction } from 'react'
import { testSendFailure,testSendResult,type TestSendView } from './test-send-view'

type TestBroadcastContext = {
  isCurrent: () => boolean
  onDraftSaved: ((broadcast: ApiBroadcast) => void) | undefined
  persistDraft: (scheduledAt: string | null, saveAsDraft?: boolean, confirmedCount?: number, autosaveStep?: BroadcastStepKey | null) => Promise<ApiBroadcast | null>
  rejectValidation: (validationError: string) => void
  saveErrors: ReturnType<typeof useSaveFormErrors>
  setError: Dispatch<SetStateAction<string>>
  setTestHistory: Dispatch<SetStateAction<TestSendView[]>>
  setTestResult: Dispatch<SetStateAction<TestSendView | null>>
  setTestSending: Dispatch<SetStateAction<boolean>>
  setTestRetryBlocked: Dispatch<SetStateAction<boolean>>
  validate: () => string
}

export async function testBroadcast({ isCurrent, onDraftSaved, persistDraft, rejectValidation, saveErrors, setError, setTestHistory, setTestResult, setTestSending, setTestRetryBlocked, validate }: TestBroadcastContext) {
    const validationError = validate()
    if (validationError) {
      rejectValidation(validationError)
      return
    }
    setTestSending(true)
    setTestRetryBlocked(false)
    setError('')
    setTestResult(null)
    const at = formatTime(new Date())
    let attempted = false
    let acknowledged = false
    try {
      const draft = await persistDraft(null, true)
      if (!draft || !isCurrent()) return
      // BROADCAST-16: テスト送信でも下書きが増えるので、一覧と
      // フォルダ件数を読み直してもらう。
      onDraftSaved?.(draft)
      attempted = true
      const res = await api.broadcasts.testSend(draft.id)
      if (!isCurrent()) return
      acknowledged = res.success
      /*
       * **HTTPの成功と配信の成功は分ける。** 全員に失敗しても
       * `success: true` で `sent/failed` が返るので、共通の分類
       * （全員失敗=エラー、一部失敗=要対応、全員成功=成功）を通す。
       */
      const view = res.success
        ? testSendResult(res.sent ?? 0, res.failed ?? 0, at)
        : testSendFailure(at)
      setTestResult(view)
      setTestHistory((history) => [view, ...history])
      if (acknowledged) notifyToast(view.message, { tone: view.kind === 'success' ? 'success' : view.kind === 'error' ? 'error' : 'info' })
      return acknowledged
    } catch (saveFailure) {
      if (!isCurrent()) return
      if (acknowledged) { notifyToast('送信は受け付けました。表示を読み直してください。'); return true }
      const names = attempted ? commonVarFailureNames(saveFailure) : null
      if (names) {
        const view: TestSendView = {kind:'error', message:'テスト送信できませんでした', commonVars:names}
        setTestRetryBlocked(false)
        setTestResult(view)
        setTestHistory(history => [view, ...history])
        return
      }
      const fieldFailure = saveErrors.capture(saveFailure);
      setTestRetryBlocked(attempted)

      const view = attempted ? { kind: 'error' as const, message: `${at} 送信の結果を確認できませんでした。届いている可能性があるため、配信の記録を確認してください。` } : testSendFailure(at)
      { if (!fieldFailure)
      setTestResult(view) }
      setTestHistory((history) => [view, ...history])
      return false
    } finally {
      setTestSending(false)
    }
  }
