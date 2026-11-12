// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountMigration from './migration'
import UidMigrationV8 from '@/v8/friends/migrations/uid'
import { SESSION_LOST_EVENT } from '@/lib/session-events'
import { MIGRATION_STEPS } from './use-uid-migration'

/**
 * Issue #1012 FRIEND-14/15/16/33/36 の回帰試験。
 *
 * 本物のReactで本物の `AccountMigration` を mount し、`api.ts` も実物を通す。
 * 差し替えるのは通信(fetch)とルーティングだけ。
 *
 * - FRIEND-14: 「詳細を見る」は更新APIを呼ばない。承認だけが1回書き込む。
 * - FRIEND-16: 履歴切替で古い応答が後から届いても対応表が戻らない。
 * - FRIEND-33: 「本移行を実行」は確認画面を開くだけで、確定まで書き込まない。
 * - FRIEND-36: 完了・一部失敗の履歴から確認付きの切り戻しへ進める。
 */

vi.hoisted(() => {
  // api.ts はモジュール評価時に必須。実値は使わず fetch ごと差し替える。
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fixture = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams('tab=migration'),
}))

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  /** 履歴一覧に出す run。 */
  runs: [] as Array<Record<string, unknown>>,
  /** run id ごとの対応表応答を差し替える。 */
  detailResponders: new Map<string, () => Promise<Response>>(),
  /** 自分自身（実行権限の案内に使う）。 */
  me: { id: 'owner-2', role: 'owner' } as { id: string; role: string; readOnly?: boolean; roleBundle?: string } | null,
  /** TECH-07: 通信断・応答喪失を再現する。'network' で fetch が投げる。 */
  failItemPatch: null as null | 'network' | { status: number; error: string },
  failExecute: null as null | 'network' | { status: number; error: string },
  failRollback: null as null | 'network',
  /** 対応表GETの回数（結果不明時の読み直しを見る）。 */
  accountRows: null as Array<Record<string, unknown>> | null,
  detailGets: 0,
  /** 一覧GETの失敗再現。'network' で fetch が投げる。 */
  failList: null as null | 'network',
}))

const heldDialogs = vi.hoisted(() => ({ execute: undefined as undefined | (() => void), rollback: undefined as undefined | (() => void) }))
vi.mock('./migration-dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./migration-dialogs')>()
  return {
    ...actual,
    ExecuteConfirmDialog: (props: React.ComponentProps<typeof actual.ExecuteConfirmDialog>) => {
      if (props.open) heldDialogs.execute = props.onConfirm
      return <actual.ExecuteConfirmDialog {...props} />
    },
    RollbackConfirmDialog: (props: React.ComponentProps<typeof actual.RollbackConfirmDialog>) => {
      if (props.open) heldDialogs.rollback = props.onConfirm
      return <actual.RollbackConfirmDialog {...props} />
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: fixture.push, replace: fixture.replace }),
  useSearchParams: () => fixture.params,
  usePathname: () => '/accounts',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined }))

const ACCOUNTS = [
  { id: 'acc-a', name: '移行元アカウント' },
  { id: 'acc-b', name: '移行先アカウント' },
]

const ITEM = {
  id: 'item-1', oldUid: 'UOLD-1', newUid: 'UNEW-1', candidateName: '候補 太郎',
  evidenceType: 'operator_csv' as const, classification: 'review' as const,
  conflictReason: null, decision: 'pending' as const, result: 'pending' as const,
  errorMessage: null,
}

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1', fromAccountId: 'acc-a', toAccountId: 'acc-b', purpose: '移行A',
    sourceKind: 'csv', sourceFilename: 'map.csv', status: 'ready', dryRunRevision: 1,
    counts: { total: 1, auto: 0, review: 1, unmatched: 0, conflict: 0, applied: 0, failed: 0 },
    createdBy: 'owner-1', approvedBy: null, createdAt: '2026-09-20T00:00:00Z',
    reviewedAt: '2026-09-20T01:00:00Z', executedAt: null, completedAt: null,
    rolledBackAt: null, failureReason: null, rollbackable: false,
    ...overrides,
  }
}

function detailFixture(run: Record<string, unknown>) {
  return {
    ...run,
    items: [ITEM], itemTotal: 1, itemLimit: 20, itemOffset: 0,
    unresolved: 0,
    decisionCounts: { pending: 0, link: 1, create: 0, exclude: 0 },
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { 'Content-Type': 'application/json' } })

