// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  call: vi.fn(),
  gate: vi.fn(async () => 'fixture-grant'),
}))

vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn() }))
vi.mock('@/components/step-up-prompt', () => ({ useStepUpGate: () => ({ gate: fx.gate, prompt: null }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffIdentity: () => ({ id: 'operator-1', name: '確認担当者' }) }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: fx.call }
})

import SelfPasskeys from './self-passkeys'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('パスキー一覧の読み込み失敗時表示と再読み込み', () => {
  it('失敗時に「未登録」と誤表示せず追加を止め、その場で再読み込みして一覧を復旧できる', async () => {
    fx.call
      .mockRejectedValueOnce(new Error('パスキー一覧を読み込めませんでした'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'key-1', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }],
      })

    render(<SelfPasskeys enabled />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('保存できませんでした')
    expect(screen.queryByText(/未登録/)).toBeNull()
    expect(screen.getByText(/確認できませんでした/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'パスキーを追加' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByText('パスキー 1')
    await waitFor(() => expect(fx.call).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/登録済み 1件/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'パスキーを追加' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
