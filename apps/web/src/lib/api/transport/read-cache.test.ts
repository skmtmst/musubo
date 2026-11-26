// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from './request'
import { clearApiReadCache } from './read-cache'
import { clearAdminSession, storeAdminSession } from '../../admin-session'
import { clearCommonCaches } from '../../common-caches'
import { beginFeatureDisabledContext } from '../../feature-disabled-context'
import { FEATURE_DISABLED_EVENT } from './session'
import { api } from '../../api'
import { LIST_REQUEST_TIMEOUT_MS } from '../../request-timeout'

const ok = (data: unknown = { value: 1 }) => new Response(JSON.stringify({ success: true, data }))
const net = vi.fn(async () => ok())
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  clearAdminSession()
  localStorage.setItem('lh_csrf', 'login-a')
  net.mockReset().mockImplementation(async () => ok())
  vi.stubGlobal('fetch', net)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('検索条件のキー順序をそろえ、同じ GET の通信は1回・返す値は独立させる', async () => {
  const a = fetchApi<{ data: { value: number } }>('/api/friends?b=2&a=1')
  const b = fetchApi<{ data: { value: number } }>('/api/friends?a=1&b=2', { method: 'GET' })
  const [first, second] = await Promise.all([a, b])
  expect(net).toHaveBeenCalledTimes(1)
  first.data.value = 99
  expect(second.data.value).toBe(1)
  await fetchApi('/api/friends?a=1&b=2')
  expect(net).toHaveBeenCalledTimes(2)
})

it.each([
  '/api/line-accounts', '/api/staff/me', '/api/tenants/me', '/api/settings/features?account_id=a',
  '/api/settings/features/visibility?account_id=a', '/api/dashboard/style?account_id=a', '/api/hq/billing/summary',
])('%s は30秒だけ再利用し、期限が切れたら通信する', async path => {
  let now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  await fetchApi(path)
  now += 29_999
  await fetchApi(path)
  expect(net).toHaveBeenCalledTimes(1)
  now += 1
  await fetchApi(path)
  expect(net).toHaveBeenCalledTimes(2)
})

it('検索の値・明示した対象・ヘッダが違えば共有しない', async () => {
  await Promise.all([
    fetchApi('/api/friends?q=a'), fetchApi('/api/friends?q=b'),
    fetchApi('/api/friends?q=a', { accountId: 'other' }),
    fetchApi('/api/friends?q=a', { headers: { 'X-Line-Account-Id': 'third' } }),
  ])
  expect(net).toHaveBeenCalledTimes(4)
})

it('画面が変わっても同じ対象の成功は再利用し、失敗の合図は各呼出元へ返す', async () => {
  beginFeatureDisabledContext('/friends')
  await fetchApi('/api/dashboard/style?account_id=a')
  beginFeatureDisabledContext('/broadcasts')
  await fetchApi('/api/dashboard/style?account_id=a')
  expect(net).toHaveBeenCalledTimes(1)
  const events: unknown[] = []
  const observe = (event: Event) => events.push((event as CustomEvent).detail)
  window.addEventListener(FEATURE_DISABLED_EVENT, observe)
  try {
    let finish!: (response: Response) => void
    net.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const firstContext = beginFeatureDisabledContext('/friends')
    const first = fetchApi('/api/tags?account_id=a')
    const secondContext = beginFeatureDisabledContext('/broadcasts')
    const second = fetchApi('/api/tags?account_id=a')
    const suppressed = fetchApi('/api/tags?account_id=a', { suppressFeatureDisabledEvent: true })
    finish(new Response('{"code":"FEATURE_DISABLED","featureId":"tags"}', { status: 403 }))
    await Promise.allSettled([first, second, suppressed])
    expect(net).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      { accountId: 'a', featureId: 'tags', featureContext: firstContext },
      { accountId: 'a', featureId: 'tags', featureContext: secondContext },
    ])
  } finally { window.removeEventListener(FEATURE_DISABLED_EVENT, observe) }
})

it('認証の世代を識別できない間は、結果も取得中の要求も共有しない', async () => {
  localStorage.clear()
  await Promise.all([fetchApi('/api/line-accounts'), fetchApi('/api/line-accounts')])
  expect(net).toHaveBeenCalledTimes(2)
})

it.each(['account', 'csrf', 'bearer', 'logout', 'login', 'invalidate'] as const)('%s の切替では全結果を破棄する', async kind => {
  localStorage.setItem('lh_selected_account', 'a')
  await fetchApi('/api/line-accounts')
  if (kind === 'account') localStorage.setItem('lh_selected_account', 'b')
  if (kind === 'csrf') localStorage.setItem('lh_csrf', 'login-b')
  if (kind === 'bearer') sessionStorage.setItem('lh_admin_session_fallback', 'login-b')
  if (kind === 'logout') clearAdminSession()
  if (kind === 'login') storeAdminSession('login-b', 'login-a')
  if (kind === 'invalidate') clearCommonCaches()
  await fetchApi('/api/line-accounts')
  expect(net).toHaveBeenCalledTimes(2)
  if (kind === 'account') {
    localStorage.setItem('lh_selected_account', 'a')
    await fetchApi('/api/line-accounts')
    expect(net).toHaveBeenCalledTimes(3)
  }
})

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s は毎回送信し、成功後の読取は古い結果を使わない', async method => {
  await fetchApi('/api/line-accounts')
  await fetchApi('/api/line-accounts/a', { method })
  await fetchApi('/api/line-accounts/a', { method })
  await fetchApi('/api/line-accounts')
  expect(net).toHaveBeenCalledTimes(4)
})