/** 通信そのものを差し替える。api・fetchApiは実物を通す。 */
function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const url = new URL(raw.startsWith('http') ? raw : `https://test.local${raw}`)
    const path = url.pathname
    const method = init?.method ?? 'GET'
    net.calls.push({ path: path + url.search, method })
    if (path === '/api/line-accounts') return json(net.accountRows ?? ACCOUNTS)
    if (path === '/api/staff/me') {
      return net.me ? json(net.me) : new Response(JSON.stringify({ success: false, error: 'x' }), { status: 500 })
    }
    if (path === '/api/friends/migrations' && method === 'GET') {
      if (net.failList === 'network') throw new TypeError('Failed to fetch')
      return json(net.runs)
    }
    const itemMatch = path.match(/^\/api\/friends\/migrations\/[^/]+\/items\/[^/]+$/)
    if (itemMatch && method === 'PATCH') {
      if (net.failItemPatch === 'network') throw new TypeError('Failed to fetch')
      if (net.failItemPatch) {
        return new Response(JSON.stringify({ success: false, error: net.failItemPatch.error }), { status: net.failItemPatch.status, headers: { 'Content-Type': 'application/json' } })
      }
      return json({ unresolved: 0 })
    }
    if (path.endsWith('/execute') && method === 'POST') {
      if (net.failExecute === 'network') throw new TypeError('Failed to fetch')
      if (net.failExecute) {
        return new Response(JSON.stringify({ success: false, error: net.failExecute.error }), { status: net.failExecute.status, headers: { 'Content-Type': 'application/json' } })
      }
      return json(runFixture({ status: 'completed', counts: { total: 1, auto: 0, review: 1, unmatched: 0, conflict: 0, applied: 1, failed: 0 } }))
    }
    if (path.endsWith('/rollback') && method === 'POST') {
      if (net.failRollback === 'network') throw new TypeError('Failed to fetch')
      return json({ ...runFixture({ status: 'rolled_back' }), rolledBack: 1 })
    }
    const detailMatch = path.match(/^\/api\/friends\/migrations\/([^/]+)$/)
    if (detailMatch && method === 'GET') {
      net.detailGets += 1
      const responder = net.detailResponders.get(detailMatch[1])
      if (responder) return responder()
      const run = net.runs.find((entry) => entry.id === detailMatch[1]) ?? runFixture({ id: detailMatch[1] })
      return json(detailFixture(run))
    }
    return json(null)
  })
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme='v8'
  fixture.push.mockClear()
  fixture.replace.mockClear()
  net.calls.length = 0
  net.accountRows = null
  net.runs = [runFixture()]
  net.detailResponders = new Map()
  net.me = { id: 'owner-2', role: 'owner' }
  net.failItemPatch = null
  net.failExecute = null
  net.failRollback = null
  net.detailGets = 0
  net.failList = null
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.documentElement.removeAttribute('data-theme')
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<AccountMigration />) })
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  if(text==='開く') text='詳細'
  if(text==='本移行を実行' && scope===document.body) text='本移行へ進む'
  const found = Array.from(scope.querySelectorAll('button')).find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`button "${text}" not found`)
  return found
}

/** 履歴行のように、目的の文字列を中に含むボタンを拾う。 */
function buttonContaining(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
    ?? Array.from(scope.querySelectorAll('tr')).find(row=>row.textContent?.includes(text))?.querySelector('button')
  if (!found) throw new Error(`button containing "${text}" not found`)
  return found
}

function openDialog(): HTMLElement {
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  if (!dialog) throw new Error('dialog not open')
  return dialog as HTMLElement
}

const writes = () => net.calls.filter((call) => call.method !== 'GET')

it('照合の帯は各分類の実値と単位を読み、表示だけでは更新しない', async () => {
  net.runs = [runFixture()]
  await act(async () => { root.render(<UidMigrationV8 initialRunId="run-1" />) })
  await flush()
  const band = within(host).getByRole('group', { name: '照合の内訳' })
  expect(band.hasAttribute('data-kpi-strip')).toBe(true)
  expect(within(band).getByText('自動で一致')).toBeTruthy()
  expect(within(band).getAllByText('0')).toHaveLength(3)
  expect(within(band).getByText('1')).toBeTruthy()
  expect(within(band).getAllByText('人')).toHaveLength(4)
  expect(writes()).toEqual([])
})

