// @vitest-environment happy-dom
/*
 * 受信箱「会話の中を探す」（V8.pen 枠 ）の動き。
 * - 打って止まったら探す。最初はいちばん新しい当たり（n 件目）
 * - Enter／↑ で古い方、Shift+Enter／↓ で新しい方。端で止まる
 * - 読んでいない番号へ移るときは、その番号を含む塊を読む
 * - 0 件は「見つかりません」。Esc・× で閉じる
 * - いま見ている当たりと、ほかの当たり（読み込み済みの吹き出しも）を分けて返す
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConversationSearchHit } from '@line-crm/shared'

const searchMessages = vi.fn()
vi.mock('@/lib/api', () => ({ api: { chats: { searchMessages: (...args: unknown[]) => searchMessages(...args) } } }))

import ChatSearchBar from './chat-search-bar'
import { useChatSearch, type ChatSearch } from './use-chat-search'

const hit = (n: number): ConversationSearchHit => ({
  id: `h${n}`, at: `2026-08-01T00:00:${String(n % 60).padStart(2, '0')}Z`, excerpt: `定期便 ${n}`,
  before: null, after: null, cursor: { at: '2026-08-01T00:00:00Z', id: `h${n}` },
})
function respond(total: number) {
  searchMessages.mockImplementation(async (_id: string, _q: string, offset: number, limit: number) => {
    const hits = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => hit(offset + i))
    return { success: true, data: { total, hits, nextOffset: offset + hits.length < total ? offset + hits.length : null } }
  })
}

let latest: ChatSearch
function Harness({ friendId = 'f1' }: { friendId?: string | null }) {
  const search = useChatSearch(friendId)
  latest = search
  return (
    <>
      <button type="button" onClick={search.openBar}>開く</button>
      {search.open && <ChatSearchBar search={search} />}
    </>
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  searchMessages.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openAndType(text: string) {
  await act(async () => { fireEvent.click(screen.getByText('開く')) })
  const input = screen.getByRole('searchbox', { name: '会話の中を探す' })
  await act(async () => { fireEvent.change(input, { target: { value: text } }) })
  return input
}

describe('会話の中を探す', () => {
  test('打って止まったら探し、いちばん新しい当たりから。Enter で古い方・Shift+Enter で新しい方', async () => {
    respond(3)
    render(<Harness />)
    const input = await openAndType('定期便')
    expect(screen.queryByText('任意')).toBeNull()
    expect(screen.queryByText(/\d+\/200文字/)).toBeNull()
    expect(input.getAttribute('maxlength')).toBe('200')
    expect(searchMessages).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('3 件中 3 件目'))
    expect(searchMessages).toHaveBeenCalledWith('f1', '定期便', 0, 100)
    expect(latest.current?.id).toBe('h2')
    expect(screen.getByRole('button', { name: '次の当たりへ（新しい方）' })).toHaveProperty('disabled', true)

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(screen.getByRole('status').textContent).toBe('3 件中 2 件目')
    expect(latest.current?.id).toBe('h1')

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }) })
    expect(screen.getByRole('status').textContent).toBe('3 件中 3 件目')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '前の当たりへ（古い方）' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '前の当たりへ（古い方）' })) })
    expect(screen.getByRole('status').textContent).toBe('3 件中 1 件目')
    expect(screen.getByRole('button', { name: '前の当たりへ（古い方）' })).toHaveProperty('disabled', true)
  })

  test('いま見ている当たりは太い枠、ほかの当たり（読み込み済みの吹き出しも）は薄い枠', async () => {
    respond(3)
    render(<Harness />)
    await openAndType('ＴＥＩＫＩ')
    await waitFor(() => expect(latest.status).toBe('ready'))
    expect(latest.hitKind({ id: 'h2' })).toBe('current')
    expect(latest.hitKind({ id: 'h0' })).toBe('other')
    // サーバーと同じそろえ方（NFKC＋小文字）で、読み込み済みの本文も当たりにする
    expect(latest.hitKind({ id: 'x', content: '次の teiki 便', messageType: 'text', isUnsent: false })).toBe('other')
    expect(latest.hitKind({ id: 'y', content: 'teiki', messageType: 'text', isUnsent: true })).toBeNull()
    expect(latest.hitKind({ id: 'z', content: '関係ない', messageType: 'text', isUnsent: false })).toBeNull()
  })

  test('当たりが多いときは新しい方の塊も読み、まだ読んでいない番号へはその塊を読んで移る', async () => {
    respond(250)
    render(<Harness />)
    const input = await openAndType('定期便')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('250 件中 250 件目'))
    expect(searchMessages).toHaveBeenNthCalledWith(2, 'f1', '定期便', 150, 100)
    // 150〜249 と 0〜99 は読んだ。149 番は読んでいない
    for (let i = 0; i < 99; i += 1) await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(screen.getByRole('status').textContent).toBe('250 件中 151 件目')
    expect(searchMessages).toHaveBeenCalledTimes(2)
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('250 件中 150 件目'))
    expect(searchMessages).toHaveBeenLastCalledWith('f1', '定期便', 50, 100)
    expect(latest.current?.id).toBe('h149')
  })

  test('0 件なら「見つかりません」。Esc で閉じる', async () => {
    respond(0)
    render(<Harness />)
    const input = await openAndType('ない言葉')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('見つかりません'))
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })
    expect(screen.queryByRole('search')).toBeNull()
    expect(latest.open).toBe(false)
  })

  test('× で閉じ、会話を替えたら閉じる', async () => {
    respond(1)
    const view = render(<Harness />)
    await openAndType('定期便')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '探すのをやめる' })) })
    expect(screen.queryByRole('search')).toBeNull()
    await openAndType('定期便')
    await waitFor(() => expect(latest.status).toBe('ready'))
    await act(async () => { view.rerender(<Harness friendId="f2" />) })
    expect(latest.open).toBe(false)
    expect(latest.current).toBeNull()
  })
})
