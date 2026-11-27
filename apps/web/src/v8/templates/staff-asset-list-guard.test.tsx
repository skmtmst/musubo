// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { broadcastMessageAssets: { list: fixture.list } } }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))

import StaffAssetList from './staff-asset-list'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('閲覧のみの資産一覧の不正応答ガード', () => {
  it('応答のdataが配列でないときは落とさずエラー表示にし、再試行で一覧を表示できる', async () => {
    fixture.list
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({
        success: true,
        data: [
          {
            id: 'asset-1',
            name: '初回クーポン',
            updatedAt: '2026-11-27T08:00:00Z',
          },
        ],
      })

    render(<StaffAssetList kind="coupon" />)

    expect(await screen.findByText('クーポンを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText(/テンプレートがありません/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))

    await waitFor(() => expect(screen.getByText('初回クーポン')).toBeTruthy())
    expect(fixture.list).toHaveBeenCalledTimes(2)
  })
})