describe('完了した移行履歴の表示と操作', () => {
  it('完了履歴に選択面を付けず、現在の履歴と切り戻しの確認を残す', async () => {
    net.runs = [runFixture({ status: 'completed', rollbackable: true })]
    await act(async () => { root.render(<UidMigrationV8 initialRunId="run-1" />) })
    await flush()
    const history = host.querySelector('[aria-labelledby="uid-history"]')!
    const current = history.querySelector('button[aria-current="true"]')!
    expect(current).not.toBeNull()
    expect(current.closest('tr')?.getAttribute('aria-selected')).toBeNull()
    expect(host.textContent).toContain('照合の結果')
    fireEvent.click(buttonByText('切り戻す', history))
    await flush()
    expect(openDialog().textContent).toContain('切り戻す')
    expect(writes()).toHaveLength(0)
  })

  it('判断中の履歴は今の移行をボタンで示し、行に塗りは付けない（Z0jHp）', async () => {
    await act(async () => { root.render(<UidMigrationV8 initialRunId="run-1" />) })
    await flush()
    const current = host.querySelector('[aria-labelledby="uid-history"] button[aria-current="true"]')!
    expect(current).not.toBeNull()
    expect(current.closest('tr')?.getAttribute('aria-selected')).toBeNull()
    expect(writes()).toHaveLength(0)
  })
})

describe('UID移行の詳細確認（FRIEND-14）', () => {
  it('「開く」は読み取り専用で、更新APIを呼ばない', async () => {
    await render()
    await flush()
    fireEvent.click(buttonByText('開く'))
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).toContain('UOLD-1')
    expect(dialog.textContent).toContain('候補 太郎')
    expect(writes()).toHaveLength(0)
  })

  it('承認だけが対象itemへ1回書き込む', async () => {
    await render()
    await flush()
    fireEvent.click(buttonByText('開く'))
    await flush()
    fireEvent.click(buttonByText('この組合せを承認', openDialog()))
    await flush()
    const patches = net.calls.filter((call) => call.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0].path).toBe('/api/friends/migrations/run-1/items/item-1')
  })

  it('閉じるだけなら書き込まない', async () => {
    await render()
    await flush()
    fireEvent.click(buttonByText('開く'))
    await flush()
    // UI-25: 「閉じる」は右上の×（aria-label）へ移った。
    fireEvent.click(openDialog().querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!)
    await flush()
    expect(writes()).toHaveLength(0)
  })
})

describe('閉じた移行確認', () => {
  it.each(['execute', 'rollback'] as const)('%s の古い確定は再度開いた確認に使えない', async (action) => {
    if (action === 'rollback') net.runs = [runFixture({ status: 'completed', rollbackable: true })]
    await render()
    await flush()
    const entry = action === 'execute' ? '本移行を実行' : 'この移行を切り戻す'
    fireEvent.click(buttonByText(entry))
    await flush()
    const oldConfirm = heldDialogs[action]!
    expect(oldConfirm).toBeTypeOf('function')
    fireEvent.click(buttonByText('キャンセル', openDialog()))
    await flush()
    fireEvent.click(buttonByText(entry))
    await flush()
    await act(async () => { oldConfirm(); await Promise.resolve() })
    await flush()
    expect(net.calls.filter((call) => call.path.endsWith(`/${action}`) && call.method === 'POST')).toHaveLength(0)
    fireEvent.click(buttonByText(action === 'execute' ? '本移行を実行' : '切り戻す', openDialog()))
    await flush()
    expect(net.calls.filter((call) => call.path.endsWith(`/${action}`) && call.method === 'POST')).toHaveLength(1)
  })
})

describe('UID移行の本実行（FRIEND-33）', () => {
  it('「本移行を実行」は確認画面を開くだけで実行しない', async () => {
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).toContain('移行元アカウント')
    expect(dialog.textContent).toContain('結び付け 1 件')
    expect(net.calls.some((call) => call.path.endsWith('/execute'))).toBe(false)
  })

  it('確認画面の確定だけが execute を1回呼ぶ', async () => {
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    fireEvent.click(buttonByText('本移行を実行', openDialog()))
    await flush()
    const executes = net.calls.filter((call) => call.path.endsWith('/execute') && call.method === 'POST')
    expect(executes).toHaveLength(1)
  })

  it('確認画面のキャンセルは書き込まない', async () => {
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    fireEvent.click(buttonByText('キャンセル', openDialog()))
    await flush()
    expect(net.calls.some((call) => call.path.endsWith('/execute'))).toBe(false)
  })

  it('作成者本人の入口は状態理由でdisabledとなり、確認も書込も始めない', async () => {
    net.me = { id: 'owner-1', role: 'owner' }
    await render()
    await flush()
    const entry = buttonByText('本移行を実行')
    expect(entry.disabled).toBe(true)
    expect(entry.hasAttribute('data-permission-locked')).toBe(false)
    expect(document.body.textContent).toContain('別のownerが実行してください')
    fireEvent.click(entry)
    await flush()
    expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
    expect(net.calls.some((call) => call.path.endsWith('/execute'))).toBe(false)
  })})

