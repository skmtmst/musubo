// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadAdminVersionDetail = vi.hoisted(() => vi.fn())

vi.mock('@/lib/admin-version-cache', () => ({
  loadAdminVersionDetail,
}))

import { BoundaryBanner } from './boundary-banner'

beforeEach(() => {
  loadAdminVersionDetail.mockReset()
})

afterEach(cleanup)

describe('restaurant/common-a/boundary-banner の空白メモ表示ガード', () => {
  it('本番環境で空白だけの補足メモが渡されても空の案内帯を描画しない', async () => {
    loadAdminVersionDetail.mockResolvedValue({ deploy_env: 'production' })

    const { container } = render(<BoundaryBanner note="   " noteAlways />)
    await waitFor(() => expect(loadAdminVersionDetail).toHaveBeenCalledTimes(1))
    expect(container.textContent).toBe('')
    expect(container.firstChild).toBeNull()
  })

  it('検証環境で空白だけの補足メモが渡されても余分な句点や空白を付けず、有効なメモは整えて出す', async () => {
    loadAdminVersionDetail.mockResolvedValue({ deploy_env: 'staging' })

    const { rerender } = render(<BoundaryBanner note="   " />)
    expect(await screen.findByText('検証環境です。予約サイトへは送りません')).toBeTruthy()
    expect(screen.queryByText(/検証環境です。予約サイトへは送りません。/)).toBeNull()

    rerender(<BoundaryBanner note=" テスト送信のみ " />)
    expect(screen.getByText('検証環境です。予約サイトへは送りません。')).toBeTruthy()
    expect(screen.getByText('テスト送信のみ')).toBeTruthy()
  })
})
