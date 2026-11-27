// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  testNotificationRecipients: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  webinarApi: {
    testNotificationRecipients: (...args: unknown[]) => mocks.testNotificationRecipients(...args),
  },
}))

import { useTestRecipients } from './use-test-recipients'

beforeEach(() => {
  mocks.testNotificationRecipients.mockReset()
})

afterEach(cleanup)

describe('useTestRecipients の応答検証', () => {
  it('success:false が返ったときは読み込み中のまま止まらず error:true にする', async () => {
    mocks.testNotificationRecipients.mockResolvedValueOnce({
      success: false,
      error: '取得できませんでした',
    })

    const view = renderHook(() => useTestRecipients('webinar-1', true))
    await waitFor(() => expect(view.result.current.error).toBe(true))
    expect(view.result.current.preview).toBeNull()
  })

  it('data や recipients が欠けている応答は成功扱いにせず error:true にする', async () => {
    mocks.testNotificationRecipients.mockResolvedValueOnce({
      success: true,
      data: { count: 1, recipients: null },
    })

    const view = renderHook(() => useTestRecipients('webinar-1', true))
    await waitFor(() => expect(view.result.current.error).toBe(true))
    expect(view.result.current.preview).toBeNull()
  })

  it('正しいプレビュー応答のときだけ preview を返し error:false のままにする', async () => {
    const preview = {
      count: 1,
      recipients: [{ id: 'u-1', displayName: 'テスト担当' }],
      token: 'tok-1',
      confirmationId: 'conf-1',
    }
    mocks.testNotificationRecipients.mockResolvedValueOnce({
      success: true,
      data: preview,
    })

    const view = renderHook(() => useTestRecipients('webinar-1', true))
    await waitFor(() => expect(view.result.current.preview).toEqual(preview))
    expect(view.result.current.error).toBe(false)
  })
})
