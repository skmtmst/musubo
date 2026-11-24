// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clampProcedureIndex, guideAnchor, guideEngineStorageKey, guideStateFromServer, nextGuideEngineState, nextGuidedStepKey, readGuideEngineState, useGuideEngine, writeGuideEngineState, type GuideSummary } from './guide-engine'

const server = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { gettingStarted: { guide: server } } }))

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
afterEach(() => { cleanup(); vi.resetAllMocks() })

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

/*
  差し戻し R1（枠 14 orKSi の共通ルール「スキップ→次の手順へ」）。
  最後の手順でスキップしても台本に無い手順へ進めず、完了も偽らない。
*/
describe('最後の手順のスキップ', () => {
  it('台本の範囲に収める（台本を持たない段は数を変えない）', () => {
    expect(clampProcedureIndex('attributes', 4)).toBe(3)
    expect(clampProcedureIndex('attributes', 0)).toBe(1)
    expect(clampProcedureIndex('attributes', 2)).toBe(2)
    expect(clampProcedureIndex('richMenu', 4)).toBe(4)
    expect(clampProcedureIndex(null, 4)).toBe(4)
  })

  it('最後の手順では手順番号を足さない（吹き出しが消えないように）', () => {
    const atLast = { phase: 'active' as const, stepKey: 'attributes', procedureIndex: 3 }
    // 同じ状態を返す（保存もしない）ので、存在しない手順4は保存されない。
    expect(nextGuideEngineState(atLast, 'advanceProcedure')).toBe(atLast)
    expect(nextGuideEngineState({ phase: 'active', stepKey: 'attributes', procedureIndex: 1 }, 'advanceProcedure'))
      .toEqual({ phase: 'active', stepKey: 'attributes', procedureIndex: 2 })
  })

  it('残っていた台本外の手順番号は読み込みで直す（案内が消えた状態から戻す）', () => {
    window.localStorage.setItem(guideEngineStorageKey('account-1'), JSON.stringify({ phase: 'active', stepKey: 'attributes', procedureIndex: 4 }))
    expect(readGuideEngineState('account-1')).toEqual({ phase: 'active', stepKey: 'attributes', procedureIndex: 3 })
    expect(guideStateFromServer({ phase: 'active', stepKey: 'attributes', procedureIndex: 4 }))
      .toEqual({ phase: 'active', stepKey: 'attributes', procedureIndex: 3 })
  })

  it('段をまたぐ次の行き先は後ろを先に探し、無ければ前に戻る', () => {
    expect(nextGuidedStepKey(summary(), 'richMenu')).toBe('attributes')
    // 最後の段から見送ると、まだ残っている前の段へ戻す（済みにはしない）。
    expect(nextGuidedStepKey(summary(), 'attributes')).toBe('richMenu')
    expect(nextGuidedStepKey(summary(), 'attributes', new Set(['attributes', 'richMenu']))).toBeNull()
    expect(nextGuidedStepKey(null, 'attributes')).toBeNull()
  })

  it('見送った段は次の行き先に選ばない（同じ所へ戻らない）', () => {
    expect(guideAnchor(summary(), new Set(['richMenu']))?.key).toBe('attributes')
    expect(guideAnchor(summary(), new Set(['richMenu', 'attributes']))).toBeNull()
  })
})

describe('ガイドの状態保存', () => {
  it('最初から始めると選択済みリッチメニューも確認し、次に進んでから再読み込みすると戻らない', async () => {
    const steps = summary().steps.map(step => step.key === 'richMenu' ? { ...step, done: true } : step)
    const progress = summary({ steps, done: 2 })
    let saved = { phase: 'paused', stepKey: 'attributes', procedureIndex: 2 }
    server.get.mockImplementation(async () => ({ success: true, data: saved }))
    server.save.mockImplementation(async (_accountId, next) => { saved = next; return { success: true } })
    const initial = renderHook(() => useGuideEngine('account-1', progress, true, 'staff-1'))
    await waitFor(() => expect(initial.result.current.loading).toBe(false))
    act(() => initial.result.current.restart?.())
    await waitFor(() => expect(saved.stepKey).toBe('richMenu'))
    expect(initial.result.current.stepKey).toBe('richMenu')
    act(() => initial.result.current.advanceProcedure())
    await waitFor(() => expect(saved.stepKey).toBe('attributes'))
    initial.unmount()
    const reloaded = renderHook(() => useGuideEngine('account-1', progress, true, 'staff-1'))
    await waitFor(() => expect(reloaded.result.current.loading).toBe(false))
    expect(reloaded.result.current.stepKey).toBe('attributes')
  })

  it('アカウントごとに覚え、別のアカウントの続きを混ぜない', () => {
    writeGuideEngineState('account-1', { phase: 'paused', stepKey: 'richMenu', procedureIndex: 2 })
    expect(readGuideEngineState('account-1')).toEqual({ phase: 'paused', stepKey: 'richMenu', procedureIndex: 2 })
    expect(readGuideEngineState('account-2')).toEqual(idle)
    expect(readGuideEngineState(null)).toEqual(idle)
  })

  it('サーバーが完了を確認するまで同じ担当者の一時停止を保ち、成功後だけ完了にする', async () => {
    const paused = { phase: 'paused' as const, stepKey: 'firstMessage', procedureIndex: 1 }
    server.get.mockResolvedValue({ success: true, data: paused })
    server.save.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true })
    const { result } = renderHook(() => useGuideEngine('account-1', summary({ done: 3 }), true, 'staff-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { expect(await result.current.complete()).toBe(false) })
    expect(result.current.phase).toBe('paused')
    expect(readGuideEngineState('account-1', 'staff-1')).toEqual(paused)
    expect(readGuideEngineState('account-1', 'staff-2')).toEqual(idle)
    await act(async () => { expect(await result.current.complete()).toBe(true) })
    expect(result.current.phase).toBe('done')
    expect(readGuideEngineState('account-1', 'staff-1').phase).toBe('done')
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
