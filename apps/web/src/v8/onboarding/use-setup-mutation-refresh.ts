'use client'

import { useEffect, useRef } from 'react'
import { API_MUTATION_SUCCEEDED } from '@/lib/api/transport/mutation-events'

export function useSetupMutationRefresh(accountId: string | null, refresh: () => void, pathname: string | null, invalidate: () => void = () => {}): void {
  const refreshRef = useRef(refresh)
  const invalidateRef = useRef(invalidate)
  refreshRef.current = refresh
  invalidateRef.current = invalidate
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const place = useRef({ accountId, pathname })
  useEffect(() => {
    const previous = place.current
    place.current = { accountId, pathname }
    if (previous.accountId === accountId && previous.pathname !== pathname && pending.current !== null) {
      clearTimeout(pending.current)
      pending.current = null
      refreshRef.current()
    }
  }, [accountId, pathname])
  useEffect(() => {
    if (!accountId) return
    const onMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId: string | null; accountIds?: string[] }>).detail
      if (detail?.accountIds?.length ? !detail.accountIds.includes(accountId) : detail?.accountId && detail.accountId !== accountId) return
      invalidateRef.current()
      if (pending.current !== null) clearTimeout(pending.current)
      pending.current = setTimeout(() => { pending.current = null; refreshRef.current() }, 500)
    }
    window.addEventListener(API_MUTATION_SUCCEEDED, onMutation)
    return () => {
      if (pending.current !== null) clearTimeout(pending.current)
      pending.current = null
      window.removeEventListener(API_MUTATION_SUCCEEDED, onMutation)
    }
  }, [accountId])
}
