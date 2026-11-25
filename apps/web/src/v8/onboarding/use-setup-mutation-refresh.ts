'use client'

import { useCallback, useEffect, useRef } from 'react'
import { ACCOUNT_STYLE_UPDATED } from '@/hooks/use-account-style'
import { API_MUTATION_SUCCEEDED } from '@/lib/api/transport/mutation-events'
import { FEATURE_SETTINGS_UPDATED_EVENT, type FeatureSettingsUpdate } from '@/lib/feature-settings-event'

export function useSetupMutationRefresh(accountId: string | null, refresh: () => void, pathname: string | null, onMutate: () => void = () => {}): () => void {
  const refreshRef = useRef(refresh)
  const mutateRef = useRef(onMutate)
  refreshRef.current = refresh
  mutateRef.current = onMutate
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearPending = useCallback(() => {
    if (pending.current === null) return false
    clearTimeout(pending.current)
    pending.current = null
    return true
  }, [])
  const flushNow = useCallback(() => {
    clearPending()
    refreshRef.current()
  }, [clearPending])
  const place = useRef({ accountId, pathname })
  useEffect(() => {
    const previous = place.current
    place.current = { accountId, pathname }
    if (previous.accountId === accountId && previous.pathname !== pathname && clearPending()) {
      refreshRef.current()
    }
  }, [accountId, pathname, clearPending])
  useEffect(() => {
    if (!accountId) return
    const onMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId: string | null; accountIds?: string[] }>).detail
      if (detail?.accountIds?.length ? !detail.accountIds.includes(accountId) : detail?.accountId && detail.accountId !== accountId) return
      mutateRef.current()
      clearPending()
      pending.current = setTimeout(() => { pending.current = null; refreshRef.current() }, 500)
    }
    const onStyleSaved = (event: Event) => {
      if ((event as CustomEvent<{ accountId: string }>).detail?.accountId === accountId) clearPending()
    }
    const onFeatureSaved = (event: Event) => {
      const detail = (event as CustomEvent<FeatureSettingsUpdate>).detail
      if (detail?.source !== 'account-style' && (!detail?.accountId || detail.accountId === accountId)) clearPending()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') clearPending()
    }
    window.addEventListener(API_MUTATION_SUCCEEDED, onMutation)
    window.addEventListener(ACCOUNT_STYLE_UPDATED, onStyleSaved)
    window.addEventListener(FEATURE_SETTINGS_UPDATED_EVENT, onFeatureSaved)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearPending()
      window.removeEventListener(API_MUTATION_SUCCEEDED, onMutation)
      window.removeEventListener(ACCOUNT_STYLE_UPDATED, onStyleSaved)
      window.removeEventListener(FEATURE_SETTINGS_UPDATED_EVENT, onFeatureSaved)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [accountId, clearPending])
  return flushNow
}
