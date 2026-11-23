'use client'

import { useEffect, useRef } from 'react'
import { API_MUTATION_SUCCEEDED } from '@/lib/api/transport/mutation-events'

export function useSetupMutationRefresh(accountId: string | null, refresh: () => void): void {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!accountId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId: string | null; accountIds?: string[] }>).detail
      if (detail?.accountIds?.length ? !detail.accountIds.includes(accountId) : detail?.accountId && detail.accountId !== accountId) return
      clearTimeout(timer)
      timer = setTimeout(() => refreshRef.current(), 500)
    }
    window.addEventListener(API_MUTATION_SUCCEEDED, onMutation)
    return () => { clearTimeout(timer); window.removeEventListener(API_MUTATION_SUCCEEDED, onMutation) }
  }, [accountId])
}
