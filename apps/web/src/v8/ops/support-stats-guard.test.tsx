// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpsSupportSummary } from '@/lib/api'
import OpsSupportStats from './support-stats'

afterEach(cleanup)

describe('OpsSupportStats 欠損・不正件数の防御', () => {
  it('summary.byStage が欠損していても落ちずにすべて未取得（—）を表示する', () => {
    const malformed = { byStage: undefined } as unknown as OpsSupportSummary
    const { container } = render(<OpsSupportStats summary={malformed} loading={false} />)
    expect([...container.querySelectorAll('[data-kpi-number]')].map((el) => el.textContent)).toEqual([
      '—',
      '—',
      '—',
      '—',
    ])
  })

  it('負数・NaN・小数の件数はそのまま表示せず未取得（—）にする', () => {
    const summary: OpsSupportSummary = {
      byStage: {
        all: 10,
        new: -1,
        in_progress: Number.NaN,
        waiting: 1.5,
        resolved: 12,
        closed: 0,
      },
      kpis: {
        untouched: 0,
        untouchedFromLine: 0,
        avgFirstReplyMinutes: null,
        prevAvgFirstReplyMinutes: null,
        resolutionRate: null,
        prevResolutionRate: null,
        avgResolutionMinutes: null,
        prevAvgResolutionMinutes: null,
      },
    }
    const { container } = render(<OpsSupportStats summary={summary} loading={false} />)
    expect([...container.querySelectorAll('[data-kpi-number]')].map((el) => el.textContent)).toEqual([
      '—',
      '—',
      '—',
      '12',
    ])
  })
})
