import { useLayoutEffect, useRef, useState } from 'react'
import { useGooglePermission } from './use-google-permission'
import { restaurantGoogleApi } from '@/lib/restaurant-google-api'
import { errorMessage } from './format'

type CheckState = { accountId: string; at: string | null; busy: boolean; error: string }
const empty = (accountId: string): CheckState => ({ accountId, at: null, busy: false, error: '' })

/** 確認成功だけを画面内で記録し、別店舗や閉じた画面の応答は引き継がない。 */
export function usePostStatusCheck(accountId: string, reload: () => Promise<void>) {
  const { allowed: canSync, lockedReason } = useGooglePermission()
  const [state, setState] = useState(() => empty(accountId))
  const pending = useRef<{ accountId: string } | null>(null)
  const reloadRef = useRef(reload)
  useLayoutEffect(() => { reloadRef.current = reload }, [reload])
  useLayoutEffect(() => {
    pending.current = null
    setState(previous => previous.accountId === accountId ? { ...previous, busy: false, error: '' } : empty(accountId))
    return () => { pending.current = null }
  }, [accountId, canSync])

  const sync = async () => {
    if (!canSync || !accountId.trim() || pending.current?.accountId === accountId) return
    const request = { accountId }
    pending.current = request
    const current = () => pending.current === request
    setState(previous => ({ ...(previous.accountId === accountId ? previous : empty(accountId)), busy: true, error: '' }))
    try {
      const result = await restaurantGoogleApi.syncPosts(accountId)
      if (!current()) return
      if (!result?.success) throw new Error('Googleの状態を確認できませんでした。もう一度お試しください。')
      await reloadRef.current()
      if (!current()) return
      setState({ accountId, at: new Date().toISOString(), busy: true, error: '' })
    } catch (error) {
      if (current()) setState(previous => ({ ...previous, error: errorMessage(error, 'Googleから投稿の状態を確認できませんでした。') }))
    } finally {
      if (current()) {
        pending.current = null
        setState(previous => ({ ...previous, busy: false }))
      }
    }
  }
  const shown = state.accountId === accountId ? state : empty(accountId)
  return { sync, syncing: shown.busy, syncError: shown.error, lastChecked: shown.at, canSync, lockedReason }
}
