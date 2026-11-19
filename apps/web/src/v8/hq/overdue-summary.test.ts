/*
 * 統括の「返信の期限を過ぎた会話」のまとめ方。口の形が合わない値・失敗を 0 にしないことと、
 * 期限が未設定の会話が混じれば合計を出さないこと（部分の値を出さない）を守る。
 */
import { describe, expect, it } from 'vitest'
import { readAccountOverdue, summarizeOverdue } from './overdue-summary'

const on = (overdueCount: number | null, uncertainCount = 0) => ({ status: 'enabled', overdueCount, uncertainCount, href: '/chats' })
const off = { status: 'disabled', overdueCount: null, uncertainCount: null, href: '/chats' }

describe('readAccountOverdue', () => {
  it('期限オフ・件数・未設定を読み分ける', () => {
    expect(readAccountOverdue(off)).toEqual({ kind: 'off' })
    expect(readAccountOverdue(on(0))).toEqual({ kind: 'count', count: 0 })
    expect(readAccountOverdue(on(3))).toEqual({ kind: 'count', count: 3 })
    expect(readAccountOverdue(on(null, 2))).toEqual({ kind: 'uncertain', missing: 2 })
  })
  it('古い口で値が無い・形が違うときは unknown にして 0 と区別する', () => {
    for (const value of [undefined, null, {}, 'enabled', { status: 'enabled' }, on(-1), on(1.5), on(null, 0), { status: 'other', overdueCount: 0 }]) {
      expect(readAccountOverdue(value)).toEqual({ kind: 'unknown' })
    }
  })
})

describe('summarizeOverdue', () => {
  it('全店が期限オフ・店が無いときは出さない', () => {
    expect(summarizeOverdue([])).toEqual({ kind: 'hidden' })
    expect(summarizeOverdue([{ accountId: 'a', overdue: off }, { accountId: 'b', overdue: off }])).toEqual({ kind: 'hidden' })
  })
  it('期限を使う店の合計と、期限超過のある店を多い順に返す', () => {
    expect(summarizeOverdue([
      { accountId: 'a', overdue: on(2) },
      { accountId: 'b', overdue: off },
      { accountId: 'c', overdue: on(5) },
      { accountId: 'd', overdue: on(0) },
    ])).toEqual({ kind: 'count', total: 7, accounts: [{ accountId: 'c', count: 5 }, { accountId: 'a', count: 2 }] })
  })
  it('期限を使う店で期限超過が 0 なら 0 を出す（読めた 0 は 0）', () => {
    expect(summarizeOverdue([{ accountId: 'a', overdue: on(0) }, { accountId: 'b', overdue: off }])).toEqual({ kind: 'count', total: 0, accounts: [] })
  })
  it('未設定の会話がある店が混じれば合計を出さず、未設定の件数を全店で足す', () => {
    expect(summarizeOverdue([
      { accountId: 'a', overdue: on(null, 2) },
      { accountId: 'b', overdue: on(4) },
      { accountId: 'c', overdue: on(null, 1) },
    ])).toEqual({ kind: 'uncertain', missing: 3 })
  })
  it('1店でも読めなければ合計を出さない（未設定より先に扱う）', () => {
    expect(summarizeOverdue([{ accountId: 'a', overdue: on(3) }, { accountId: 'b', overdue: undefined }])).toEqual({ kind: 'unknown' })
    expect(summarizeOverdue([{ accountId: 'a', overdue: on(null, 2) }, { accountId: 'b', overdue: {} }])).toEqual({ kind: 'unknown' })
    expect(summarizeOverdue([{ accountId: 'a', overdue: off }, { accountId: 'b', overdue: undefined }])).toEqual({ kind: 'unknown' })
  })
})
