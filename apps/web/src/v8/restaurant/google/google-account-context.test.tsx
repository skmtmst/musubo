// @vitest-environment happy-dom
/* Googleビジネスは画面右上の共通LINEアカウント選択を使い、独自の店舗選択を出さない。 */
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectionFn = vi.hoisted(() => vi.fn())
const location = vi.hoisted(() => ({ search: 'tab=settings', replace: vi.fn() }))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(location.search) }))
vi.mock('@/lib/use-same-page-url', () => ({ useSamePageUrl: () => ({ replace: location.replace, push: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'a', setSelectedAccountId: vi.fn(), accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { connection: (...args: unknown[]) => connectionFn(...args) } }))

import GoogleV8 from './google'

function connection(stores: Array<{ id: string; name: string; line_account_id: string | null }>) {
  return {
    success: true,
    store: { id: 's1', name: '渋谷店', lineAccountId: 'a' },
    connection: { status: 'connected', locationTitle: '渋谷店', locationMapsUrl: null },
    stores,
    candidates: [],
    summary: { unrepliedCount: 0, draftCount: 0, attentionCount: 0, newCount: 0, storedCount: 0, postsAttentionCount: 0, syncStale: false },
    writeEnabled: true,
    oauthConfigured: true,
    aiAvailable: false,
    permissions: { canManageConnection: true, canPublishReply: true },
  }
}

afterEach(cleanup)
beforeEach(() => { location.search = 'tab=settings'; location.replace.mockClear() })

describe('Googleビジネス：共通アカウントの選択を使う', () => {
  it('複数店舗が返っても画面内の店舗選択を出さず、選択中のアカウントを読み込む', async () => {
    connectionFn.mockResolvedValue(connection([
      { id: 's1', name: '渋谷店', line_account_id: 'a' },
      { id: 's2', name: '新宿店', line_account_id: 'b' },
    ]))
    render(<GoogleV8 />)
    expect(await screen.findByRole('heading', { name: 'Googleビジネス' })).toBeTruthy()
    expect(connectionFn).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('button', { name: '店舗' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
    expect(screen.queryByText('設定')).toBeNull()
  })

  it('店舗が1つの時も同じ表示にする', async () => {
    connectionFn.mockResolvedValue(connection([{ id: 's1', name: '渋谷店', line_account_id: 'a' }]))
    render(<GoogleV8 />)
    expect(await screen.findByRole('heading', { name: 'Googleビジネス' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '店舗' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
  })

  it('営業時間を開いた時に未接続ならGoogle接続画面へ進む', async () => {
    location.search = 'tab=hours'
    connectionFn.mockResolvedValue({ ...connection([]), connection: { status: 'disconnected', locationTitle: null, locationMapsUrl: null } })
    render(<GoogleV8 />)
    await waitFor(() => expect(location.replace).toHaveBeenCalledWith('/settings/sns?source=hours'))
  })
})
