// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  stats: vi.fn(),
  list: vi.fn(),
  detect: vi.fn(),
  page: 1,
}))

vi.mock('@/components/shared/list-url-state', () => ({
  useListUrlValue: <T,>(key: string, initial: T): [T, (v: T) => void] => {
    if (key === 'page') return [fx.page as unknown as T, vi.fn()]
    return [initial, vi.fn()]
  },
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      duplicates: {
        ...actual.api.duplicates,
        stats: fx.stats,
      },
      identityCandidates: {
        ...actual.api.identityCandidates,
        list: fx.list,
        detectFriendDuplicates: fx.detect,
      },
    },
  }
})

import { formatRelative, useDuplicatesData } from './use-duplicates-data'

function Probe() {
  const d = useDuplicatesData()
  return (
    <div>
      <button type="button" onClick={() => void d.detect()}>再検出</button>
      <span data-testid="candidate-error">{d.candidateError}</span>
      <span data-testid="total-text">{d.duplicateTotalText}</span>
      <span data-testid="detail-text">{d.duplicateDetail}</span>
    </div>
  )
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  fx.page = 1
  fx.stats.mockResolvedValue({ success: true, data: { totalFollowing: 10, uniquePeople: 8, friendDups: 2, duplicateGroups: 1, wastedPerBroadcastYen: 0, msgUnitYen: 0, perAccount: [] } })
  fx.list.mockResolvedValue({ success: true, data: { items: [], total: 0, statusCounts: { pending: 0 }, lowConfidenceCount: 0 } })
})

afterEach(() => {
  cleanup()
})

describe('useDuplicatesData / formatRelative 不正日時・不正応答・二重再検出防御', () => {
  it('formatRelative は不正な日時文字列で NaN を出さず確認不能を返す', () => {
    expect(formatRelative('not-a-date')).toBe('確認できません')
    expect(formatRelative('')).toBe('確認できません')
  })

  it('候補一覧の items 非配列や負の total は読み込み失敗扱いとし、不正ページ番号でも負の offset を送らない', async () => {
    fx.page = 0
    fx.list.mockResolvedValueOnce({ success: true, data: { items: null, total: -1 } })

    render(<Probe />)

    await waitFor(() => {
      expect(screen.getByTestId('candidate-error').textContent).toBe('候補一覧を読み込めませんでした')
    })
    expect(fx.list).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }))
    expect(screen.getByTestId('total-text').textContent).toBe('—')
  })

  it('statusCounts に負数や NaN があるときは内訳を確定表示せず、detect 連打でも二重実行しない', async () => {
    const pendingDetect = deferred<{ success: boolean }>()
    fx.detect.mockReturnValue(pendingDetect.promise)
    fx.list.mockResolvedValueOnce({
      success: true,
      data: { items: [], total: 3, statusCounts: { pending: -2, confirmed: Number.NaN }, lowConfidenceCount: 0 },
    })

    render(<Probe />)

    await waitFor(() => {
      expect(screen.getByTestId('detail-text').textContent).toBe('内訳は読み込めませんでした')
    })

    const btn = screen.getByRole('button', { name: '再検出' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(fx.detect).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingDetect.resolve({ success: true })
      await Promise.resolve()
    })
  })
})
