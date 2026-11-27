'use client'

import { useEffect, useRef } from 'react'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { ApiError, api, type RichMenuScheduleInput } from '@/lib/api'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'

export const SCHEDULE_SAVED_MESSAGE = '公開予約を保存しました。予約時点の内容で公開します。'
export const SCHEDULE_FAILED_MESSAGE =
  '公開予約を保存できませんでした。入力と通信状態を確認して、もう一度お試しください。'

/**
 * 「同じ操作」の目印。予約の中身が同じならこの文字列も同じになる。
 * 中身を直してから送り直したときは別の操作になり、新しいキーが振られる。
 */
export function scheduleSignature(groupId: string, input: RichMenuScheduleInput): string {
  return JSON.stringify([
    groupId,
    input.mode,
    input.startsAt,
    input.endsAt ?? null,
    input.restoreGroupId ?? null,
  ])
}

/**
 * 公開予約の保存。1回の操作の Idempotency-Key を、応答が確定するまで持ち続ける。
 *
 * 押すたびに新しいキーを作ると、応答が返ってこなかった（通信が切れた・
 * 画面を閉じた）ときの押し直しがサーバーには別の操作に見え、同じ予約が
 * 2件できる。キーは中身ごとに覚えておき、保存できたときだけ捨てる。
 * 保存できなかったときは同じキーのまま送り直すので、サーバー側で
 * 「もう入っている予約」として1件にまとまる。
 */
export function useScheduleSubmit(params: {
  groupId: string
  /** 予約の前に下書きを保存する。予約は保存済みの内容を写し取るため。 */
  persistDraft: () => Promise<void>
  onSaving: (saving: boolean) => void
  onSaved: (message: string) => void
  onFailed: (message: string) => void
}): (input: RichMenuScheduleInput) => Promise<void> {
  const keys = useRef<IdempotencyKeyStore | null>(null)
  if (!keys.current) keys.current = new IdempotencyKeyStore()
  const mountedRef = useRef(true)
  const submittingRef = useRef(false)
  const scopeRef = useRef({ groupId: params.groupId, generation: 0 })
  if (scopeRef.current.groupId !== params.groupId) {
    scopeRef.current = { groupId: params.groupId, generation: scopeRef.current.generation + 1 }
    submittingRef.current = false
  }
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      scopeRef.current = { groupId: scopeRef.current.groupId, generation: scopeRef.current.generation + 1 }
      submittingRef.current = false
    }
  }, [])

  return async (input: RichMenuScheduleInput) => {
    if (submittingRef.current) return
    const runScope = scopeRef.current
    const groupId = params.groupId
    const isCurrent = () => mountedRef.current && scopeRef.current === runScope
    const store = keys.current as IdempotencyKeyStore
    const signature = scheduleSignature(groupId, input)
    const idempotencyKey = store.get(signature)
    submittingRef.current = true
    params.onSaving(true)
    try {
      await params.persistDraft()
      if (!isCurrent()) return
      const response = await api.richMenuGroups.schedule(groupId, input, idempotencyKey)
      if (!response.success) throw new Error(response.error)
      // ここで初めて「この操作は終わった」と言える。次の予約は新しいキーになる。
      store.clear(signature)
      if (!isCurrent()) return
      params.onSaved(SCHEDULE_SAVED_MESSAGE)
    } catch (caught) {
      if (!isCurrent()) return
      // 応答が確定していないので、キーは捨てずに残す。
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 429)) {
        params.onFailed(describeApiFailure(caught, '公開予約の保存', { scope: 'store' }))
        return
      }
      params.onFailed(SCHEDULE_FAILED_MESSAGE)
    } finally {
      if (isCurrent()) {
        submittingRef.current = false
        params.onSaving(false)
      }
    }
  }
}