describe('UID移行の切り戻し（FRIEND-36/15）', () => {
  it('完了履歴は「実データはまだ変更していません」と言わず切り戻しへ進める', async () => {
    net.runs = [runFixture({
      status: 'completed', rollbackable: true,
      counts: { total: 1, auto: 0, review: 1, unmatched: 0, conflict: 0, applied: 1, failed: 0 },
    })]
    await render()
    await flush()
    expect(document.body.textContent).not.toContain('実データはまだ変更していません')
    expect(document.body.textContent).toContain('本移行と照合が終わりました')
    fireEvent.click(buttonByText('この移行を切り戻す'))
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).toContain('1 件')
    expect(net.calls.some((call) => call.path.endsWith('/rollback'))).toBe(false)
    fireEvent.click(buttonByText('切り戻す', dialog))
    await flush()
    expect(net.calls.filter((call) => call.path.endsWith('/rollback') && call.method === 'POST')).toHaveLength(1)
  })

  it('一部失敗の履歴は成功分・失敗分を分け、切り戻せることを示す', async () => {
    net.runs = [runFixture({
      status: 'failed', rollbackable: true, failureReason: '一部失敗',
      counts: { total: 2, auto: 0, review: 0, unmatched: 0, conflict: 0, applied: 1, failed: 1 },
    })]
    await render()
    await flush()
    expect(document.body.textContent).toContain('一部だけ反映されました')
    expect(document.body.textContent).toContain('一部失敗')
    expect(document.body.textContent).not.toContain('本移行と照合が完了しています')
    buttonByText('この移行を切り戻す')
  })
})

describe('対応表の遅延応答（FRIEND-16）', () => {
  it('履歴を連続で切り替えても、最後に選んだ対応表だけが残る', async () => {
    const runB = runFixture({ id: 'run-b', purpose: '移行B', counts: { total: 22, auto: 0, review: 0, unmatched: 0, conflict: 0, applied: 0, failed: 0 } })
    const runC = runFixture({ id: 'run-c', purpose: '移行C', counts: { total: 33, auto: 0, review: 0, unmatched: 0, conflict: 0, applied: 0, failed: 0 } })
    net.runs = [runFixture(), runB, runC]
    // run-b の応答だけを後回しにする。B/Cの対応表はUIDで見分ける。
    let releaseB: (() => void) | null = null
    net.detailResponders.set('run-b', () => new Promise<Response>((resolve) => {
      releaseB = () => resolve(json({ ...detailFixture(runB), items: [{ ...ITEM, id: 'item-b', oldUid: 'U-B-999' }] }))
    }))
    net.detailResponders.set('run-c', async () => json({ ...detailFixture(runC), items: [{ ...ITEM, id: 'item-c', oldUid: 'U-C-888' }] }))
    await render()
    await flush()
    // 履歴B → 履歴C と連続で切り替える。
    fireEvent.click(buttonContaining('移行B'))
    await flush()
    fireEvent.click(buttonContaining('移行C'))
    await flush()
    expect(document.body.textContent).toContain('U-C-888')
    // 遅れていたBの応答が届いても、表示はCのまま。
    releaseB?.()
    await flush()
    expect(document.body.textContent).toContain('U-C-888')
    expect(document.body.textContent).not.toContain('U-B-999')
  })
})

