// @vitest-environment happy-dom
/*
 * 保存した分析の定期レポートを StrictMode の下で読み直す（WEB132 と同じ形の取り残し）。
 *
 * 開発時の StrictMode は Effect を「付ける→外す→付ける」と1回多く回す。
 * 「生きている」印を外すときだけ false にすると、付いているのに false が残り、
 * 「もう一度確認」で読み直した結果を捨てて「確認中」のまま止まる。
 */
import React, { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const scheduleList = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      analytics: {
        ...actual.api.analytics,
        saved: { ...actual.api.analytics.saved, list: async () => ({ success: true, data: [] }) },
        reportSchedules: { ...actual.api.analytics.reportSchedules, list: scheduleList },
      },
    },
  }
})

import SavedV8 from './saved'

afterEach(() => { cleanup(); scheduleList.mockReset() })

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

it('定期レポートの取得中は内訳を0と表示せず、取得後は実数を表示する', async () => {
  let resolve!: (value: unknown) => void
  scheduleList.mockReturnValue(new Promise((done) => { resolve = done }))
  render(<SavedV8 accountId="acc-1" canManage />)
  expect(document.body.textContent).not.toContain('動いている 0')
  await act(async () => { resolve({ success: true, data: { items: [], recentOneTime: [] } }) })
  await flush()
  expect(document.body.textContent).toContain('動いている 0')
})

it('StrictMode の下でも「もう一度確認」の結果を出し、「確認中」を解く', async () => {
  document.documentElement.dataset.theme = 'v8'
  scheduleList
    .mockRejectedValueOnce(new Error('定期レポートを確認できませんでした'))
    .mockRejectedValueOnce(new Error('定期レポートを確認できませんでした'))
    .mockResolvedValue({
      success: true,
      data: {
        items: [{
          id: 'sch-1', name: '週の成果', status: 'active', savedAnalysisIds: [], cadence: 'weekly',
          nextRunAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
        }],
        recentOneTime: [],
      },
    })
  render(<StrictMode><SavedV8 accountId="acc-1" canManage /></StrictMode>)
  await flush()
  expect(screen.getByRole('alert').textContent).toContain('定期レポートを確認できませんでした')

  await act(async () => { screen.getByRole('button', { name: 'もう一度確認' }).click() })
  await flush()
  expect(document.body.textContent).not.toContain('確認中')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.body.textContent).toContain('週の成果')
})
