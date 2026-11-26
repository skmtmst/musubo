'use client'

import { useEffect, useState } from 'react'
import type { LineAccount } from '@line-crm/shared'
import { api, type LineRegistrationReceipt } from '@/lib/api'
import { ApiError } from '@/lib/api/transport/errors'

type ReceiptStatus = LineRegistrationReceipt['status'] | 'loading' | 'unavailable' | 'closed' | 'inactive'

export function useRegistrationReceipt(accountId: string, enabled: boolean) {
  const [result, setResult] = useState<{ id: string; status: ReceiptStatus; verified: boolean }>({
    id: '', status: 'loading', verified: false,
  })
  const [account, setAccount] = useState<LineAccount>()
  const current = result.id === accountId ? result : null
  const verified = current?.verified === true

  useEffect(() => {
    if (!accountId || !enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let status: ReceiptStatus = 'unavailable'
      let success = false
      try {
        const response = await api.lineAccounts.registrationReceipt(accountId)
        if (response.success) {
          success = true
          status = response.data.status
        }
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === 'LINE_ACCOUNT_INACTIVE') status = 'inactive'
          else if (error.status === 401 || error.status === 403 || error.status === 404) status = 'closed'
        }
      }
      if (!active) return
      setResult(previous => ({
        id: accountId, status,
        verified: success || (previous.id === accountId && previous.verified && status === 'unavailable'),
      }))
      if (status !== 'confirmed' && status !== 'closed' && status !== 'inactive') {
        timer = setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [accountId, enabled])

  useEffect(() => {
    if (!accountId || !verified) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const response = await api.lineAccounts.get(encodeURIComponent(accountId))
        if (active && response.success) { setAccount(response.data); return }
      } catch (error) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          if (active) setResult({ id: accountId, status: 'closed', verified: false })
          return
        }
      }
      if (active) timer = setTimeout(() => void load(), 5000)
    }
    void load()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [accountId, verified])

  return { status: current?.status ?? 'loading', account: account?.id === accountId ? account : undefined, verified }
}
