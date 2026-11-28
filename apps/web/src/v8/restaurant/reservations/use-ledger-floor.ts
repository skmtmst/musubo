import { useEffect, useState } from 'react'
import type { RestaurantFloor } from '@line-crm/shared'
import { reservationBoardApi } from '@/lib/api/helpers/reservation-board'

type FloorSnapshot = {
  key: string
  floor: RestaurantFloor | undefined
  error: unknown
}

/** 読込失敗を未設定と扱わず、店舗を変えた後の古い応答も捨てる。 */
export function useLedgerFloor(accountId: string | null | undefined, storeId: string) {
  const key = accountId && storeId ? `${accountId}:${storeId}` : ''
  const [snapshot, setSnapshot] = useState<FloorSnapshot | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setSnapshot(null)
    if (accountId && storeId) {
      const requestKey = `${accountId}:${storeId}`
      void reservationBoardApi.floors(accountId, storeId)
        .then(result => {
          const failed = !result || (result as { success?: boolean }).success === false
          if (failed || !Array.isArray(result.data)) throw new Error('座席表を読み込めませんでした')
          if (current) setSnapshot({ key: requestKey, floor: result.data[0], error: null })
        })
        .catch(caught => {
          if (current) setSnapshot({ key: requestKey, floor: undefined, error: caught })
        })
    }
    return () => { current = false }
  }, [accountId, storeId, retry])
  const matched = key && snapshot?.key === key ? snapshot : null
  return { floor: matched?.floor, error: matched?.error ?? null, reload: () => setRetry(value => value + 1) }
}
