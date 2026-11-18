// @vitest-environment happy-dom
/*
 * R582: `/broadcasts/reserved` に存在しないIDを指定したとき、対象なしを
 * 汎用通信エラーと同じ文と再読込だけで出していた。
 *
 * 対象なし（404）は存在しない旨と配信予定への戻り口だけ、
 * 通信失敗（503など）は同画面での再試行だけを出す。混ぜない。
 * 503から直ったときは予約内容まで戻れる。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const params = vi.hoisted(() => ({ id: 'broadcast-missing' as string | null }))
const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  preflight: vi.fn(),
  notificationSettings: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (key: string) => (key === 'id' ? params.id : null) }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'visual-qa-account', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number) {
      super(`API error: ${status}`)
      this.status = status
    }
  }
  return {
    ApiError,
    api: {
      broadcasts: {
        get: (...args: unknown[]) => apiMocks.get(...args),
        preflight: (...args: unknown[]) => apiMocks.preflight(...args),
        notificationSettings: (...args: unknown[]) => apiMocks.notificationSettings(...args),
        testSend: vi.fn(),
        create: vi.fn(),
        cancelReservation: vi.fn(),
      },
      tags: { list: async () => ({ success: true, data: [] }) },
      scenarios: { list: async () => ({ success: true, data: [] }) },
      staff: { me: async () => ({ success: true, data: { role: 'owner' } }) },
    },
  }
})

import { ApiError } from '@/lib/api'
import Page from './page'

beforeEach(() => {
  params.id = 'broadcast-missing'
  apiMocks.get.mockReset()
  apiMocks.preflight.mockResolvedValue({ success: false, error: 'x' })
  apiMocks.notificationSettings.mockResolvedValue({ success: false, error: 'x' })
})
afterEach(cleanup)

const broadcast = {
  id: 'broadcast-missing',
  title: '8月キャンペーンのお知らせ',
  messageType: 'image',
  messageContent: '8月キャンペーンのお知らせの本文です。',
  targetType: 'all',
  targetTagId: null,
  status: 'scheduled',
  scheduledAt: '2026-09-08T01:00:00.000Z',
  sentAt: null,
  totalCount: 0,
  successCount: 0,
  lineAccountId: 'visual-qa-account',
  version: 1,
  createdAt: '2026-08-16T00:00:00Z',
}

describe('broadcasts/reserved の対象なし案内（R582）', () => {
  it('現在の人数を取得し、配信対象の行に表示する', async () => {
    apiMocks.get.mockResolvedValue({ success: true, data: broadcast })
    apiMocks.preflight.mockResolvedValue({ success: true, data: {
      audienceCount: 37, hiddenExcluded: 2, warnings: [],
    } })
    render(<Page />)
    expect(await screen.findByText('このアカウントの友だち全員 37 人（除く見込み 2 人）')).toBeTruthy()
    expect(screen.getByText('送る前にもう一度、対象の人数を数え直します')).toBeTruthy()
    expect(apiMocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
      targetType: 'all', lineAccountId: 'visual-qa-account',
      messageContent: broadcast.messageContent,
    }))
  })

  it('人数の計算が失敗しても予約は表示し、0人と置き換えない', async () => {
    apiMocks.get.mockResolvedValue({ success: true, data: broadcast })
    apiMocks.preflight.mockRejectedValue(new ApiError(403))
    render(<Page />)
    expect(await screen.findByText('一斉配信を予約しました')).toBeTruthy()
    expect(screen.getByText('このアカウントの友だち全員')).toBeTruthy()
    expect(screen.queryByText(/全員 0 人/)).toBeNull()
    expect(screen.queryByText('予約結果を読み込めませんでした')).toBeNull()
  })

  it('予約の詳細リンクに保存したIDを安全に渡す', async () => {
    const id = '予約 & detail'
    params.id = id
    apiMocks.get.mockResolvedValue({ success: true, data: { ...broadcast, id } })
    render(<Page />)
    const link = await screen.findByRole('link', { name: '予約の内容を見る' })
    expect(link.getAttribute('href')).toBe(`/broadcasts/detail?id=${encodeURIComponent(id)}`)
  })

  it('存在しないIDでは一覧へ戻る口だけを出す', async () => {
    apiMocks.get.mockRejectedValue(new ApiError(404))
    render(<Page />)
    expect(await screen.findByText('予約した配信が見つかりません')).toBeTruthy()
    // 押しても直らない再試行は出さない。
    expect(screen.queryByText('もう一度読み込む')).toBeNull()
    expect(screen.getByRole('link', { name: '配信予定へ戻る' }).getAttribute('href')).toBe('/broadcasts')
  })

  it('success:false の応答も対象なしにする', async () => {
    apiMocks.get.mockResolvedValue({ success: false, error: 'Broadcast not found' })
    render(<Page />)
    expect(await screen.findByText('予約した配信が見つかりません')).toBeTruthy()
    expect(screen.queryByText('もう一度読み込む')).toBeNull()
  })

  it('503では同画面の再試行だけを出す', async () => {
    apiMocks.get.mockRejectedValue(new ApiError(503))
    render(<Page />)
    expect(await screen.findByText('予約結果を読み込めませんでした')).toBeTruthy()
    expect(screen.getByText('通信が切れたか、サーバーが応えませんでした。しばらくしてから、もう一度読み込んでください。')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    // 一覧へ逃がす口は出さない。同画面で続けられる。
    expect(screen.queryByRole('link', { name: '配信予定へ戻る' })).toBeNull()
  })

  it('503から直ったら再試行で予約内容まで戻れる', async () => {
    apiMocks.get
      .mockRejectedValueOnce(new ApiError(503))
      .mockResolvedValueOnce({ success: true, data: broadcast })
    render(<Page />)
    await screen.findByText('予約結果を読み込めませんでした')
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.getAllByText('8月キャンペーンのお知らせ')[0]).toBeTruthy())
    expect(apiMocks.get).toHaveBeenCalledTimes(2)
  })
})
