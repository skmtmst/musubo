import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  downloadApiFile: vi.fn(),
}))

vi.mock('./api', () => transport)

import { isUberConnectionMutationData, restaurantDeliveryApi } from './restaurant-delivery-api'

beforeEach(() => {
  transport.fetchApi.mockReset()
  transport.fetchApi.mockResolvedValue({ success: true })
})

describe('restaurant delivery Uber connection transport', () => {
  it('接続確認は選択中のLINE公式アカウントを付けて1回だけPOSTする', async () => {
    await restaurantDeliveryApi.ubereatsCheckConnection('account/1')

    expect(transport.fetchApi).toHaveBeenCalledTimes(1)
    expect(transport.fetchApi).toHaveBeenCalledWith(
      '/api/restaurant-test/delivery/ubereats/connection/check?account_id=account%2F1',
      { method: 'POST', body: '{}' },
    )
  })

  it('接続解除は利用者が確認した印をDELETEの本文へ付ける', async () => {
    await restaurantDeliveryApi.ubereatsDisconnect('account/1')

    expect(transport.fetchApi).toHaveBeenCalledTimes(1)
    expect(transport.fetchApi).toHaveBeenCalledWith(
      '/api/restaurant-test/delivery/ubereats/connection?account_id=account%2F1',
      { method: 'DELETE', body: '{"confirmed":true}' },
    )
  })

  it('確認した接続の版を解除時に送る', async () => {
    await Reflect.apply(restaurantDeliveryApi.ubereatsDisconnect, null, ['account/1', 5])
    expect(transport.fetchApi).toHaveBeenCalledWith(
      '/api/restaurant-test/delivery/ubereats/connection?account_id=account%2F1',
      { method: 'DELETE', body: JSON.stringify({ confirmed: true, expectedVersion: 5 }) },
    )
  })

  it('接続変更の成功応答は状態と全ての日時がそろった形だけを受け入れる', () => {
    const complete = {
      success: true,
      connection: {
        status: 'connected',
        storeName: '渋谷店',
        connectedAt: '2026-10-23T01:00:00.000Z',
        provisionedAt: '2026-10-23T01:00:00.000Z',
        checkedAt: '2026-10-23T01:00:00.000Z',
        lastError: null,
      },
    }
    expect(isUberConnectionMutationData(complete)).toBe(true)
    expect(isUberConnectionMutationData({ ...complete, connection: { ...complete.connection, checkedAt: undefined } })).toBe(false)
    expect(isUberConnectionMutationData({ ...complete, connection: { ...complete.connection, status: 'unknown' } })).toBe(false)
    expect(isUberConnectionMutationData({ success: true })).toBe(false)
  })
})
