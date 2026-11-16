// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import SettingsBoard from './settings'

/*
  差し戻し R4 の見張り。承認済み Pen
  /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 14 (orKSi) の⑤営業時間 手順1/2 は「つなぐを押した時」ではなく
  「Googleとつながって戻ってきた時」に2/2へ進む。失敗・中断では1/2に留まる。
*/

const fixture = vi.hoisted(() => ({
  connectStart: vi.fn(), selectLocation: vi.fn(), disconnect: vi.fn(),
  connection: vi.fn(), profile: vi.fn(), syncProfile: vi.fn(), proposeHours: vi.fn(),
}))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: fixture }))
vi.mock('./use-google-permission', () => ({ useGooglePermission: () => ({ allowed: true, canView: true, known: true, lockedReason: null }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'a', name: '対象LINE' }] })) }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

function data(status: string): GoogleConnectionData {
  return {
    store: { id: 's', name: '合成店', lineAccountId: 'a' },
    connection: status === 'disconnected'
      ? { id: null, confirmationRevision: 0, status, locationName: null, locationTitle: null }
      : { id: 'conn', confirmationRevision: 4, status, locationName: 'locations/a', locationTitle: '合成店' },
    candidates: [{ locationName: 'locations/a', locationTitle: '合成店' }],
    summary: { storedCount: 0, unrepliedCount: 0, attentionCount: 0, syncStale: false },
    permissions: { canManageConnection: true, canPublishReply: true }, oauthConfigured: true, writeEnabled: true,
  } as unknown as GoogleConnectionData
}

/* guide-signal.ts の合図。手順を進める合図はこの1本だけ。 */
const signals: string[] = []
const listen = (event: Event) => {
  const anchor = (event as CustomEvent<{ anchor?: string }>).detail?.anchor
  if (anchor) signals.push(anchor)
}

beforeEach(() => {
  signals.length = 0
  window.addEventListener('lh:v8:guide-signal', listen)
  fixture.connectStart.mockResolvedValue({ authorizeUrl: 'https://example.invalid/authorize' })
})

afterEach(() => {
  window.removeEventListener('lh:v8:guide-signal', listen)
  cleanup()
  vi.clearAllMocks()
})

describe('⑤営業時間 手順1/2 の進み方（R4）', () => {
  it('未接続のまま「接続する」を押しただけでは進む合図を出さない', () => {
    render(<SettingsBoard accountId="acc" data={data('disconnected')} onChanged={vi.fn()} />)
    const button = screen.getByRole('button', { name: /接続する/ })
    expect(button.getAttribute('data-guide-anchor')).toBe('hours.googleConnect')
    fireEvent.click(button)
    expect(signals).not.toContain('hours.googleConnect')
  })

  it('失敗・中断で未接続のまま戻ってきた時も1/2に留まる', () => {
    render(<SettingsBoard accountId="acc" data={data('disconnected')} onChanged={vi.fn()} />)
    expect(signals).not.toContain('hours.googleConnect')
  })

  it('つながって戻ってきた時に1度だけ進む合図を出す', () => {
    render(<SettingsBoard accountId="acc" data={data('pending_location')} onChanged={vi.fn()} />)
    expect(signals.filter(anchor => anchor === 'hours.googleConnect').length).toBe(1)
  })

  it('接続済みで開き直した時も進む合図を出す', () => {
    render(<SettingsBoard accountId="acc" data={data('connected')} onChanged={vi.fn()} />)
    expect(signals.filter(anchor => anchor === 'hours.googleConnect').length).toBe(1)
  })
})
