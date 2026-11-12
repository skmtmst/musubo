// @vitest-environment happy-dom
/*
 * V8 健康日記（src/v8/nen-health）の動きの試験。BEHAVIOR.md を守る。
 * 一覧を取り直し続けない・「…」→30日のまとめ（引き出し・印刷）・閉じた後の遅い返事を出さない・
 * 道具の札で絞る・記録の項目の表、を確かめる。
 */
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NenHealthListData, NenHealthRow, NenHealthSummaryData } from '@/lib/nen-pets-api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, fetchApi }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/nen/health',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

import HealthV8, { type HealthTabKey } from './health'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KOMUGI: NenHealthRow = {
  pet: { id: 'pet-komugi', name: 'こむぎ', callName: 'こむぎちゃん', animalType: 'dog', breed: '柴', ageLabel: '4歳', imageUrl: null },
  owner: { friendId: 'friend-3', name: '見本 169', customerId: '10234' },
  lastLoggedOn: '2026-09-30', lastLoggedLabel: '7日前', daysSinceLast: 7, count30d: 28, totalRecords: 80,
  weightSeries: [9.8, 9.7, 9.6, 9.5, 9.4, 9.3, 9.2, 9.2], latestWeightKg: 9.2, weightChangePercent: -6,
  latestStool: '正常', latestAppetite: '普通', changes: [{ key: 'weight_drop', label: '体重 −6%（8週）', tone: 'warn' }], concerning: true,
}
const CHIBI: NenHealthRow = {
  ...KOMUGI, pet: { ...KOMUGI.pet, id: 'pet-chibi', name: 'ちび', animalType: 'cat', breed: 'スコティッシュ' },
  count30d: 0, weightSeries: [null, null, null, null, null, null, null, null], latestStool: null, latestAppetite: null,
  changes: [{ key: 'silent', label: '30日以上 記録なし', tone: 'faint' }], concerning: false,
}
const LIST: NenHealthListData = {
  items: [KOMUGI, CHIBI], total: 2, page: 1, pageSize: 10,
  kpis: { recordsThisWeek: 38, petsWithRecords: 6, petsTotal: 8, concerning: 2, silent30: 2 },
}
const SUMMARY: NenHealthSummaryData = {
  pet: { id: 'pet-komugi', name: 'こむぎ', callName: 'こむぎちゃん', animalType: 'dog', breed: '柴', ageLabel: '4歳', weightKg: 9.2 },
  owner: { friendId: 'friend-3', name: '見本 169' },
  generatedAt: '2026-09-30T10:00:00+09:00',
  summary: {
    days: 30, records: 28, weight: { first: 9.8, last: 9.2, min: 9.2, max: 9.8 }, heartRateAvg: 96, respiratoryRateAvg: 24,
    stool: { normal: 28 }, appetite: { normal: 28 }, skin: {}, tearStain: {},
    notes: [{ loggedOn: '2026-09-30', note: '散歩を短めにした' }],
    logs: [{ loggedOn: '2026-09-30', weightKg: 9.2, heartRateBpm: 96, respiratoryRateBpm: 24, stool: 'normal', appetite: 'normal', skin: 'normal', tearStain: 'normal' }],
  },
  labels: { stool: { normal: '正常' }, appetite: { normal: '普通' } },
}

let host: HTMLDivElement
let root: Root

async function settle(ms = 30) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
}
async function render(tab: HealthTabKey) {
  await act(async () => { root.render(<HealthV8 accountId="acc-1" tab={tab} onChangeTab={() => {}} />) })
  await settle()
}
const buttons = () => Array.from(document.querySelectorAll('button'))
const byText = (text: string) => buttons().find((b) => b.textContent?.trim() === text)
const byLabel = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)
async function click(target: Element | undefined) {
  expect(target).toBeTruthy()
  await act(async () => { fireEvent.click(target!) })
  await settle()
}
const listCalls = () => fetchApi.mock.calls.filter(([path]) => String(path).startsWith('/api/nen/health?'))

