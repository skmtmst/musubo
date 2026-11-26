// @vitest-environment happy-dom
/*
 * 接続の一覧（利用者承認の★`設定SNS連携_複数接続_第1段_v7.pen` F1 `tIRy5` の行）。
 *
 * 画面の口がまだ1サービス1件しか返さないので、複数接続の見え方と操作はここで確かめる。
 *  - 受入条件1：Google 2件・Instagram 2件を一覧の行として出す。
 *  - 受入条件4：解除は押した行だけを渡し、ほかの行は消えない。
 *  - 「主連携にする」は接続が2件以上あって、その行がまだ主連携でないときだけ出す。
 *  - 絵のとおり［主連携にする］と、つなぎ直しで直せる行の［つなぎ直す］は行の中に置き、
 *    「⋯」には重ねて置かない。
 *  - 閲覧しかできない人には操作を消さず、押せない状態にして理由を添える（F8）。
 */

import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SnsConnectionList from './connection-list'
import type { SnsConnectionView, SnsServiceSlots, SnsService } from './connection-slots'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

const LOCKED_REASON = 'オーナーか管理者だけが接続を変更できます'

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function conn(
  service: SnsService,
  id: string,
  name: string,
  over: Partial<SnsConnectionView> = {},
): SnsConnectionView {
  return { id, service, name, meta: [], state: 'connected', primary: false, version: 1, ...over }
}

/** Google ロケーション2件（1件目が主連携）。 */
function googleSlots(): SnsServiceSlots {
  return {
    service: 'googleBusiness',
    connections: [
      conn('googleBusiness', 'gc-1', '見本 本店', {
        primary: true,
        meta: ['owner@example.com', '最後に取り込んだ日時 11/16 9:00'],
      }),
      conn('googleBusiness', 'gc-2', '見本 駅前店', {
        meta: ['owner@example.com', '最後に取り込んだ日時 11/16 8:30'],
      }),
    ],
  }
}

/** Instagram 2件（2件目は認可切れ）。 */
function instagramSlots(): SnsServiceSlots {
  return {
    service: 'instagram',
    connections: [
      conn('instagram', 'ig-1', '@sample_shop', { meta: ['ビジネスアカウント', '接続した日 10/7'] }),
      conn('instagram', 'ig-2', '@sample_shop_ekimae', {
        state: 'expired',
        meta: ['ビジネスアカウント', '接続した日 10/8'],
      }),
    ],
  }
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-connection-id]'))
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `${name}の操作` }))
}

