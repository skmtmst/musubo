// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { name: 'テスト店' } }),
}))
vi.mock('@/lib/staff-role', () => ({
  canManageRole: () => true,
  useStaffRole: () => 'owner',
}))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({
  usePermissionLockReason: () => undefined,
}))
vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: { get: fx.get },
}))

import StyleEntry from './style-entry'

describe('StyleEntry 未知スタイル・欠損応答のフェイルクローズ', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('未知の style が選択済みとして返ったとき「標準」と決めつけずエラーと再読み込みを出す', async () => {
    fx.get.mockResolvedValueOnce({
      success: true,
      data: { style: 'unknown_future_style', styleSelected: true },
    })

    render(<StyleEntry />)
    expect(await screen.findByText('使い方のスタイルを確認できませんでした')).toBeTruthy()
    expect(screen.queryByText('標準')).toBeNull()
    expect(screen.getByRole('button', { name: /もう一度読み込む/ })).toBeTruthy()
  })

  it('data 欠損や styleSelected が真偽値でない応答でも落ちずにエラー表示にする', async () => {
    fx.get.mockResolvedValueOnce({
      success: true,
      data: { style: 'restaurant', styleSelected: 'yes' },
    })

    render(<StyleEntry />)
    expect(await screen.findByText('使い方のスタイルを確認できませんでした')).toBeTruthy()
  })
})
