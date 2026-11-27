// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('./shell', () => ({ WEBHOOKS_DESCRIPTION: '外部連携', ViewerBand: () => null, WebhookTabs: () => null }))
vi.mock('./use-sheets', async () => {
  const { useSaveFormErrors } = await import('@/components/shared/save-form-errors')
  return { useSheets: () => ({
    saveErrors: useSaveFormErrors(), selectedAccountId: 'a', selectedAccount: { id: 'a', name: '見本' }, accounts: [], isOwner: false,
    overview: { outgoingCount: 0, incomingCount: 0 }, connection: { status: 'connected', lastSyncedAt: null },
    canManage: false, oauthConfigured: true, status: 'ready', actionError: '', saveNotice: '', disconnectNotice: '', runsError: '', runsLoading: false,
    busy: null, showTargetForm: false, targetInput: '', disconnectFor: null, callbackNotice: null, connStatus: 'connected', staleRunningRun: null, effectivelyRunning: false,
    groups: [{ key: 'one', startedAt: '2026-10-26T00:00:00Z', kind: 'constructor', status: '__proto__', parts: ['内容を確認できません 1'] }],
    lastSyncText: '—', load: vi.fn(), loadRuns: vi.fn(), handleConnect: vi.fn(), handleSaveTarget: vi.fn(), handleSync: vi.fn(), handleDisconnect: vi.fn(), setShowTargetForm: vi.fn(), setTargetInput: vi.fn(), setDisconnectFor: vi.fn(),
  }) }
})
import WebhooksSheets from './sheets'
afterEach(cleanup)
it('未知の同期種別と状態が届いても一覧を開き、成功や失敗と決めつけない', () => {
  render(<WebhooksSheets />)
  expect(screen.getByText('種類を確認できません')).toBeTruthy()
  const status = screen.getByText('状態を確認できません')
  expect(status.closest('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  expect(screen.getByText('内容を確認できません 1')).toBeTruthy()
})
