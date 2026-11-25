// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadApiFile, fetchApiBlob } from './download'
import { clearApiReadCache } from './read-cache'
import {
  clearReportedServerFailures,
  fetchApi,
  MAX_RECENT_SERVER_FAILURES,
  RECENT_SERVER_FAILURE_MS,
  reportedServerFailureCount,
} from './request'

const originalFetch = globalThis.fetch
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function flushReports(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.localStorage.setItem('lh_csrf', 'csrf-test')
  window.history.replaceState(null, '', '/events')
  clearApiReadCache()
  clearReportedServerFailures()
  URL.createObjectURL = vi.fn(() => 'blob:mock-download')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearApiReadCache()
  clearReportedServerFailures()
  window.localStorage.clear()
  window.sessionStorage.clear()
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

describe('5xx自動エラー報告の識別・再送・寿命管理', () => {
  it('同じURLでもHTTPメソッド・エラーコード・発生画面が異なれば各々報告し、GET成功でPOST失敗の抑止を解除しない', async () => {
    const reports: Array<{ message: string; path: string }> = []
    let getStatus = 500
    let postCode = 'SAVE_CONFLICT_DB'

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.pathname === '/api/client-errors') {
        reports.push(JSON.parse(String(init?.body ?? '{}')) as { message: string; path: string })
        return jsonResponse({ success: true })
      }
      if (url.pathname === '/api/items' && method === 'GET') {
        if (getStatus >= 500) return jsonResponse({ success: false, code: 'READ_TIMEOUT', error: 'timeout' }, getStatus)
        return jsonResponse({ success: true, data: [] })
      }
      if (url.pathname === '/api/items' && method === 'POST') {
        return jsonResponse({ success: false, code: postCode, error: 'write failed' }, 500)
      }
      return jsonResponse({ success: true })
    }) as typeof fetch

    await expect(fetchApi('/api/items?account_id=acc-1')).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reports).toHaveLength(1)

    // 同じGET + 同じcodeの再発は抑止される
    await expect(fetchApi('/api/items?account_id=acc-1', { cache: 'no-store' })).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reports).toHaveLength(1)

    // 同じURLでもPOST失敗は別件として報告される
    await expect(fetchApi('/api/items?account_id=acc-1', { method: 'POST', body: JSON.stringify({ name: 'a' }) }))
      .rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reports).toHaveLength(2)

    // GETが200で回復しても、POST失敗の抑止は解除されない
    getStatus = 200
    await fetchApi('/api/items?account_id=acc-1', { cache: 'no-store' })
    await expect(fetchApi('/api/items?account_id=acc-1', { method: 'POST', body: JSON.stringify({ name: 'a' }) }))
      .rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reports).toHaveLength(2)

    // 同じPOSTでもエラーコードが変われば別障害として報告される
    postCode = 'STORAGE_UNAVAILABLE'
    await expect(fetchApi('/api/items?account_id=acc-1', { method: 'POST', body: JSON.stringify({ name: 'a' }) }))
      .rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reports).toHaveLength(3)

    // 別画面で同じ失敗が起きた場合もその画面の障害として報告される
    window.history.replaceState(null, '', '/friends')
    await expect(fetchApi('/api/items?account_id=acc-1', { method: 'POST', body: JSON.stringify({ name: 'a' }) }))
      .rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reports).toHaveLength(4)
    expect(reports[3]?.path).toContain('/friends')
  })

  it('fetchApiBlobとdownloadApiFileでも店舗単位で5xx報告と回復解除を分離する', async () => {
    let reportCalls = 0
    const storeShouldFail = new Map<string, boolean>([
      ['store-a', true],
      ['store-b', true],
    ])

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      if (url.pathname === '/api/client-errors') {
        reportCalls += 1
        return jsonResponse({ success: true })
      }
      if (url.pathname === '/api/mileage/exports') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { accountId?: string }
        const store = body.accountId ?? 'store-a'
        if (storeShouldFail.get(store)) {
          return jsonResponse({ success: false, code: 'EXPORT_FAILED', error: 'export failed' }, 500)
        }
        return new Response('id,points\n1,10\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })
      }
      if (url.pathname === '/api/friends/exports/job-shared/download') {
        const currentStore = window.localStorage.getItem('lh_selected_account') ?? 'store-a'
        if (storeShouldFail.get(currentStore)) {
          return jsonResponse({ success: false, code: 'CSV_STREAM_ERROR', error: 'stream failed' }, 500)
        }
        return new Response('id,name\n1,Alice\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })
      }
      return jsonResponse({ success: true })
    }) as typeof fetch

    // fetchApiBlob: URLにaccountIdが無い共通パスでも init.accountId で店舗ごとに報告される
    await expect(
      fetchApiBlob('/api/mileage/exports', { method: 'POST', accountId: 'store-a', body: JSON.stringify({ accountId: 'store-a' }) }),
    ).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(1)

    await expect(
      fetchApiBlob('/api/mileage/exports', { method: 'POST', accountId: 'store-b', body: JSON.stringify({ accountId: 'store-b' }) }),
    ).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(2)

    // store-b だけ成功しても store-a の抑止は消えず、store-b の再発は再報告される
    storeShouldFail.set('store-b', false)
    await fetchApiBlob('/api/mileage/exports', { method: 'POST', accountId: 'store-b', body: JSON.stringify({ accountId: 'store-b' }) })
    await expect(
      fetchApiBlob('/api/mileage/exports', { method: 'POST', accountId: 'store-a', body: JSON.stringify({ accountId: 'store-a' }) }),
    ).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(2)

    storeShouldFail.set('store-b', true)
    await expect(
      fetchApiBlob('/api/mileage/exports', { method: 'POST', accountId: 'store-b', body: JSON.stringify({ accountId: 'store-b' }) }),
    ).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(3)

    // downloadApiFile: URLにaccountIdが無い共通パスでも選択店舗が異なれば各々報告され、回復後は再発で再送する
    window.localStorage.setItem('lh_selected_account', 'store-a')
    await expect(downloadApiFile('/api/friends/exports/job-shared/download', 'friends.csv')).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(4)

    window.localStorage.setItem('lh_selected_account', 'store-b')
    await expect(downloadApiFile('/api/friends/exports/job-shared/download', 'friends.csv')).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(5)

    storeShouldFail.set('store-b', false)
    await downloadApiFile('/api/friends/exports/job-shared/download', 'friends.csv')
    storeShouldFail.set('store-b', true)
    await expect(downloadApiFile('/api/friends/exports/job-shared/download', 'friends.csv')).rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportCalls).toBe(6)
  })

  it('報告送信中は重複送信を防ぎ、報告自体が通信失敗または非2xxなら抑止記録を残さず次回再送する', async () => {
    let reportAttempts = 0
    let reportMode: 'pending' | 'network-error' | 'http-503' | 'ok' = 'pending'
    let resolvePendingReport!: (res: Response) => void

    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      if (url.pathname === '/api/client-errors') {
        reportAttempts += 1
        if (reportMode === 'pending') {
          return new Promise<Response>(resolve => { resolvePendingReport = resolve })
        }
        if (reportMode === 'network-error') {
          return Promise.reject(new TypeError('Failed to fetch'))
        }
        if (reportMode === 'http-503') {
          return Promise.resolve(jsonResponse({ success: false }, 503))
        }
        return Promise.resolve(jsonResponse({ success: true }, 200))
      }
      return Promise.resolve(jsonResponse({ success: false, code: 'UPSTREAM_DOWN', error: 'down' }, 502))
    }) as typeof fetch

    // 送信中に同じ502が重なっても送信中の便は1回だけ
    await expect(fetchApi('/api/tags?account_id=acc-1', { cache: 'no-store' })).rejects.toMatchObject({ status: 502 })
    await expect(fetchApi('/api/tags?account_id=acc-1', { cache: 'no-store' })).rejects.toMatchObject({ status: 502 })
    expect(reportAttempts).toBe(1)

    // 送信中の便が503で失敗したら記録を消し、次の発生で再送する
    resolvePendingReport(jsonResponse({ success: false }, 503))
    await flushReports()
    expect(reportedServerFailureCount()).toBe(0)

    reportMode = 'network-error'
    await expect(fetchApi('/api/tags?account_id=acc-1', { cache: 'no-store' })).rejects.toMatchObject({ status: 502 })
    await flushReports()
    expect(reportAttempts).toBe(2)
    expect(reportedServerFailureCount()).toBe(0)

    // 送信が200で通った後は60秒間抑止される
    reportMode = 'ok'
    await expect(fetchApi('/api/tags?account_id=acc-1', { cache: 'no-store' })).rejects.toMatchObject({ status: 502 })
    await flushReports()
    expect(reportAttempts).toBe(3)
    expect(reportedServerFailureCount()).toBe(1)

    await expect(fetchApi('/api/tags?account_id=acc-1', { cache: 'no-store' })).rejects.toMatchObject({ status: 502 })
    await flushReports()
    expect(reportAttempts).toBe(3)
  })

  it('クエリ違いの大量失敗でも件数上限を超えず、60秒経過後は通常応答でも期限切れ記録を掃除する', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    let reportAttempts = 0

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://127.0.0.1:8788')
      if (url.pathname === '/api/client-errors') {
        reportAttempts += 1
        return jsonResponse({ success: true })
      }
      if (url.pathname === '/api/ok') {
        return jsonResponse({ success: true, data: {} })
      }
      return jsonResponse({ success: false, code: 'QUERY_FAIL', error: 'failed' }, 500)
    }) as typeof fetch

    for (let i = 0; i < MAX_RECENT_SERVER_FAILURES + 25; i += 1) {
      await expect(fetchApi(`/api/search?account_id=acc-1&q=item-${i}`, { cache: 'no-store' }))
        .rejects.toMatchObject({ status: 500 })
      await flushReports()
    }
    expect(reportAttempts).toBe(MAX_RECENT_SERVER_FAILURES + 25)
    expect(reportedServerFailureCount()).toBe(MAX_RECENT_SERVER_FAILURES)

    // 直近のクエリは抑止され、押し出された最古のクエリは再報告される
    const latestIndex = MAX_RECENT_SERVER_FAILURES + 24
    await expect(fetchApi(`/api/search?account_id=acc-1&q=item-${latestIndex}`, { cache: 'no-store' }))
      .rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportAttempts).toBe(MAX_RECENT_SERVER_FAILURES + 25)

    await expect(fetchApi('/api/search?account_id=acc-1&q=item-0', { cache: 'no-store' }))
      .rejects.toMatchObject({ status: 500 })
    await flushReports()
    expect(reportAttempts).toBe(MAX_RECENT_SERVER_FAILURES + 26)
    expect(reportedServerFailureCount()).toBe(MAX_RECENT_SERVER_FAILURES)

    // 60秒経過後は通常の200応答でも期限切れエントリが一掃される
    vi.advanceTimersByTime(RECENT_SERVER_FAILURE_MS)
    await fetchApi('/api/ok?account_id=acc-1', { cache: 'no-store' })
    expect(reportedServerFailureCount()).toBe(0)
  })
})
