// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  fetch: vi.fn(),
  addresses: vi.fn(),
  issue: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: calls.fetch }
})
vi.mock('@/lib/restaurant-test-api', () => ({
  restaurantTestApi: {
    listIntakeAddresses: calls.addresses,
    issueIntakeAddress: calls.issue,
  },
}))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: () => undefined }))
vi.mock('@/components/shared/date-time-field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/date-time-field')>()
  return {
    ...actual,
    default: ({ onChange, ...props }: React.ComponentProps<typeof actual.default>) => (
      <input {...props} onChange={(e) => onChange(e.target.value)} />
    ),
  }
})

import ChannelsBoard, { type RestaurantChannel } from './channels'

const SAMPLE_CHANNEL: RestaurantChannel = {
  id: 'ch-1',
  code: 'tabelog',
  name: '食べログ',
  todayCount: 5,
  lastReceivedAt: '2026-10-20T01:00:00Z',
  unreadableCount: 1,
  receiveMethod: 'email_forward',
  status: 'receiving',
  daysWithoutReceipt: 0,
}

beforeEach(() => {
  vi.resetAllMocks()
  calls.addresses.mockResolvedValue({ data: [{ address: 'store@intake.example.test' }] })
  calls.issue.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
})

describe('予約経路の連携：部分失敗時の表示と再読み込み', () => {
  it('読めなかったメールの取得が失敗しても経路一覧を残し、読めなかった件数を0件と偽らず再読み込みで回復できる', async () => {
    let inboundFail = true
    calls.fetch.mockImplementation(async (url: string) => {
      if (url.includes('inbound-emails')) {
        if (inboundFail) throw new Error('メール一覧エラー')
        return {
          data: [{ id: 'mail-1', storeId: 's', receivedAt: '2026-10-20T02:00:00Z', status: 'quarantined', reason: '日時不明', mediaCode: 'tabelog', mediaName: '食べログ' }],
          total: 2,
        }
      }
      return { data: [SAMPLE_CHANNEL] }
    })

    const { container } = render(<ChannelsBoard accountId="a" storeId="s" storeName="本店" date="2026-10-20" canEdit />)

    expect(await screen.findByText('食べログ')).toBeTruthy()
    expect(screen.getByText('読めなかったメールを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('いま残っているものはありません')).toBeNull()

    const kpiNumbers = [...container.querySelectorAll('[data-kpi-number]')].map((el) => el.textContent)
    expect(kpiNumbers).toEqual(['5', '—'])

    inboundFail = false
    const unreadCard = screen.getByRole('heading', { name: '読めなかったもの' }).closest('[aria-labelledby="rs-unread-title"]') as HTMLElement
    fireEvent.click(within(unreadCard).getByRole('button', { name: 'もう一度読み込む' }))

    expect(await screen.findByText(/日時不明/)).toBeTruthy()
    await waitFor(() => {
      expect([...container.querySelectorAll('[data-kpi-number]')].map((el) => el.textContent)).toEqual(['5', '2'])
    })
  })

  it('取り込みアドレスの取得が失敗しても経路一覧を残し、未発行と誤認させず発行ボタンを隠したまま再読み込みで回復できる', async () => {
    calls.addresses.mockRejectedValueOnce(new Error('アドレス取得失敗'))
    calls.addresses.mockResolvedValueOnce({ data: [{ address: 'store@intake.example.test' }] })
    calls.fetch.mockImplementation(async (url: string) =>
      url.includes('inbound-emails') ? { data: [], total: 0 } : { data: [SAMPLE_CHANNEL] },
    )

    render(<ChannelsBoard accountId="a" storeId="s" storeName="本店" date="2026-10-20" canEdit />)

    expect(await screen.findByText('食べログ')).toBeTruthy()
    const input = screen.getByLabelText('取り込みアドレス') as HTMLInputElement
    expect(input.value).toBe('読み込めませんでした')
    expect(screen.queryByRole('button', { name: '発行する' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect((screen.getByLabelText('取り込みアドレス') as HTMLInputElement).value).toBe('store@intake.example.test')
    })
    expect(screen.getByRole('button', { name: /発行し直す（旧は/ })).toBeTruthy()
  })

  it('予約経路本体の読み込み失敗時に再読み込みボタンを連打しても重複リクエストを送らない', async () => {
    let resolveRetry: ((value: { data: RestaurantChannel[] }) => void) | null = null
    let channelsCallCount = 0
    calls.fetch.mockImplementation(async (url: string) => {
      if (url.includes('inbound-emails')) return { data: [], total: 0 }
      channelsCallCount += 1
      if (channelsCallCount === 1) throw new Error('通信失敗')
      return await new Promise<{ data: RestaurantChannel[] }>((resolve) => {
        resolveRetry = resolve
      })
    })

    render(<ChannelsBoard accountId="a" storeId="s" storeName="本店" date="2026-10-20" canEdit />)

    const retryButton = await screen.findByRole('button', { name: 'もう一度読み込む' })
    expect(channelsCallCount).toBe(1)

    fireEvent.click(retryButton)
    fireEvent.click(retryButton)

    await waitFor(() => expect(channelsCallCount).toBe(2))
    resolveRetry!({ data: [SAMPLE_CHANNEL] })
    expect(await screen.findByText('食べログ')).toBeTruthy()
  })
})
