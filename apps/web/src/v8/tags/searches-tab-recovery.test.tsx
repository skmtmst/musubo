// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedSearch } from '@line-crm/shared'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

const net = vi.hoisted(() => ({
  list: vi.fn(),
  marks: vi.fn(),
  scenarios: vi.fn(),
  fields: vi.fn(),
  tags: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      savedSearches: { ...actual.api.savedSearches, list: net.list },
      tags: { ...actual.api.tags, list: net.tags },
      supportMarks: { ...actual.api.supportMarks, list: net.marks },
      scenarios: { ...actual.api.scenarios, list: net.scenarios },
      friendFields: { ...actual.api.friendFields, list: net.fields },
    },
  }
})

import { flushListUrlState } from '@/components/shared/list-url-state'
import { ApiError } from '@/lib/api'
import SearchesTab from './searches-tab'

const SAMPLE_SEARCH = {
  id: 's1',
  name: 'VIPかつ未契約',
  scope: 'friends',
  conditions: { all: [{ kind: 'scenario', op: 'eq', value: 'sc1' }] },
  createdBy: 'staff-1',
  lineAccountId: 'acc',
  isShared: false,
  displayOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  matchCount: 12,
  usedIn: [],
  canDelete: true,
} as SavedSearch

const SUMMARY = { total: 1, usedInBroadcasts: 0, zeroMatches: 0, callsThisMonth: 10 }

beforeEach(() => {
  window.history.replaceState(null, '', '/tags?tab=searches')
  flushListUrlState()
  net.list.mockResolvedValue({ success: true, items: [SAMPLE_SEARCH], summary: SUMMARY })
  net.marks.mockResolvedValue({ success: true, data: [] })
  net.scenarios.mockResolvedValue({ success: true, data: [{ id: 'sc1', name: '7日間フォロー' }] })
  net.fields.mockResolvedValue({ success: true, data: [] })
  net.tags.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('保存した検索の失敗時KPIと条件名再取得', () => {
  it('一覧の取得失敗時は4つのKPIカードすべてに「読み込めませんでした」を表示し、権限不足時は「権限がありません」を表示する', async () => {
    net.list.mockRejectedValueOnce(new ApiError(500, 'server down'))
    const view = render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('保存した検索を読み込めませんでした')
    const errorCards = [...view.container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
    expect(errorCards).toHaveLength(4)
    expect(errorCards.every((card) => (card.textContent ?? '').includes('読み込めませんでした'))).toBe(true)

    cleanup()
    net.list.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    const view403 = render(<SearchesTab accountId="acc" canEdit />)
    await screen.findByText('保存した検索を見る権限がありません')
    const forbiddenCards = [...view403.container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
    expect(forbiddenCards).toHaveLength(4)
    expect(forbiddenCards.every((card) => (card.textContent ?? '').includes('権限がありません'))).toBe(true)
  })

  it('補助取得（シナリオ名など）が失敗したときは一覧を残したまま案内と「条件名を読み直す」を出し、連打を防いで回復できる', async () => {
    net.scenarios.mockRejectedValueOnce(new Error('scenarios down'))
    render(<SearchesTab accountId="acc" canEdit />)

    await screen.findByText('VIPかつ未契約')
    expect(await screen.findByText(/条件に使うタグやシナリオなどの名前の一部を読み込めませんでした/)).toBeTruthy()

    let resolveRetry!: (value: { success: true; data: Array<{ id: string; name: string }> }) => void
    net.scenarios.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRetry = resolve }),
    )

    const retryButton = screen.getByRole('button', { name: '条件名を読み直す' })
    fireEvent.click(retryButton)
    await waitFor(() => expect((retryButton as HTMLButtonElement).disabled).toBe(true))
    const callsDuringRetry = net.scenarios.mock.calls.length
    fireEvent.click(retryButton)
    expect(net.scenarios.mock.calls.length).toBe(callsDuringRetry)

    await act(async () => {
      resolveRetry({ success: true, data: [{ id: 'sc1', name: '7日間フォロー' }] })
    })
    await waitFor(() => expect(screen.queryByText(/条件に使うタグやシナリオなどの名前の一部を読み込めませんでした/)).toBeNull())
  })
})
