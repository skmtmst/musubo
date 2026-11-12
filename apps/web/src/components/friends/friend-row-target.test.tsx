// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendListItem } from '@/lib/api'
import type { FriendListColumn } from './friend-list-types'

/*
 * 行を押した先は友だちの詳細（/friends/detail?id=…）。
 * 受信箱へは行の「…」のトーク項目から行く。
 * チェックボックス・★では移動しない。実際に押して確かめる。
 */

const pushes: string[] = []
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (url: string) => { pushes.push(url) } }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children?: unknown; onClick?: (event: { stopPropagation: () => void }) => void }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        onClick?.(event)
      }}
      {...(rest as object)}
    >
      {children as never}
    </a>
  ),
}))

import FriendListRow from './friend-list-row'

const BASE: FriendListItem = {
  id: 'friend-1',
  lineUserId: 'U0000000000000000000000000000001',
  displayName: 'Demo Person(Obama)',
  pictureUrl: null,
  statusMessage: null,
  isFollowing: true,
  chatStatus: 'resolved',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-20T09:00:00.000Z',
  tags: [],
  latestIncomingMessage: {
    content: 'こんにちは',
    messageType: 'text',
    createdAt: '2026-09-20T10:00:00.000Z',
  },
  latestOutgoingAt: null,
  activeScenario: null,
  operator: null,
  supportMark: null,
}

const COLUMNS = new Set<FriendListColumn>(['support', 'scenario', 'latest', 'tags', 'source', 'last'])

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  pushes.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

function render(friend: FriendListItem = BASE, canEdit = false, onAction = vi.fn()) {
  act(() => {
    root.render(
      <FriendListRow
        friend={friend}
        canEdit={canEdit}
        onAction={onAction}
        visibleColumns={COLUMNS}
        onToggleSelect={() => {}}
        onToggleAttention={() => {}}
      />,
    )
  })
}

function rowElement(): HTMLElement {
  const row = host.querySelector('[role="link"]')
  if (!row) throw new Error('行が見つかりません')
  return row as HTMLElement
}

describe('友だち行の行き先', () => {
  it('行を押すと友だちの詳細へ行く（受信箱ではない）', () => {
    render()
    act(() => {
      rowElement().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(pushes).toEqual(['/friends/detail?id=friend-1'])
  })

  it('Enterでも友だちの詳細へ行く', () => {
    render()
    act(() => {
      rowElement().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(pushes).toEqual(['/friends/detail?id=friend-1'])
  })

  function openMenu(): HTMLElement {
    const trigger = host.querySelector('button[aria-label="Demo Person(Obama)のその他操作"]')
    if (!trigger) throw new Error('操作メニューが見つかりません')
    act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')
    if (!menu) throw new Error('メニューが開きませんでした')
    return menu
  }

  it('メッセージの無い友だちでもトークの行き先を開ける', () => {
    render({ ...BASE, latestIncomingMessage: null })
    const menu = openMenu()
    expect(pushes).toEqual([])
    const inbox = [...menu.querySelectorAll('button')].find((button) => button.textContent?.includes('トークを開く'))
    if (!inbox) throw new Error('トーク項目が見つかりません')
    act(() => inbox.click())
    expect(pushes).toEqual(['/chats?friend=friend-1'])
  })

  it('メニューの項目で移動するときに行の詳細移動を重ねない', () => {
    render()
    const menu = openMenu()
    const detail = [...menu.querySelectorAll('button')].find((button) => button.textContent?.includes('友だちの詳細を見る'))
    if (!detail) throw new Error('詳細項目が見つかりません')
    act(() => detail.click())
    expect(pushes).toEqual(['/friends/detail?id=friend-1'])
  })

  it('編集項目を選ぶと対象の操作だけを開き、行の移動は起こさない', () => {
    const onAction = vi.fn()
    render(BASE, true, onAction)
    const menu = openMenu()
    const edit = [...menu.querySelectorAll('button')].find((button) => button.textContent === '担当者を変える')
    if (!edit) throw new Error('担当者の編集項目がありません')
    act(() => edit.click())
    expect(onAction).toHaveBeenCalledWith('operator')
    expect(pushes).toEqual([])
  })

  it('閲覧のみは変更項目を押せず、トークと詳細へは移動できる', () => {
    const onAction = vi.fn()
    render(BASE, false, onAction)
    const menu = openMenu()
    const buttons = [...menu.querySelectorAll('button')]
    expect(buttons.find((button) => button.textContent === 'トークを開く')?.disabled).toBe(false)
    expect(buttons.find((button) => button.textContent === '友だちの詳細を見る')?.disabled).toBe(false)
    const changes = buttons.filter((button) => !['トークを開く', '友だちの詳細を見る'].includes(button.textContent ?? ''))
    // 2026-10-07：「予約して送る」（V8）を足して9項目。
    expect(changes.length).toBe(9)
    expect(changes.find((button) => button.textContent?.startsWith('予約して送る'))?.disabled).toBe(true)
    expect(changes.every((button) => button.disabled)).toBe(true)
    expect(menu.textContent).toContain('閲覧のみでは変更できません')
    expect(onAction).not.toHaveBeenCalled()
  })

  it('チェックボックスを押しても移動しない', () => {
    render()
    const checkbox = host.querySelector('input[type="checkbox"]')
    if (!checkbox) throw new Error('チェックボックスが見つかりません')
    act(() => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(pushes).toEqual([])
  })

  it('名前は列の中で1行省略し、全文はtitleで読める', () => {
    render()
    const name = host.querySelector('a[title="Demo Person(Obama)"]')
    expect(name).not.toBeNull()
    expect(name?.className).toContain('truncate')
  })
})

it('省略したタグの件数から、隠れたすべてのタグ名を確認できる', async () => {
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 80, height: 24, top: 0, left: 0, right: 80, bottom: 24, x: 0, y: 0, toJSON() {} } as DOMRect)
  render({ ...BASE, tags: [
    { id: 'tag-1', name: '表示するタグ' },
    { id: 'tag-2', name: '省略したタグ1' },
    { id: 'tag-3', name: '省略したタグ2' },
  ] })
  const count = host.querySelector<HTMLButtonElement>('[data-tag-overflow] button[aria-haspopup="dialog"]')!
  expect(count.textContent).toMatch(/^\+\d+$/)
  await act(async () => count.click())
  const all = document.querySelector('[role="dialog"]')!
  for (const name of ['表示するタグ', '省略したタグ1', '省略したタグ2']) expect(all.textContent).toContain(name)
  geometry.mockRestore()

})
