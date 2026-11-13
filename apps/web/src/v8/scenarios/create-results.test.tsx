import { getPageAction, querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
/*
 * ★V8 シナリオを作る①（create.tsx・）と配信結果（results.tsx・）の動きの試験。
 * BEHAVIOR.md の主な動きを守る：
 * - 作る①：はじめは「時刻で指定」を選び、2方式の図を要約で読める。既存の下書きは保存済みの方式。
 *   閲覧のみには保存の操作を灰色と理由付きで残す。「この方式で保存する」で作って1通目へ進む。
 * - 配信結果：購読の状態の札（途中・送れずに止まった・読み終えた）と「何通目まで」。
 *   「…」は配信中・止まっている行だけ、閲覧のみには置かない。配信失敗の行だけ「失敗を再送」。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

let search = ''
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
let role = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

const scenario = {
  id: 'sc-1', name: '新規登録7日間フォロー', description: null, triggerType: 'friend_add', triggerTagId: null,
  isActive: true, deliveryMode: 'elapsed', allowConcurrent: true, displayOrder: 0, folderId: null,
  lineAccountId: 'account-a', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  steps: [
    { id: 'st-1', scenarioId: 'sc-1', stepOrder: 1, delayMinutes: 0, offsetDays: 0, deliveryTime: '10:00' },
    { id: 'st-2', scenarioId: 'sc-1', stepOrder: 2, delayMinutes: 0, offsetDays: 1, deliveryTime: '20:00' },
  ],
}
const stats = { enrolledTotal: 10, activeNow: 3, completed: 5, paused: 1, steps: [{ stepOrder: 1, reachedCount: 10, reachRate: 1 }, { stepOrder: 2, reachedCount: 8, reachRate: 0.8 }] }
const metric = (value: number | null) => ({ value, state: value === null ? 'unavailable' : 'available', reason: null })
const sub = (id: string, friendName: string, status: string, currentStepOrder: number, pauseReason: string | null = null) => ({
  id, friendId: `f-${id}`, friendName, status, currentStepOrder, startedAt: '2026-09-01T00:00:00.000Z',
  nextDeliveryAt: status === 'active' ? '2026-10-04T01:00:00.000Z' : null, pauseReason, updatedAt: '2026-09-01T00:00:00.000Z',
})
const runs = {
  summary: { active: 2, paused: 2, completed: 5, delivering: 0 },
  subscriptions: [
    sub('s1', '見本 16', 'active', 3),
    sub('s2', '見本 27', 'paused', 2, 'delivery_failed'),
    sub('s3', '見本 143', 'paused', 1, 'manual'),
    sub('s4', 'Kyohei Yamamoto', 'completed', 4),
  ],
  pagination: { total: 4, limit: 50, cursor: '', nextCursor: null },
  testSends: [], quota: { limit: null, used: null, remaining: null, state: 'unavailable', reason: null, asOf: '' },
  concurrentBroadcasts: [], scenarioClickTotal: 0,
  steps: [
    { id: 'st-1', stepOrder: 1, delivered: 10, opened: metric(null), clicked: metric(4), failed: metric(1) },
    { id: 'st-2', stepOrder: 2, delivered: 8, opened: metric(null), clicked: metric(null), failed: metric(0) },
  ],
}

const create = vi.fn()
/* シナリオの下書きの口の見本（キーごとに1行・版は保存ごとに変わる）。 */
const drafts = new Map<string, { value: unknown; version: string; updatedAt: string }>()
const draftCalls: string[] = []
let draftSeq = 0
const draftRow = (key: string, row: { value: unknown; version: string; updatedAt: string }) => ({
  key, lineAccountId: 'account-a', content: { value: row.value }, scenarioId: null, stepId: null,
  version: row.version, updatedBy: 'staff-1', updatedAt: row.updatedAt, expiresAt: '2026-12-01T00:00:00.000Z',
})
vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: () => Promise.resolve({ success: true, data: scenario }),
    stats: () => Promise.resolve({ success: true, data: stats }),
    invalidateScenario: () => {},
  },
}))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      folders: { ...api.folders, list: () => Promise.resolve({ success: true, data: [] }) },
      scenarioDrafts: {
        get: async (_account: string, key: string) => {
          draftCalls.push(`GET ${key}`)
          const row = drafts.get(key)
          if (!row) throw new actual.ApiError(404, 'not_found', 'not_found')
          return { success: true, data: draftRow(key, row) }
        },
        save: async (_account: string, key: string, body: { expectedVersion: string | 0; content: { value: unknown } }) => {
          draftCalls.push(`PUT ${key}`)
          const row = drafts.get(key)
          if ((row?.version ?? 0) !== body.expectedVersion) throw new actual.ApiError(409, 'version_conflict', 'version_conflict')
          draftSeq += 1
          const next = { value: body.content.value, version: `00000000-0000-4000-8000-${String(draftSeq).padStart(12, '0')}`, updatedAt: new Date().toISOString() }
          drafts.set(key, next)
          return { success: true, data: draftRow(key, next) }
        },
        delete: async (_account: string, key: string, version: string) => {
          draftCalls.push(`DELETE ${key}`)
          if (drafts.get(key)?.version !== version) throw new actual.ApiError(409, 'version_conflict', 'version_conflict')
          drafts.delete(key)
          return { success: true }
        },
      },
      scenarios: {
        ...api.scenarios,
        create: (...args: unknown[]) => create(...args),
        runs: () => Promise.resolve({ success: true, data: runs }),
        friendPlan: () => Promise.resolve({ success: true, data: {
          scenarioId: 'sc-1', lineAccountId: 'account-a', friendId: 'f-unknown', friendName: '確認対象',
          computedAt: '2026-10-11T01:00:00Z', sideEffects: false, basis: 'pinned',
          subscription: { id: 'unknown', status: 'paused', currentStepOrder: 1, startedAt: '2026-10-01T01:00:00Z', nextDeliveryAt: null, pauseReason: 'delivery_unconfirmed' },
          start: { state: 'blocked', reasons: [] }, steps: [], warnings: [],
        } }),
      },
    },
  }
})

