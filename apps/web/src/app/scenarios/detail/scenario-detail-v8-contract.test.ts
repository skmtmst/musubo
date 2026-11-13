// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ScenarioResultsV8 from '@/v8/scenarios/results'
import { findPickerDialog } from '@/components/shared/entity-picker-test-helpers'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * ★V8 シナリオ配信の配信結果の契約（#1161）。
 *
 * 画面を描いて押し、口（api）のモックに何が渡ったかと、画面の変化を見る。
 * - 数の帯・失敗した記録からの絞り込み
 * - 購読操作（止める・再開・失敗を再送・移す）は購読ごとの口を、確認キー（Idempotency-Key）付きで呼ぶ
 * - 取得失敗・未取得・0件を分けて出す（SCENARIO-10）
 * 板の文言の一字一句は固定しない（V8 の直しで文言が変わるたびに
 * 試験を書き換えることになるため）。
 */

const V8_DETAIL_CSS = fs.readFileSync(path.join(__dirname, '../../../v8/scenario-detail/detail.module.css'), 'utf8')
const V8_RESULTS_CSS = fs.readFileSync(
  path.join(__dirname, '../../../v8/scenarios/results.module.css'),
  'utf8',
)

const resultFixture = vi.hoisted(() => ({
  stats: { enrolledTotal: 10, activeNow: 3, completed: 5, paused: 1, steps: [] },
  scenario: { id: 'sc-1', name: '新規登録フォロー', lineAccountId: 'account-a', steps: [] },
  account: 'account-a' as string | null,
  runs: vi.fn(),
  ops: { pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), move: vi.fn() },
  list: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('id=sc-1'), usePathname: () => '/scenarios/results' }))
vi.mock('next/link', () => ({ default: ({ children, href }: React.ComponentProps<'a'>) => React.createElement('a', { href }, children) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: resultFixture.account, loading: false }) }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/scenarios/scenario-reference-data', () => ({ scenarioReferenceData: {
  scenario: () => Promise.resolve({ success: true, data: resultFixture.scenario }),
  stats: () => Promise.resolve({ success: true, data: resultFixture.stats }),
} }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, scenarios: { ...actual.api.scenarios, runs: resultFixture.runs, subscriptionOps: resultFixture.ops, list: resultFixture.list } } }
})
afterEach(() => { cleanup(); vi.clearAllMocks(); resultFixture.account = 'account-a' })

const SUBSCRIPTIONS = [
  { id: 'sub-active', friendId: 'f-1', friendName: '見本 01', status: 'active', confirmationRevision: 4, pauseReason: null, currentStepOrder: 1, startedAt: '2026-10-01T01:00:00Z', nextDeliveryAt: null },
  { id: 'sub-paused', friendId: 'f-2', friendName: '見本 02', status: 'paused', pauseReason: 'manual', currentStepOrder: 1, startedAt: '2026-10-01T01:00:00Z', nextDeliveryAt: null },
  { id: 'sub-failed', friendId: 'f-3', friendName: '見本 03', status: 'paused', pauseReason: 'delivery_failed', currentStepOrder: 1, startedAt: '2026-10-01T01:00:00Z', nextDeliveryAt: null },
]

function runsData(subscriptions: unknown[] = [], nextCursor: string | null = null) {
  return { success: true, data: {
    summary: { active: 2, paused: 1, completed: 5, delivering: 1 },
    subscriptions, pagination: { total: subscriptions.length, limit: 50, cursor: '', nextCursor },
    steps: [{ stepOrder: 1, failed: { state: 'available', value: 2 } }],
  } }
}

async function renderResults(subscriptions: unknown[] = [], nextCursor: string | null = null) {
  resultFixture.runs.mockResolvedValue(runsData(subscriptions, nextCursor))
  const result = render(React.createElement(ScenarioResultsV8))
  await waitFor(() => expect(screen.getByRole('heading', { name: '配信結果：新規登録フォロー' })).toBeTruthy())
  await waitFor(() => expect(screen.getByText('始まった')).toBeTruthy())
  return result
}