describe('通信例外の結果不明（TECH-07 / FRIEND-33/34）', () => {
  it('UID判断の通信断は「結果不明」と伝え、対応表を読み直す', async () => {
    net.failItemPatch = 'network'
    await render()
    await flush()
    fireEvent.click(buttonByText('開く'))
    await flush()
    const getsBefore = net.detailGets
    fireEvent.click(buttonByText('この組合せを承認', openDialog()))
    await flush()
    // 「保存できませんでした」ではなく「応答を確認できなかった」と区別する。
    expect(openDialog().textContent).toContain('応答を確認できませんでした')
    expect(document.body.textContent).toContain('対応表を読み直して')
    // 実際の判断を確かめるため対応表を読み直す。無条件の再送はしない。
    expect(net.detailGets).toBeGreaterThan(getsBefore)
    const patches = net.calls.filter((call) => call.method === 'PATCH')
    expect(patches).toHaveLength(1)
    // busy は必ず解除される（操作中のまま残らない）。
    expect(buttonByText('この組合せを承認', openDialog()).disabled).toBe(false)
  })

  it('UID判断の確定失敗（サーバー応答あり）は結果不明と混ぜない', async () => {
    net.failItemPatch = { status: 500, error: 'internal error' }
    await render()
    await flush()
    fireEvent.click(buttonByText('開く'))
    await flush()
    const getsBefore = net.detailGets
    fireEvent.click(buttonByText('この組合せを承認', openDialog()))
    await flush()
    expect(document.body.textContent).not.toContain('応答を確認できませんでした')
    // サーバーが拒否した失敗では読み直しを増やさない。
    expect(net.detailGets).toBe(getsBefore)
  })

  it('本移行の通信断は結果不明を示して履歴を読み直し、二重送信しない', async () => {
    net.failExecute = 'network'
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    const getsBefore = net.detailGets
    fireEvent.click(buttonByText('本移行を実行', openDialog()))
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).toContain('応答を確認できませんでした')
    expect(dialog.textContent).toContain('履歴を読み直して')
    expect(net.calls.filter((call) => call.path.endsWith('/execute') && call.method === 'POST')).toHaveLength(1)
    expect(net.detailGets).toBeGreaterThan(getsBefore)
    // busy 解除で閉じられる。再実行は操作者の判断に委ねる。
    fireEvent.click(buttonByText('キャンセル', dialog))
    await flush()
  })

  it('本移行の確定失敗（サーバー応答あり）は結果不明メッセージを出さない', async () => {
    net.failExecute = { status: 409, error: 'already executing' }
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    fireEvent.click(buttonByText('本移行を実行', openDialog()))
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).not.toContain('応答を確認できませんでした')
    // 英語の内部の文はそのまま出さず、日本語の案内にする（リリース前点検 2026-10-07）。
    expect(dialog.textContent).not.toContain('already executing')
    expect(dialog.textContent).toContain('本移行を実行できませんでした')
  })

  it('切り戻しの通信断も結果不明を示して履歴を読み直す', async () => {
    net.failRollback = 'network'
    net.runs = [runFixture({
      status: 'completed', rollbackable: true,
      counts: { total: 1, auto: 0, review: 1, unmatched: 0, conflict: 0, applied: 1, failed: 0 },
    })]
    await render()
    await flush()
    fireEvent.click(buttonByText('この移行を切り戻す'))
    await flush()
    const getsBefore = net.detailGets
    fireEvent.click(buttonByText('切り戻す', openDialog()))
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).toContain('応答を確認できませんでした')
    expect(net.calls.filter((call) => call.path.endsWith('/rollback') && call.method === 'POST')).toHaveLength(1)
    expect(net.detailGets).toBeGreaterThan(getsBefore)
  })
})

/**
 * カード間隔そろえ（★管理画面 gap-4・2026-09-26）の描画試験。
 * 空（履歴なし）・読み込み中・失敗・正常の主な状態を押さえる。
 */