import ScenarioCreateV8 from './create'
import ScenarioResultsV8 from './results'

beforeEach(() => {
  role = verifiedStaffRole('owner')
  search = ''
  push.mockReset()
  create.mockReset()
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })

describe('作る①（dnzqC）', () => {
  test('名前を入力しても情報と配信方式は同じ作業中の手順に留まる', () => {
    render(<ScenarioCreateV8 />)
    fireEvent.change(screen.getByRole('textbox', { name: 'シナリオ名' }), { target: { value: '新しいシナリオ' } })
    const steps = screen.getByRole('navigation', { name: 'シナリオ作成の進み方' })
    const items = within(steps).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('シナリオ情報・配信方式')
    expect(items[0].getAttribute('data-step-state')).toBe('current')
    expect(items[1].getAttribute('data-step-state')).toBe('todo')
  })
  test('F7: 画面の説明が開け、名前の必須と欄の理由を読む', async () => {
    render(<ScenarioCreateV8 />)
    const name = screen.getByRole('textbox', { name: 'シナリオ名' })
    expect(name.getAttribute('aria-required')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'シナリオを作るの説明' }))
    expect(screen.getByText('名前とフォルダを決め、配信方式を選んでから1通目を設定します。作ったあとは配信方式を変えられません。')).toBeTruthy()
    const save = screen.getByRole('button', { name: /この方式で保存する/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.hasAttribute('data-permission-locked')).toBe(false)
    expect(save.getAttribute('aria-description')).toBe('シナリオ名を入力してください')
    expect(document.querySelector('[data-template-region="footer"] [role="status"]')?.textContent).toBe('シナリオ名を入力してください')
    fireEvent.click(save)
    expect(create).not.toHaveBeenCalled()
  })

  test('はじめは「時刻で指定」を選び、図を押しても方式を替えられ、札は個別に読ませない', async () => {
    render(<ScenarioCreateV8 />)
    const absolute = screen.getByRole('radio', { name: /時刻で指定/ }) as HTMLInputElement
    expect(absolute.checked).toBe(true)
    const diagrams = screen.getAllByRole('img')
    expect(diagrams).toHaveLength(2)
    expect(diagrams[0].getAttribute('aria-label')).toContain('両方に、1通目は当日15時、2通目は翌日20時')
    expect(diagrams[1].getAttribute('aria-label')).toContain('当日17時と翌日22時')
    for (const diagram of diagrams) expect(diagram.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(diagrams[1])
    expect(absolute.checked).toBe(false)
    expect((screen.getByRole('radio', { name: /経過時間で指定/ }) as HTMLInputElement).checked).toBe(true)
    expect(diagrams[0].getAttribute('data-selected')).toBe('false')
    expect(diagrams[1].getAttribute('data-selected')).toBe('true')
    fireEvent.click(diagrams[0])
    expect(absolute.checked).toBe(true)
    expect((screen.getByRole('radio', { name: /経過時間で指定/ }) as HTMLInputElement).checked).toBe(false)
    expect(diagrams[0].getAttribute('data-selected')).toBe('true')
    expect(diagrams[1].getAttribute('data-selected')).toBe('false')
    // 下の見本の表は置かない（図に入ったため・絵 ）。
    expect(screen.queryByRole('table', { name: '選んだ配信方式の見本' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '配信方式の説明' }))
    expect(screen.getByText('作ったあとは変えられません')).toBeTruthy()
  })

  test('既存の下書きは保存済みの方式を選び、下書きの帯を出す', async () => {
    search = 'id=sc-1'
    render(<ScenarioCreateV8 />)
    await screen.findByText('「新規登録7日間フォロー」の下書きを作りました。続けて配信方式を選んでください。')
    expect((screen.getByRole('radio', { name: /経過時間で指定/ }) as HTMLInputElement).checked).toBe(true)
  })

  test('この方式で保存する：名前と選んだ方式で作り、1通目へ進む', async () => {
    create.mockResolvedValue({ success: true, data: { id: 'new-1' } })
    render(<ScenarioCreateV8 />)
    fireEvent.change(screen.getByRole('textbox', { name: 'シナリオ名' }), { target: { value: '春のフォロー' } })
    fireEvent.click(screen.getByRole('button', { name: /この方式で保存する/ }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/scenarios/first-step?id=new-1'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '春のフォロー', deliveryMode: 'absolute_time' }))
  })

  test('WEB226：「あとで決める」で作れなかった（通信の失敗）ときも、理由を出す', async () => {
    create.mockRejectedValue(new Error('network'))
    render(<ScenarioCreateV8 />)
    fireEvent.change(screen.getByRole('textbox', { name: 'シナリオ名' }), { target: { value: '春のフォロー' } })
    fireEvent.click(getPageAction({ name: /あとで決める/ }))
    await waitFor(() => expect(screen.getByText('シナリオを作成できませんでした。時間をおいてもう一度お試しください。')).toBeTruthy())
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining('/scenarios/first-step'))
  })

  test('編集鍵が無い担当者にも保存の操作を残し、共通の理由と帯で拒む', () => {
    role = verifiedStaffRole('staff')
    render(<ScenarioCreateV8 />)
    const save = screen.getByRole('button', { name: /この方式で保存する/ })
    expect(save.hasAttribute('data-permission-locked')).toBe(true)
    expect(save.getAttribute('aria-disabled')).toBe('true')
    const draft = getPageAction({ name: /あとで決める/ })
    expect(draft.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
    fireEvent.click(save); fireEvent.click(draft)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('作る①：書きかけをシナリオの下書きの口へ残す（本物の行は作らない）', () => {
  function memoryStorage() {
    const map = new Map<string, string>()
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, String(value)) },
      removeItem: (key: string) => { map.delete(key) },
      get length() { return map.size },
    }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', memoryStorage())
    drafts.clear()
    draftCalls.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const settle = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

  test('名前を打って2秒で下書きの口へ残し、開き直すと「前の入力を戻す」で戻る。本物のシナリオは作らない', async () => {
    const first = render(<ScenarioCreateV8 />)
    await settle(0)
    fireEvent.change(screen.getByRole('textbox', { name: 'シナリオ名' }), { target: { value: '春のフォロー' } })
    fireEvent.click(screen.getByRole('radio', { name: /経過時間で指定/ }))
    await settle(2100)
    expect(document.body.textContent).toContain('下書き保存済み・0秒前')
    expect(create).not.toHaveBeenCalled()
    expect([...drafts.keys()]).toEqual([expect.stringMatching(/^new:/)])
    first.unmount()

    render(<ScenarioCreateV8 />)
    await settle(0)
    expect((screen.getByRole('textbox', { name: 'シナリオ名' }) as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).toContain('保存していない入力が残っています')
    fireEvent.click(screen.getByRole('button', { name: '前の入力を戻す' }))
    await settle(0)
    expect((screen.getByRole('textbox', { name: 'シナリオ名' }) as HTMLInputElement).value).toBe('春のフォロー')
    expect((screen.getByRole('radio', { name: /経過時間で指定/ }) as HTMLInputElement).checked).toBe(true)
  })

  test('以前このブラウザに残した書きかけは、一度だけ下書きの口へ移して消す', async () => {
    localStorage.setItem('lh:v8-draft:scenario-create:account-a:new', JSON.stringify({ savedAt: Date.now(), value: { name: '前の入力', folderId: '', mode: 'elapsed' } }))
    render(<ScenarioCreateV8 />)
    await settle(0)
    expect(localStorage.getItem('lh:v8-draft:scenario-create:account-a:new')).toBeNull()
    expect([...drafts.values()].map((row) => row.value)).toEqual([{ name: '前の入力', folderId: '', mode: 'elapsed' }])
    expect(screen.getByRole('button', { name: '前の入力を戻す' })).toBeTruthy()
  })

  test('作ったら下書きを消す', async () => {
    create.mockResolvedValue({ success: true, data: { id: 'new-1' } })
    render(<ScenarioCreateV8 />)
    await settle(0)
    fireEvent.change(screen.getByRole('textbox', { name: 'シナリオ名' }), { target: { value: '春のフォロー' } })
    await settle(2100)
    expect(drafts.size).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /この方式で保存する/ }))
    await settle(0)
    expect(push).toHaveBeenCalledWith('/scenarios/first-step?id=new-1')
    expect(drafts.size).toBe(0)
  })

  test('キャンセルで下書きを消して一覧へ戻る', async () => {
    render(<ScenarioCreateV8 />)
    await settle(0)
    fireEvent.change(screen.getByRole('textbox', { name: 'シナリオ名' }), { target: { value: '春のフォロー' } })
    await settle(2100)
    expect(drafts.size).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
    await settle(0)
    expect(drafts.size).toBe(0)
    expect(push).toHaveBeenCalledWith('/scenarios')
  })

  test('閲覧のみは下書きの口を読みも書きもせず、戻す帯も出さない', async () => {
    localStorage.setItem('lh:v8-draft:scenario-create:account-a:new', JSON.stringify({ savedAt: Date.now(), value: { name: '前の入力', folderId: '', mode: 'elapsed' } }))
    role = verifiedStaffRole('staff')
    render(<ScenarioCreateV8 />)
    await settle(2100)
    expect(draftCalls).toEqual([])
    expect(screen.queryByRole('button', { name: '前の入力を戻す' })).toBeNull()
  })
})

describe('配信結果（X4STXS）', () => {
  test('途中の通を削除した後も結果と購読者は画面上の順番で示す', async () => {
    const oldOrder = scenario.steps[1].stepOrder
    const oldCurrent = runs.subscriptions[1].currentStepOrder
    scenario.steps[1].stepOrder = 3
    runs.subscriptions[1].currentStepOrder = 3
    try {
      search = 'id=sc-1'; render(<ScenarioResultsV8 />)
      await screen.findByText('見本 27')
      expect(screen.getByRole('progressbar', { name: '2 通目の届いた率' })).toBeTruthy()
      expect(within(screen.getByText('見本 27').closest('[role="row"]')!).getByText('2 通目まで')).toBeTruthy()
    } finally { scenario.steps[1].stepOrder = oldOrder; runs.subscriptions[1].currentStepOrder = oldCurrent }
  })
  test('公開版に固定された購読にはAPIからの表示順を使う', async () => {
    const previous = runs.subscriptions[1]
    runs.subscriptions[1] = { ...previous, currentStepOrder: 3, currentDisplayOrder: 2 } as typeof previous
    try {
      search = 'id=sc-1'; render(<ScenarioResultsV8 />)
      await screen.findByText('見本 27')
      expect(within(screen.getByText('見本 27').closest('[role="row"]')!).getByText('2 通目まで')).toBeTruthy()
    } finally { runs.subscriptions[1] = previous }
  })
  test('再参加の古い完了と新しい途中を人数から引かず、購読件数と未取得を分ける', async () => {
    const previous = { total: stats.enrolledTotal, summary: { ...runs.summary } }
    stats.enrolledTotal = 1; runs.summary = { active: 1, paused: 0, completed: 2, delivering: 0 }
    try {
      search = 'id=sc-1'; render(<ScenarioResultsV8 />); await screen.findByText('見本 16')
      const metric = (name: string) => screen.getByText(name, { selector: '[data-kpi-label] span' }).closest('[data-kpi-presentation]')!
      expect(metric('始まった').querySelector('[data-kpi-number]')?.textContent).toBe('1')
      expect(metric('読み終えた').querySelector('[data-kpi-number]')?.textContent).toBe('2')
      expect(metric('読み終えた').textContent).toContain('件')
      expect(metric('途中').textContent).toContain('購読')
      expect(screen.getByText(/件（購読）$/)).toBeTruthy()
      expect(metric('離れた').querySelector('[data-kpi-number]')?.textContent).toBe('—')
      expect(metric('読み終えた').textContent).not.toContain('200.0%')
      expect(screen.queryByText(/ここで .*離れた/)).toBeNull()
    } finally { stats.enrolledTotal = previous.total; runs.summary = previous.summary }
  })

  test('送達不明は要確認と確認方法を出し、再開・再送・移動を出さない', async () => {
    const uncertain = sub('unknown', '確認対象', 'paused', 1, 'delivery_unconfirmed')
    runs.subscriptions.push(uncertain)
    try {
      search = 'id=sc-1'
      render(<ScenarioResultsV8 />)
      await screen.findByText('要確認')
      expect(screen.getByText(/届いたか確認できないため/)).toBeTruthy()
      expect(screen.getByText(/相手に到着を確認/)).toBeTruthy()
      expect(screen.getByText('—（要確認）')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '確認対象のその他の操作' })).toBeNull()
      expect(screen.getByRole('link', { name: 'トークの送信記録を確認' })).toBeTruthy()
      const row = (screen.getAllByRole('row').find(row => row.textContent?.includes('確認対象')) ?? querySupplementaryPageAction('確認対象'))!
      fireEvent.click(within(row).getByRole('button', { name: '予定を見る' }))
      const dialog = await screen.findByRole('dialog')
      await waitFor(() => expect(within(dialog).getByText('要確認')).toBeTruthy())
      expect(within(dialog).queryByText('画面からの停止')).toBeNull()
      expect(within(dialog).getByRole('link', { name: 'トークの送信記録を確認' }).getAttribute('href')).toBe('/chats?friend=f-unknown')
    } finally { runs.subscriptions.pop() }
  })

  test('状態の札・何通目まで・次に届く', async () => {
    search = 'id=sc-1'
    render(<ScenarioResultsV8 />)
    await screen.findByText('見本 16')
    expect(screen.getByText('送れずに止まった')).toBeTruthy()
    expect(screen.getByText('止まっている')).toBeTruthy()
    expect(screen.getAllByText('読み終えた').length).toBeGreaterThan(0)
    expect(within(screen.getByText('見本 16').closest('[role="row"]')!).getByText('—')).toBeTruthy()
    expect(screen.getAllByText('—（止めている）').length).toBe(2)
    expect(screen.getByText('届いた率 100.0%・開いた —・押した 4人')).toBeTruthy()
  })

  test('「…」は配信中・止まっている行だけ。配信失敗の行だけ「失敗を再送」', async () => {
    search = 'id=sc-1'
    render(<ScenarioResultsV8 />)
    await screen.findByText('見本 16')
    expect(screen.getByRole('button', { name: '見本 16のその他の操作' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kyohei Yamamotoのその他の操作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '見本 27のその他の操作' }))
    expect(await screen.findByRole('menuitem', { name: '失敗を再送' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '見本 143のその他の操作' }))
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '失敗を再送' })).toBeNull())
  })

  test('閲覧のみには行の「…」を置かない（予定を見るは出す）', async () => {
    role = verifiedStaffRole('staff')
    search = 'id=sc-1'
    render(<ScenarioResultsV8 />)
    await screen.findByText('見本 16')
    expect(screen.queryByRole('button', { name: /のその他の操作$/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /予定を見る/ }).length).toBeGreaterThan(0)
  })
})

afterEach(() => { verifiedStaffRole(null) })
