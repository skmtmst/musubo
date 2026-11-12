// @vitest-environment happy-dom
/*
 * V8 自動応答一覧（src/v8）の動きの試験。BEHAVIOR.md の主要な動きを守る。
 * 行が出る・言葉で絞れる・止める窓が開く・選ぶとまとめ帯が出る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listReplies = vi.hoisted(() => vi.fn())
const listTemplates = vi.hoisted(() => vi.fn())
const summary = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const updateRule = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: { ...actual.api.autoReplies, list: listReplies, summary, update: updateRule },
      templates: { ...actual.api.templates, list: listTemplates },
      folders: { ...actual.api.folders, list: listFolders },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner', canManageRole: () => true }
})

import AutoRepliesListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const ruleA = {
  id: 'ar-1',
  name: '営業時間外の自動返信',
  keyword: '営業時間',
  matchType: 'contains',
  keywords: null,
  respondToAll: false,
  isActive: true,
  lifecycleStatus: 'published',
  hits: { period: 5, total: 20 },
  responseContent: '営業時間外です',
  responseType: 'text',
  keywordMatchMode: 'any',
  activeFrom: null,
  activeUntil: null,
  responseWeekdays: null,
  responseHolidayRule: null,
  cooldownMinutes: null,
  skipWhenOperatorActive: false,
  oncePerFriend: false,
  messageKinds: null,
  friendConditions: null,
  folderId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const ruleB = { ...ruleA, id: 'ar-2', name: '予約変更のお問い合わせ', keyword: '予約', responseContent: 'ご予約を承ります', isActive: false, lifecycleStatus: 'stopped' }

beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  window.history.replaceState(null, '', '/auto-replies')
  document.documentElement.dataset.theme = 'v8'
  listReplies.mockImplementation(async () => ({ success: true, data: [ruleA, ruleB] }))
  listTemplates.mockImplementation(async () => ({ success: true, data: [] }))
  summary.mockImplementation(async () => ({ success: true, data: { conflictCount: 0, dispatchStopped: false } }))
  listFolders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 0 }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  forgetStaffIdentity(); forgetSessionSnapshot()
  host.remove()
  delete document.documentElement.dataset.theme
})

/* 広い板のふり（happy-dom は狭い板扱いで選ぶ箱・つまみが出ない）。 */
function stubWideViewport() {
  const real = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }),
    configurable: true,
  })
  return () => {
    Object.defineProperty(window, 'matchMedia', { value: real, configurable: true })
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('V8 自動応答一覧（src/v8）の動き', () => {
  it('行が2件出る', async () => {
    act(() => { root.render(<AutoRepliesListV8 />) })
    await flush()
    expect(host.textContent).toContain('営業時間外の自動返信')
    expect(host.textContent).toContain('予約変更のお問い合わせ')
  })

  it('言葉で絞ると1件になる', async () => {
    act(() => { root.render(<AutoRepliesListV8 />) })
    await flush()
    const search = host.querySelector('input[placeholder="ルール名・言葉で探す"]') as HTMLInputElement
    expect(search, '探す欄がありません').toBeTruthy()
    fireEvent.change(search, { target: { value: '営業時間' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await flush()
    expect(host.textContent).toContain('営業時間外の自動返信')
    expect(host.textContent).not.toContain('予約変更のお問い合わせ')
  })

  it('選ぶとまとめ帯が出る', async () => {
    const restore = stubWideViewport()
    try {
      act(() => { root.render(<AutoRepliesListV8 />) })
      await flush()
      const checkbox = host.querySelector('input[type="checkbox"][aria-label="営業時間外の自動返信を選択"]') as HTMLInputElement
      expect(checkbox, '行の選択肢がありません').toBeTruthy()
      act(() => { checkbox.click() })
      await flush()
      expect(host.textContent).toContain('1件を選択中')
      expect(host.textContent).toContain('まとめて止める')
    } finally {
      restore()
    }
  })
})

it('WEB083: 4番目を先頭へドラッグして保存後もD,A,B,Cになる', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const restore = stubWideViewport()
  let stored = ['A', 'B', 'C', 'D'].map((id, priority) => ({ ...ruleA, id, name: id, priority, lineAccountId: 'account-a' }))
  listReplies.mockImplementation(async () => ({ success: true, data: stored }))
  updateRule.mockImplementation(async (id: string, patch: { priority: number }) => {
    stored = stored.map(r => r.id === id ? { ...r, ...patch } : r)
    return { success: true }
  })
  try {
    act(() => { root.render(<AutoRepliesListV8 />) }); await flush()
    const from = host.querySelector<HTMLElement>('[data-reorder-id="D"] [data-reorder-handle]')!
    const to = host.querySelector<HTMLElement>('[data-reorder-id="A"]')!
    expect(from).toBeTruthy()
    act(() => { fireEvent.dragStart(from) }); act(() => { fireEvent.drop(to) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) }); await flush()
    expect([...stored].sort((a,b) => a.priority - b.priority).map(r => r.id)).toEqual(['D', 'A', 'B', 'C'])
    expect(new Set(stored.map(r => r.priority)).size).toBe(4)
  } finally { restore(); vi.useRealTimers() }
})

it('取得失敗を空の一覧にせず、その場で読み直すとルールが戻る', async () => {
  listReplies.mockResolvedValueOnce({ success: false, error: '通信に失敗しました' })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).not.toContain('まだ自動応答のルールはありません')
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'もう一度読み込む')
  expect(retry).toBeTruthy()
  const calls = listReplies.mock.calls.length
  act(() => { retry!.click() })
  await flush()
  expect(listReplies.mock.calls.length).toBe(calls + 1)
  expect(host.textContent).toContain('営業時間外の自動返信')
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'もう一度読み込む')).toBe(false)
})