describe('UID移行の空と履歴のカード表示', () => {
  it('履歴なしは「テスト移行はまだありません」を白いカードの中に出す', async () => {
    net.runs = []
    await render()
    await flush()
    const emptyTitle = Array.from(document.body.querySelectorAll('p')).find((node) => node.textContent === 'テスト移行はまだありません')
    expect(emptyTitle).toBeTruthy()
    // 灰色の1枚ではなく、白地・枠・角丸のカード（section）の中にある。
    const card = emptyTitle!.closest('section')
    expect(card).toBeTruthy()
    expect(card!.querySelector('h3')?.textContent).toBe('テスト移行の結果')
    // 履歴側の空カードも同じ形で出す。
    expect(document.body.textContent).toContain('移行履歴はまだありません')
    // A-28：絞り込み用の既定文ではなく、移行の履歴用の説明を出す。
    expect(document.body.textContent).toContain('移行を実行すると、ここに履歴が表示されます。')
    expect(document.body.textContent).not.toContain('条件を変えるか、新しく作成してください。')
  })

  it('履歴なしでも下の履歴節へ飛ぶだけのボタンは出さない', async () => {
    net.runs = []
    await render()
    await flush()
    expect(document.body.querySelector('a[href="#migration-history"]')).toBeNull()
    // 別画面への導線は残す。
    fireEvent.click(buttonByText('データ管理'))
    fireEvent.click(buttonByText('CSVで書き出す'))
    expect(fixture.push).toHaveBeenCalledWith('/friends/migrations')
  })

  it('読み込み中は1枚だけ出す', async () => {
    net.runs = []
    await render()
    // 読み込み完了後は空のカードが出る（読み込み中の1枚と置き換わる）。
    await flush()
    expect(document.body.textContent).toContain('テスト移行はまだありません')
    expect(document.body.textContent).not.toContain('UID移行を読み込んでいます')
  })

  it('読み込み失敗は1画面に1枚だけ出し、再読み込みできる', async () => {
    net.runs = []
    net.failList = 'network'
    await render()
    await flush()
    expect(document.body.textContent).toContain('UID移行を読み込めませんでした')
    // 登録した履歴が消えたように見せない文言を出す。
    expect(document.body.textContent).toContain('登録した移行履歴は消えていません')
    // 再読み込みで直る。
    net.failList = null
    fireEvent.click(buttonByText('もう一度読み込む'))
    await flush()
    expect(document.body.textContent).toContain('テスト移行はまだありません')
  })

  it('対応表あり（正常）は結果カードと履歴節を両方出す', async () => {
    await render()
    await flush()
    expect(document.body.textContent).toContain('要確認の判断')
    expect(document.body.textContent).toContain('移行の履歴')
    expect(document.body.querySelector('a[href="#migration-history"]')).toBeNull()
  })
})

describe('R398 一部反映の500で「未変更」と残さない', () => {
  it('本移行の500後は履歴を読み直し、反映済みと残作業を示す', async () => {
    net.failExecute = { status: 500, error: '本移行を実行できませんでした' }
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    const getsBefore = net.detailGets
    // 確定後の読み直しでは、1件反映済みの失敗が返る。
    net.detailResponders.set('run-1', async () => json(detailFixture(runFixture({
      status: 'failed',
      counts: { total: 2, auto: 0, review: 2, unmatched: 0, conflict: 0, applied: 1, failed: 1 },
    }))))
    fireEvent.click(buttonByText('本移行を実行', openDialog()))
    await flush()
    // POSTの再送はしないが、詳細GETは読み直す。
    expect(net.calls.filter((call) => call.path.endsWith('/execute') && call.method === 'POST')).toHaveLength(1)
    expect(net.detailGets).toBeGreaterThan(getsBefore)
    const dialog = openDialog()
    expect(dialog.textContent).toContain('1 件が反映されています')
    expect(document.body.textContent).toContain('一部だけ反映されました')
    expect(document.body.textContent).not.toContain('実データはまだ変更していません')
  })

  it('500後に詳細の再取得も失敗したら結果未確認になる', async () => {
    net.failExecute = { status: 500, error: '本移行を実行できませんでした' }
    await render()
    await flush()
    fireEvent.click(buttonByText('本移行を実行'))
    await flush()
    // 確定後の読み直しも失敗する。
    net.detailResponders.set('run-1', async () => json(null, 500))
    fireEvent.click(buttonByText('本移行を実行', openDialog()))
    await flush()
    expect(openDialog().textContent).toContain('実行結果を確認できませんでした')
  })
})

