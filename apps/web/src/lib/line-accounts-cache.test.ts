// @vitest-environment happy-dom
/*
 * 画面を移るたびに取り直していた /api/line-accounts を、タブ内で使い回す。
 * AuthGuard の確認と並べて先に取り始め、載せる側（AccountProvider）が相乗りする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'



const list = vi.hoisted(() => vi.fn())


import { clearLineAccountsCache, loadLineAccounts, prefetchLineAccounts } from './line-accounts-cache'

const ok = { success: true as const, data: [{ id: 'acc-1' }] }

describe('アカウント一覧の共有', () => {
  beforeEach(() => {
    localStorage.setItem('lh_csrf', 'fixture-session')
    clearLineAccountsCache()
    list.mockReset()
    list.mockResolvedValue(ok)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/staff/me') return new Response(JSON.stringify({ success: true, data: { id: 'me' } }))
      return new Response(JSON.stringify(await list()))
    }))
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('同時に来た要求は1本にまとめ、同じ答えを返す', async () => {
    const [a, b] = await Promise.all([loadLineAccounts(), loadLineAccounts()])
    expect(list).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('プリフェッチに載せる側が相乗りする（確認と並列）', async () => {
    prefetchLineAccounts()
    const res = await loadLineAccounts()
    expect(list).toHaveBeenCalledTimes(1)
    expect(res).toEqual(ok)
  })

  it('完了した要求は保存せず、次の要求は読み直す', async () => {
    await loadLineAccounts()
    await loadLineAccounts()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('失敗は覚えず、次は取り直す', async () => {
    list.mockResolvedValueOnce({ success: false, error: 'x' })
    await loadLineAccounts()
    await loadLineAccounts()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('reload では使い回しの答えを捨てて必ず取り直す', async () => {
    await loadLineAccounts()
    await loadLineAccounts({ reload: true })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('ログアウト・セッション切れで捨てたら、次は取り直す', async () => {
    await loadLineAccounts()
    clearLineAccountsCache()
    await loadLineAccounts()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
