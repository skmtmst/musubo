// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('./use-audit-counts', () => ({ useAuditCounts: () => ({ '': 1, impersonation: 1 }) }))
vi.mock('./use-ops-read-only', () => ({ useOpsReadOnly: () => false }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ops: {
        ...actual.api.ops,
        audit: (...args: unknown[]) => mocks.audit(...args),
      },
    },
  }
})

import OpsAuditV8 from './audit'

const rowAll = {
  id: 'audit-1',
  created_at: '2026-10-10T01:00:00Z',
  staff_name: '運用 太郎',
  tenant_name: '契約先A',
  action: 'tenant.status.change',
  reason: '運用テストのため停止',
  ip: '127.0.0.1',
  visible_to_tenant: 0,
}

const rowImp = {
  id: 'audit-2',
  created_at: '2026-10-10T02:00:00Z',
  staff_name: '運用 花子',
  tenant_name: '契約先B',
  action: 'impersonation.start',
  reason: '画面確認のため代理ログイン',
  ip: '127.0.0.1',
  visible_to_tenant: 1,
}

beforeEach(() => {
  vi.resetAllMocks()
  window.history.replaceState(null, '', '/ops/audit')
  document.documentElement.dataset.theme = 'v8'
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('運営の監査ログ：切替後の読み込み失敗からの再試行と古い応答の破棄', () => {
  it('一覧表示後のタブ切替で取得に失敗したとき、失敗帯の再読み込みボタンから再取得して回復できる', async () => {
    mocks.audit
      .mockResolvedValueOnce({ success: true, data: [rowAll], total: 1 })
      .mockResolvedValueOnce({ success: false, error: '監査ログを読み込めませんでした' })
      .mockResolvedValueOnce({ success: true, data: [rowImp], total: 1 })

    render(<OpsAuditV8 />)

    await screen.findByText('運用テストのため停止')
    fireEvent.click(screen.getByRole('tab', { name: /代理ログイン/ }))

    const retryButton = await screen.findByRole('button', { name: 'もう一度読み込む' })
    expect(screen.getByRole('alert').textContent).toContain('監査ログを読み込めませんでした')

    fireEvent.click(retryButton)
    await waitFor(() => expect(screen.getByText('画面確認のため代理ログイン')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.audit).toHaveBeenCalledTimes(3)
  })

  it('タブを連続で切り替えたとき、前の遅い応答で最新の一覧を上書きしない', async () => {
    let resolveSlow!: (value: unknown) => void
    mocks.audit
      .mockResolvedValueOnce({ success: true, data: [rowAll], total: 1 })
      .mockReturnValueOnce(new Promise((resolve) => { resolveSlow = resolve }))
      .mockResolvedValueOnce({ success: true, data: [rowImp], total: 1 })

    render(<OpsAuditV8 />)

    await screen.findByText('運用テストのため停止')
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /代理ログイン/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /契約先の停止/ })) })

    await screen.findByText('画面確認のため代理ログイン')
    await act(async () => {
      resolveSlow({ success: true, data: [{ ...rowAll, id: 'stale-row', reason: '古い応答の記録' }], total: 1 })
    })
    expect(screen.queryByText('古い応答の記録')).toBeNull()
    expect(screen.getByText('画面確認のため代理ログイン')).toBeTruthy()
  })
})
