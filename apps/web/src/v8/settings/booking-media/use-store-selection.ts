'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { restaurantTestApi, type RestaurantStore } from '@/lib/restaurant-test-api'

type Selection = {
  accountId: string; stores: RestaurantStore[]; id: string; contextId: string | null
  status: 'loading' | 'ready' | 'error'; error: unknown; switching: boolean; changedElsewhere: boolean
}
const empty = (accountId: string): Selection => ({ accountId, stores: [], id: '', contextId: null, status: 'loading', error: null, switching: false, changedElsewhere: false })

export function bookingMediaStores(stores: RestaurantStore[], accountId: string): RestaurantStore[] {
  return stores.filter(store => store.line_account_id === accountId && store.status !== 'archived')
}

export function initialBookingMediaStore(stores: RestaurantStore[], contextId: string | null): string {
  const active = stores.filter(store => store.status === 'active')
  return active.length === 1 ? active[0].id : active.find(store => store.id === contextId)?.id ?? ''
}

/** 店舗欄の選択と、ログイン全体の表示店舗を区別する。 */
export function useBookingMediaStoreSelection(accountId: string | null) {
  const [selection, setSelection] = useState<Selection>(() => empty(accountId ?? ''))
  const latestAccount = useRef(accountId)
  latestAccount.current = accountId
  const generation = useRef(0)
  const mounted = useRef(true)
  const switchPending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  const [reload, setReload] = useState(0)
  const refresh = useCallback(() => setReload(value => value + 1), [])

  useEffect(() => {
    const ticket = ++generation.current
    if (!accountId) return
    setSelection(empty(accountId))
    void Promise.all([restaurantTestApi.listStores(accountId), restaurantTestApi.storeContext(accountId)])
      .then(([list, context]) => {
        if (!mounted.current || generation.current !== ticket || latestAccount.current !== accountId) return
        const stores = bookingMediaStores(list.data.stores, accountId)
        const contextId = context.data.selectedStore?.id ?? null
        setSelection({ ...empty(accountId), stores, contextId, id: initialBookingMediaStore(stores, contextId), status: 'ready' })
      }).catch(error => {
        if (mounted.current && generation.current === ticket && latestAccount.current === accountId) setSelection({ ...empty(accountId), status: 'error', error })
      })
    return () => { generation.current++ }
  }, [accountId, reload])

  const current = selection.accountId === accountId ? selection : empty(accountId ?? '')
  const requiresSwitch = current.contextId !== null && current.contextId !== current.id
  const storeId = current.status === 'ready' && !current.switching && !current.error && !requiresSwitch ? current.id : ''

  const choose = (id: string) => {
    if (latestAccount.current !== accountId || current.status !== 'ready' || current.switching || !current.stores.some(store => store.id === id)) return
    setSelection(value => ({ ...value, id, error: null, changedElsewhere: false }))
  }

  const recheckContext = useCallback(async () => {
    const requestedAccount = latestAccount.current
    if (!requestedAccount) return
    const ticket = generation.current
    try {
      const response = await restaurantTestApi.storeContext(requestedAccount)
      if (!mounted.current || generation.current !== ticket || latestAccount.current !== requestedAccount) return
      setSelection(value => value.accountId === requestedAccount ? { ...value, contextId: response.data.selectedStore?.id ?? null, changedElsewhere: true, error: null } : value)
    } catch (error) {
      if (mounted.current && generation.current === ticket && latestAccount.current === requestedAccount) setSelection(value => value.accountId === requestedAccount ? { ...value, error } : value)
    }
  }, [])

  const switchContext = async () => {
    if (latestAccount.current !== accountId || !accountId || !current.id || !requiresSwitch || current.switching || switchPending.current) return
    const ticket = generation.current, id = current.id
    switchPending.current = true
    setSelection(value => ({ ...value, switching: true, error: null }))
    try {
      await restaurantTestApi.selectStore(accountId, id)
      if (!mounted.current) return
      if (generation.current !== ticket || latestAccount.current !== accountId) { void recheckContext(); return }
      const response = await restaurantTestApi.storeContext(accountId)
      if (!mounted.current || generation.current !== ticket || latestAccount.current !== accountId) return
      if (response.data.selectedStore?.id !== id) throw new Error('表示店舗が変わりました。もう一度確認してください。')
      setSelection(value => ({ ...value, contextId: id, switching: false, changedElsewhere: false }))
    } catch (error) {
      if (mounted.current && generation.current === ticket && latestAccount.current === accountId) setSelection(value => ({ ...value, switching: false, error }))
      else if (mounted.current) void recheckContext()
    } finally {
      switchPending.current = false
    }
  }

  return { ...current, storeId, requiresSwitch, choose, refresh, recheckContext, switchContext }
}
