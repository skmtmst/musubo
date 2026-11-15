// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { guideAnchor, guideEngineStorageKey, guideStateFromServer, nextGuideEngineState, readGuideEngineState, writeGuideEngineState, type GuideSummary } from './guide-engine'

const summary = (overrides: Partial<GuideSummary> = {}): GuideSummary => ({
  steps: [
    { key: 'accounts', label: 'LINEをつなぐ', href: '/settings/line', done: true },
    { key: 'richMenu', label: 'リッチメニューを選ぶ', href: '/getting-started/rich-menu', done: false },
    { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables', done: false },
  ],
  done: 1, total: 3, ...overrides,
})

const idle = { phase: 'idle' as const, stepKey: null, procedureIndex: 1 }

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
  it('開始・一時停止・再開で止めた段と手順から続けられる', () => {
    const started = nextGuideEngineState(idle, 'start', 'richMenu')
    expect(started).toEqual({ phase: 'active', stepKey: 'richMenu', procedureIndex: 1 })
    const atTwo = nextGuideEngineState(started, 'advanceProcedure')
    expect(atTwo).toEqual({ phase: 'active', stepKey: 'richMenu', procedureIndex: 2 })
    const paused = nextGuideEngineState(atTwo, 'pause')
    expect(paused).toEqual({ phase: 'paused', stepKey: 'richMenu', procedureIndex: 2 })
    // 止めた段へ戻るなら手順も止めた所から。別の段へ移るなら手順1から。
    expect(nextGuideEngineState(paused, 'resume')).toEqual({ phase: 'active', stepKey: 'richMenu', procedureIndex: 2 })
    expect(nextGuideEngineState(paused, 'resume', 'attributes')).toEqual({ phase: 'active', stepKey: 'attributes', procedureIndex: 1 })
  })

  it('段が進むと手順は1に戻る（1/3→2/3の数え直し）', () => {
    const atThree = { phase: 'active' as const, stepKey: 'richMenu', procedureIndex: 3 }
    expect(nextGuideEngineState(atThree, 'advance', 'attributes')).toEqual({ phase: 'active', stepKey: 'attributes', procedureIndex: 1 })
  })

  it('一時停止中は次の段・次の手順へ進めず、できない遷移では状態を変えない', () => {
    const paused = { phase: 'paused' as const, stepKey: 'richMenu', procedureIndex: 2 }
    expect(nextGuideEngineState(paused, 'advance', 'attributes')).toBe(paused)
    expect(nextGuideEngineState(paused, 'advanceProcedure')).toBe(paused)
    expect(nextGuideEngineState(idle, 'pause')).toBe(idle)
    expect(nextGuideEngineState(idle, 'resume')).toBe(idle)
  })

  it('9項目が済んだら終わりにし、やり直しで最初に戻す', () => {
    expect(nextGuideEngineState({ phase: 'active', stepKey: 'richMenu', procedureIndex: 2 }, 'complete'))
      .toEqual({ phase: 'done', stepKey: null, procedureIndex: 1 })
    expect(nextGuideEngineState({ phase: 'done', stepKey: null, procedureIndex: 1 }, 'reset')).toEqual(idle)
  })
})

describe('ガイドの状態保存', () => {
  it('アカウントごとに覚え、別のアカウントの続きを混ぜない', () => {
    writeGuideEngineState('account-1', { phase: 'paused', stepKey: 'richMenu', procedureIndex: 2 })
    expect(readGuideEngineState('account-1')).toEqual({ phase: 'paused', stepKey: 'richMenu', procedureIndex: 2 })
    expect(readGuideEngineState('account-2')).toEqual(idle)
    expect(readGuideEngineState(null)).toEqual(idle)
  })

  it('壊れた記録は案内を始めていない状態として扱う', () => {
    window.localStorage.setItem(guideEngineStorageKey('account-1'), '{壊れた')
    expect(readGuideEngineState('account-1')).toEqual(idle)
    window.localStorage.setItem(guideEngineStorageKey('account-1'), JSON.stringify({ phase: 'なにか', stepKey: 7, procedureIndex: 0 }))
    expect(readGuideEngineState('account-1')).toEqual(idle)
  })

  /*
    承認済み Pen 枠 14 (orKSi) の L3lP08 は、進行状態をユーザー×アカウントで
    サーバー保存にする。壊れた返事で案内を勝手に始めないことを見張る。
  */
  it('サーバーの返事を状態に直し、足りない値は既定に寄せる', () => {
    expect(guideStateFromServer({ phase: 'paused', stepKey: 'hours', procedureIndex: 2 }))
      .toEqual({ phase: 'paused', stepKey: 'hours', procedureIndex: 2 })
    expect(guideStateFromServer({ phase: 'idle', stepKey: null, procedureIndex: 1 })).toEqual(idle)
    expect(guideStateFromServer({ phase: 'なにか', stepKey: 7, procedureIndex: 0 })).toEqual(idle)
    expect(guideStateFromServer(null)).toEqual(idle)
  })
})
