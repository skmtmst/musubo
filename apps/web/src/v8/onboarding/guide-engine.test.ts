// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { guideAnchor, guideEngineStorageKey, nextGuideEngineState, readGuideEngineState, writeGuideEngineState, type GuideSummary } from './guide-engine'

const summary = (overrides: Partial<GuideSummary> = {}): GuideSummary => ({
  steps: [
    { key: 'accounts', label: 'LINEをつなぐ', href: '/settings/line', done: true },
    { key: 'richMenu', label: 'リッチメニューを選ぶ', href: '/getting-started/rich-menu', done: false },
    { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables', done: false },
  ],
  done: 1, total: 3, ...overrides,
})

beforeEach(() => { window.localStorage.clear() })

describe('ガイドの行き先', () => {
  it('まだで行き先が実在する最初の段だけを案内する', () => {
    expect(guideAnchor(summary())).toEqual({ key: 'richMenu', label: 'リッチメニューを選ぶ', href: '/getting-started/rich-menu' })
  })

  it('行き先の無い段は案内しない（作っていない画面へ送らない）', () => {
    const steps = summary().steps.map(step => step.key === 'richMenu' ? { ...step, href: null } : step)
    expect(guideAnchor({ ...summary(), steps })?.key).toBe('attributes')
    expect(guideAnchor({ steps: [{ key: 'x', label: 'x', href: null, done: false }], done: 0, total: 1 })).toBeNull()
    expect(guideAnchor(null)).toBeNull()
  })
})

describe('ガイドの状態遷移', () => {
  it('開始・一時停止・再開で止めた段から続けられる', () => {
    const started = nextGuideEngineState({ phase: 'idle', stepKey: null }, 'start', 'richMenu')
    expect(started).toEqual({ phase: 'active', stepKey: 'richMenu' })
    const paused = nextGuideEngineState(started, 'pause')
    expect(paused).toEqual({ phase: 'paused', stepKey: 'richMenu' })
    expect(nextGuideEngineState(paused, 'resume')).toEqual({ phase: 'active', stepKey: 'richMenu' })
    expect(nextGuideEngineState(paused, 'resume', 'attributes')).toEqual({ phase: 'active', stepKey: 'attributes' })
  })

  it('一時停止中は次の段へ進めず、できない遷移では状態を変えない', () => {
    const paused = { phase: 'paused' as const, stepKey: 'richMenu' }
    expect(nextGuideEngineState(paused, 'advance', 'attributes')).toBe(paused)
    const idle = { phase: 'idle' as const, stepKey: null }
    expect(nextGuideEngineState(idle, 'pause')).toBe(idle)
    expect(nextGuideEngineState(idle, 'resume')).toBe(idle)
  })

  it('9項目が済んだら終わりにし、やり直しで最初に戻す', () => {
    expect(nextGuideEngineState({ phase: 'active', stepKey: 'richMenu' }, 'complete')).toEqual({ phase: 'done', stepKey: null })
    expect(nextGuideEngineState({ phase: 'done', stepKey: null }, 'reset')).toEqual({ phase: 'idle', stepKey: null })
  })
})

describe('ガイドの状態保存', () => {
  it('アカウントごとに覚え、別のアカウントの続きを混ぜない', () => {
    writeGuideEngineState('account-1', { phase: 'paused', stepKey: 'richMenu' })
    expect(readGuideEngineState('account-1')).toEqual({ phase: 'paused', stepKey: 'richMenu' })
    expect(readGuideEngineState('account-2')).toEqual({ phase: 'idle', stepKey: null })
    expect(readGuideEngineState(null)).toEqual({ phase: 'idle', stepKey: null })
  })

  it('壊れた記録は案内を始めていない状態として扱う', () => {
    window.localStorage.setItem(guideEngineStorageKey('account-1'), '{壊れた')
    expect(readGuideEngineState('account-1')).toEqual({ phase: 'idle', stepKey: null })
    window.localStorage.setItem(guideEngineStorageKey('account-1'), JSON.stringify({ phase: 'なにか', stepKey: 7 }))
    expect(readGuideEngineState('account-1')).toEqual({ phase: 'idle', stepKey: null })
  })
})
