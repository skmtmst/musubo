// @vitest-environment happy-dom
/*
 * 運用状態の履歴詳細モーダル（止めた・戻した記録 / 管理画面の更新内容）の読み込み状態・失敗表示と再試行。
 * - 取得に失敗したとき、再読み込みボタンが二重に出ない（1つだけ）
 * - 失敗時・読み込み中に2枚のKPIカードが「読み込めませんでした」／読み込み中表示になる
 * - 再読み込み連打で二重通信にならず、成功で記録一覧と件数へ戻る
 * - 更新内容モーダルでも取得失敗時に未反映件数などの誤表示を出さない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  history: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      operations: {
        ...actual.api.operations,
        history: (...args: unknown[]) => apiMocks.history(...args),
      },
    },
  }
})

import HistoryDetails from './history-details'

const INCIDENT_ENTRY = {
  id: 'op-1',
  historyKind: 'incident',
  createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  stoppedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  resolvedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  actorId: 'owner@example.com',
  capabilities: ['broadcast'],
  lineAccountId: null,
  reason: '配信設定の確認のため一時停止',
  status: 'resolved',
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('運用状態の履歴詳細モーダルの読み込み・失敗と再試行', () => {
  it('取得失敗時は再読み込みボタンが1つだけで、2枚のKPIに「読み込めませんでした」を出し、連打を抑えて復旧できる', async () => {
    let resolveRetry!: (value: unknown) => void
    apiMocks.history
      .mockRejectedValueOnce(new Error('history failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<HistoryDetails panel="incidents" onClose={() => {}} />)

    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('運用履歴を読み込めませんでした')

    const retryButtons = within(dialog).getAllByRole('button', { name: 'もう一度読み込む' })
    expect(retryButtons).toHaveLength(1)

    const kpiCards = [...dialog.querySelectorAll('[data-kpi-strip] > [data-design-version]')]
    expect(kpiCards).toHaveLength(2)
    for (const card of kpiCards) {
      expect(card.textContent).toContain('読み込めませんでした')
    }

    fireEvent.click(retryButtons[0])
    fireEvent.click(retryButtons[0])
    await waitFor(() => expect(apiMocks.history).toHaveBeenCalledTimes(2))

    resolveRetry({ success: true, data: [INCIDENT_ENTRY] })
    await within(dialog).findByText('配信設定の確認のため一時停止')
    expect(within(dialog).queryByText('運用履歴を読み込めませんでした')).toBeNull()
    expect(apiMocks.history).toHaveBeenCalledTimes(2)
  })

  it('読み込み中は2枚のKPIが読み込み中表示になる', async () => {
    apiMocks.history.mockImplementation(() => new Promise(() => {}))

    render(<HistoryDetails panel="incidents" onClose={() => {}} />)

    const dialog = await screen.findByRole('dialog')
    const kpiCards = [...dialog.querySelectorAll('[data-kpi-strip] > [data-design-version]')]
    expect(kpiCards).toHaveLength(2)
    for (const card of kpiCards) {
      expect(card.textContent).toContain('読み込んでいます')
      expect(card.getAttribute('aria-busy')).toBe('true')
    }
  })

  it('更新内容モーダルの失敗時は再読み込みボタンが1つだけで、不完全な更新一覧を出さない', async () => {
    apiMocks.history.mockResolvedValueOnce({ success: false, error: 'unavailable' })

    render(<HistoryDetails panel="updates" onClose={() => {}} />)

    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('運用履歴を読み込めませんでした')
    expect(within(dialog).getAllByRole('button', { name: 'もう一度読み込む' })).toHaveLength(1)
    expect(within(dialog).queryByLabelText('管理画面の更新内容の一覧')).toBeNull()
    expect(dialog.textContent).not.toContain('まだ画面に入っていない変更が')
    expect(dialog.textContent).not.toContain('続きが')
  })
})