it('取得に成功して0件だったときだけ、空の一覧を出す', async () => {
  listReplies.mockResolvedValue({ success: true, data: [] })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('まだ自動応答のルールはありません')
  expect(host.textContent).not.toContain('実行結果を読み込めませんでした')
  expect([...host.querySelectorAll('[data-kpi-number]')].map(node => node.textContent)).toEqual(['0', '0', '0', '0'])
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'もう一度読み込む')).toBe(false)
})

it('ルールの実行結果が未取得のときは0回に置き換えない', async () => {
  listReplies.mockResolvedValue({ success: true, data: [{ ...ruleA, hits: undefined, actionExecutionCount: null }] })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('実行結果を読み込めませんでした')
  expect([...host.querySelectorAll('[data-kpi-number]')].map(node => node.textContent)).toEqual(['1', '—', '—', '0'])
})

it('取得済みのルールの実行回数は合計して表示する', async () => {
  listReplies.mockResolvedValue({ success: true, data: [
    { ...ruleA, actionExecutionCount: 2 },
    { ...ruleB, actionExecutionCount: 3 },
  ] })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('累計 40回')
  expect(host.textContent).not.toContain('実行結果を読み込めませんでした')
  expect([...host.querySelectorAll('[data-kpi-number]')].map(node => node.textContent)).toEqual(['1', '10', '5', '0'])
})

it('未分類の件数は一覧と同じ選択中の店舗だけを数える', async () => {
  const restore = stubWideViewport()
  try {
    listReplies.mockResolvedValue({ success: true, data: [] })
    listFolders.mockImplementation(async (_kind, accountId) => ({ success: true, data: [], unfiledCount: accountId === 'account-a' ? 0 : 5 }))
    act(() => { root.render(<AutoRepliesListV8 />) })
    await flush()
    expect(listFolders).toHaveBeenCalledWith('auto_reply', 'account-a')
    expect(host.querySelector('button[title="未分類"]')?.textContent).toBe('未分類0')
  } finally { restore() }
})


