import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { classifyEmailFailure, emailKey, emailSourceFromParam, mergeEmailRows, nextEmailPage, sameEmail } from './email-sources'

type Row = { source: 'shared' | 'store'; threadId: string; isUnread: boolean; lastMessageAt: string | null; lastIncomingAt: string }
const row = (source: Row['source'], threadId: string, isUnread: boolean, at: string): Row => ({ source, threadId, isUnread, lastMessageAt: at, lastIncomingAt: at })
const ids = (rows: Row[]) => rows.map(emailKey)

describe('共通と店舗の一覧を混ぜる', () => {
  it('両方の口の並び（未読が先→新しい順）のまま1本にする', () => {
    const shared = [row('shared', 'c1', true, '2026-11-24T03:00:00Z'), row('shared', 'c2', false, '2026-11-24T05:00:00Z')]
    const store = [row('store', 's1', true, '2026-11-24T04:00:00Z'), row('store', 's2', false, '2026-11-24T01:00:00Z')]
    const merged = mergeEmailRows(shared, store, { sharedMore: false, storeMore: false, latest: false })
    expect(ids(merged.rows)).toEqual(['store:s1', 'shared:c1', 'shared:c2', 'store:s2'])
    expect(merged.held).toBe(0)
  })

  it('続きのある経路を読み切ったら、もう一方の後ろの行は続きを読むまで出さない', () => {
    const shared = [row('shared', 'c1', true, '2026-11-24T05:00:00Z'), row('shared', 'c2', false, '2026-11-24T04:00:00Z')]
    const store = [row('store', 's1', false, '2026-11-24T03:00:00Z')]
    const first = mergeEmailRows(shared, store, { sharedMore: true, storeMore: false, latest: false })
    expect(ids(first.rows)).toEqual(['shared:c1', 'shared:c2'])
    expect(first.held).toBe(1)
    const next = mergeEmailRows([...shared, row('shared', 'c3', false, '2026-11-24T02:00:00Z')], store, { sharedMore: false, storeMore: false, latest: false })
    expect(ids(next.rows)).toEqual(['shared:c1', 'shared:c2', 'store:s1', 'shared:c3'])
  })

  it('新しい順は読んだ範囲を時刻だけで並べ、待たせない', () => {
    const shared = [row('shared', 'c1', true, '2026-11-24T01:00:00Z')]
    const store = [row('store', 's1', false, '2026-11-24T02:00:00Z')]
    const merged = mergeEmailRows(shared, store, { sharedMore: true, storeMore: true, latest: true })
    expect(ids(merged.rows)).toEqual(['store:s1', 'shared:c1'])
    expect(merged.held).toBe(0)
  })

  it('同じ会話IDでも経路が違えば別の会話として扱う', () => {
    const a = { source: 'shared' as const, threadId: 'same' }
    const b = { source: 'store' as const, threadId: 'same' }
    expect(sameEmail(a, b)).toBe(false)
    expect(sameEmail(a, { ...a })).toBe(true)
    expect(emailKey(a)).not.toBe(emailKey(b))
    expect(emailSourceFromParam('store')).toBe('store')
    expect(emailSourceFromParam(null)).toBe('shared')
    expect(emailSourceFromParam('other')).toBe('shared')
  })
})

describe('続きの位置と有無', () => {
  it('空のページは終わり。共通の口が末尾を越えて返す総数0で、読んだ件数を消さない', () => {
    expect(nextEmailPage({ offset: 200, received: 0, total: 0, pageSize: 200 })).toEqual({ loaded: 200, hasMore: false })
  })
  it('店舗の口の nextOffset を優先し、null なら終わり', () => {
    expect(nextEmailPage({ offset: 0, received: 200, total: 250, nextOffset: 200, pageSize: 200 })).toEqual({ loaded: 200, hasMore: true })
    expect(nextEmailPage({ offset: 200, received: 50, total: 250, nextOffset: null, pageSize: 200 })).toEqual({ loaded: 250, hasMore: false })
  })
  it('nextOffset の無い共通の口は総数で判断し、総数が無ければページが埋まったかで判断する', () => {
    expect(nextEmailPage({ offset: 0, received: 2, total: 3, pageSize: 200 })).toEqual({ loaded: 2, hasMore: true })
    expect(nextEmailPage({ offset: 2, received: 1, total: 3, pageSize: 200 })).toEqual({ loaded: 3, hasMore: false })
    expect(nextEmailPage({ offset: 0, received: 200, pageSize: 200 })).toEqual({ loaded: 200, hasMore: true })
    expect(nextEmailPage({ offset: 0, received: 20, pageSize: 200 })).toEqual({ loaded: 20, hasMore: false })
  })
})

describe('一覧の失敗の分け方', () => {
  const failure = (status: number) => new ApiError(status, `API ${status}`)
  it('共通の口の403だけは出さない扱い、ほかは失敗として知らせる', () => {
    expect(classifyEmailFailure('shared', failure(403))).toBe('forbidden')
    expect(classifyEmailFailure('shared', failure(503))).toBe('error')
    expect(classifyEmailFailure('shared', new Error('リクエストが時間切れになりました'))).toBe('error')
  })
  it('店舗の口は403でも隠さず失敗として知らせる', () => {
    expect(classifyEmailFailure('store', failure(403))).toBe('error')
    expect(classifyEmailFailure('store', failure(404))).toBe('error')
  })
})