it('成功しなかった更新では成功済みの読みを破棄せず、204の成功では破棄する', async () => {
  await fetchApi('/api/line-accounts')
  net.mockResolvedValueOnce(new Response('{"success":false}'))
  await fetchApi('/api/line-accounts/a', { method: 'PATCH' })
  await fetchApi('/api/line-accounts')
  expect(net).toHaveBeenCalledTimes(2)
  net.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await fetchApi('/api/line-accounts/a', { method: 'DELETE' })
  await fetchApi('/api/line-accounts')
  expect(net).toHaveBeenCalledTimes(4)
})

it.each(['cache', 'network', 'http', 'application', 'shape', 'empty'] as const)('%s の失敗・破棄を次の読取へ残さない', async kind => {
  if (kind === 'network') net.mockRejectedValueOnce(new TypeError('offline'))
  if (kind === 'http') net.mockResolvedValueOnce(new Response('{"error":"denied"}', { status: 403 }))
  if (kind === 'application') net.mockResolvedValueOnce(new Response('{"success":false}'))
  if (kind === 'shape') net.mockResolvedValueOnce(new Response('{"success":true}'))
  if (kind === 'empty') net.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await fetchApi('/api/line-accounts').catch(() => undefined)
  if (kind === 'cache') clearApiReadCache()
  await fetchApi('/api/line-accounts')
  expect(net).toHaveBeenCalledTimes(2)
})

it.each(['mutation', 'switch', 'reload'] as const)('%s 前に始めた遅い応答は、新しい答えを再登録しない', async kind => {
  let finish!: (response: Response) => void
  net.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
  const old = fetchApi('/api/line-accounts')
  if (kind === 'mutation') await fetchApi('/api/line-accounts/a', { method: 'PATCH' })
  if (kind === 'switch') localStorage.setItem('lh_selected_account', 'b')
  net.mockResolvedValueOnce(ok({ value: 2 }))
  const fresh = await fetchApi('/api/line-accounts', kind === 'reload' ? { cache: 'reload' } : undefined)
  expect(fresh).toEqual({ success: true, data: { value: 2 } })
  finish(ok({ value: 99 }))
  await old
  expect(await fetchApi('/api/line-accounts')).toEqual(fresh)
  expect(net).toHaveBeenCalledTimes(kind === 'mutation' ? 3 : 2)
})

it('読み直しと no-store は取得中にも相乗りせず、失敗後に前の成功へ戻らない', async () => {
  await fetchApi('/api/line-accounts')
  net.mockResolvedValueOnce(new Response('{"error":"denied"}', { status: 403 }))
  await expect(fetchApi('/api/line-accounts', { cache: 'reload' })).rejects.toThrow()
  await fetchApi('/api/line-accounts', { cache: 'no-store' })
  await fetchApi('/api/line-accounts')
  expect(net).toHaveBeenCalledTimes(4)
})

it('個別に中止できる要求は相乗りさせず、他の要求の中止へ巻き込まない', async () => {
  await Promise.all([fetchApi('/api/friends', { signal: new AbortController().signal }), fetchApi('/api/friends')])
  expect(net).toHaveBeenCalledTimes(2)
})

it('アカウントの接続を実確認するときは、進行中の確認とも共有しない', async () => {
  let finish!: (response: Response) => void
  net.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
  const first = api.lineAccounts.list(true)
  const second = api.lineAccounts.list(true)
  expect(net).toHaveBeenCalledTimes(2)
  finish(ok([]))
  await Promise.all([first, second])
})

it.each(['retry-first', 'late-first'])('時間切れの便を再試行へ回さず、後着の成功も再登録しない（%s）', async order => {
  let now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  let finish!: (response: Response) => void
  net.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    .mockResolvedValueOnce(ok({ value: 2 }))
  const old = fetchApi('/api/line-accounts')
  now += LIST_REQUEST_TIMEOUT_MS
  if (order === 'late-first') { finish(ok({ value: 99 })); await old }
  const fresh = await fetchApi('/api/line-accounts')
  expect(fresh).toEqual({ success: true, data: { value: 2 } })
  if (order === 'retry-first') { finish(ok({ value: 99 })); await old }
  expect(await fetchApi('/api/line-accounts')).toEqual(fresh)
  expect(net).toHaveBeenCalledTimes(2)
})

it.each(['create', 'rename', 'favorite', 'archive', 'duplicate', 'removeImage'] as const)('バナーの%s後は古い通信に相乗りせず一覧と件数を取り直す', async action => {
  let revision = 0
  const releaseOld: Array<(response: Response) => void> = []
  net.mockImplementation(async (_input, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') { revision++; return ok({ revision }) }
    if (revision === 0) return new Promise<Response>(resolve => { releaseOld.push(resolve) })
    return ok({ revision })
  })
  const oldList = api.hqBanners.projects.list()
  const oldStats = api.hqBanners.stats()
  switch (action) {
    case 'create': await api.hqBanners.projects.create({ name: '見本' }); break
    case 'rename': await api.hqBanners.projects.update('p1', { name: '変更後' }); break
    case 'favorite': await api.hqBanners.projects.update('p1', { isFavorite: true }); break
    case 'archive': await api.hqBanners.projects.update('p1', { archived: true }); break
    case 'duplicate': await api.hqBanners.projects.duplicate('p1'); break
    case 'removeImage': await api.hqBanners.images.remove('i1'); break
  }
  const freshList = api.hqBanners.projects.list()
  const freshStats = api.hqBanners.stats()
  releaseOld.forEach(resolve => resolve(ok({ revision: 0 })))
  await Promise.all([oldList, oldStats])
  expect((await freshList).data).toEqual({ revision: 1 })
  expect((await freshStats).data).toEqual({ revision: 1 })
})
