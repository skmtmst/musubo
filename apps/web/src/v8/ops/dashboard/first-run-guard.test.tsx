// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  readOnly: false,
  firstRun: vi.fn(),
}))

vi.mock('../use-ops-read-only', () => ({
  useOpsReadOnly: () => fx.readOnly,
}))

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ops: { ...actual.api.ops, firstRun: fx.firstRun },
    },
  }
})

import OpsFirstRunCard from './first-run'

describe('OpsFirstRunCard 異常数値防御と不正応答フェイルクローズ', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.readOnly = false
  })

  afterEach(() => {
    cleanup()
  })

  it('割合・分数・件数に NaN や負数が混ざっても NaN% や負数単位を出さず「—」として表示する', async () => {
    fx.firstRun.mockResolvedValue({
      success: true,
      data: {
        periodLabel: '直近7日',
        accounts: -3,
        withinTenMinutesPercent: Number.NaN,
        minutesToFirstMessage: { median: -5, p75: Number.NaN, reached: -1 },
        allStepsDone: { count: 1, percent: Number.POSITIVE_INFINITY },
        biggestDrop: { key: 'style', fromPrevious: Number.NaN, lost: -2 },
        stages: [
          { key: 'started', count: 10, percent: Number.NaN, fromPrevious: null, minutesFromPrevious: null },
          { key: 'style', count: 5, percent: 50, fromPrevious: -10, minutesFromPrevious: Number.NaN },
        ],
      },
    })

    const { container } = render(<OpsFirstRunCard period="7d" />)
    expect(await screen.findByText(/いちばん落ちている段/)).toBeTruthy()
    expect(container.textContent).not.toContain('NaN')
    expect(container.textContent).not.toContain('Infinity')
    expect(container.textContent).not.toContain('-5 分')
    expect(container.textContent).not.toContain('-3 件')
    expect(container.textContent).not.toContain('-10%')
    expect(container.textContent).not.toContain('— 分')
    expect(container.textContent).not.toContain('— 件')
  })

  it('stages の件数が NaN や配列欠損の不正応答を 0 件に丸めずエラー表示（再読み込み付き）にする', async () => {
    fx.firstRun.mockResolvedValueOnce({
      success: true,
      data: {
        periodLabel: '直近7日',
        accounts: 10,
        withinTenMinutesPercent: 50,
        minutesToFirstMessage: { median: 5, p75: 10, reached: 5 },
        allStepsDone: { count: 2, percent: 20 },
        biggestDrop: null,
        stages: [
          { key: 'started', count: Number.NaN, percent: 100, fromPrevious: null, minutesFromPrevious: null },
        ],
      },
    })

    render(<OpsFirstRunCard period="7d" />)
    expect(await screen.findByText('最初の10分を読み込めませんでした')).toBeTruthy()
    expect(screen.getByRole('button', { name: /もう一度読み込む/ })).toBeTruthy()
  })
})
