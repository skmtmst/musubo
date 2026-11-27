// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyHoursWorkspace, HOURS_WEEKDAYS, type HoursWorkspace, type OpeningWeek } from '@line-crm/shared'
import type { GoogleProfileData } from '@/lib/restaurant-google-api'
import { useHoursWorkspace } from './use-hours-workspace'

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  syncProfile: vi.fn(),
  hoursWorkspace: vi.fn(),
  saveHoursWorkspace: vi.fn(),
  reviewHoursWorkspace: vi.fn(),
  change: vi.fn(),
}))

vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))

const weekly = Object.fromEntries(HOURS_WEEKDAYS.map((d) => [d, [{ open: '11:00', close: '22:00' }]])) as OpeningWeek

function makeProfile(accountId: string, title: string): GoogleProfileData {
  return {
    success: true,
    store: { id: `store-${accountId}`, name: title, lineAccountId: accountId },
    profile: {
      name: `locations/${accountId}`,
      title,
      address: null,
      phone: null,
      websiteUri: null,
      description: null,
      openStatus: 'OPEN',
      regularHours: weekly,
      specialHours: [],
      mapsUri: null,
    },
    today: { date: '2026-11-04', weekday: 'WEDNESDAY', holidayName: null, periods: [], closed: false, special: false },
    holidays: [],
    timeZone: 'Asia/Tokyo',
    closed: false,
    photoCount: 0,
    googleUpdates: null,
    fetchedAt: '2026-11-04T03:00:00Z',
    stale: false,
    refreshError: null,
    pendingChangeCount: 0,
    writeEnabled: true,
    aiAvailable: true,
    permissions: { canManageConnection: true, canPublishReply: true, canSendChange: true },
  }
}

function makeWorkspaceData(note: string, version = 1) {
  const data = emptyHoursWorkspace()
  data.notes['2026-11-14'] = note
  return { version, data, history: [], holidays: [], serviceTypes: [] }
}

function Harness({ accountId }: { accountId: string }) {
  const ws = useHoursWorkspace(accountId)
  return (
    <div>
      <output data-testid="loading">{String(ws.loading)}</output>
      <output data-testid="store">{ws.data?.store.name ?? ''}</output>
      <output data-testid="note">{ws.workspace.notes['2026-11-14'] ?? ''}</output>
      <output data-testid="error">{ws.error}</output>
      <output data-testid="save-error">{ws.saveError}</output>
      <output data-testid="saving">{String(ws.saving)}</output>
      <button
        type="button"
        onClick={() => {
          const next: HoursWorkspace = { ...ws.workspace, notes: { ...ws.workspace.notes, '2026-11-14': '編集したメモ' } }
          ws.update(next)
          void ws.flush().catch(() => undefined)
        }}
      >
        今すぐ保存
      </button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

describe('useHoursWorkspace のアカウント切替・古い応答の守り', () => {
  it('A の読み込みが遅れて返っても B の表示を上書きしない', async () => {
    let resolveA!: (value: GoogleProfileData) => void
    mocks.profile.mockImplementation((accountId: string) => {
      if (accountId === 'acc-a') return new Promise<GoogleProfileData>((resolve) => { resolveA = resolve })
      return Promise.resolve(makeProfile('acc-b', '店舗B'))
    })
    mocks.hoursWorkspace.mockImplementation((accountId: string) =>
      Promise.resolve(makeWorkspaceData(accountId === 'acc-a' ? 'メモA' : 'メモB', accountId === 'acc-a' ? 1 : 2)),
    )

    const view = render(<Harness accountId="acc-a" />)
    expect(mocks.profile).toHaveBeenCalledWith('acc-a')

    view.rerender(<Harness accountId="acc-b" />)
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
      expect(screen.getByTestId('store').textContent).toBe('店舗B')
      expect(screen.getByTestId('note').textContent).toBe('メモB')
    })

    resolveA(makeProfile('acc-a', '店舗A'))
    await waitFor(() => expect(mocks.hoursWorkspace).toHaveBeenCalledWith('acc-a'))

    expect(screen.getByTestId('store').textContent).toBe('店舗B')
    expect(screen.getByTestId('note').textContent).toBe('メモB')
  })

  it('A で読み込んだあと B の読み込みが失敗しても A の店舗データを残さない', async () => {
    mocks.profile.mockImplementation((accountId: string) => {
      if (accountId === 'acc-a') return Promise.resolve(makeProfile('acc-a', '店舗A'))
      return Promise.reject(new Error('network'))
    })
    mocks.hoursWorkspace.mockResolvedValue(makeWorkspaceData('メモA', 1))

    const view = render(<Harness accountId="acc-a" />)
    await waitFor(() => expect(screen.getByTestId('store').textContent).toBe('店舗A'))

    view.rerender(<Harness accountId="acc-b" />)
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
      expect(screen.getByTestId('error').textContent).toContain('営業時間を読み込めませんでした')
    })

    expect(screen.getByTestId('store').textContent).toBe('')
    expect(screen.getByTestId('note').textContent).toBe('')
  })

  it('A の保存失敗が遅れて返っても B に saveError や保存ブロックを持ち込まない', async () => {
    let rejectSaveA!: (err: unknown) => void
    mocks.profile.mockImplementation((accountId: string) =>
      Promise.resolve(makeProfile(accountId, accountId === 'acc-a' ? '店舗A' : '店舗B')),
    )
    mocks.hoursWorkspace.mockImplementation((accountId: string) =>
      Promise.resolve(makeWorkspaceData(accountId === 'acc-a' ? 'メモA' : 'メモB', accountId === 'acc-a' ? 1 : 2)),
    )
    mocks.saveHoursWorkspace.mockImplementation((accountId: string) => {
      if (accountId === 'acc-a') return new Promise((_, reject) => { rejectSaveA = reject })
      return Promise.resolve({ version: 3, data: emptyHoursWorkspace(), history: [] })
    })

    const view = render(<Harness accountId="acc-a" />)
    await waitFor(() => expect(screen.getByTestId('store').textContent).toBe('店舗A'))

    fireEvent.click(screen.getByRole('button', { name: '今すぐ保存' }))
    await waitFor(() => expect(mocks.saveHoursWorkspace).toHaveBeenCalledWith('acc-a', 1, expect.anything(), ''))

    view.rerender(<Harness accountId="acc-b" />)
    await waitFor(() => {
      expect(screen.getByTestId('store').textContent).toBe('店舗B')
      expect(screen.getByTestId('saving').textContent).toBe('false')
    })

    rejectSaveA(new Error('conflict'))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByTestId('save-error').textContent).toBe('')

    fireEvent.click(screen.getByRole('button', { name: '今すぐ保存' }))
    await waitFor(() => expect(mocks.saveHoursWorkspace).toHaveBeenCalledWith('acc-b', 2, expect.anything(), ''))
    expect(screen.getByTestId('save-error').textContent).toBe('')
  })
})
