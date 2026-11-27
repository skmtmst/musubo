// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthResult } from '@/lib/auth-email'

const mocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
  resetTurnstile: vi.fn(),
  resetAuthSelectionCleared: vi.fn(),
}))

vi.mock('@/lib/auth-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-email')>()
  return {
    ...actual,
    TURNSTILE_SITE_KEY: 'test-site-key',
    authRequest: (...args: unknown[]) => mocks.authRequest(...args),
  }
})

vi.mock('@/components/auth/turnstile', () => ({
  default: function TurnstileStub({
    onToken,
    handleRef,
  }: {
    onToken: (token: string | null) => void
    handleRef?: (handle: { reset: () => void } | null) => void
  }) {
    React.useEffect(() => {
      handleRef?.({ reset: mocks.resetTurnstile })
      onToken('turnstile-token-1')
      return () => handleRef?.(null)
    }, [handleRef, onToken])
    return <div data-testid="turnstile-stub" />
  },
}))

vi.mock('@/lib/hq-navigation', () => ({
  resetAuthSelectionCleared: (...args: unknown[]) => mocks.resetAuthSelectionCleared(...args),
}))

import OpsLoginV8 from './login'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.authRequest.mockReset()
  mocks.resetTurnstile.mockReset()
  mocks.resetAuthSelectionCleared.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OpsLoginV8 の二重送信ガード', () => {
  it('送信中に連打してもログインAPIを1回しか送らず、失敗後は再送できる', async () => {
    const first = deferred<AuthResult<{ twoFactor: boolean }>>()
    const second = deferred<AuthResult<{ twoFactor: boolean }>>()
    mocks.authRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { container } = render(<OpsLoginV8 />)

    fireEvent.change(screen.getByLabelText(/メールアドレス/), { target: { value: 'ops@example.com' } })
    fireEvent.change(screen.getByLabelText(/^パスワード/, { selector: 'input' }), { target: { value: 'StrongPass123!' } })

    const form = container.querySelector('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(mocks.authRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({ ok: false, status: 401, error: 'メールアドレスかパスワードが違います' })
      await first.promise
    })

    expect(await screen.findByText('メールアドレスかパスワードが違います')).toBeTruthy()

    fireEvent.submit(form)
    expect(mocks.authRequest).toHaveBeenCalledTimes(2)
  })
})
