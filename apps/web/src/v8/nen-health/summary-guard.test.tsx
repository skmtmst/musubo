// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NenHealthSummaryData } from '@/lib/nen-pets-api'
import SummaryDrawerV8 from './summary'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function makeSummary(overrides?: Partial<NenHealthSummaryData['summary']>, generatedAt = '2026-09-30T09:00:00.000Z'): NenHealthSummaryData {
  return {
    generatedAt,
    pet: {
      id: 'pet-1',
      name: 'こむぎ',
      callName: 'こむぎ',
      animalType: 'dog',
      breed: '柴',
      ageLabel: '4歳',
    },
    owner: { friendId: 'f-1', name: '見本 太郎', customerId: null },
    labels: {
      stool: { normal: '問題なし' },
      appetite: { normal: 'ふつう' },
    },
    summary: {
      days: 30,
      records: 2,
      weight: { first: 5.0, last: 5.5, min: 5.0, max: 5.5 },
      respiratoryRateAvg: 24,
      heartRateAvg: 90,
      stool: { normal: 2 },
      appetite: { normal: 2 },
      skin: {},
      tearStain: {},
      logs: [
        { loggedOn: '2026-09-29', weightKg: 5.0, stool: 'normal', appetite: 'normal', skin: null, tearStain: null, heartRateBpm: 90, respiratoryRateBpm: 24 },
        { loggedOn: '2026-09-30', weightKg: 5.5, stool: 'normal', appetite: 'normal', skin: null, tearStain: null, heartRateBpm: 90, respiratoryRateBpm: 24 },
      ],
      notes: [],
      ...overrides,
    },
  } as unknown as NenHealthSummaryData
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('nen-health/summary の非有限数値・異常日数ガード', () => {
  it('体重や日数が NaN・不正値のときに NaN 表示や壊れた範囲・SVG 座標を出さない', () => {
    const malformed = makeSummary({
      days: Number.NaN,
      weight: { first: Number.NaN, last: 5.5, min: 5.0, max: 5.5 },
      logs: [
        { loggedOn: '2026-09-29', weightKg: Number.NaN, stool: 'normal', appetite: 'normal', skin: null, tearStain: null, heartRateBpm: null, respiratoryRateBpm: null },
        { loggedOn: '2026-09-30', weightKg: 5.5, stool: 'normal', appetite: 'normal', skin: null, tearStain: null, heartRateBpm: null, respiratoryRateBpm: null },
      ],
    })

    act(() => {
      root.render(
        <SummaryDrawerV8
          status="ready"
          summary={malformed}
          onClose={vi.fn()}
          onRetry={vi.fn()}
          onPrint={vi.fn()}
        />,
      )
    })

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('—〜')
    // グラフ SVG に NaN 座標が混ざっていないこと
    const svg = document.body.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.innerHTML).not.toContain('NaN')
  })

  it('正常データでは前どおり増減（+0.5kg（+10%））と期間を表示する', () => {
    act(() => {
      root.render(
        <SummaryDrawerV8
          status="ready"
          summary={makeSummary()}
          onClose={vi.fn()}
          onRetry={vi.fn()}
          onPrint={vi.fn()}
        />,
      )
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('30日で +0.5kg（+10%）')
    expect(text).toContain('09/01〜09/30')
  })
})