describe('複数の接続を一覧に出す（受入条件1）', () => {
  it('Google ロケーション2件を行として出し、主連携の札は1件だけにする', () => {
    render(<SnsConnectionList slots={googleSlots()} canManage />)

    const list = rows()
    expect(list).toHaveLength(2)
    expect(list.map((row) => row.dataset.connectionId)).toEqual(['gc-1', 'gc-2'])

    expect(within(list[0]!).getByText('見本 本店')).toBeTruthy()
    expect(within(list[1]!).getByText('見本 駅前店')).toBeTruthy()
    // 状態の札は行ごとに出す。
    expect(within(list[0]!).getByText('接続済み')).toBeTruthy()
    expect(within(list[1]!).getByText('接続済み')).toBeTruthy()
    // 控えめな1行は「・」でつなぐ。
    expect(within(list[1]!).getByText('owner@example.com・最後に取り込んだ日時 11/16 8:30')).toBeTruthy()

    expect(within(list[0]!).getByText('主連携')).toBeTruthy()
    expect(within(list[1]!).queryByText('主連携')).toBeNull()
  })

  it('Instagram 2件を行として出し、認可切れも同じ一覧に並べる', () => {
    render(<SnsConnectionList slots={instagramSlots()} canManage />)

    const list = rows()
    expect(list).toHaveLength(2)
    expect(list.map((row) => row.dataset.connectionId)).toEqual(['ig-1', 'ig-2'])
    expect(within(list[0]!).getByText('接続済み')).toBeTruthy()
    expect(within(list[1]!).getByText('接続の異常')).toBeTruthy()
    // Instagram には主連携を置かない。
    expect(screen.queryByText('主連携')).toBeNull()
  })

  it('行の中の移動は渡された行だけに出す（Google の「営業時間へ →」）', () => {
    render(
      <SnsConnectionList
        slots={googleSlots()}
        canManage
        rowLink={(c) => (c.id === 'gc-1' ? { href: `/restaurant/google/hours?c=${c.id}`, label: '営業時間へ' } : null)}
      />,
    )

    const links = screen.getAllByRole('link', { name: '営業時間へ' })
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('/restaurant/google/hours?c=gc-1')
  })

  it('接続が1件も無いときは一覧の箱ごと出さない', () => {
    const { container } = render(
      <SnsConnectionList slots={{ service: 'instagram', connections: [] }} canManage />,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('行の操作（受入条件4）', () => {
  it('解除は押した行の接続だけを渡し、ほかの行は消えない', () => {
    const onDisconnect = vi.fn()
    const slots = googleSlots()
    render(<SnsConnectionList slots={slots} canManage onDisconnect={onDisconnect} />)

    openMenu('見本 駅前店')
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0]!)

    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect.mock.calls[0]![0]).toBe(slots.connections[1])
    // 一覧じたいは解除の確認が済むまで動かさない（ほかの接続の行は残る）。
    expect(rows().map((row) => row.dataset.connectionId)).toEqual(['gc-1', 'gc-2'])
  })

  it('つなぎ直しで直せる行は行の中の［つなぎ直す］で、その行の接続を渡す', () => {
    const onReconnect = vi.fn()
    const slots = instagramSlots()
    render(<SnsConnectionList slots={slots} canManage onReconnect={onReconnect} />)

    // 期限切れの行は絵（F1）のとおり行の中に出す。
    const expired = rows()[1]!
    fireEvent.click(within(expired).getByRole('button', { name: 'つなぎ直す' }))
    expect(onReconnect.mock.calls[0]![0]).toBe(slots.connections[1])

    // 同じ操作を「⋯」にも重ねて置かない（ほかに入れる操作が無ければ「⋯」も出さない）。
    expect(within(expired).queryByRole('button', { name: '@sample_shop_ekimaeの操作' })).toBeNull()
  })

  it('ふつうに繋がっている行の「つなぎ直す」は「⋯」の中に置く', () => {
    const onReconnect = vi.fn()
    const slots = instagramSlots()
    render(<SnsConnectionList slots={slots} canManage onReconnect={onReconnect} />)

    const healthy = rows()[0]!
    expect(within(healthy).queryByRole('button', { name: 'つなぎ直す' })).toBeNull()

    openMenu('@sample_shop')
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'つなぎ直す' })[0]!)
    expect(onReconnect.mock.calls[0]![0]).toBe(slots.connections[0])
  })

  it('「主連携にする」は2件以上あって、まだ主連携でない行だけに出す', () => {
    const onSetPrimary = vi.fn()
    const slots = googleSlots()
    render(
      <SnsConnectionList
        slots={slots}
        canManage
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSetPrimary={onSetPrimary}
      />,
    )

    const list = rows()
    // すでに主連携の行には出さない。
    expect(within(list[0]!).queryByRole('button', { name: '主連携にする' })).toBeNull()

    fireEvent.click(within(list[1]!).getByRole('button', { name: '主連携にする' }))
    expect(onSetPrimary.mock.calls[0]![0]).toBe(slots.connections[1])
  })

  it('接続が1件のときは「主連携にする」を出さない（選ぶ意味がない）', () => {
    const slots = googleSlots()
    render(
      <SnsConnectionList
        slots={{ ...slots, connections: [conn('googleBusiness', 'gc-9', '見本 本店')] }}
        canManage
        onReconnect={vi.fn()}
        onSetPrimary={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: '主連携にする' })).toBeNull()
    openMenu('見本 本店')
    expect(screen.queryAllByRole('menuitem', { name: /主連携にする/ })).toHaveLength(0)
  })

  it('処理中の行の操作だけを止める', () => {
    render(
      <SnsConnectionList
        slots={googleSlots()}
        canManage
        busyId="gc-2"
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSetPrimary={vi.fn()}
      />,
    )

    // 行の中の操作も止める。
    const busyRow = rows()[1]!
    expect((within(busyRow).getByRole('button', { name: '主連携にする' }) as HTMLButtonElement).disabled).toBe(true)

    openMenu('見本 駅前店')
    const busyItems = screen.getAllByRole('menuitem')
    expect(busyItems.length).toBeGreaterThan(0)
    for (const item of busyItems) {
      expect((item as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.keyDown(document.body, { key: 'Escape' })

    // もう一方の行は動かせる。
    openMenu('見本 本店')
    expect(
      screen.getAllByRole('menuitem', { name: '解除する' }).some((item) => !(item as HTMLButtonElement).disabled),
    ).toBe(true)
  })
})

describe('閲覧しかできない人（F8）', () => {
  it('操作を消さず、押せない状態にして理由を添える', () => {
    render(
      <SnsConnectionList
        slots={googleSlots()}
        canManage={false}
        lockedReason={LOCKED_REASON}
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSetPrimary={vi.fn()}
      />,
    )

    const menu = screen.getByRole('button', { name: '見本 駅前店の操作' })
    expect(menu.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByText(LOCKED_REASON).length).toBeGreaterThan(0)

    // 行の中の操作も消さず、押せない状態にして理由を添える。
    const primary = screen.getByRole('button', { name: '主連携にする' })
    expect(primary.getAttribute('aria-disabled')).toBe('true')
    expect((primary as HTMLButtonElement).disabled).toBe(false)

    // 押しても開かない。
    fireEvent.click(menu)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
