// @vitest-environment happy-dom
/*
 * V6R-S0-b: サイドバーと画面側が同じ表示可否を別々に取りに行かない。
 * 検証環境の実測では、多くの画面で /api/settings/features/visibility が2回呼ばれていた。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const visibility = vi.hoisted(() => vi.fn())


import { clearFeatureVisibilityCache, loadFeatureVisibility } from './feature-visibility-cache'
import { FEATURE_SETTINGS_UPDATED_EVENT } from './feature-settings-event'

const ok = { success: true as const, data: { features: { broadcasts: true } } }

describe('表示可否の共有（V6R-S0-b）', () => {
  beforeEach(() => {
    localStorage.setItem('lh_csrf', 'fixture-session')
    clearFeatureVisibilityCache()
    visibility.mockReset()
    visibility.mockResolvedValue(ok)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/staff/me') return new Response(JSON.stringify({ success: true, data: { id: 'me' } }))
      return new Response(JSON.stringify(await visibility(url.searchParams.get('account_id'))))
    }))
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('同時に来た要求は1本にまとめ、同じ答えを返す', async () => {
    const [a, b] = await Promise.all([loadFeatureVisibility('acc-1'), loadFeatureVisibility('acc-1')])
    expect(visibility).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('アカウントが違えば別に取る', async () => {
    await loadFeatureVisibility('acc-1')
    await loadFeatureVisibility('acc-2')
    expect(visibility).toHaveBeenCalledTimes(2)
  })

  it('失敗は覚えず、次は取り直す', async () => {
    visibility.mockResolvedValueOnce({ success: false, error: 'x' })
    await loadFeatureVisibility('acc-1')
    await Promise.resolve()
    await loadFeatureVisibility('acc-1')
    expect(visibility).toHaveBeenCalledTimes(2)

    visibility.mockRejectedValueOnce(new Error('network'))
    clearFeatureVisibilityCache()
    await loadFeatureVisibility('acc-1').catch(() => null)
    await Promise.resolve()
    await loadFeatureVisibility('acc-1')
    expect(visibility).toHaveBeenCalledTimes(4)
  })

  it('機能設定を保存した合図で、そのアカウントの答えを捨てる', async () => {
    await loadFeatureVisibility('acc-1')
    await loadFeatureVisibility('acc-2')
    window.dispatchEvent(new CustomEvent(FEATURE_SETTINGS_UPDATED_EVENT, { detail: { accountId: 'acc-1' } }))
    await loadFeatureVisibility('acc-1')
    await loadFeatureVisibility('acc-2')
    expect(visibility.mock.calls.map(([id]) => id)).toEqual(['acc-1', 'acc-2', 'acc-1'])
  })

  it('30秒を過ぎたら取り直す', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await loadFeatureVisibility('acc-1')
    now += 29_000
    await loadFeatureVisibility('acc-1')
    expect(visibility).toHaveBeenCalledTimes(1)
    now += 2_000
    await loadFeatureVisibility('acc-1')
    expect(visibility).toHaveBeenCalledTimes(2)
  })
})

describe('表示可否の共有は軽いまま（V6R-S0-b）', () => {
  it('メニュー定義（feature-settings・menu）を読み込まない。読み込むと全画面の最初の読み込みが約7kB増えた', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(__dirname, 'feature-visibility-cache.ts'), 'utf8')
    expect(source).not.toMatch(/from '\.\/feature-settings'/)
    expect(source).not.toMatch(/from '\.\/menu'/)
  })
})

describe('表示可否の初回読み込み', () => {
  it.each(['./feature-settings', './menu'])('%s を実行しない', async (unneededModule) => {
    vi.resetModules()
    const loadUnneededModule = vi.fn(() => ({}))
    vi.doMock(unneededModule, loadUnneededModule)
    try {
      await import('./feature-visibility-cache')
      expect(loadUnneededModule).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock(unneededModule)
      vi.resetModules()
    }
  })
})