describe('読込骨格の表示時間と完了への切替', () => {
  it.each(['ready', 'error'])('遅い応答から%sへ進むとき表示後400msを保つ', async (outcome) => {
    vi.useFakeTimers()
    let complete!: (value: unknown) => void
    listReplies.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const shownBones = () => [...host.querySelectorAll('[aria-busy="true"] [data-skeleton]')]
      .filter(bone => !bone.closest('[data-skeleton-reserve]'))
    try {
      act(() => { root.render(<AutoRepliesListV8 />) })
      await flush()
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(shownBones()).toHaveLength(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(shownBones().length).toBeGreaterThan(0)
      expect(shownBones().every(bone => bone.tagName === 'SPAN' && bone.children.length === 0)).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      await act(async () => { complete(outcome === 'ready'
        ? { success: true, data: [ruleA] }
        : { success: false, error: '画面確認用の読込失敗' }) })
      await flush()
      expect(shownBones().length).toBeGreaterThan(0)
      expect(host.querySelector('[data-row-id]')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(349) })
      expect(shownBones().length).toBeGreaterThan(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(shownBones()).toHaveLength(0)
      if (outcome === 'ready') expect(host.querySelector('[data-row-id]')).toBeTruthy()
      else expect(host.textContent).toContain('読み込めませんでした')
    } finally { vi.useRealTimers() }
  })

  it('300ms以内の応答は骨格を見せず行へ切り替える', async () => {
    vi.useFakeTimers()
    let complete!: (value: unknown) => void
    listReplies.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    try {
      act(() => { root.render(<AutoRepliesListV8 />) }); await flush()
      await act(async () => { await vi.advanceTimersByTimeAsync(250); complete({ success: true, data: [ruleA] }) })
      await flush()
      expect(host.querySelector('[data-row-id]')).toBeTruthy()
      expect(host.querySelector('[aria-busy="true"] [data-skeleton]')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(host.querySelector('[aria-busy="true"] [data-skeleton]')).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

it('すべて・フォルダ・未分類を同じ一覧で数え、別の集計を混ぜない', async()=>{
 listReplies.mockResolvedValueOnce({success:true,data:[{...ruleA,folderId:'folder-a'},ruleB]})
 listFolders.mockResolvedValueOnce({success:true,data:[{id:'folder-a',name:'問合せ',itemCount:99}],unfiledCount:98})
 act(()=>root.render(<AutoRepliesListV8/>)); await flush()
 const rows=[...host.querySelectorAll('aside [data-part="folder-row"]')].map(el=>el.textContent?.replace(/\s/g,''))
 expect(rows).toEqual(expect.arrayContaining(['すべて2','問合せ1','未分類1']))
})

it('フォルダの数は表示ページの20件ではなく取得した26件全体を数える', async () => {
  listReplies.mockResolvedValueOnce({ success: true, data: Array.from({ length: 26 }, (_, index) => ({
    ...ruleA, id: `rule-${index}`, name: `ルール${index}`, folderId: index < 13 ? 'folder-a' : null,
  })) })
  listFolders.mockResolvedValueOnce({ success: true, data: [{ id: 'folder-a', name: '問合せ', itemCount: 99 }], unfiledCount: 98 })
  act(() => root.render(<AutoRepliesListV8 />)); await flush()
  const counts = () => [...host.querySelectorAll('aside [data-part="folder-row"]')].map(el => el.textContent?.replace(/\s/g, ''))
  expect(counts()).toEqual(expect.arrayContaining(['すべて26', '問合せ13', '未分類13']))
  expect(host.querySelectorAll('[data-row-id]')).toHaveLength(20)
  fireEvent.click(host.querySelector<HTMLButtonElement>('button[aria-label="次のページ"]')!)
  await flush()
  expect(host.querySelectorAll('[data-row-id]')).toHaveLength(6)
  expect(counts()).toEqual(expect.arrayContaining(['すべて26', '問合せ13', '未分類13']))
})

it('確認できる自動応答の有効状態を一覧の上に示す', async () => {
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('確認できる自動応答に、有効なルールがあります。')
})

it('緊急停止中は有効ルールがあっても自動応答を送らないと示す', async () => {
  summary.mockResolvedValue({ success: true, data: { conflictCount: 0, dispatchStopped: true } })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('停止中です。いま自動応答は送られません。')
  expect(host.textContent).not.toContain('確認できる自動応答に、有効なルールがあります。')
})

it('送信状態が読めなければ不明と表示する', async () => {
  summary.mockResolvedValue({ success: true, data: { conflictCount: 0, dispatchStopped: null } })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('自動応答全体の送信状態を確認できません。')
})

it('確認できる有効なルールがない時はその範囲を明示する', async () => {
  listReplies.mockResolvedValue({ success: true, data: [ruleB] })
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).toContain('確認できる自動応答に、有効なルールはありません。')
})

it('自動応答を取得できない時は状態を断定しない', async () => {
  listReplies.mockRejectedValue(new Error('offline'))
  act(() => { root.render(<AutoRepliesListV8 />) })
  await flush()
  expect(host.textContent).not.toContain('確認できる自動応答のうち、有効なルールが')
  expect(host.textContent).not.toContain('確認できる自動応答に、有効なルールはありません。')
})
