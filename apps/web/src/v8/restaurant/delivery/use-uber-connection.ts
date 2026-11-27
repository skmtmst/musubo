'use client'

import { useEffect, useState } from 'react'
import { restaurantDeliveryApi, type DeliveryConnectionStatus } from '@/lib/restaurant-delivery-api'

/** 接続の札は設定画面と同じ保存済みの接続を読む。受注の設定を接続完了とみなさない。 */
export function useUberConnection(accountId: string | null): DeliveryConnectionStatus | null {
  const [connection, setConnection] = useState<{ accountId: string; status: DeliveryConnectionStatus } | null>(null)
  useEffect(() => {
    let current = true
    setConnection(null)
    if (!accountId) return
    void restaurantDeliveryApi.ubereatsConnection(accountId).then((res) => {
      if (!current) return
      const conn = res?.connection
      if (!conn || typeof conn !== 'object') {
        setConnection(null)
        return
      }
      const unknown = conn.lastError === 'pos_activation_started' || conn.lastError === 'pos_activation_unknown'
      let status: DeliveryConnectionStatus | null = null
      if (unknown || conn.status === 'expired' || conn.status === 'no_permission') {
        status = 'error'
      } else if (conn.status === 'connected') {
        status = 'connected'
      } else if (conn.status === 'disconnected' || conn.status === 'pending_store') {
        status = 'disconnected'
      }
      setConnection(status ? { accountId, status } : null)
    }).catch(() => {
      if (current) setConnection(null)
    })
    return () => { current = false }
  }, [accountId])
  return connection?.accountId === accountId ? connection.status : null
}
