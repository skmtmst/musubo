// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ list: vi.fn(), latestRun: vi.fn(), run: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: { analytics: { v6Funnels: net } } }))
vi.mock('./parts', () => ({ RANGES: [{ days: 30, label: '過去30日' }], downloadCsv: vi.fn(), formatAnalyticsDate: vi.fn(), formatAnalyticsDateTime: vi.fn(), rangeFor: vi.fn(() => ({ from: '2026-10-01' })), useRegisterExport: vi.fn() }))
vi.mock('@/components/shared/period-picker', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/period-picker')>()
  return { ...actual, default: ({ onRangeChange }: { onRangeChange: (range: { from: string; to: string }) => void }) => <button onClick={() => onRangeChange({ from: '2026-10-01', to: '2026-10-02' })}>期間を変更</button> }
})
import FunnelV8 from './funnel'
const result = { runId: 'run-1', state: 'available', stateReason: null, groups: [], cohortFrom: '2026-10-01', cohortTo: '2026-10-31', dataCutoffAt: '2026-10-31', versionNumber: 1 }
beforeEach(() => {
  vi.clearAllMocks()
  net.list.mockResolvedValue({ success: true, data: [{ id: 'flow', name: '購入まで', status: 'active', windowDays: 30, currentVersion: { id: 'v1', versionNumber: 1 } }] })
  net.latestRun.mockResolvedValue({ success: true, data: result })
})
afterEach(cleanup)

it('集計中に期間を変えても結果の保存欄は完了まで開かない', async () => {
  let finish!: (value: unknown) => void
  net.run.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<FunnelV8 accountId="a" canManage renderSave={() => <span>保存欄</span>} />)
  expect(await screen.findByText('この結果を保存する')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '集計し直す' }))
  await waitFor(() => expect(net.run).toHaveBeenCalledOnce())
  expect(screen.queryByText('この結果を保存する')).toBeNull()
  fireEvent.click(screen.getByText('定義の操作と集計の詳細'))
  fireEvent.click(screen.getByRole('button', { name: '期間を変更' }))
  expect(screen.queryByText('この結果を保存する')).toBeNull()
  await act(async () => finish({ success: true, data: { ...result, runId: 'run-2' } }))
  expect(await screen.findByText('この結果を保存する')).toBeTruthy()
})

it.each([true, false])('古い定義の結果の更新案内は編集可否 %s に合う', async canManage => {
  net.latestRun.mockResolvedValue({ success: true, data: { ...result, versionNumber: 2 } })
  render(<FunnelV8 accountId="a" canManage={canManage} />)
  const notice = await screen.findByText(/この結果は定義版2で集計したものです/)
  expect(notice.textContent).toContain('いまの定義は版1です。')
  expect(notice.textContent).toContain(canManage ? '再集計' : '管理者に再集計を依頼してください')
  if (!canManage) expect(notice.textContent).not.toContain('この30日を再集計')
})