async function chooseRowOp(friendName: string, op: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${friendName}のその他の操作` }))
  const item = await screen.findByRole('menuitem', { name: op })
  await act(async () => { fireEvent.click(item) })
}

describe('★V8 シナリオ配信結果（X4STXS）の契約', () => {

  it('配信結果の数の帯は人数と購読の件数を分けて描く', async () => {
    const { container } = await renderResults()
    const band = container.querySelector('[data-design="KPIs"]')!
    // 取れない値は単位を付けない（「— 人」にしない）。0 は値なので単位を残す。
    const expected = [['始まった', '10', '人'], ['読み終えた', '5', '件'], ['途中', '4', '件'], ['離れた', '—', '']]
    for (const [label, value, unit] of expected) {
      const cell = within(band as HTMLElement).getByText(label).closest('[data-kpi-presentation]')!
      expect(cell.querySelector('[data-kpi-number]')?.textContent).toBe(value)
      expect(cell.textContent).toContain(value + unit)
      expect(cell.querySelector('[data-kpi-unit]') !== null, `${label} の単位の有無`).toBe(unit !== '')
    }
  })

  it('失敗した記録から停止中の購読へ絞り込み、送信中は別に知らせる', async () => {
    await renderResults()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('いま送っています（送信中の購読 1 件）'))
    fireEvent.click(screen.getByRole('button', { name: '送れなかった記録 2 件・止まっている購読だけを見る' }))
    await waitFor(() => expect(resultFixture.runs).toHaveBeenLastCalledWith('sc-1', 'account-a', expect.objectContaining({ status: 'paused' })))
  })

  it('止める・再開・失敗を再送は、購読ごとの口を確認キー付きで呼び、終わったら一覧を読み直す', async () => {
    for (const fn of Object.values(resultFixture.ops)) fn.mockResolvedValue({ success: true, data: {} })
    await renderResults(SUBSCRIPTIONS)
    await screen.findByText('見本 01')
    const before = resultFixture.runs.mock.calls.length
    await chooseRowOp('見本 01', '止める')
    await waitFor(() => expect(resultFixture.ops.pause).toHaveBeenCalledWith('sub-active', expect.stringMatching(/^[0-9a-f-]{36}$/)))
    await waitFor(() => expect(resultFixture.runs.mock.calls.length).toBeGreaterThan(before))
    await chooseRowOp('見本 02', '再開する')
    await waitFor(() => expect(resultFixture.ops.resume).toHaveBeenCalledWith('sub-paused', expect.any(String)))
    await chooseRowOp('見本 03', '失敗を再送')
    await waitFor(() => expect(resultFixture.ops.retry).toHaveBeenCalledWith('sub-failed', expect.any(String)))
  })

  it('止まり方で出し分ける：手で止めた購読に「失敗を再送」を出さない', async () => {
    await renderResults(SUBSCRIPTIONS)
    fireEvent.click(await screen.findByRole('button', { name: '見本 02のその他の操作' }))
    expect(await screen.findByRole('menuitem', { name: '再開する' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '失敗を再送' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '止める' })).toBeNull()
  })

  it('失敗したらその場で知らせ、同じ操作のやり直しは同じ確認キー、成功したあとの次の操作は新しいキー', async () => {
    resultFixture.ops.pause
      .mockResolvedValueOnce({ success: false, error: '時間を置いてください' })
      .mockResolvedValue({ success: true, data: {} })
    await renderResults(SUBSCRIPTIONS)
    await chooseRowOp('見本 01', '止める')
    await screen.findByText('見本 01 への操作を完了できませんでした。時間を置いてください')
    await chooseRowOp('見本 01', '止める')
    await waitFor(() => expect(resultFixture.ops.pause).toHaveBeenCalledTimes(2))
    await chooseRowOp('見本 01', '止める')
    await waitFor(() => expect(resultFixture.ops.pause).toHaveBeenCalledTimes(3))
    const keys = resultFixture.ops.pause.mock.calls.map((call) => call[1])
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[1])
  })

  it('別のシナリオへ移すは、有効な別のシナリオだけを候補にして、移しの口を確認キー付きで呼ぶ', async () => {
    resultFixture.list.mockResolvedValue({ success: true, data: [
      { id: 'sc-1', name: '新規登録フォロー', isActive: true },
      { id: 'sc-2', name: '休眠フォロー', isActive: true },
      { id: 'sc-3', name: '止めたシナリオ', isActive: false },
    ] })
    resultFixture.ops.move.mockResolvedValue({ success: true, data: {} })
    await renderResults(SUBSCRIPTIONS)
    await chooseRowOp('見本 01', '別のシナリオへ移す')
    const dialog = await screen.findByRole('dialog', { name: '見本 01 を別のシナリオへ移す' })
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    expect(resultFixture.list).toHaveBeenCalledWith({ accountId: 'account-a' })
    fireEvent.click(await screen.findByRole('button', { name: /^移し先のシナリオ(?::|：)?(選ぶ|変える)?$/ }))
    const picker = await findPickerDialog()
    await waitFor(() => expect(within(picker).queryByRole('radio', { name: '休眠フォロー' })).not.toBeNull())
    // いまのシナリオ自身と、止めてあるシナリオは移し先に出さない。
    expect(within(picker).queryByRole('radio', { name: '止めたシナリオ' })).toBeNull()
    expect(within(picker).queryByRole('radio', { name: '新規登録フォロー' })).toBeNull()
    fireEvent.click(within(picker).getByRole('radio', { name: '休眠フォロー' }))
    fireEvent.click(within(picker).getByRole('button', { name: '選ぶ' }))
    await waitFor(() => expect(screen.queryAllByRole('dialog').includes(picker)).toBe(false))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'このシナリオへ移す' })) })
    await waitFor(() => expect(resultFixture.ops.move).toHaveBeenCalledWith('sub-active', 'sc-2', expect.stringMatching(/^[0-9a-f-]{36}$/), { revision: 4, status: 'active' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '見本 01 を別のシナリオへ移す' })).toBeNull())
  })

  it('アカウントを切り替えた後に古い移動先を復活させない', async () => {
    let finish!: (value: unknown) => void
    resultFixture.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ success: true, data: [{ id: 'fresh', name: '新しい候補', isActive: true }] })
    const view = await renderResults(SUBSCRIPTIONS)
    await chooseRowOp('見本 01', '別のシナリオへ移す')
    resultFixture.account = 'account-b'; view.rerender(React.createElement(ScenarioResultsV8))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '見本 01 を別のシナリオへ移す' })).toBeNull())
    await act(async () => { finish({ success: true, data: [{ id: 'old', name: '古い候補', isActive: true }] }) })
    await chooseRowOp('見本 01', '別のシナリオへ移す')
    fireEvent.click(await screen.findByRole('button', { name: /^移し先のシナリオ(?::|：)?(選ぶ|変える)?$/ }))
    const picker = await findPickerDialog()
    expect(within(picker).queryByRole('radio', { name: '古い候補' })).toBeNull()
    expect(within(picker).getByRole('radio', { name: '新しい候補' })).toBeTruthy()
  })

  it('取得失敗・未取得・0件を分けて出す（SCENARIO-10）', async () => {
    await renderResults([])
    await screen.findByText('購読している友だちはまだいません')
    cleanup()
    resultFixture.runs.mockReset()
    resultFixture.runs.mockResolvedValue({ success: false, error: 'offline' })
    render(React.createElement(ScenarioResultsV8))
    await screen.findByText('購読一覧を読み込めませんでした')
    expect(screen.queryByText('購読している友だちはまだいません')).toBeNull()
    resultFixture.runs.mockResolvedValue(runsData(SUBSCRIPTIONS))
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('見本 01')
    cleanup()
    resultFixture.account = null
    resultFixture.runs.mockClear()
    render(React.createElement(ScenarioResultsV8))
    await screen.findByText('上部のLINEアカウントを選ぶと、購読している友だちの一覧を表示します。')
    expect(resultFixture.runs).not.toHaveBeenCalled()
    expect(screen.queryByText('購読している友だちはまだいません')).toBeNull()
  })

  it('通ごとの反応と参加中の友だちの段を持ち、友だちごとの予定を開け、続きがある時だけさらに読み込む', async () => {
    await renderResults(SUBSCRIPTIONS, 'next-1')
    expect(screen.getByRole('heading', { name: '通ごとの反応' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '参加中の友だち' })).toBeTruthy()
    await screen.findByText('見本 01')
    expect(screen.getAllByRole('button', { name: '予定を見る' }).length).toBe(SUBSCRIPTIONS.length)
    resultFixture.runs.mockResolvedValue(runsData([{ ...SUBSCRIPTIONS[0], id: 'sub-next', friendName: '続き 四郎' }]))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'さらに読み込む' })) })
    await waitFor(() => expect(resultFixture.runs).toHaveBeenLastCalledWith('sc-1', 'account-a', expect.objectContaining({ cursor: 'next-1' })))
    await screen.findByText('続き 四郎')
    expect(screen.getByText('見本 01')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'さらに読み込む' })).toBeNull()
  })

  it('読み込み中は購読一覧を読み込み中と出す（0件と混ぜない）', async () => {
    resultFixture.runs.mockReturnValue(new Promise(() => {}))
    render(React.createElement(ScenarioResultsV8))
    await waitFor(() => expect(document.querySelector('[data-list-state="loading"][aria-label="購読一覧を読み込んでいます"]')).not.toBeNull())
    expect(screen.queryByText('購読している友だちはまだいません')).toBeNull()
  })
})

describe('★V8 シナリオの CSS モジュールの契約', () => {
  it("既存の見た目 に効かせる指定を持たない（data-theme セレクタの直書きは無い）", () => {
    /*
     * V8 の画面は component 側の分岐でだけ出るので、CSS 側で
     * [data-theme] を条件にする必要は無い。付いていたら 管理画面 の
     * 見た目へ漏れ出す危険があるので契約で止める。
     */
    expect(V8_DETAIL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('[data-theme')
    expect(V8_RESULTS_CSS).not.toContain('[data-theme')
  })

})
