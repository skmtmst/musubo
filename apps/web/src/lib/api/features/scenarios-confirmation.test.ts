import { afterEach, beforeAll, expect, it, vi } from 'vitest'

let api: typeof import('../index').api
beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_URL = 'https://worker.example.com'
  ;({ api } = await import('../index'))
})
afterEach(() => vi.unstubAllGlobals())

it('削除時は停止中・完了済みも含む集計を送る', async () => {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchSpy)
  await api.scenarios.delete('sc-1', { contentRevision: 2, activeCount: 1, rowIdSum: 2, rowIdSquareSum: 4, totalCount: 4, totalRowIdSum: 10, totalRowIdSquareSum: 30, referrers: [] })
  const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(String(init.body))).toEqual({ expectedContentRevision: 2, expectedSubscriptions: { activeCount: 4, rowIdSum: 10, rowIdSquareSum: 30 }, expectedActiveSubscriptions: { activeCount: 1, rowIdSum: 2, rowIdSquareSum: 4 }, expectedReferrers: [] })
})
