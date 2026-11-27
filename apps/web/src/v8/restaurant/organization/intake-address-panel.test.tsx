// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantIntakeAddress, RestaurantStore } from '@/lib/restaurant-test-api'

const apiMocks = vi.hoisted(() => ({
  listIntakeAddresses: vi.fn(),
  issueIntakeAddress: vi.fn(),
}))

vi.mock('@/lib/restaurant-test-api', () => ({
  restaurantTestApi: apiMocks,
}))

import { IntakeAddressPanel } from './organization-forms'

const storeA: RestaurantStore = {
  id: 'store-a',
  name: '渋谷本店',
  code: 'A',
  area: '渋谷',
  capacity: 20,
  status: 'active',
  line_account_id: 'account-1',
  line_account_name: '渋谷本店',
}

const storeB: RestaurantStore = {
  id: 'store-b',
  name: '新宿店',
  code: 'B',
  area: '新宿',
  capacity: 30,
  status: 'active',
  line_account_id: 'account-1',
  line_account_name: '新宿店',
}

const addr = (id: string, storeId: string, address: string): RestaurantIntakeAddress => ({
  id,
  storeId,
  localPart: id,
  address,
  status: 'active',
  createdAt: '2026-10-10T03:00:00.000Z',
  revokedAt: null,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('IntakeAddressPanel の店舗切替・再試行・二重発行防止', () => {
  it('店舗を切り替えたあと、前の店舗の遅い応答で新しい店舗のアドレスを上書きしない', async () => {
    const reqA = deferred<{ data: RestaurantIntakeAddress[] }>()
    const reqB = deferred<{ data: RestaurantIntakeAddress[] }>()
    apiMocks.listIntakeAddresses
      .mockReturnValueOnce(reqA.promise)
      .mockReturnValueOnce(reqB.promise)

    const view = render(<IntakeAddressPanel accountId="account-1" store={storeA} readOnly={false} />)
    await waitFor(() => expect(apiMocks.listIntakeAddresses).toHaveBeenCalledWith('account-1', 'store-a'))

    view.rerender(<IntakeAddressPanel accountId="account-1" store={storeB} readOnly={false} />)
    await waitFor(() => expect(apiMocks.listIntakeAddresses).toHaveBeenCalledWith('account-1', 'store-b'))

    await act(async () => {
      reqB.resolve({ data: [addr('b1', 'store-b', 'store-b@in.example.jp')] })
      await reqB.promise
    })
    expect(await screen.findByDisplayValue('store-b@in.example.jp')).not.toBeNull()

    await act(async () => {
      reqA.resolve({ data: [addr('a1', 'store-a', 'store-a@in.example.jp')] })
      await reqA.promise
    })
    expect(screen.getByDisplayValue('store-b@in.example.jp')).not.toBeNull()
    expect(screen.queryByDisplayValue('store-a@in.example.jp')).toBeNull()
  })

  it('取得失敗時は「もう一度読み込む」から復帰でき、配列欠損もエラー扱いにする', async () => {
    apiMocks.listIntakeAddresses
      .mockResolvedValueOnce({ success: false, data: null })
      .mockResolvedValueOnce({ data: [addr('a1', 'store-a', 'store-a@in.example.jp')] })

    render(<IntakeAddressPanel accountId="account-1" store={storeA} readOnly={false} />)

    await screen.findByText('取り込みアドレスを読み込めませんでした。')
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    expect(await screen.findByDisplayValue('store-a@in.example.jp')).not.toBeNull()
  })

  it('発行ボタンを連打しても発行APIは1回だけ呼ばれ、完了後のお知らせが再読み込みで消えない', async () => {
    const issueReq = deferred<{ success: boolean }>()
    const reloadReq = deferred<{ data: RestaurantIntakeAddress[] }>()
    apiMocks.listIntakeAddresses
      .mockResolvedValueOnce({ data: [] })
      .mockReturnValueOnce(reloadReq.promise)
    apiMocks.issueIntakeAddress.mockReturnValueOnce(issueReq.promise)

    render(<IntakeAddressPanel accountId="account-1" store={storeA} readOnly={false} />)
    const issueButton = await screen.findByRole('button', { name: 'アドレスを発行' })
    await waitFor(() => expect((issueButton as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(issueButton)
    fireEvent.click(issueButton)
    expect(apiMocks.issueIntakeAddress).toHaveBeenCalledTimes(1)

    await act(async () => {
      issueReq.resolve({ success: true })
      await issueReq.promise
    })
    await act(async () => {
      reloadReq.resolve({ data: [addr('a1', 'store-a', 'store-a@in.example.jp')] })
      await reloadReq.promise
    })

    expect(await screen.findByDisplayValue('store-a@in.example.jp')).not.toBeNull()
    expect(screen.getByText('取り込みアドレスを発行しました。')).not.toBeNull()
  })
})
