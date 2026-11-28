// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
const fixture = vi.hoisted(() => ({ selectLocation: vi.fn() }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: fixture }))
vi.mock('./use-google-permission', () => ({ useGooglePermission: () => ({ allowed: true, canView: true, known: true, lockedReason: null }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [] })) }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import SettingsBoard from './settings'
const data = { store: { id: 's', name: '見本店', lineAccountId: 'a' }, connection: { id: 'conn', confirmationRevision: 1, status: 'pending_location', locationName: null, locationTitle: null }, candidates: [{ locationName: 'locations/sample', locationTitle: '見本店' }], summary: { storedCount: 0, unrepliedCount: 0, attentionCount: 0, syncStale: false }, permissions: { canManageConnection: true, canPublishReply: true }, oauthConfigured: true, writeEnabled: true } as unknown as GoogleConnectionData
const changed = vi.fn()
const view = (account = 'a') => <><SettingsBoard accountId={account} data={data} onChanged={changed} /><ToastHost /></>
beforeEach(() => { fixture.selectLocation.mockReset(); changed.mockReset() })
afterEach(() => { cleanup(); clearToastsForTest() })
function select() { fireEvent.click(screen.getByRole('radio', { name: '見本店' })) }
async function submit() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'この店舗を接続する' })) }) }
it('連携先を選べたら完了を知らせる', async () => { fixture.selectLocation.mockResolvedValueOnce({}); render(view()); select(); await submit(); expect(await screen.findByText('Google の連携先の店舗を設定しました。')).toBeTruthy(); expect(changed).toHaveBeenCalledOnce() })
it('選択に失敗したら完了を知らせない', async () => { fixture.selectLocation.mockRejectedValueOnce(new Error('失敗')); render(view()); select(); await submit(); expect(screen.queryByText('Google の連携先の店舗を設定しました。')).toBeNull(); expect(changed).not.toHaveBeenCalled() })
it('アカウント切替後に古い選択結果で通知しない', async () => { let resolve!: (v: unknown) => void; fixture.selectLocation.mockImplementationOnce(() => new Promise(done => { resolve = done })); const tree = render(view()); select(); fireEvent.click(screen.getByRole('button', { name: 'この店舗を接続する' })); tree.rerender(view('b')); await act(async () => { resolve({}) }); expect(screen.queryByText('Google の連携先の店舗を設定しました。')).toBeNull(); expect(changed).not.toHaveBeenCalled() })