describe('V8 健康日記（src/v8/nen-health）', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'v8'
    fetchApi.mockReset()
    fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/nen/health?')) return { success: true, data: LIST }
      if (path.startsWith('/api/nen/health/pet-komugi/summary')) return { success: true, data: SUMMARY }
      return { success: true, data: {} }
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => { root.unmount() })
    host.remove()
    delete document.documentElement.dataset.theme
  })

  it('一覧は1回だけ取り、数の帯・札・「いつもどおり／記録なし」の言葉を出す', async () => {
    await render('logs')
    await settle(80)
    expect(listCalls()).toHaveLength(1)
    expect(String(listCalls()[0][0])).toContain('pageSize=20')
    expect(host.textContent).toContain('記録のあるペット 6')
    expect(host.textContent).toContain('気になる変化 2')
    expect(host.textContent).toContain('体重が減った')
    expect(host.textContent).toContain('記録なし')
    expect(host.textContent).toContain('28 日')
    expect(host.textContent).toContain('9/30')
  })

  it('「…」→30日のまとめ：引き出しに記録を並べ、印刷・PDF に保存できる', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    await render('logs')
    expect(byText('獣医師向け PDF を書き出す')?.disabled).toBe(true)
    await click(byLabel('「こむぎ」の操作'))
    await click(byText('30日のまとめ'))
    expect(document.body.textContent).toContain('健康日記 30日のまとめ')
    const weightNumber = Array.from(document.querySelectorAll('[data-detail-field]')).find(el => el.querySelector('[data-detail-label]')?.textContent === '体重')
    expect(weightNumber).toBeTruthy()
    expect(weightNumber?.querySelector('[data-detail-value]')?.textContent).toBe('9.8 → 9.2 kg')
    expect(document.body.textContent).toContain('30日で −0.6kg（−6%）')
    expect(document.body.textContent).toContain('散歩を短めにした')
    expect(byText('獣医師向け PDF を書き出す')?.disabled).toBe(false)
    await click(byText('印刷・PDF に保存する'))
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('まとめを閉じた後に遅れて届いた返事は出さない', async () => {
    let resolveSummary: (value: unknown) => void = () => {}
    fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/nen/health?')) return { success: true, data: LIST }
      if (path.includes('/summary')) return new Promise((resolve) => { resolveSummary = resolve })
      return { success: true, data: {} }
    })
    await render('logs')
    await click(byLabel('「こむぎ」の操作'))
    await click(byText('30日のまとめ'))
    await click(byLabel('閉じる'))
    await act(async () => { resolveSummary({ success: true, data: SUMMARY }) })
    await settle()
    expect(Array.from(document.querySelectorAll('[data-detail-value]')).some(el => el.textContent === '9.8 → 9.2 kg')).toBe(false)
    expect(byText('獣医師向け PDF を書き出す')?.disabled).toBe(true)
  })

  it('道具の札から、気になる変化だけに絞って取り直す', async () => {
    await render('logs')
    await click(buttons().find((button) => button.hasAttribute('aria-pressed') && /^気になる変化 \d+$/.test(button.textContent?.trim() ?? '')))
    expect(String(listCalls().at(-1)?.[0])).toContain('change=concern')
  })

  it('WEB224：行の「獣医師向け PDF」は、紙の面が置かれてから印刷の窓を開く', async () => {
    let sheetAtPrint: boolean | null = null
    vi.spyOn(window, 'print').mockImplementation(() => { sheetAtPrint = document.querySelector('[data-print-sheet]') !== null })
    await render('logs')
    await click(byLabel('「こむぎ」の操作'))
    await click(byText('獣医師向け PDF'))
    await settle(120)
    expect(sheetAtPrint).toBe(true)
  })

  it('WEB223：絞り込みを外すと、探す欄の言葉も消える（0.3秒後に前の言葉で絞り直さない）', async () => {
    await render('logs')
    const box = host.querySelector('input[type="search"], input[aria-label*="探す"]') as HTMLInputElement
    expect(box).toBeTruthy()
    await act(async () => { fireEvent.change(box, { target: { value: 'こむぎ' } }) })
    await settle(400)
    expect(String(listCalls().at(-1)?.[0])).toContain('q=')
    await click(byText('よく使う絞り込み'))
    await click(byText('絞り込みを外す'))
    await settle(400)
    expect(box.value).toBe('')
    expect(String(listCalls().at(-1)?.[0])).not.toContain('q=%E3')
  })

  it('記録の項目は、変えられない決まりの表を出す', async () => {
    await render('items')
    expect(host.textContent).toContain('「気になる変化」に出る条件')
    expect(host.textContent).toContain('直近8週の週平均で、最初と最後の週を比べて ±10% 以上')
    expect(host.textContent).toContain('項目と条件は決まっていて、ここでは変えられません')
  })
})
