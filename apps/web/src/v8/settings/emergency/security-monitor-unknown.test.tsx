// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SecurityMonitorPanel } from './security-monitor'
const fixture = vi.hoisted(() => ({ list: vi.fn(), acknowledge: vi.fn(), resolve: vi.fn() }))
vi.mock('@/lib/api/helpers/security-monitor', () => ({ securityMonitorApi: fixture }))
const entry = { id: 'sample', ruleKey: 'login_failures', summary: '見本の異常', count: 2, threshold: 1, status: 'open', version: 3, firstDetectedAt: '2026-11-27T00:00:00Z', lastDetectedAt: '2026-11-27T00:00:00Z', reviewedAt: null, notification: 'sent' }
function response(patch: Record<string, unknown>) { const now = new Date().toISOString(); return { success: true, data: { items: [{ ...entry, ...patch }], monitor: { status: 'running', lastStartedAt: now, lastCompletedAt: now, configurationValid: true }, thresholds: {}, configurationValid: true, windowMinutes: 15, limit: 200, offset: 0, total: 1 } } }
afterEach(() => { cleanup(); vi.resetAllMocks() })
it.each(['future', 'toString', 'constructor', '__proto__'])('未知の状態 %s は不明と示し、異常を消さず操作を出さない', async status => {
 fixture.list.mockResolvedValueOnce(response({ status })); render(<SecurityMonitorPanel accountId="a" canOperate />)
 expect(await screen.findByText('見本の異常')).toBeTruthy(); const row = screen.getByText('見本の異常').closest('[role="row"]')!
 expect(within(row as HTMLElement).getByText('状態不明')).toBeTruthy(); expect(within(row as HTMLElement).queryByRole('button', { name: /のその他操作/ })).toBeNull()
 expect(screen.queryByText(/未対応の異常はありません/)).toBeNull()
})
it.each(['future', 'toString', 'constructor', '__proto__'])('未知の通知状態 %s は不明と示し、既知の異常状態を保つ', async notification => {
 fixture.list.mockResolvedValueOnce(response({ notification })); render(<SecurityMonitorPanel accountId="a" canOperate />)
 expect(await screen.findByText('見本の異常')).toBeTruthy(); const row = screen.getByText('見本の異常').closest('[role="row"]')!
 expect(within(row as HTMLElement).getByText('通知不明')).toBeTruthy(); expect(within(row as HTMLElement).getByText('未対応')).toBeTruthy(); expect(within(row as HTMLElement).getByRole('button', { name: /のその他操作/ })).toBeTruthy()
})

it.each(['future', 'toString', 'constructor', '__proto__'])('未知の見張り状態 %s を稼働中と表示しない', async status => {
 const result = response({}); result.data.monitor.status = status; fixture.list.mockResolvedValueOnce(result)
 render(<SecurityMonitorPanel accountId="a" canOperate />)
 expect(await screen.findByText('見張りの状態を確認できません')).toBeTruthy()
 expect(screen.queryByText('見張りは動いています')).toBeNull()
 expect(screen.getByRole('alert').textContent).toContain('見張りの状態を確認できません。')
})
