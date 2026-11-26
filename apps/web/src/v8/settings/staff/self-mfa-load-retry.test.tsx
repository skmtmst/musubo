// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), gate: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: mocks.fetch }
})
vi.mock('@/components/step-up-prompt', () => ({ useStepUpGate: () => ({ gate: mocks.gate, prompt: null }) }))

import SelfMfa from './self-mfa'

afterEach(() => {
  cleanup()
  mocks.fetch.mockReset()
  mocks.gate.mockReset()
})

describe('認証アプリ状態の読み込み失敗時表示と再読み込み', () => {
  it('失敗時に「保存できませんでした」「確認中」を出さず、その場で再読み込みして状態を復旧できる', async () => {
    const onEnabledChange = vi.fn()
    mocks.fetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        success: true,
        data: { staffId: 'fixture-self', enabledAt: '2026-10-12T10:00:00Z', canEdit: true, notice: null },
      })

    render(<SelfMfa compact onEnabledChange={onEnabledChange} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('保存できませんでした')
    expect(screen.queryByText(/確認中/)).toBeNull()
    expect(screen.getByText(/確認できませんでした/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByText(/登録済み/)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onEnabledChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole('button', { name: '登録し直す' })).toBeTruthy()
  })
})
