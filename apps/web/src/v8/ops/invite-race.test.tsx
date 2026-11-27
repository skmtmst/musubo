// @vitest-environment happy-dom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthResult } from '@/lib/auth-email'

const mocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
  storeAdminSession: vi.fn(),
  resetAuthSelectionCleared: vi.fn(),
}))

vi.mock('@/lib/auth-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-email')>()
  return {
    ...actual,
    authRequest: (...args: unknown[]) => mocks.authRequest(...args),
  }
})

vi.mock('@/lib/admin-session', () => ({
  adminSessionHandoffPath: (path: string) => path,
  twoFactorChallengeHandoffPath: (path: string) => path,
  storeAdminSession: (...args: unknown[]) => mocks.storeAdminSession(...args),
}))

vi.mock('@/lib/hq-navigation', () => ({
  resetAuthSelectionCleared: (...args: unknown[]) => mocks.resetAuthSelectionCleared(...args),
}))

import OpsInviteV8 from './invite'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.authRequest.mockReset()
  mocks.storeAdminSession.mockReset()
  mocks.resetAuthSelectionCleared.mockReset()
  window.location.hash = '#invite=token-abc'
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
  vi.restoreAllMocks()
})

describe('OpsInviteV8 の同時確認・二重送信ガード', () => {
  it('招待確認が重なっても古い失敗応答で新しい有効な招待を上書きしない', async () => {
    const first = deferred<AuthResult<{ email: string; name: string; needsPassword: boolean }>>()
    const second = deferred<AuthResult<{ email: string; name: string; needsPassword: boolean }>>()
    mocks.authRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(<StrictMode><OpsInviteV8 /></StrictMode>)
    await waitFor(() => expect(mocks.authRequest).toHaveBeenCalledTimes(2))

    await act(async () => {
      second.resolve({
        ok: true,
        status: 200,
        data: { email: 'ops@example.com', name: '運営 太郎', needsPassword: false },
      })
      await second.promise
    })
    expect(await screen.findByDisplayValue('ops@example.com')).toBeTruthy()

    await act(async () => {
      first.resolve({
        ok: false,
        status: 500,
        error: '古い失敗応答',
      })
      await first.promise
    })

    expect(screen.getByDisplayValue('ops@example.com')).toBeTruthy()
    expect(screen.queryByText('古い失敗応答')).toBeNull()
  })

  it('送信中にフォームを連打しても承認APIを1回しか送らず、失敗後は再送できる', async () => {
    const acceptFirst = deferred<AuthResult<{ next: string }>>()
    const acceptSecond = deferred<AuthResult<{ next: string }>>()
    mocks.authRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { email: 'ops@example.com', name: '運営 太郎', needsPassword: false },
      })
      .mockReturnValueOnce(acceptFirst.promise)
      .mockReturnValueOnce(acceptSecond.promise)

    const { container } = render(<OpsInviteV8 />)
    await screen.findByDisplayValue('ops@example.com')

    const form = container.querySelector('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(mocks.authRequest).toHaveBeenCalledTimes(2)

    await act(async () => {
      acceptFirst.resolve({ ok: false, status: 500, error: '一時的に失敗しました' })
      await acceptFirst.promise
    })
    expect(await screen.findByText('一時的に失敗しました')).toBeTruthy()

    fireEvent.submit(form)
    expect(mocks.authRequest).toHaveBeenCalledTimes(3)
  })
})
