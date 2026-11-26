// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { SecurityMonitorPanel } from './security-monitor'
const fixture = vi.hoisted(() => ({ list: vi.fn(), acknowledge: vi.fn(), resolve: vi.fn() }))
vi.mock('@/lib/api/helpers/security-monitor', () => ({ securityMonitorApi: fixture }))
const entry = { id: 'sample', ruleKey: 'login_failures', summary: '見本の異常', count: 2, threshold: 1, status: 'open', version: 3, firstDetectedAt: '2026-11-27T00:00:00Z', lastDetectedAt: '2026-11-27T00:00:00Z', reviewedAt: null, notification: 'sent' }
const reply = { success: true, data: { items: [entry], monitor: { status: 'running', lastStartedAt: new Date().toISOString(), lastCompletedAt: new Date().toISOString(), configurationValid: true }, thresholds: {}, configurationValid: true, windowMinutes: 15, limit: 200, offset: 0, total: 1 } }
beforeEach(() => { vi.resetAllMocks(); fixture.list.mockResolvedValue(reply) })
afterEach(() => { cleanup(); clearToastsForTest() })
const view = (account = 'a') => <><SecurityMonitorPanel accountId={account} canOperate /><ToastHost /></>
async function choose(label: string) { fireEvent.click(await screen.findByRole('button', { name: /のその他操作/ })); fireEvent.click(await screen.findByRole('menuitem', { name: label })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label })) }
it.each([['確かめた', 'acknowledge', '異常を確かめたことを記録しました。'], ['解決した', 'resolve', '異常を解決済みにしました。']] as const)('%s の完了を知らせる', async (label, key, message) => {
 fixture[key].mockResolvedValueOnce({ success: true, data: {} }); render(view()); await choose(label)
 expect(await screen.findByText(message)).toBeTruthy(); expect(fixture[key]).toHaveBeenCalledOnce()
})
it('更新失敗は完了を知らせず確認画面に理由を残す', async () => {
 fixture.acknowledge.mockResolvedValueOnce({ success: false }); render(view()); await choose('確かめた')
 expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeTruthy(); expect(screen.queryByText('異常を確かめたことを記録しました。')).toBeNull()
})
it('アカウントを切り替えた後の古い結果で通知しない', async () => {
 let resolve!: (v: unknown) => void; fixture.acknowledge.mockImplementationOnce(() => new Promise(done => { resolve = done })); const tree = render(view()); await choose('確かめた'); tree.rerender(view('b')); await act(async () => { resolve({ success: true, data: {} }) }); expect(screen.queryByText('異常を確かめたことを記録しました。')).toBeNull()
})
