import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: () => null }))

const inbox = readFileSync(new URL('./support-inbox.tsx', import.meta.url), 'utf8')

import { shouldRefetchSelectedDetail } from './support-inbox'

describe('問い合わせ一覧の定期取得 (#630)', () => {
  it('5秒起点の1本だけで一覧と会話を更新し、自前の setInterval は持たない', () => {
    expect(inbox).toContain('startVisiblePoll')
    expect(inbox).not.toContain('setInterval')
    // 一覧と会話は同じ1本の中で取り直す(同時1本)。
    expect(inbox).toContain('loadInbox(!loud)')
    expect(inbox).toContain('loadDetail(current.threadId, true)')
  })

  it('全取得に世代ID(古い絞り込み・選択の遅い応答は捨てる)', () => {
    expect(inbox).toContain('createPollGeneration')
    expect(inbox).toContain('genRef.current.isStale(mySeq)')
    expect(inbox).toContain('selectedRef.current?.threadId !== threadId')
  })

  it('未解決の間だけ動かし、対応済み・すべて表示では回さない', () => {
    const shouldLine = inbox
      .slice(inbox.indexOf('shouldPoll: () => status'))
      .split('\n')[0]
    expect(shouldLine).toContain("status === 'open'")
    expect(shouldLine).toContain("status === 'unread'")
    expect(shouldLine).toContain("status === 'in_progress'")
    expect(shouldLine).toContain("status === 'on_hold'")
    expect(shouldLine).not.toContain('resolved')
    expect(shouldLine).not.toContain("'all'")
  })

  it('静かな取り直しは成否を返し、失敗は投げて数え直す', () => {
    expect(inbox).toContain('Promise<boolean>')
    expect(inbox).toContain('onGiveUp')
    expect(inbox).toContain('onRecovered')
  })

  it('未解決一覧でも、選択中メールが対応済みなら詳細を取り直さない', () => {
    const unresolved = { channel: 'email', status: 'in_progress' } as const
    // どちらも未解決のときだけ取り直す。
    expect(shouldRefetchSelectedDetail(unresolved, 'in_progress')).toBe(true)
    expect(shouldRefetchSelectedDetail(unresolved, undefined)).toBe(true)
    // 一覧側が対応済みと言っている(詳細より先に変わることがある)。
    expect(
      shouldRefetchSelectedDetail({ channel: 'email', status: 'resolved' }, 'in_progress'),
    ).toBe(false)
    // 詳細側が対応済みと言っている(一覧より先に変わることがある)。
    expect(shouldRefetchSelectedDetail(unresolved, 'resolved')).toBe(false)
    // メール以外・未選択は詳細を持たない。
    expect(shouldRefetchSelectedDetail({ channel: 'line', status: 'in_progress' }, 'in_progress')).toBe(
      false,
    )
    expect(shouldRefetchSelectedDetail(null, 'in_progress')).toBe(false)
  })

  it('詳細の状態はループを止めずに読む(refで追う)', () => {
    expect(inbox).toContain('detailStatusRef')
    expect(inbox).toContain('shouldRefetchSelectedDetail(current, detailStatus)')
  })

  it('詳細の状態はスレッドIDと組で持ち、前のスレッドのものを見ない(#630)', () => {
    expect(inbox).toContain('threadId: string; status: ThreadStatus')
    expect(inbox).toContain('seen.threadId === current.threadId')
  })

  it('選択更新で制御器を作り直さない(refで読み、depsにselectedを入れない)', () => {
    expect(inbox).toContain('selectedRef.current = selected')
    expect(inbox).toContain('}, [channel, query, status])')
    expect(inbox).toContain('[loadDetail, loadInbox, status, inboxRetryKey]')
    expect(inbox).toContain('selectedRef.current')
  })

})
