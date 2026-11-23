'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api,type BroadcastPreflight } from '@/lib/api'
import type { SegmentCondition } from '@/lib/segment-condition'
import type { Dispatch,RefObject,SetStateAction } from 'react'

type RunBroadcastPreflightContext = {
  preflightRequestBody: () => { correctionDraftId?: string; deliveryLimit?: import('@line-crm/shared').BroadcastDeliveryLimit; targetType: "tag" | "segment"; targetTagId: string | null; segmentConditions: SegmentCondition | null; lineAccountId: string | null; messageContent: string; scheduledAt: string | null; messageCount: number; }
  preflightSeq: RefObject<number>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  setError: Dispatch<SetStateAction<string>>
  setPreflightKey: Dispatch<SetStateAction<string | null>>
  setPreflightResult: Dispatch<SetStateAction<BroadcastPreflight | null>>
  setPreflightStatus: Dispatch<SetStateAction<"error" | "idle" | "loading" | "ready">>
}

export async function runBroadcastPreflight({ preflightRequestBody, preflightSeq, saveErrors, setError, setPreflightKey, setPreflightResult, setPreflightStatus }: RunBroadcastPreflightContext, silent = false) {
    if (!silent) setError('')
    setPreflightStatus('loading')
    setPreflightResult(null)
    setPreflightKey(null)
    const seq = ++preflightSeq.current
    try {
      const requestBody = preflightRequestBody()
      const requestKey = JSON.stringify(requestBody)
      const res = await api.broadcasts.preflight(requestBody)
      // 遅れて届いた古い要求の応答で、新しい確認を上書きしない。
      if (seq !== preflightSeq.current) return
      if (res.success) {
        setPreflightResult(res.data)
        setPreflightKey(requestKey)
        setPreflightStatus('ready')
      } else {
        setPreflightStatus('error')
        if (!silent) setError(res.error)
      }
    } catch (saveFailure) {
      if (seq !== preflightSeq.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setPreflightStatus('error');

      if (!silent) { if (!fieldFailure)


 setError('確認できませんでした。時間をおいて、もう一度お試しください。') }
    }
  }