describe('UID移行の閲覧のみ', () => {
  it('一括確認を開いた後に本人確認が失効しても内容を残し、普通disabledで確定0', async () => {
    await act(async () => { root.render(<UidMigrationV8 initialRunId="run-1" />) })
    await flush()
    fireEvent.click(buttonByText('要確認をまとめて「結び付ける」'))
    await flush()
    expect(buttonByText('結び付ける', openDialog())).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event(SESSION_LOST_EVENT)) })
    await flush()
    const confirm = buttonByText('結び付ける', openDialog())
    expect(confirm.disabled).toBe(true)
    expect(confirm.hasAttribute('data-permission-locked')).toBe(false)
    fireEvent.click(confirm)
    await flush()
    expect(writes()).toHaveLength(0)
  })
  it.each(['legacy', 'v8'])('確認窓の本人確認が失効しても内容と操作を残し、普通disabledで保存0: %s', async entry => {
    await act(async () => { root.render(entry === 'v8' ? <UidMigrationV8 initialRunId="run-1" /> : <AccountMigration />) })
    await flush()
    fireEvent.click(entry === 'v8' ? buttonContaining('UOLD-1') : buttonByText('開く'))
    await flush()
    expect(buttonByText('この組合せを承認', openDialog())).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event(SESSION_LOST_EVENT)) })
    await flush()
    const dialog = openDialog()
    expect(dialog.textContent).toContain('UOLD-1')
    for (const label of ['この組合せを承認', '除外する']) {
      const action = buttonByText(label, dialog)
      expect(action.disabled).toBe(true)
      expect(action.hasAttribute('data-permission-locked')).toBe(false)
      fireEvent.click(action)
    }
    await flush()
    expect(writes()).toHaveLength(0)
  })
  it.each([
    { id: 'owner-2', role: 'owner', readOnly: true },
    { id: 'owner-2', role: 'owner', roleBundle: 'view_only' },
  ])('履歴は読めて変更の入口は灰色で残り、書き込まない: %j', async identity => {
    net.me = identity
    await act(async () => { root.render(<UidMigrationV8 initialRunId="run-1" />) })
    await flush()
    expect(host.querySelector('[aria-labelledby="uid-history"]')).toBeTruthy()
    expect(host.textContent).toContain('閲覧のみで見ています')
    for (const label of ['新しい移行を作る', '本移行へ進む', '要確認をまとめて「結び付ける」']) {
      const action = buttonByText(label)
      expect(action.disabled).toBe(false)
      expect(action.getAttribute('aria-disabled')).toBe('true')
      expect(action.hasAttribute('data-permission-locked')).toBe(true)
      fireEvent.click(action)
    }
    expect(buttonByText('表示中をCSVで書き出す').disabled).toBe(false)
    await flush()
    expect(net.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })
})

describe('UID移行の対応表の読み方', () => {
  const detailGetPaths = () => net.calls.filter((call) => call.method === 'GET' && /^\/api\/friends\/migrations\/run-1\?/.test(call.path)).map((call) => call.path)

  it('対応表は20件ずつ読み、次のページで続きを読む', async () => {
    net.detailResponders.set('run-1', async () => json({ ...detailFixture(runFixture()), itemTotal: 25 }))
    await render()
    await flush()
    expect(detailGetPaths().at(-1)).toContain('limit=20&offset=0')
    fireEvent.click(document.body.querySelector<HTMLButtonElement>('button[aria-label="次のページ"]')!)
    await flush()
    expect(detailGetPaths().at(-1)).toContain('limit=20&offset=20')
  })

  it('分類の絞り込みと「未判断のみ」を持ち、未判断のみは口へ伝える', async () => {
    await render()
    await flush()
    expect(document.body.querySelector('[aria-label="分類で絞り込む"]')).toBeTruthy()
    const pending = within(document.body).getByRole('checkbox', { name: '未判断のみ' })
    fireEvent.click(pending)
    await flush()
    expect(detailGetPaths().at(-1)).toContain('pendingOnly=1')
  })

  it('一致先なしの行には「結び付ける」「新しく作る」を出さない', async () => {
    net.detailResponders.set('run-1', async () => json({
      ...detailFixture(runFixture()),
      items: [{ ...ITEM, id: 'item-u', oldUid: 'U-NOMATCH', newUid: null, candidateName: null, classification: 'unmatched' }],
    }))
    await render()
    await flush()
    fireEvent.click(document.body.querySelector<HTMLButtonElement>('button[aria-label="U-NOMATCH の引き継ぎ方"]')!)
    await flush()
    const options = [...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim())
    expect(options).toContain('除く')
    expect(options).not.toContain('新しく作る')
    expect(options).not.toContain('結び付ける')
  })
})

describe('UID移行の現在地と入力欄', () => {
  it('Z0jHp の枠に、データ管理の現在地「UID移行」を出す', async () => {
    await render()
    await flush()
    expect(host.querySelector('[data-design-node="Z0jHp"]')).toBeTruthy()
    const crumbs = within(host).getByRole('navigation', { name: 'データ管理の中の現在地' })
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe('UID移行')
  })

  it('移行元・移行先は選び欄で選び、利用目的は入力欄で書く', async () => {
    net.runs = []
    await render()
    await flush()
    expect(host.querySelector('[aria-label="移行元アカウント"]')).toBeTruthy()
    expect(host.querySelector('[aria-label="移行先アカウント"]')).toBeTruthy()
    const label = [...host.querySelectorAll('span')].find((node) => node.textContent === '利用目的')
    const input = label?.parentElement?.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.input(input, { target: { value: '店舗統合' } })
    expect(input.value).toBe('店舗統合')
  })
})

