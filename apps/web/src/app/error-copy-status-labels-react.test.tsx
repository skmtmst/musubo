// @vitest-environment happy-dom
/*
 * 「〜失敗しました」で終わってよいのは、利用者への指示ではない結果の札・履歴の行だけ
 * （error-copy-recovery-contract.test.ts の例外）。その文が本当に札として出ることを描いて見る。
 * 予約確認の送信結果の札は app/booking/bookings/new/page-instant.test.tsx が見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import LoginAudit from '@/components/staff/login-audit'
import type { AuditEventItem } from '@/lib/api'

const fixture = vi.hoisted(() => ({ events: vi.fn() }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, audit: { events: fixture.events } } }
})

function loginEvent(id: string, result: AuditEventItem['result']): AuditEventItem {
  return {
    id, category: 'auth', lineAccountId: 'account-a', actor: { id: 'staff-1', name: '見本', role: 'admin' },
    action: 'auth.login', target: null, result, before: null, after: null, reason: null, requestTraceId: null,
    ipPrefix: null, deviceFamily: null, riskLevel: 'normal', retentionClass: 'security', createdAt: '2026-10-01T00:00:00.000Z',
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.events.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
})

it('ログイン記録の1行は、成功と失敗を結果の札として出す', async () => {
  fixture.events.mockResolvedValue({
    success: true,
    data: {
      items: [loginEvent('event-ok', 'success'), loginEvent('event-ng', 'failed')],
      summary: { periodDays: 30, total: 2, deleted: 0, sent: 0, changed: 0, logins: 2, suspiciousLogins: 0, attention: 0 },
      pagination: { total: 2, limit: 20, offset: 0 },
    },
  })
  await act(async () => { root.render(<LoginAudit />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })

  expect(host.textContent).toContain('ログインしました')
  expect(host.textContent).toContain('ログインに失敗しました')
})
