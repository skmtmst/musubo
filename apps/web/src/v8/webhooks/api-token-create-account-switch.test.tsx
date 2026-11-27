// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { ApiError } from '@/lib/api'

const fixture = vi.hoisted(() => ({
  account: 'account-a',
  create: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account }),
}))
vi.mock('./shell', () => ({ useWebhookOverview: () => ({}) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      webhooks: {
        ...actual.api.webhooks,
        apiTokens: {
          ...actual.api.webhooks.apiTokens,
          list: fixture.list,
          create: fixture.create,
          rotate: fixture.rotate,
          revoke: fixture.revoke,
        },
      },
    },
  }
})

import { useApiTokens } from './use-api-tokens'

beforeEach(() => {
  vi.resetAllMocks()
  fixture.account = 'account-a'
  fixture.list.mockResolvedValue({ success: true, data: [] })
  verifiedStaffRole('owner')
  forgetSessionSnapshot()
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  forgetSessionSnapshot()
})

describe('API 接続の鍵発行中のアカウント切替ガード', () => {
  it('発行通信中にアカウントを切り替えると作成窓と送信中を解除し、古い本人確認を新しいアカウントに出さない', async () => {
    let rejectCreate!: (reason: unknown) => void
    fixture.create.mockReturnValueOnce(new Promise((_, reject) => { rejectCreate = reject }))

    const view = renderHook(useApiTokens)
    await act(async () => {})

    act(() => {
      view.result.current.openCreate()
      view.result.current.setName('外部連携A')
    })
    expect(view.result.current.createOpen).toBe(true)

    let pending!: Promise<void>
    act(() => {
      pending = view.result.current.handleCreate()
    })
    expect(view.result.current.creating).toBe(true)

    fixture.account = 'account-b'
    view.rerender()

    expect(view.result.current.createOpen).toBe(false)
    expect(view.result.current.creating).toBe(false)

    await act(async () => {
      rejectCreate(new ApiError(428, '本人確認が必要です', 'STEP_UP_REQUIRED'))
      await pending
    })

    expect(view.result.current.stepUp).toBeNull()
    expect(view.result.current.creating).toBe(false)
    expect(view.result.current.createError).toBe('')
  })

  it('A→B→A へ往復したあと、古い世代の本人確認コールバックと保持済み発行関数は動かない', async () => {
    fixture.create.mockRejectedValueOnce(new ApiError(428, '本人確認が必要です', 'STEP_UP_REQUIRED'))

    const view = renderHook(useApiTokens)
    await act(async () => {})

    act(() => {
      view.result.current.openCreate()
      view.result.current.setName('外部連携A')
    })

    const staleHandleCreate = view.result.current.handleCreate
    await act(async () => {
      await view.result.current.handleCreate()
    })

    const staleRetry = view.result.current.stepUp?.retry
    expect(staleRetry).toBeDefined()

    fixture.account = 'account-b'
    view.rerender()
    fixture.account = 'account-a'
    view.rerender()

    await act(async () => {
      await staleRetry?.('step-up-token')
      await staleHandleCreate()
    })

    expect(fixture.create).toHaveBeenCalledTimes(1)
  })
})
