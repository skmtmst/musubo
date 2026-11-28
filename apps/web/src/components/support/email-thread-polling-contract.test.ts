import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const thread = readFileSync(new URL('./email-thread.tsx', import.meta.url), 'utf8')

describe('メール会話の定期取得 (#630)', () => {
  it('5秒起点の1本だけで取り直し、自前の setInterval は持たない', () => {
    expect(thread).toContain('startVisiblePoll')
    expect(thread).not.toContain('setInterval')
    expect(thread).toContain('onGiveUp')
    expect(thread).toContain('onRecovered')
  })

  it('状態はスレッドIDと組で持ち、前のスレッドのものを見ない(#630)', () => {
    expect(thread).toContain('threadId: string; status: ThreadStatus')
    expect(thread).toContain('seen.threadId === latestThreadRef.current')
  })

  it('静かな取り直しは成否を返し、失敗は投げて数え直す', () => {
    expect(thread).toContain('Promise<boolean>')
  })
})
