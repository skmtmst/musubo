// @vitest-environment happy-dom
/*
 * V-1/V-2: 再確認の窓（StepUpPrompt）と見なれないログイン帯（UnfamiliarLoginNotice）
 * を実物の部品で確かめる。
 *
 *   - stepUpMethod が 'password' のとき、窓はパスワード入力に切り替わる
 *   - 'none' のときは案内だけ出して送信しない
 *   - 右上の×で閉じられる（閉じるはフッターの操作ではなく右上）
 *   - unfamiliarAt が無いセッションでは帯を出さない
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  authStepUp: vi.fn(),
  snapshot: null as { impersonation: null; unfamiliarAt: string | null; stepUpMethod: 'totp' | 'password' | 'none' } | null,
}))

class MockApiError extends Error {
  status: number
  code: string | undefined
  data: unknown
  constructor(status: number, message?: string, code?: string, data?: unknown) {
    super(message || `API error: ${status}`)
    this.status = status
    this.code = code
    this.data = data
  }
}

vi.mock('@/lib/api', () => ({
  ApiError: MockApiError,
  api: { auth: { stepUp: (...args: unknown[]) => fixture.authStepUp(...args) } },
}))
vi.mock('@/lib/session-snapshot', () => ({
  readSessionSnapshot: () => fixture.snapshot,
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}))

const { default: StepUpPrompt } = await import('./step-up-prompt')
const { default: UnfamiliarLoginNotice } = await import('./unfamiliar-login-notice')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  fixture.authStepUp.mockReset()
  fixture.snapshot = { impersonation: null, unfamiliarAt: null, stepUpMethod: 'totp' }
})
afterEach(() => { cleanup() })

describe('StepUpPrompt（V-1）', () => {
  it('2段階認証の人には6桁コードの窓を出し、grantで本操作をやり直す', async () => {
    fixture.authStepUp.mockResolvedValue({ success: true, data: { token: 'grant-1' } })
    const retry = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      render(<StepUpPrompt
        request={{ purpose: 'staff.permissions.change', action: '権限を変更する', retry }}
        onDone={() => undefined}
        onClose={() => undefined}
      />)
    })
    await screen.findByText('認証アプリで本人確認')
    // 6桁目が入った瞬間に送られる（動きの点検・6。「本人確認して実行」を押さなくてよい）。
    await act(async () => { fireEvent.change(screen.getByLabelText('1桁目'), { target: { value: '123456' } }) })
    await waitFor(() => expect(fixture.authStepUp).toHaveBeenCalledWith({
      method: 'totp', value: '123456', purpose: 'staff.permissions.change',
    }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith('grant-1'))
  })

  it('2段階認証が無い人にはパスワードの窓を出す', async () => {
    fixture.snapshot!.stepUpMethod = 'password'
    fixture.authStepUp.mockResolvedValue({ success: true, data: { token: 'grant-2' } })
    const retry = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      render(<StepUpPrompt
        request={{ purpose: 'line_account.credentials', action: '接続情報を変更する', retry }}
        onDone={() => undefined}
        onClose={() => undefined}
      />)
    })
    await screen.findByText('パスワードで本人確認')
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'pw-12345' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '本人確認して実行' })) })
    await waitFor(() => expect(fixture.authStepUp).toHaveBeenCalledWith({
      method: 'password', value: 'pw-12345', purpose: 'line_account.credentials',
    }))
  })

  it('確認の方法が無い人には案内だけ出して送信しない', async () => {
    fixture.snapshot!.stepUpMethod = 'none'
    await act(async () => {
      render(<StepUpPrompt
        request={{ purpose: 'staff.permissions.change', action: '権限を変更する', retry: async () => undefined }}
        onDone={() => undefined}
        onClose={() => undefined}
      />)
    })
    await screen.findByText(/先に確認方法を設定してください/)
    expect(fixture.authStepUp).not.toHaveBeenCalled()
  })

  it('R502 方法未設定ではコード欄と実行ボタンを出さず設定への導線を出す', async () => {
    fixture.snapshot!.stepUpMethod = 'none'
    await act(async () => {
      render(<StepUpPrompt
        request={{ purpose: 'staff.permissions.change', action: '権限を変更する', retry: async () => undefined }}
        onDone={() => undefined}
        onClose={() => undefined}
      />)
    })
    await screen.findByText('本人確認の方法が未設定です')
    // 使えない入力欄・実行ボタンは出さない。
    expect(screen.queryByLabelText('1桁目')).toBeNull()
    expect(screen.queryByLabelText('パスワード')).toBeNull()
    expect(screen.queryByRole('button', { name: '本人確認して実行' })).toBeNull()
    // 設定への導線と閉じる操作は出す。
    expect(screen.getByRole('link', { name: '確認方法を設定する' }).getAttribute('href')).toBe('/staff')
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy()
  })

  it('R503 入力上限の429では待ち時間の案内を出す', async () => {
    fixture.authStepUp.mockRejectedValue(new MockApiError(429, '', undefined, { retryAfterSeconds: 540 }))
    const retry = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      render(<StepUpPrompt
        request={{ purpose: 'staff.permissions.change', action: '権限を変更する', retry }}
        onDone={() => undefined}
        onClose={() => undefined}
      />)
    })
    await screen.findByText('認証アプリで本人確認')
    // 6桁目が入った瞬間に送られる（動きの点検・6。「本人確認して実行」を押さなくてよい）。
    await act(async () => { fireEvent.change(screen.getByLabelText('1桁目'), { target: { value: '123456' } }) })
    await screen.findByText(/入力回数の上限に達しました/)
    await screen.findByText(/約9分待ってからやり直してください/)
    expect(screen.queryByText(/API error/)).toBeNull()
    expect(retry).not.toHaveBeenCalled()
  })

  it('右上の×で閉じられる', async () => {
    const onClose = vi.fn()
    await act(async () => {
      render(<StepUpPrompt
        request={{ purpose: 'staff.permissions.change', action: '権限を変更する', retry: async () => undefined }}
        onDone={() => undefined}
        onClose={onClose}
      />)
    })
    await screen.findByText('認証アプリで本人確認')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '閉じる' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('UnfamiliarLoginNotice（V-2）', () => {
  it('unfamiliarAt が無いセッションでは帯を出さない', async () => {
    let container: HTMLElement | undefined
    await act(async () => { container = render(<UnfamiliarLoginNotice />).container })
    expect(container!.querySelector('[role="note"]')).toBeNull()
  })

  it('unfamiliarAt が立つセッションでは警告帯とセッション管理への導線を出す', async () => {
    fixture.snapshot!.unfamiliarAt = '2026-10-04T01:00:00.000Z'
    await act(async () => { render(<UnfamiliarLoginNotice />) })
    await screen.findByText(/大事な操作の前に毎回、本人確認をします/)
    expect(screen.getByRole('link', { name: 'ログイン中の端末を見る' }).getAttribute('href')).toBe('/staff?section=sessions')
    expect(screen.getByText('いつもと違う端末・場所からのログインです')).toBeTruthy()
  })
})
