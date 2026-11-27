// @vitest-environment happy-dom
/*
 * シナリオの下書きをサーバーの下書きの口へ残す（★V8）の試験。
 * 止まって2秒で PUT（新規は版0・以降は返った版）・開き直すと「前の入力を戻す」・捨てると DELETE・
 * 以前のブラウザの書きかけを一度だけ移して消す・409 は最新を読んで競合の帯（上書きしない）・
 * 保存済みの形に戻ったら消す・閲覧のみは読み書きしない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const get = vi.fn()
const save = vi.fn()
const del = vi.fn()
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: { ...actual.api, scenarioDrafts: { get: (...a: unknown[]) => get(...a), save: (...a: unknown[]) => save(...a), delete: (...a: unknown[]) => del(...a) } },
  }
})

import { ApiError } from '@/lib/api'
import { browserDraftKey } from './use-browser-draft'
import { AUTOSAVE_WORDS } from './use-draft-autosave'
import { forgetNewScenarioDraftKey, newScenarioDraftKey, scenarioDraftKey, useScenarioDraft } from './use-scenario-draft'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = scenarioDraftKey('sc-1', 'info')
const LEGACY = browserDraftKey(['scenario-create', 'account-a', 'sc-1'])
const V1 = '11111111-1111-4111-8111-111111111111'
const V2 = '22222222-2222-4222-8222-222222222222'
const V3 = '33333333-3333-4333-8333-333333333333'
type Props = { value: string; baseline: string; active?: boolean; draftKey?: string | null; accountId?: string; canSaveNow?: () => boolean }
let hook: ReturnType<typeof useScenarioDraft<string>> | null = null
function Harness({ value, baseline, active = true, draftKey = KEY, accountId = 'account-a', canSaveNow }: Props) {
  hook = useScenarioDraft({ accountId, draftKey, scenarioId: 'sc-1', legacyKey: LEGACY, value, baseline, active, canSaveNow })
  return null
}

const draft = (value: string, version: string, updatedAt = new Date(Date.now() - 5000).toISOString()) => ({
  key: KEY, lineAccountId: 'account-a', content: { value }, scenarioId: 'sc-1', stepId: null,
  version, updatedBy: 'staff-1', updatedAt, expiresAt: '2026-12-01T00:00:00.000Z',
})
const notFound = () => Promise.reject(new ApiError(404, 'not_found', 'not_found'))
const conflict = () => Promise.reject(new ApiError(409, 'version_conflict', 'version_conflict'))

let host: HTMLDivElement
let root: Root
const render = async (props: Props) => {
  await act(async () => { root.render(<Harness {...props} />) })
}
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const remount = async (props: Props) => {
  act(() => root.unmount())
  root = createRoot(host)
  await render(props)
}
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    get length() { return map.size },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', memoryStorage())
  get.mockReset().mockImplementation(notFound)
  save.mockReset()
  del.mockReset().mockResolvedValue({ success: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  hook = null
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useScenarioDraft', () => {
  it('止まって2秒で版0で作り、次は返った版で更新する。帯は「下書き保存済み・n秒前」', async () => {
    save.mockResolvedValueOnce({ success: true, data: draft('春', V1) }).mockResolvedValueOnce({ success: true, data: draft('春の', V2) })
    await render({ value: '', baseline: '' })
    await advance(0)
    await render({ value: '春', baseline: '' })
    expect(hook?.label).toBe(AUTOSAVE_WORDS.unsaved)
    await advance(1900)
    expect(save).not.toHaveBeenCalled()
    await advance(200)
    expect(save).toHaveBeenCalledWith('account-a', KEY, { expectedVersion: 0, content: { value: '春' }, scenarioId: 'sc-1', stepId: null })
    expect(hook?.label).toBe(AUTOSAVE_WORDS.saved('0秒前'))
    await render({ value: '春の', baseline: '' })
    await advance(2100)
    expect(save).toHaveBeenLastCalledWith('account-a', KEY, expect.objectContaining({ expectedVersion: V1, content: { value: '春の' } }))
  })

  it('開き直すと前の入力を出し、決めるまで上書きしない。戻すと値を返す', async () => {
    get.mockResolvedValue({ success: true, data: draft('前の入力', V1) })
    await render({ value: '', baseline: '' })
    await advance(0)
    expect(hook?.pendingAgo).toBe('5秒前')
    await render({ value: '打ちかけ', baseline: '' })
    await advance(3000)
    expect(save).not.toHaveBeenCalled()
    let restored: string | null = null
    act(() => { restored = hook?.restore() ?? null })
    expect(restored).toBe('前の入力')
    expect(hook?.pendingAgo).toBeNull()
  })

  it('「捨てる」で返った版を添えて消す', async () => {
    get.mockResolvedValue({ success: true, data: draft('前の入力', V1) })
    await render({ value: '', baseline: '' })
    await advance(0)
    act(() => hook?.clear())
    expect(del).toHaveBeenCalledWith('account-a', KEY, V1)
    expect(hook?.pendingAgo).toBeNull()
  })

  it('以前のブラウザの書きかけは一度だけサーバーへ移して消す', async () => {
    localStorage.setItem(LEGACY, JSON.stringify({ savedAt: Date.now() - 60_000, value: 'ブラウザの入力' }))
    save.mockResolvedValue({ success: true, data: draft('ブラウザの入力', V1) })
    await render({ value: '', baseline: '' })
    await advance(0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('account-a', KEY, expect.objectContaining({ expectedVersion: 0, content: { value: 'ブラウザの入力' } }))
    expect(localStorage.getItem(LEGACY)).toBeNull()
    expect(hook?.pendingAgo).toBe('1分前')
    get.mockResolvedValue({ success: true, data: draft('ブラウザの入力', V1) })
    await remount({ value: '', baseline: '' })
    await advance(0)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('移せなければブラウザに残す（次に開いたときにもう一度）', async () => {
    localStorage.setItem(LEGACY, JSON.stringify({ savedAt: Date.now(), value: 'ブラウザの入力' }))
    save.mockRejectedValue(new ApiError(500, 'x', 'x'))
    await render({ value: '', baseline: '' })
    await advance(0)
    expect(localStorage.getItem(LEGACY)).not.toBeNull()
    expect(hook?.pendingAgo).not.toBeNull()
  })

  it('409 は最新を1回読んで競合の帯。上書きせず、読み込むか上書きを選ぶ', async () => {
    save.mockImplementationOnce(conflict)
    await render({ value: '', baseline: '' })
    await advance(0)
    get.mockResolvedValue({ success: true, data: draft('ほかの入力', V2) })
    await render({ value: '自分の入力', baseline: '' })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1)
    expect(hook?.conflictAgo).toBe('5秒前')
    await advance(5000)
    expect(save).toHaveBeenCalledTimes(1)

    save.mockResolvedValueOnce({ success: true, data: draft('自分の入力', V3) })
    act(() => hook?.overwrite())
    await advance(2100)
    expect(save).toHaveBeenLastCalledWith('account-a', KEY, expect.objectContaining({ expectedVersion: V2, content: { value: '自分の入力' } }))
    expect(hook?.conflictAgo).toBeNull()
  })

  it('競合の帯で最新を読み込むと最新の値を返し、その版で続ける', async () => {
    save.mockImplementationOnce(conflict)
    await render({ value: '', baseline: '' })
    await advance(0)
    get.mockResolvedValue({ success: true, data: draft('ほかの入力', V2) })
    await render({ value: '自分の入力', baseline: '' })
    await advance(2100)
    let latest: string | null = null
    act(() => { latest = hook?.loadLatest() ?? null })
    expect(latest).toBe('ほかの入力')
    save.mockResolvedValueOnce({ success: true, data: draft('ほかの入力2', V3) })
    await render({ value: 'ほかの入力2', baseline: '' })
    await advance(2100)
    expect(save).toHaveBeenLastCalledWith('account-a', KEY, expect.objectContaining({ expectedVersion: V2 }))
  })

  it('保存済みの形に戻ったら下書きを消す', async () => {
    save.mockResolvedValue({ success: true, data: draft('春', V1) })
    await render({ value: '', baseline: '' })
    await advance(0)
    await render({ value: '春', baseline: '' })
    await advance(2100)
    await render({ value: '', baseline: '' })
    await advance(2100)
    expect(del).toHaveBeenCalledWith('account-a', KEY, V1)
    expect(hook?.label).toBeNull()
  })

  it('閲覧のみは読みも書きもしない', async () => {
    localStorage.setItem(LEGACY, JSON.stringify({ savedAt: Date.now(), value: 'ブラウザの入力' }))
    await render({ value: '', baseline: '', active: false })
    await advance(0)
    await render({ value: '打った', baseline: '', active: false })
    await advance(3000)
    expect(get).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(hook?.label).toBeNull()
    expect(hook?.pendingAgo).toBeNull()
  })

  it('新規のキーはこのブラウザに覚えて同じものを返し、忘れると新しくなる', () => {
    const first = newScenarioDraftKey('account-a')
    expect(first).toMatch(/^new:/)
    expect(newScenarioDraftKey('account-a')).toBe(first)
    forgetNewScenarioDraftKey('account-a')
    expect(newScenarioDraftKey('account-a')).not.toBe(first)
  })

  // 監査 WEB-020：切り替える前のアカウントの読みが遅れて返っても、今のアカウントの版にしない。
  it('アカウント A の読みが B へ切り替えたあとに返っても、B の下書きは版0で作る', async () => {
    let resolveA: (value: unknown) => void = () => {}
    get.mockImplementation((account: string) => account === 'account-a'
      ? new Promise((resolve) => { resolveA = resolve })
      : notFound())
    await render({ value: '', baseline: '', accountId: 'account-a' })
    await render({ value: '', baseline: '', accountId: 'account-b' })
    await advance(0)
    await act(async () => { resolveA({ success: true, data: draft('A の入力', V1) }) })
    await advance(0)
    save.mockResolvedValueOnce({ success: true, data: draft('B の入力', V2) })
    await render({ value: 'B の入力', baseline: '', accountId: 'account-b' })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith('account-b', KEY, expect.objectContaining({ expectedVersion: 0, content: { value: 'B の入力' } }))
  })

  // 監査 WEB-021：保存の途中で「捨てる」を押したら、遅れた 409 のあとに下書きを作り直さない。
  it('保存中に捨てると、遅れた 409 のあと読み直しも版0での作り直しもしない', async () => {
    save.mockResolvedValueOnce({ success: true, data: draft('春', V1) })
    await render({ value: '', baseline: '' })
    await advance(0)
    await render({ value: '春', baseline: '' })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1)

    let rejectSecond: (reason: unknown) => void = () => {}
    save.mockImplementationOnce(() => new Promise((_, reject) => { rejectSecond = reject }))
    await render({ value: '春の', baseline: '' })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(2)
    act(() => hook?.clear())
    expect(del).toHaveBeenCalledWith('account-a', KEY, V1)
    get.mockClear()
    await act(async () => { rejectSecond(new ApiError(409, 'version_conflict', 'version_conflict')) })
    await advance(0)
    expect(get).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('保存中に捨てたあと保存が通ってしまったら、できた下書きをその版で消す', async () => {
    save.mockResolvedValueOnce({ success: true, data: draft('春', V1) })
    await render({ value: '', baseline: '' })
    await advance(0)
    await render({ value: '春', baseline: '' })
    await advance(2100)

    let resolveSecond: (value: unknown) => void = () => {}
    save.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    await render({ value: '春の', baseline: '' })
    await advance(2100)
    act(() => hook?.clear())
    del.mockClear()
    await act(async () => { resolveSecond({ success: true, data: draft('春の', V2) }) })
    await advance(0)
    expect(del).toHaveBeenCalledWith('account-a', KEY, V2)
    expect(hook?.label).not.toBe(AUTOSAVE_WORDS.saved('0秒前'))
  })
})


const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const legacy = (value = 'ブラウザの下書き', savedAt = Date.now()) => {
  const raw = JSON.stringify({ value, savedAt })
  localStorage.setItem(LEGACY, raw)
  return raw
}

describe('下書きの任意の保存直前確認', () => {
  it('拒否中もGETと復元用の下書きは残し、自動保存と削除は0', async () => {
    get.mockResolvedValue({ success: true, data: draft('残す', V1) })
    await render({ value: '入力中', baseline: '', canSaveNow: () => false })
    await advance(0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(hook?.pending?.value).toBe('残す')
    act(() => hook?.clear())
    await advance(2500)
    expect(hook?.pending?.value).toBe('残す')
    expect(save).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
  })

  it('許可された入力は通常どおり1回保存する', async () => {
    save.mockResolvedValue({ success: true, data: draft('入力', V1) })
    await render({ value: '', baseline: '', canSaveNow: () => true })
    await advance(0)
    await render({ value: '入力', baseline: '', canSaveNow: () => true })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('account-a', KEY, expect.objectContaining({ expectedVersion: 0, content: { value: '入力' } }))
    expect(hook?.label).toBe(AUTOSAVE_WORDS.saved('0秒前'))
  })

  it('GET待ちで拒否になればブラウザ下書きの移行PUTも削除も行わない', async () => {
    const raw = legacy(), response = deferred<unknown>()
    get.mockReturnValue(response.promise)
    await render({ value: '', baseline: '', canSaveNow: () => true })
    await render({ value: '', baseline: '', canSaveNow: () => false })
    await act(async () => response.resolve({ success: false }))
    expect(get).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
    expect(localStorage.getItem(LEGACY)).toBe(raw)
    expect(hook?.pending).toBeNull()
    expect(hook?.loadFailed).toBe(true)
  })

  it('GET中に拒否と許可を挟んでも古い移行を再開しない', async () => {
    const raw = legacy(), response = deferred<unknown>()
    get.mockReturnValue(response.promise)
    const allowed = () => true
    await render({ value: '', baseline: '', canSaveNow: allowed })
    await render({ value: '', baseline: '', canSaveNow: () => false })
    await render({ value: '', baseline: '', canSaveNow: allowed })
    await act(async () => response.resolve({ success: false }))
    await advance(2500)
    expect(save).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
    expect(localStorage.getItem(LEGACY)).toBe(raw)
  })

  it('拒否で始めた読取は描画なしで許可へ変わっても移行を始めない', async () => {
    const raw = legacy(), response = deferred<unknown>()
    get.mockReturnValue(response.promise)
    let allowed = false
    await render({ value: '', baseline: '', canSaveNow: () => allowed })
    allowed = true
    await act(async () => response.resolve({ success: false }))
    expect(save).not.toHaveBeenCalled()
    expect(localStorage.getItem(LEGACY)).toBe(raw)
  })

  it('移行PUTの成功待ちで拒否されてもブラウザの控えを消さない', async () => {
    const raw = legacy(), response = deferred<unknown>()
    save.mockReturnValue(response.promise)
    await render({ value: '', baseline: '', canSaveNow: () => true })
    await advance(0)
    expect(save).toHaveBeenCalledTimes(1)
    await render({ value: '', baseline: '', canSaveNow: () => false })
    await act(async () => response.resolve({ success: true, data: draft('ブラウザの下書き', V1) }))
    expect(localStorage.getItem(LEGACY)).toBe(raw)
    expect(hook?.pending?.value).toBe('ブラウザの下書き')
    expect(del).not.toHaveBeenCalled()
  })

  it.each(['server-newer', 'legacy-baseline'] as const)('拒否時は%sのブラウザ控えも保持する', async kind => {
    const raw = legacy(kind === 'legacy-baseline' ? '' : '古い控え', Date.now() - 20000)
    get.mockResolvedValue({ success: true, data: draft('新しいサーバー下書き', V1, new Date(Date.now() - (kind === 'legacy-baseline' ? 30000 : 5000)).toISOString()) })
    await render({ value: '', baseline: '', canSaveNow: () => false })
    await advance(0)
    expect(localStorage.getItem(LEGACY)).toBe(raw)
    expect(hook?.pending?.value).toBe('新しいサーバー下書き')
    expect(save).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
  })

  it('保存済みと同じ下書きも拒否時は自動削除しない', async () => {
    get.mockResolvedValue({ success: true, data: draft('本体', V1) })
    await render({ value: '本体', baseline: '本体', canSaveNow: () => false })
    await advance(0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(hook?.pending?.value).toBe('本体')
    expect(del).not.toHaveBeenCalled()
  })

  it('開始callbackがGET待ちで失効すれば、最新callbackがtrueでも移行しない', async () => {
    const raw = legacy(), response = deferred<unknown>()
    get.mockReturnValue(response.promise)
    let originAllowed = true
    await render({ value: '', baseline: '', canSaveNow: () => originAllowed })
    await render({ value: '', baseline: '', canSaveNow: () => true })
    originAllowed = false
    await act(async () => response.resolve({ success: false }))
    expect(get).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
    expect(localStorage.getItem(LEGACY)).toBe(raw)
  })

  it('保存済みの形へ戻した後の自動削除も、直前に拒否されれば0回', async () => {
    const yes = () => true
    save.mockResolvedValue({ success: true, data: draft('入力', V1) })
    await render({ value: '', baseline: '', canSaveNow: yes })
    await advance(0)
    await render({ value: '入力', baseline: '', canSaveNow: yes })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1)
    await render({ value: '', baseline: '', canSaveNow: () => false })
    await advance(2100)
    expect(del).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('許可時に保持したclearも別描画の最新callbackで拒否し、控えを残す', async () => {
    get.mockResolvedValue({ success: true, data: draft('残す', V1) })
    await render({ value: '', baseline: '', canSaveNow: () => true })
    await advance(0)
    const held = hook!.clear, raw = legacy()
    let latestAllowed = true
    await render({ value: '', baseline: '', canSaveNow: () => latestAllowed })
    latestAllowed = false
    act(held)
    expect(del).not.toHaveBeenCalled()
    expect(localStorage.getItem(LEGACY)).toBe(raw)
    expect(hook?.pending?.value).toBe('残す')
  })

  it('最新callbackがtrueでも保持clearの開始callbackが失効すれば拒否する', async () => {
    get.mockResolvedValue({ success: true, data: draft('残す', V1) })
    let originAllowed = true
    await render({ value: '', baseline: '', canSaveNow: () => originAllowed })
    await advance(0)
    const held = hook!.clear
    await render({ value: '', baseline: '', canSaveNow: () => true })
    originAllowed = false
    act(held)
    expect(del).not.toHaveBeenCalled()
    expect(hook?.pending?.value).toBe('残す')
  })

  it('許可が戻った後も古いclearは動かず、新しいclearだけが1回削除する', async () => {
    get.mockResolvedValue({ success: true, data: draft('残す', V1) })
    const yes = () => true
    await render({ value: '', baseline: '', canSaveNow: yes })
    await advance(0)
    const held = hook!.clear
    await render({ value: '', baseline: '', canSaveNow: () => false })
    await render({ value: '', baseline: '', canSaveNow: yes })
    act(held)
    expect(del).not.toHaveBeenCalled(); expect(hook?.pending?.value).toBe('残す')
    act(() => hook!.clear())
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('account-a', KEY, V1)
  })

  it('AからBを経てAへ戻っても保持clearで新しい下書きを消さない', async () => {
    get.mockResolvedValue({ success: true, data: draft('残す', V1) })
    const yes = () => true
    await render({ value: '', baseline: '', canSaveNow: yes })
    await advance(0)
    const held = hook!.clear
    await render({ value: '', baseline: '', accountId: 'account-b', canSaveNow: yes })
    await advance(0)
    await render({ value: '', baseline: '', canSaveNow: yes })
    await advance(0)
    act(held)
    expect(get).toHaveBeenCalledTimes(3)
    expect(del).not.toHaveBeenCalled(); expect(hook?.pending?.value).toBe('残す')
  })

  it('active=falseの新しいclearでもブラウザ控えは残す', async () => {
    const yes = () => true, raw = legacy()
    await render({ value: '', baseline: '', active: false, canSaveNow: yes })
    act(() => hook!.clear())
    expect(localStorage.getItem(LEGACY)).toBe(raw)
    expect(get).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled()
  })

  it('409後のGET中に拒否と許可を挟んでも版0の再作成は送らない', async () => {
    const response = deferred<unknown>(), yes = () => true
    get.mockImplementationOnce(notFound).mockReturnValueOnce(response.promise)
    save.mockImplementation(conflict)
    await render({ value: '', baseline: '', canSaveNow: yes })
    await advance(0)
    await render({ value: '入力中', baseline: '', canSaveNow: yes })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(2)
    await render({ value: '入力中', baseline: '', canSaveNow: () => false })
    await render({ value: '入力中', baseline: '', canSaveNow: yes })
    await act(async () => response.resolve({ success: false }))
    await advance(2500)
    expect(save).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
  })

  it('保持overwriteは拒否時に競合を消さず、再送しない', async () => {
    get.mockImplementationOnce(notFound).mockResolvedValueOnce({ success: true, data: draft('別の下書き', V2) })
    save.mockImplementation(conflict)
    await render({ value: '', baseline: '', canSaveNow: () => true })
    await advance(0)
    await render({ value: '入力中', baseline: '', canSaveNow: () => true })
    await advance(2100)
    expect(hook?.conflictAgo).not.toBeNull()
    const held = hook!.overwrite
    await render({ value: '入力中', baseline: '', canSaveNow: () => false })
    act(held)
    await advance(2500)
    expect(hook?.conflictAgo).not.toBeNull()
    expect(save).toHaveBeenCalledTimes(1); expect(del).not.toHaveBeenCalled()
  })

  it.each([false, true])('保存中のclear後に遅延成功が来ても、最新許可=%sならその許可で後片付けする', async allowed => {
    const response = deferred<unknown>(), yes = () => true
    save.mockReturnValue(response.promise)
    await render({ value: '', baseline: '', canSaveNow: yes })
    await advance(0)
    await render({ value: '入力中', baseline: '', canSaveNow: yes })
    await advance(2100)
    expect(save).toHaveBeenCalledTimes(1)
    act(() => hook!.clear())
    await render({ value: '入力中', baseline: '', canSaveNow: allowed ? yes : () => false })
    await act(async () => response.resolve({ success: true, data: draft('入力中', V1) }))
    expect(del).toHaveBeenCalledTimes(allowed ? 1 : 0)
    if (allowed) expect(del).toHaveBeenCalledWith('account-a', KEY, V1)
  })
})
