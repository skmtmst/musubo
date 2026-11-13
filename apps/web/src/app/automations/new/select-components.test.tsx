// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * R21・R22 の描画の試験。主な状態（空・読み込み中・失敗・正常）を
 * 本物のReactで確かめる。直しを戻すと赤くなる。
 */
vi.mock('@/lib/api', () => ({
  api: { friends: { list: vi.fn(), get: vi.fn() } },
}))

import { api } from '@/lib/api'
import { WeekdaySelect } from '@/v8/automations/create/weekday-select'
import { FriendMultiSelect } from '@/v8/automations/create/friend-multi-select'

const mockList = api.friends.list as unknown as ReturnType<typeof vi.fn>

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  mockList.mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  if (root) await act(async () => { root!.unmount() })
  if (container) container.remove()
  root = null
  container = null
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(node) })
  return container
}

async function typeText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function chips(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll('[role="group"] button'))
}

describe('動かす曜日の札（R21）', () => {
  it('7つの札を出し、選んだ曜日の確かめを人の言葉で出す', async () => {
    const onChange = vi.fn()
    const el = await mount(<WeekdaySelect value={[1, 3]} time="09:00" onChange={onChange} />)
    expect(chips(el).map((button) => button.textContent)).toEqual(['月', '火', '水', '木', '金', '土', '日'])
    const pressed = chips(el).filter((button) => button.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((button) => button.textContent)).toEqual(['月', '水'])
    expect(el.textContent).toContain('毎週 月・水 の 09:00（日本時間）に動きます。')
    expect(el.textContent).toContain('次は ')
  })

  it('札を押すと増減し、空になると選ぶよう促す', async () => {
    let value: number[] = [1]
    const onChange = vi.fn((days: number[]) => { value = days })
    const render = async () => {
      if (root) await act(async () => { root!.render(<WeekdaySelect value={value} time="09:00" onChange={onChange} />) })
    }
    const el = await mount(<WeekdaySelect value={value} time="09:00" onChange={onChange} />)
    await click(chips(el)[1])
    expect(onChange).toHaveBeenLastCalledWith([1, 2])
    await render()
    value = []
    await render()
    expect(el.textContent).toContain('曜日を1つ以上選んでください。')
  })
})

describe('対象の友だちの複数選択（R22）', () => {
  it('選んだ人は札と人数の見出しに出し、×で外せる', async () => {
    const onChange = vi.fn()
    const el = await mount(
      <FriendMultiSelect accountId="account-1" selectedIds={['a', 'b']} names={{ a: '見本 143', b: '見本 121' }} onChange={onChange} />,
    )
    expect(el.textContent).toContain('対象の友だち（2 人）')
    expect(el.textContent).toContain('見本 143')
    const remove = el.querySelector('button[aria-label="見本 143を外す"]')
    if (!remove) throw new Error('外すボタンが見つかりません')
    await click(remove)
    expect(onChange).toHaveBeenCalledWith(['b'], { a: '見本 143', b: '見本 121' })
  })

  it('名前で探して候補から足せる（読み込み中・正常）', async () => {
    const onChange = vi.fn()
    let resolveList!: (value: { success: true; data: { items: Array<{ id: string; displayName: string }>; total: number } }) => void
    mockList.mockImplementationOnce(
      () => new Promise((resolve) => { resolveList = resolve }),
    )
    const el = await mount(
      <FriendMultiSelect accountId="account-1" selectedIds={[]} names={{}} onChange={onChange} />,
    )
    await click(el.querySelector('button[aria-haspopup="dialog"]')!)
    const input = document.querySelector('input[type="search"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('検索欄が見つかりません')
    // 待ちは偽の時計で進める（本物の時間を待たない）。250ms の待ちは打った瞬間から数えるので、打つ前に替える。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await typeText(input, 'やま')
    // 250ms の待ちの間は読み込み中。
    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    vi.useRealTimers()
    // まだ返事が無いので読み込み中のまま。
    expect(document.body.textContent).toContain('友だちを探しています…')
    await act(async () => {
      resolveList({ success: true, data: { items: [{ id: 'friend-1', displayName: '見本 143' }], total: 1 } })
    })
    expect(document.body.textContent).toContain('見本 143')
    await click(document.querySelector('input[type="checkbox"][aria-label="見本 143"]')!)
    expect(onChange).not.toHaveBeenCalled()
    const add = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '選ぶ（1件）')
    if (!add) throw new Error('追加ボタンが見つかりません')
    await click(add)
    expect(onChange).toHaveBeenCalledWith(['friend-1'], { 'friend-1': '見本 143' })
    expect(mockList).toHaveBeenCalledWith({ accountId: 'account-1', search: 'やま', limit: 20, offset: '0', includeTags: false })
  })

  it('探せないときは失敗だけを出し、候補は出さない', async () => {
    const onChange = vi.fn()
    mockList.mockRejectedValueOnce(new Error('network'))
    const el = await mount(
      <FriendMultiSelect accountId="account-1" selectedIds={[]} names={{}} onChange={onChange} />,
    )
    await click(el.querySelector('button[aria-haspopup="dialog"]')!)
    const input = document.querySelector('input[type="search"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('検索欄が見つかりません')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await typeText(input, 'やま')
    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    vi.useRealTimers()
    expect(document.body.textContent).toContain('友だちを読み込めませんでした。')
    expect(document.querySelector('input[type="checkbox"][aria-label="見本 143"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('アカウントが無ければ探せない', async () => {
    const el = await mount(
      <FriendMultiSelect accountId={null} selectedIds={[]} names={{}} onChange={vi.fn()} />,
    )
    const open = el.querySelector('button[aria-haspopup="dialog"]')
    if (!(open instanceof HTMLButtonElement)) throw new Error('選ぶ欄が見つかりません')
    expect(open.disabled).toBe(true)
    expect(mockList).not.toHaveBeenCalled()
  })
})