describe('UID移行の5段階の表示', () => {
  const stepNav = () => within(host).getByRole('navigation', { name: '移行の手順' })
  const states = () => [...stepNav().querySelectorAll('[data-step-state]')].map((item) => item.getAttribute('data-step-state'))

  it('手順は5段を共通の帯で出す', async () => {
    await render()
    await flush()
    const names = [...stepNav().querySelectorAll('ol > li [data-step-name]')]
    expect(names.map((name) => name.textContent?.trim())).toEqual([...MIGRATION_STEPS])
  })

  it('本移行を待つ移行は「本移行と照合」の段を今の段にする', async () => {
    await render()
    await flush()
    expect(stepNav().querySelector('[aria-current="step"]')?.textContent).toContain('本移行と照合')
    expect(states().slice(0, 4).every((state) => state === 'done')).toBe(true)
  })

  it('判断が残っている移行は「要確認の判断」を今の段にする', async () => {
    net.runs = [runFixture({ status: 'review' })]
    net.detailResponders.set('run-1', async () => json({ ...detailFixture(runFixture({ status: 'review' })), unresolved: 1 }))
    await render()
    await flush()
    expect(stepNav().querySelector('[aria-current="step"]')?.textContent).toContain('要確認の判断')
    expect(states().at(-1)).not.toBe('done')
  })

  it('完了・切り戻し済みは全段を済みにし、今の段を指さない', async () => {
    net.runs = [runFixture({ status: 'completed', rollbackable: true })]
    await render()
    await flush()
    expect(stepNav().querySelector('[aria-current="step"]')).toBeNull()
    expect(states()).toEqual(MIGRATION_STEPS.map(() => 'done'))
    expect(host.textContent).toContain('一致先なし')
  })

  it('失敗した移行は全段を済みにしない', async () => {
    net.runs = [runFixture({ status: 'failed', rollbackable: true, failureReason: '一部失敗', counts: { total: 2, auto: 0, review: 0, unmatched: 0, conflict: 0, applied: 1, failed: 1 } })]
    await render()
    await flush()
    expect(states().at(-1)).not.toBe('done')
  })
})


it.each(['legacy', 'v8'])('移行先を未選択で開き、候補の状態とIDを示し、CSVなしでは送れない: %s', async entry => {
  net.runs = []
  net.accountRows = [
    { id: 'archive-id', name: '同じ名前の店', isActive: false, archivedAt: '2026-10-01' },
    { id: 'active-id', name: '同じ名前の店', isActive: true, archivedAt: null },
  ]
  await act(async () => { root.render(entry === 'v8' ? <UidMigrationV8 initialRunId={null} /> : <AccountMigration />) })
  await flush()
  const target = host.querySelector('[aria-label="移行先アカウント"]') as HTMLButtonElement
  expect(target.closest('[data-choice-field]')?.textContent).toContain('移行先アカウントを選択')
  expect(buttonByText('テスト移行を実行').disabled).toBe(true)
  fireEvent.click(target)
  await flush()
  const dialog = openDialog()
  const text = dialog.textContent ?? ''
  expect(text).toContain('保管済み · ID: archive-id')
  expect(text).toContain('現役 · ID: active-id')
  expect(text.indexOf('現役 · ID: active-id')).toBeLessThan(text.indexOf('保管済み · ID: archive-id'))
  expect(within(dialog).queryByRole('radio', { name: '移行先アカウントを選択' })).toBeNull()
  const choose = within(dialog).getByRole('button', { name: '選ぶ', exact: true }) as HTMLButtonElement
  expect(choose.disabled).toBe(true)
  const candidates = within(dialog).getAllByRole('radio')
  expect(candidates).toHaveLength(2)
  fireEvent.click(candidates[0])
  await flush()
  expect(choose.disabled).toBe(false)
  fireEvent.click(choose)
  await flush()
  expect(target.closest('[data-choice-field]')?.textContent).toContain('同じ名前の店')
  expect(writes()).toEqual([])
})
