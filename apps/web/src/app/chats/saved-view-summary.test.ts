import { describe, expect, it } from 'vitest'

import { savedViewSummary } from '@/v8/inbox-chat/saved-view-summary'
import type { InboxSavedViewConditions } from '@/v8/inbox-chat/saved-view-types'

function conditions(patch: Partial<InboxSavedViewConditions> = {}): InboxSavedViewConditions {
  return {
    version: 1, query: '', channels: [], statuses: [], assignees: [],
    unread: 'all', quickFilter: 'all', messageTypes: [], receivedFrom: null, receivedTo: null,
    sort: 'newest', due: 'all', ...patch,
  }
}

/**
 * 設計 `ASsb3` は保存した検索の名前の下に「対応マーク：未対応／期限：超過」の
 * ように**何で絞ったか**を出す。名前だけだと、`未対応・期限超過` と
 * `見本担当の未対応` のどちらを押せばいいのかが名前の付け方頼みになる。
 */
describe('保存した検索の要約', () => {
  it('絞った軸だけを並べる', () => {
    expect(savedViewSummary(conditions({ statuses: ['unread'], channels: ['line'] })))
      .toBe('受信経路：LINE／対応状況：未対応')
  })

  it('軸の並びは設計と同じ（担当者が対応状況より先）', () => {
    /* 設計 `ASsb3` は「担当者：見本／対応マーク：未対応」。 */
    const summary = savedViewSummary(
      conditions({ statuses: ['unread'], assignees: ['op-1'] }),
      new Map([['op-1', '見本']]),
    )
    expect(summary).toBe('担当者：見本／対応状況：未対応')
  })

  it('自分の未読は「未読のみ」と書く（「自分の」は担当者の軸が言う）', () => {
    expect(savedViewSummary(conditions({ channels: ['line'], unread: 'mine' })))
      .toBe('受信経路：LINE／未読のみ')
  })

  it('全部選んでいる軸は「絞っていない」ので出さない', () => {
    const all = conditions({
      channels: ['line', 'email'],
      statuses: ['unread', 'in_progress', 'on_hold', 'resolved'],
    })
    expect(savedViewSummary(all)).toBe('絞り込みなし')
  })

  it('何も絞っていないとき、黙らない', () => {
    /*
      空文字を返すと、名前の下がただの隙間になり
      「読み込めていない」のか「絞っていない」のかが分からない。
    */
    expect(savedViewSummary(conditions())).toBe('絞り込みなし')
  })

  it('担当者は名前で出す', () => {
    const names = new Map([['op-1', '見本'], ['op-2', '菅野']])
    expect(savedViewSummary(conditions({ assignees: ['op-1', 'op-2'] }), names))
      .toBe('担当者：見本・菅野')
  })

  it('名前が引けない担当者を、IDのまま出さない', () => {
    /*
      `operator-kenta` と書かれても、それが誰なのかは分からない。
      引けないときは人数で言う。
    */
    const summary = savedViewSummary(conditions({ assignees: ['op-1', 'op-unknown'] }), new Map([['op-1', '見本']]))
    expect(summary).toBe('担当者：2人')
    expect(summary).not.toContain('op-unknown')
  })

  it('対応状況は用語表の言い方で出す', () => {
    expect(savedViewSummary(conditions({ statuses: ['resolved'] }))).toBe('対応状況：対応済み')
    expect(savedViewSummary(conditions({ statuses: ['on_hold'] }))).toBe('対応状況：保留')
  })

  it('1時間以上待ちを保存したときは条件の要約へ出す（INBOX-10）', () => {
    expect(savedViewSummary(conditions({ due: 'overdue' }))).toBe('1時間以上待ち')
  })

  it('要返信を保存したときは条件の要約へ出す（N-020）', () => {
    expect(savedViewSummary(conditions({ quickFilter: 'reply' }))).toBe('要返信')
    // quickFilter の「1時間以上待ち」も、旧軸 due が無くても出す。
    expect(savedViewSummary(conditions({ quickFilter: 'overdue' }))).toBe('1時間以上待ち')
  })

  it('並び順は、既定でないときだけ出す', () => {
    expect(savedViewSummary(conditions({ sort: 'newest' }))).toBe('絞り込みなし')
    expect(savedViewSummary(conditions({ sort: 'waiting_desc' }))).toBe('待ち時間が長い順')
  })
})
