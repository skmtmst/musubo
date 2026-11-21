// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
/*
 * 監査 WEB311：配信 A の承認の操作が終わる前に配信 B へ移ったら、
 * A の応答で B の承認の帯（文・押せる状態）を書き換えない。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiBroadcast } from '@/lib/api'
import { buttonByText, click, mount, settle, stubFetchNotFound, type Mounted } from '@/test-utils/race'

const net = vi.hoisted(() => ({
  id: 'bc-1',
  correction: false,
  send: vi.fn(),
  approve: vi.fn(),
  remind: null as null | { resolve: (v: unknown) => void },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`id=${net.id}`),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined }),
  usePathname: () => '/broadcasts/detail',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))

const pending = {
  approval: {
    status: 'pending', requestedByStaffId: 's1', requestedAt: '2026-09-25T10:00:00+09:00', approverStaffId: 's2',
    note: null, decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null,
  },
  gate: { required: true, recipientCount: 1200, threshold: 1000, singleOperator: false, operatorCount: 2 },
  viewer: { isApprover: false, canApprove: false, isRequester: true },
}

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: {
        ...actual.api.broadcasts,
        get: (id: string) => Promise.resolve({ success: true, data: {
          id, title: `配信 ${id}`, messageType: 'text', messageContent: '本文', targetType: 'all', targetTagId: null,
          status: net.correction ? 'draft' : 'scheduled', scheduledAt: net.correction ? null : '2026-10-09T01:00:00.000Z', correctionOfBroadcastId: net.correction ? 'source' : null, version: 3, sentAt: null, totalCount: 0, successCount: 0,
          createdAt: '2026-09-09T00:00:00.000Z', lineAccountId: 'acc-1', accountIds: null, dedupPriority: null,
          failedAccountIds: null, trackLinks: false,
        } as unknown as ApiBroadcast }),
        send: net.send,
        getInsight: () => Promise.resolve({ success: true, data: null }),
        approval: {
          ...actual.api.broadcasts.approval,
          get: () => Promise.resolve({ success: true, data: net.correction ? { ...pending, viewer: { isApprover: true, canApprove: true, isRequester: false } } : pending }),
          approve: net.approve,
          candidates: () => Promise.resolve({ success: true, data: [] }),
          remind: () => new Promise((resolve) => { net.remind = { resolve } }),
        },
      },
    },
  }
})

const { default: BroadcastDetailPage } = await import('./page')

let view: Mounted
beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  net.id = 'bc-1'
  net.remind = null
  net.correction = false
  net.send.mockReset()
  net.approve.mockReset()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubFetchNotFound()
  view = mount()
})
afterEach(async () => {
  await view.unmount()
  vi.unstubAllGlobals()
})

describe('承認の操作の世代（WEB311）', () => {
  it('A の「もう一度知らせる」の失敗が、B の帯に出ない・B のボタンを止めない', async () => {
    await view.render(<BroadcastDetailPage />)
    await settle()
    await click(buttonByText(view.host, 'もう一度知らせる'))
    expect(net.remind).not.toBeNull()
    net.id = 'bc-2'
    await view.render(<BroadcastDetailPage />)
    await settle()
    net.remind?.resolve({ success: false, error: 'Aの配信で失敗しました' })
    await settle()
    expect(view.host.textContent).toContain('配信 bc-2')
    expect(view.host.textContent).not.toContain('Aの配信で失敗しました')
    expect(buttonByText(view.host, 'もう一度知らせる')?.disabled).toBe(false)
  })
  it('訂正を承認後、表示した人数と承認した版で送信する', async () => {
    net.correction = true
    net.approve.mockResolvedValue({ success: true, data: { needsSend: true } })
    net.send.mockResolvedValue({ success: true, data: {} })
    await view.render(<BroadcastDetailPage />)
    await settle()
    await click(buttonByText(view.host, '承認して送る'))
    await settle()
    expect(net.approve).toHaveBeenCalledWith('bc-1', 3, undefined)
    expect(net.send).toHaveBeenCalledWith('bc-1', { expectedVersion: 3, confirmedRecipientCount: 1200 })
  })

})
