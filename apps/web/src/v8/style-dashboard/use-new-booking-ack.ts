'use client'

import { useRef, useState } from 'react'
import { styleApi } from '@/lib/api/helpers/styles'
import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure } from '@/components/shared/api-error-message'
import type { StyleSideBooking } from './model'

type Operation = { storeId: string; operationId: string }

/** 一括操作も、押した時に見えている予約だけを対象にする。 */
export function useNewBookingAck(accountId: string | null, refresh?: () => Promise<void>) {
  const [pending, setPending] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const idle = useRef<Promise<void>>(Promise.resolve())
  const release = useRef<() => void>(() => {})
  const lock = () => {
    busyRef.current = true
    idle.current = new Promise(resolve => { release.current = resolve })
    setBusy(true)
  }
  const unlock = () => { busyRef.current = false; setBusy(false); release.current() }
  const run = async (rows: StyleSideBooking[]) => {
    if (!accountId || busyRef.current || !rows.length) return
    if (rows.some(row => !row.storeId)) {
      notifyToast('店舗情報を確認できません。読み直してからお試しください。', { tone: 'error' })
      return
    }
    lock()
    setPending(rows.map(row => row.id))
    const operations = rows.map(row => ({ storeId: row.storeId as string, operationId: crypto.randomUUID(), bookingId: row.id }))
    const results = await Promise.allSettled(operations.map(op => styleApi.acknowledgeNewBookings(accountId, op)))
    const succeeded: Operation[] = []
    let failures = 0
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.data.acknowledgedCount > 0) succeeded.push(operations[i])
      else failures++
    })
    if (failures) setPending(operations.filter((_, i) => results[i].status === 'fulfilled' && (results[i] as PromiseFulfilledResult<Awaited<ReturnType<typeof styleApi.acknowledgeNewBookings>>>).value.data.acknowledgedCount > 0).map(op => op.bookingId))
    try { await refresh?.() } finally { setPending([]); unlock() }
    if (succeeded.length) notifyToast(`${succeeded.length}件を確認済みにしました`, {
      actionLabel: '元に戻す', onAction: () => { void undo(succeeded) },
    })
    if (failures) {
      const rejected = results.find(result => result.status === 'rejected')
      const reason = rejected?.status === 'rejected' ? describeApiFailure(rejected.reason, '確認') : '予約の状態が変わりました。一覧を読み直してください。'
      notifyToast(`${failures}件を確認済みにできませんでした。${reason}`, { tone: 'error' })
    }
  }
  const undo = async (operations: Operation[]) => {
    if (!accountId) return
    while (busyRef.current) await idle.current
    lock()
    const results = await Promise.allSettled(operations.map(op => styleApi.undoNewBookingsAcknowledgement(accountId, op.operationId, op.storeId)))
    try { await refresh?.() } finally { unlock() }
    if (results.some(result => result.status === 'rejected' || result.value.data.undoneCount === 0)) notifyToast('元に戻せなかった予約があります。予約が変更されていないか確認してください。', { tone: 'error' })
    else notifyToast('確認済みを元に戻しました')
  }
  return { pending, busy, acknowledge: run }
}
