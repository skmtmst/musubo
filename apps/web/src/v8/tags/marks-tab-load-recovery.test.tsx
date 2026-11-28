// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportMarkListItem } from '@/lib/api'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

const net = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      supportMarks: { ...actual.api.supportMarks, list: net.list },
      listStats: { ...actual.api.listStats, get: net.stats },
    },
  }
})

import { ApiError } from '@/lib/api'
import { flushListUrlState } from '@/components/shared/list-url-state'
import MarksTab from './marks-tab'

function mark(overrides: Partial<SupportMarkListItem> = {}): SupportMarkListItem {
  return {
    id: 'mk1',
    name: '要対応',
    color: '#EF4B55',
    isDefault: false,
    autoOnInbound: false,
    displayOrder: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 2,
    isInherited: false,
    automationRules: [],
    friendCount: 8,
    usedIn: { broadcasts: 1, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 },
    ...overrides,
  } as SupportMarkListItem
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/tags?tab=marks')
  flushListUrlState()
  net.list.mockReset()
  net.stats.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('MarksTab の KPI 読込・集計失敗の再読み込み', () => {
  it('受信箱の集計だけが失敗したとき、その場から集計を読み直して KPI を回復できる', async () => {
    net.list.mockResolvedValue({ success: true, data: [mark()] })
    net.stats
      .mockRejectedValueOnce(new ApiError(500, 'stats failed'))
      .mockResolvedValueOnce({
        success: true,
        data: { marks: { unanswered: 7, inProgress: 4, resolved: 9, changedLast7: 12 } },
      })

    render(<MarksTab accountId="acc-1" canEdit />)

    await screen.findByRole('table')
    await screen.findByText(/受信箱の集計を読み込めませんでした/)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      const band = document.querySelector<HTMLElement>('[data-design="KPIs"]')!
      expect(within(band).getByText('7')).toBeTruthy()
      expect(within(band).getByText('4')).toBeTruthy()
      expect(within(band).getByText('12')).toBeTruthy()
    })
    expect(screen.queryByText(/受信箱の集計を読み込めませんでした/)).toBeNull()
    expect(net.stats).toHaveBeenCalledTimes(2)
  })

  it('一覧の取得が終わっていれば、集計がまだ読み込み中でも「マーク」KPI をすぐ表示する', async () => {
    const pendingStats = deferred<{ success: true; data: { marks: { unanswered: number; inProgress: number; resolved: number; changedLast7: number } } }>()
    net.list.mockResolvedValue({
      success: true,
      data: [
        mark(),
        mark({ id: 'mk2', name: '対応中', friendCount: 0, usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 } }),
      ],
    })
    net.stats.mockReturnValueOnce(pendingStats.promise)

    render(<MarksTab accountId="acc-1" canEdit />)
    await screen.findByRole('table')

    const band = document.querySelector<HTMLElement>('[data-design="KPIs"]')!
    expect(band.textContent).toContain('2種類')
    expect(band.textContent).toContain('使っている 1')

    await act(async () => {
      pendingStats.resolve({ success: true, data: { marks: { unanswered: 3, inProgress: 1, resolved: 0, changedLast7: 5 } } })
    })
    await waitFor(() => expect(band.textContent).toContain('3人'))
  })

  it('一覧と集計が両方失敗したとき、「もう一度読み込む」1回で両方とも再取得する', async () => {
    net.list
      .mockRejectedValueOnce(new ApiError(500, 'list failed'))
      .mockResolvedValueOnce({ success: true, data: [mark()] })
    net.stats
      .mockRejectedValueOnce(new ApiError(500, 'stats failed'))
      .mockResolvedValueOnce({
        success: true,
        data: { marks: { unanswered: 6, inProgress: 2, resolved: 1, changedLast7: 8 } },
      })

    render(<MarksTab accountId="acc-1" canEdit />)
    await screen.findByText('対応マークを読み込めませんでした')

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByRole('table')
    await waitFor(() => {
      const band = document.querySelector<HTMLElement>('[data-design="KPIs"]')!
      expect(band.textContent).toContain('6人')
    })
    expect(net.list).toHaveBeenCalledTimes(2)
    expect(net.stats).toHaveBeenCalledTimes(2)
  })
})
