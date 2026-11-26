// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accountId: 'acc-1' as string | null,
  columns: vi.fn(),
  updateColumnMessage: vi.fn(),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: state.accountId }),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => 'admin',
  canManageRole: () => true,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      nenCampaigns: {
        ...actual.api.nenCampaigns,
        columns: state.columns,
        updateColumnMessage: state.updateColumnMessage,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import ColumnIntros from './column-intros'

const sampleColumn = {
  id: 'col-1',
  slug: 'spring-care',
  title: '春のケア特集',
  introText: '季節の変わり目のごはんのコツ',
  publishedAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
}

beforeEach(() => {
  state.accountId = 'acc-1'
  state.columns.mockReset()
  state.updateColumnMessage.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ColumnIntros の読み込み失敗・再読み込み・切替', () => {
  it('API が success: false を返したときに空状態にせず、エラー表示からその場で読み直せる', async () => {
    state.columns
      .mockResolvedValueOnce({ success: false, error: 'upstream error' })
      .mockResolvedValueOnce({ success: true, data: [sampleColumn] })

    render(<ColumnIntros />)

    await screen.findByText('コラムの紹介文を読み込めませんでした')
    expect(screen.queryByText(/コラムがまだありません/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await screen.findByText('春のケア特集')
    expect(state.columns).toHaveBeenCalledTimes(2)
    expect(state.columns).toHaveBeenLastCalledWith('acc-1')
  })

  it('403 のときは権限不足表示を出し、空状態に混ぜず権限付与後にその場で読み直せる', async () => {
    state.columns
      .mockRejectedValueOnce(new ApiError(403, 'forbidden'))
      .mockResolvedValueOnce({ success: true, data: [sampleColumn] })

    render(<ColumnIntros />)

    await screen.findByText('表示する権限がありません')
    expect(document.querySelector('[data-list-state="forbidden"]')).not.toBeNull()
    expect(screen.queryByText(/コラムがまだありません/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('春のケア特集')
    expect(state.columns).toHaveBeenCalledTimes(2)
  })

  it('アカウントを切り替えたあとに読み込みが失敗しても、前アカウントのコラムを残さない', async () => {
    state.columns
      .mockResolvedValueOnce({ success: true, data: [sampleColumn] })
      .mockRejectedValueOnce(new ApiError(500, 'server error'))

    const view = render(<ColumnIntros />)
    await screen.findByText('春のケア特集')

    state.accountId = 'acc-2'
    view.rerender(<ColumnIntros />)

    await screen.findByText('コラムの紹介文を読み込めませんでした')
    expect(screen.queryByText('春のケア特集')).toBeNull()
  })

  it('LINEアカウント未選択のときは案内を出し、誤ったエラー再読み込みを出さない', async () => {
    state.accountId = null
    render(<ColumnIntros />)

    await screen.findByText('LINEアカウントを選んでください')
    expect(screen.queryByRole('button', { name: '読み直す' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
  })
})
