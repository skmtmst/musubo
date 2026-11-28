// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UpdateHistoryV8 from './history'

const history = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { operations: { history } } }))
vi.mock('@/lib/use-running-version', () => ({
  useRunningVersion: () => ({
    detail: { version: '0.26.0', released_at: '2026-10-25T09:00:00Z' },
    statusText: '稼働版を確認',
  }),
}))
vi.mock('@/generated/release-log-summary.json', () => ({
  default: {
    releases: [
      {
        version: '0.26.0',
        released: '2026-10-25 18:00',
        entryCount: 1,
        entries: [{ kind: 'fixed', text: '読み込み失敗時の表示を直した', by: 'kenta', pr: 1, at: '2026-10-25T10:00' }],
      },
    ],
    updates: [],
    pending: { entryCount: 0, counts: { added: 0, changed: 0, fixed: 0 } },
  },
}))

afterEach(() => {
  cleanup()
  history.mockReset()
})

describe('更新履歴の読み込み失敗時表示と再読み込み', () => {
  it('失敗時にKPIを「読み込み中」のままにせず、その場で再読み込みして配備結果を復旧できる', async () => {
    const recentAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    history
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        success: true,
        data: [
          {
            historyKind: 'deployment',
            deployment: {
              deploymentId: 'dep-1',
              phase: 'succeeded',
              environment: 'staging',
              version: '0.26.0',
              pullRequest: null,
              actor: 'github-actions',
              occurredAt: recentAt,
            },
          },
        ],
      })

    render(<UpdateHistoryV8 />)

    await screen.findByText('更新の記録を読み込めませんでした')
    const kpiBand = screen.getByLabelText('更新の集計')
    expect(within(kpiBand).queryByText('読み込み中')).toBeNull()
    expect(within(kpiBand).getByText('読み込めませんでした')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => expect(history).toHaveBeenCalledTimes(2))
    await screen.findByText('成功')
    expect(screen.queryByText('更新の記録を読み込めませんでした')).toBeNull()
    expect(within(kpiBand).getByText('自動 1・手動 0')).toBeTruthy()
  })
})
