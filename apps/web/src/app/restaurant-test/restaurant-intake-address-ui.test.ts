// @vitest-environment happy-dom
import React from 'react'
import { setImmediate } from 'node:timers'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { IntakeAddressPanel, StoreForm } from '@/v8/restaurant/organization/organization-forms'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { ApiError } from '@/lib/api'
import type { RestaurantStore } from '@/lib/restaurant-test-api'
import type { AccountWithStats } from '@/contexts/account-context'
import { describe, expect, test } from 'vitest'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
const store = { id: 'store-1', name: '試験店', code: 'S', area: '', capacity: 20, status: 'active', line_account_id: 'used', line_account_name: '使用中公式' } as RestaurantStore
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function captureRequests() {
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init })
    return new Response(JSON.stringify({ success: true, data: init?.method ? { id: 'issued-1' } : [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return requests
}

describe('飲食店向け予約メール取り込みアドレス画面', () => {
  test('一覧・発行APIを店舗単位で呼び分ける', async () => {
    const requests = captureRequests()
    await restaurantTestApi.listIntakeAddresses('account&1', 'store/1 ?')
    await restaurantTestApi.issueIntakeAddress('account&1', 'store/1 ?')
    expect(requests).toHaveLength(2)
    expect(requests.map(row => row.url.pathname)).toEqual(['/api/restaurant-test/intake-addresses', '/api/restaurant-test/intake-addresses'])
    expect(requests.map(row => row.url.searchParams.get('account_id'))).toEqual(['account&1', 'account&1'])
    expect(requests[0].url.searchParams.get('storeId')).toBe('store/1 ?')
    expect(requests[0].init?.method ?? 'GET').toBe('GET')
    expect(requests[1].init?.method).toBe('POST')
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ storeId: 'store/1 ?' })
  })

  test('未発行・コピー・再発行確認・ドメイン未設定を運用者へ表示する', async () => {
    const logs = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log' | 'warn' | 'error'))
    const address = { id: 'mail-1', address: 'intake@example.test', status: 'active', createdAt: '2026-10-01T00:00:00Z', revokedAt: null }
    const list = vi.spyOn(restaurantTestApi, 'listIntakeAddresses').mockResolvedValue({ data: [] } as never)
    const issue = vi.spyOn(restaurantTestApi, 'issueIntakeAddress').mockResolvedValue({ success: true } as never)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    const view = render(React.createElement(IntakeAddressPanel, { accountId: 'account-1', store, readOnly: false }))
    await screen.findByText('未設定')
    expect(screen.getByText('予約メール取り込みアドレス')).toBeTruthy()
    list.mockResolvedValue({ data: [address] } as never)
    fireEvent.click(screen.getByRole('button', { name: 'アドレスを発行' }))
    await screen.findByDisplayValue(address.address)
    // コピー部品の初期effect（世代の更新）を済ませてから操作する。
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) })
    fireEvent.click(screen.getByRole('button', { name: 'メールアドレスをコピー' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(address.address))
    await screen.findByText('コピーしました')
    issue.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'アドレスを発行' }))
    const dialog = screen.getByRole('dialog', { name: '新しい取り込みアドレスを発行しますか？' })
    expect(dialog.textContent).toContain('90日後に失効')
    expect(issue).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '発行する' }))
    await waitFor(() => expect(issue).toHaveBeenCalledWith('account-1', 'store-1'))
    await screen.findByText(/旧アドレスは90日後に失効します/)
    view.unmount()
    list.mockRejectedValue(new ApiError(503, 'unconfigured'))
    render(React.createElement(IntakeAddressPanel, { accountId: 'account-1', store, readOnly: false }))
    await screen.findByText('取り込み用ドメインが未設定です')
    expect(logs.flatMap(log => log.mock.calls).flat().join(' ')).not.toContain(address.address)
  })
})

describe('飲食店向け店舗とLINE公式アカウントの紐づけ画面', () => {
  test('店舗作成・編集APIを配線し、削除APIは持たない', async () => {
    const requests = captureRequests()
    const body = { name: '試験店', code: 'S', area: '', capacity: 20, timezone: 'Asia/Tokyo', lineAccountId: 'free' }
    await restaurantTestApi.createStore('account-1', body)
    await restaurantTestApi.updateStore('account-1', 'store-1', { ...body, status: 'active' })
    expect(requests).toHaveLength(2)
    expect(requests.map(row => row.url.pathname)).toEqual(['/api/restaurant-test/stores', '/api/restaurant-test/stores/store-1'])
    expect(requests.map(row => row.url.searchParams.get('account_id'))).toEqual(['account-1', 'account-1'])
    expect(requests.map(row => row.init?.method)).toEqual(['POST', 'PATCH'])
    expect(JSON.parse(String(requests[0].init?.body))).toEqual(body)
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ ...body, status: 'active' })
    expect('deleteStore' in restaurantTestApi).toBe(false)
  })

  test('LINE公式アカウントを必須選択にして使用中アカウントを選択不可にする', () => {
    const accounts = [{ id: 'used', name: '使用中公式' }, { id: 'free', name: '空いている公式' }] as AccountWithStats[]
    const submit = vi.fn()
    const view = render(React.createElement(StoreForm, { accounts, stores: [store], busy: false, onSubmit: submit, onCancel: () => {} }))
    // ：作ってあるアカウントは選ぶ窓で選ぶ。他店舗で使用中の候補は押せない。
    fireEvent.click(screen.getByRole('button', { name: 'LINE公式アカウント：選択する' }))
    const dialog = screen.getByRole('dialog', { name: 'LINE公式アカウントを選ぶ' })
    const usedRadio = within(dialog).getByRole('radio', { name: '使用中公式' }) as HTMLInputElement
    expect(usedRadio.disabled).toBe(true)
    expect(within(dialog).getByText('他店舗で使用中')).toBeTruthy()
    fireEvent.click(usedRadio)
    expect(view.container.querySelector<HTMLInputElement>('input[name="lineAccountId"]')?.value).toBe('')
    expect(screen.queryByRole('button', { name: /店舗を削除/ })).toBeNull()
    view.unmount()
    render(React.createElement(StoreForm, { store, accounts, stores: [store], busy: false, onSubmit: submit, onCancel: () => {} }))
    expect(screen.getByRole('button', { name: 'LINE公式アカウント：変更する' }).closest('[data-entity-picker-field]')?.textContent).toContain('使用中公式')
    fireEvent.click(screen.getByRole('button', { name: '状態' }))
    expect(screen.getByRole('option', { name: 'アーカイブ' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /店舗を削除/ })).toBeNull()
  })
})
