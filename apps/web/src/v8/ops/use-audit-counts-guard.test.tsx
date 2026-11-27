// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuditCounts } from './use-audit-counts'

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { ops: { audit } } }))
vi.mock('@/components/ops/ops-ui', () => ({ opsCall: async (response: Promise<unknown>) => response }))

const filters = [
  { key: 'members', actions: 'member.invite' },
  { key: 'tenants', actions: 'tenant.create' },
]

afterEach(() => {
  cleanup()
  audit.mockReset()
})

describe('監査ログ件数取得の失敗分離と未処理拒否防止', () => {
  it('一部の取得が失敗したりtotalが不正でも未処理の失敗にならず、取得できた件数だけ反映する', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      audit.mockImplementation(async (params: { action?: string }) => {
        if (params.action === 'member.invite') throw new Error('network down')
        if (params.action === 'tenant.create') return { success: true, data: [], total: undefined }
        return { success: true, data: [], total: 42 }
      })

      const view = renderHook(() => useAuditCounts('2026-11-01', '2026-11-27', filters))

      await waitFor(() => expect(view.result.current).toEqual({ '': 42 }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
