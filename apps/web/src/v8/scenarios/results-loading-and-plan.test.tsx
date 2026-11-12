// @vitest-environment happy-dom
/*
 * ★V8 シナリオ配信結果（results.tsx）の読み込みと友だち別の配信予定の動きの試験。
 * API のクライアントは本物を通し、通信（fetch）だけを差し替える。
 * - シナリオ・集計を先に出し、購読一覧は別の流れで読む
 * - 購読一覧の失敗は「まだいません」と言わず読み直しの口を出す。アカウント未選択は未取得
 * - アカウントを替えたあとに返った古い応答は捨てる
 * - 続きはカーソルで読み足し、状態の絞り込みはサーバーへ渡す
 * - 次の配信は日本時間で出し、ISO の文字のまま出さない
 * - 友だち別の配信予定は送らない試算口だけを読み、未確定・止まっている理由・配信されない理由を隠さない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const account = vi.hoisted(() => ({ id: 'account-a' as string | null }))
const reference = vi.hoisted(() => ({ scenario: vi.fn(), stats: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams('id=sc-1'),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})
vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: { scenario: reference.scenario, stats: reference.stats, invalidateScenario: () => {} },
}))

import ScenarioResultsV8 from './results'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'

const scenario = {
  id: 'sc-1', name: '新規登録7日間フォロー', description: null, triggerType: 'friend_add', triggerTagId: null,
  isActive: true, deliveryMode: 'elapsed', allowConcurrent: true, displayOrder: 0, folderId: null,
  lineAccountId: 'account-a', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  steps: [{ id: 'st-1', scenarioId: 'sc-1', stepOrder: 1, delayMinutes: 0, offsetDays: 0, deliveryTime: '10:00' }],
}
const stats = { enrolledTotal: 3, activeNow: 2, completed: 1, paused: 0, steps: [{ stepOrder: 1, reachedCount: 3, reachRate: 1 }] }
const metric = (value: number | null) => ({ value, state: value === null ? 'unavailable' : 'available', reason: null })
const sub = (id: string, friendName: string) => ({
  id, friendId: `f-${id}`, friendName, status: 'active', confirmationRevision: 4, currentStepOrder: 1, startedAt: '2026-09-01T00:00:00.000Z',
  nextDeliveryAt: '2026-10-04T01:00:00.000Z', pauseReason: null, updatedAt: '2026-09-01T00:00:00.000Z',
})
const runsBody = (subs: ReturnType<typeof sub>[], extra: { total?: number; nextCursor?: string | null } = {}) => ({
  summary: { active: subs.length, paused: 0, completed: 0, delivering: 0 },
  subscriptions: subs,
  pagination: { total: extra.total ?? subs.length, limit: 50, cursor: '', nextCursor: extra.nextCursor ?? null },
  testSends: [], quota: { limit: null, used: null, remaining: null, state: 'unavailable', reason: null, asOf: '' },
  concurrentBroadcasts: [], scenarioClickTotal: 0,
  steps: [{ id: 'st-1', stepOrder: 1, delivered: 3, opened: metric(null), clicked: metric(null), failed: metric(0) }],
})
const plan = (overrides: Record<string, unknown> = {}) => ({
  scenarioId: 'sc-1', lineAccountId: 'account-a', friendId: 'f-s1', friendName: '見本 16',
  computedAt: '2026-10-11T01:00:00Z', sideEffects: false, basis: 'published',
  subscription: { id: 's1', status: 'paused', currentStepOrder: 1, startedAt: '2026-10-01T01:00:00Z', nextDeliveryAt: '2026-10-12T11:00:00.000Z', pauseReason: 'after_send' },
  start: { state: 'blocked', reasons: ['ブロックされています'] },
  steps: [{ stepId: 'st-1', stepOrder: 1, scheduledAt: '10/12 20:00', outcome: 'deliver', dynamic: true, reason: 'タグで分かれます' }],
  warnings: ['条件のタグが消えています'],
  ...overrides,
})

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>
let handler: Handler
const requests: Array<{ method: string; path: string; search: URLSearchParams }> = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
function base(url: URL): Response {
  if (url.pathname === '/api/scenarios/sc-1/runs') return json({ success: true, data: runsBody([sub('s1', '見本 16')]) })
  if (url.pathname === '/api/friends') return json({ success: true, data: { items: [{ id: 'f-s9', displayName: '検証 太郎' }], total: 1, hasMore: false, nextCursor: null } })
  if (url.pathname === '/api/scenarios/sc-1/friends/f-s1/plan') return json({ success: true, data: plan() })
  return json({ success: true, data: {} })
}
const runsCalls = () => requests.filter((r) => r.path === '/api/scenarios/sc-1/runs')

beforeEach(() => {
  account.id = 'account-a'
  requests.length = 0
  handler = base
  reference.scenario.mockReset()
  reference.scenario.mockResolvedValue({ success: true, data: scenario })
  reference.stats.mockReset()
  reference.stats.mockResolvedValue({ success: true, data: stats })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.searchParams })
    return handler(url, init)
  }))
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('移動する購読の確認版と状態を送る', async () => {
  let sent: unknown
  handler = (url, init) => {
    if (url.pathname === '/api/scenarios') return json({success:true,data:{items:[scenario,{...scenario,id:'sc-2',name:'移動先'}]}})
    if (url.pathname === '/api/folders') return json({success:true,data:[]})
    if (url.pathname === '/api/scenario-subscriptions/s1/move') { sent=JSON.parse(String(init?.body)); return json({success:true,data:{}}) }
    return base(url)
  }
  render(<ScenarioResultsV8 />)
  await screen.findByText('見本 16')
  fireEvent.click(screen.getByRole('button',{name:'見本 16のその他の操作'}))
  fireEvent.click(screen.getByRole('menuitem',{name:'別のシナリオへ移す'}))
  await pickEntity('移し先のシナリオ','移動先')
  fireEvent.click(screen.getByRole('button',{name:'このシナリオへ移す'}))
  await waitFor(()=>expect(sent).toEqual({targetScenarioId:'sc-2',expectedConfirmationRevision:4,expectedStatus:'active'}))
})

describe('読み込みの状態', () => {
  test('シナリオと集計の失敗は1枚にし、読み直すと出る', async () => {
    reference.scenario.mockRejectedValueOnce(new Error('offline'))
    render(<ScenarioResultsV8 />)
    await screen.findByText('配信結果を読み込めませんでした')
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('見本 16')
    expect(reference.scenario).toHaveBeenCalledTimes(2)
  })

  test('購読一覧を待たずに通ごとの反応を出す', async () => {
    handler = (url) => url.pathname === '/api/scenarios/sc-1/runs' ? new Promise<Response>(() => {}) : base(url)
    render(<ScenarioResultsV8 />)
    await screen.findByRole('heading', { name: '通ごとの反応' })
    expect(screen.getByLabelText('購読一覧を読み込んでいます').getAttribute('aria-busy')).toBe('true')
  })

  test('購読一覧の失敗は「まだいません」と言わず、読み直すと一覧だけ取り直す', async () => {
    let fail = true
    handler = (url) => url.pathname === '/api/scenarios/sc-1/runs' && fail ? json({ success: false, error: 'down' }, 500) : base(url)
    render(<ScenarioResultsV8 />)
    // 失敗の1枚は共通部品が「〜を読み込めませんでした」にそろえる。
    await screen.findByText('購読一覧を読み込めませんでした')
    expect(screen.queryByText('購読している友だちはまだいません')).toBeNull()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('見本 16')
    expect(reference.scenario).toHaveBeenCalledTimes(1)
  })

  test('正常に0件のときだけ「まだいません」を出す', async () => {
    handler = (url) => url.pathname === '/api/scenarios/sc-1/runs' ? json({ success: true, data: runsBody([]) }) : base(url)
    render(<ScenarioResultsV8 />)
    await screen.findByText('購読している友だちはまだいません')
  })

  test('アカウント未選択は未取得として案内し、購読一覧を読まない', async () => {
    account.id = null
    render(<ScenarioResultsV8 />)
    await screen.findByText('上部のLINEアカウントを選ぶと、購読している友だちの一覧を表示します。')
    expect(screen.queryByText('購読している友だちはまだいません')).toBeNull()
    expect(runsCalls()).toHaveLength(0)
  })

  test('アカウントを替えたあとに返った前のアカウントの一覧は捨てる', async () => {
    let lateA!: (response: Response) => void
    handler = (url) => {
      if (url.pathname !== '/api/scenarios/sc-1/runs') return base(url)
      if (url.searchParams.get('lineAccountId') === 'account-a') return new Promise<Response>((resolve) => { lateA = resolve })
      return json({ success: true, data: runsBody([sub('s2', '見本 27')]) })
    }
    const view = render(<ScenarioResultsV8 />)
    await waitFor(() => expect(runsCalls()).toHaveLength(1))
    account.id = 'account-b'
    view.rerender(<ScenarioResultsV8 />)
    await screen.findByText('見本 27')
    lateA(json({ success: true, data: runsBody([sub('s1', '見本 16')]) }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('見本 16')).toBeNull()
    expect(screen.getByText('見本 27')).toBeTruthy()
  })
})

describe('購読一覧のページと絞り込み', () => {
  test('50件ずつ読み、続きはカーソルで読み足して件数は全体で出す', async () => {
    handler = (url) => {
      if (url.pathname !== '/api/scenarios/sc-1/runs') return base(url)
      return url.searchParams.get('cursor') === 'next-1'
        ? json({ success: true, data: runsBody([sub('s2', '見本 27')], { total: 2 }) })
        : json({ success: true, data: runsBody([sub('s1', '見本 16')], { total: 2, nextCursor: 'next-1' }) })
    }
    render(<ScenarioResultsV8 />)
    await screen.findByText('見本 16')
    expect(runsCalls()[0].search.get('limit')).toBe('50')
    expect(screen.getByText('1 / 2 件（購読）')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'さらに読み込む' }))
    await screen.findByText('見本 27')
    expect(screen.getByText('見本 16')).toBeTruthy()
    expect(screen.getByText('2 / 2 件（購読）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'さらに読み込む' })).toBeNull()
  })

  test('状態の絞り込みはサーバーへ渡す', async () => {
    render(<ScenarioResultsV8 />)
    await screen.findByText('見本 16')
    fireEvent.click(screen.getByRole('button', { name: '購読の状態で絞り込む' }))
    fireEvent.click(within(await screen.findByRole('option', { name: '止まっている' })).getByRole('button'))
    await waitFor(() => expect(runsCalls().at(-1)?.search.get('status')).toBe('paused'))
  })
})

describe('次の配信の日時', () => {
  test('一覧の「次に届く」は日本時間で出し、ISO の文字のまま出さない', async () => {
    render(<ScenarioResultsV8 />)
    const row = (await screen.findByText('見本 16')).closest('[role="row"]') as HTMLElement
    expect(row.textContent).toContain('10:00')
    expect(row.textContent).not.toContain('2026-10-04T01:00')
  })
})

describe('友だち別の配信予定', () => {
  async function openPlanForRow() {
    render(<ScenarioResultsV8 />)
    const row = (await screen.findByText('見本 16')).closest('[role="row"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '予定を見る' }))
    return screen.findByRole('dialog')
  }

  test('送らない試算口だけを読み、送らないことを断る', async () => {
    const dialog = await openPlanForRow()
    expect(dialog.textContent).toContain('送信・シナリオへの登録・タグの更新は行いません')
    await within(dialog).findByText('いまはこの友だちへ配信されません')
    const planCall = requests.find((r) => r.path === '/api/scenarios/sc-1/friends/f-s1/plan')
    expect(planCall?.search.get('lineAccountId')).toBe('account-a')
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([])
  })

  test('未確定・止まっている理由・配信されない理由・注意を隠さず、次の予定は日本時間', async () => {
    const dialog = await openPlanForRow()
    await within(dialog).findByText('いまはこの友だちへ配信されません')
    expect(within(dialog).getByText('ブロックされています')).toBeTruthy()
    // 届く見通しでも、配信時点の条件で変わる通は「未確定」を添える。
    expect(within(dialog).getByText('届く見通し')).toBeTruthy()
    expect(within(dialog).getByText('未確定')).toBeTruthy()
    expect(within(dialog).getByText('タグで分かれます')).toBeTruthy()
    expect(within(dialog).getByText('止まっている理由')).toBeTruthy()
    expect(within(dialog).getByText('この通を送ったあと止める設定')).toBeTruthy()
    expect(within(dialog).getByText('条件のタグが消えています')).toBeTruthy()
    const next = within(dialog).getByText('次の配信予定').nextElementSibling as HTMLElement
    expect(next.textContent).toContain('20:00')
    expect(next.textContent).not.toContain('T11:00')
  })

  test('まだ始まっていない友だちは「まだ開始していません」', async () => {
    handler = (url) => url.pathname === '/api/scenarios/sc-1/friends/f-s1/plan'
      ? json({ success: true, data: plan({ subscription: null, start: { state: 'ok', reasons: [] }, steps: [], warnings: [] }) })
      : base(url)
    const dialog = await openPlanForRow()
    await within(dialog).findByText('まだ開始していません')
    expect(within(dialog).queryByText('次の配信予定')).toBeNull()
  })

  test('副作用なしと言えない応答は予定として出さない', async () => {
    handler = (url) => url.pathname === '/api/scenarios/sc-1/friends/f-s1/plan'
      ? json({ success: true, data: plan({ sideEffects: true }) })
      : base(url)
    const dialog = await openPlanForRow()
    await within(dialog).findByText('配信予定を確認できませんでした')
    expect(within(dialog).queryByText('いまはこの友だちへ配信されません')).toBeNull()
  })
})
