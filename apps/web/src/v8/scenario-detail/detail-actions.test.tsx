import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { getPageAction, querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * シナリオ配信の編集（src/v8/scenario-detail）で、消す・写す・始めた直後・テスト送信・置き場の動きを、
 * 画面を描いて押して確かめる。口（api）のモックに何が渡ったかと、画面に何が出たかを見る。
 * - シナリオを消す：共通の確認窓で影響（購読中の人数・残る履歴）を読んでから。成功だけ閉じて一覧へ、失敗は窓に残す
 * - 通の複製：後ろの通を1つずつずらしてから、時刻・絞り込み・質問・下書きを写して足す
 * - シナリオの複製：通・全体の設定・きっかけ・アクションを写す。途中で止まったら作りかけを見せ、続きから写す
 * - 始めた直後：試算の人数と開始の記録で知らせ、配信結果へ進める
 * - まとめてテスト：同じ LINE アカウントの友だちから選び、送る通を配信の時刻つきで並べる
 * - 置き場：所属アカウントのフォルダだけを候補にし、候補に無い保存値・読めない時を示す
 * - 保存・開始のきっかけ・配信の3つの段、通ごとの数（配信対象・配信後）、通の行の操作と編集欄
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const calls = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  reorderSteps: vi.fn(),
  addStep: vi.fn(),
  triggerList: vi.fn(),
  triggerAdd: vi.fn(),
  actionList: vi.fn(),
  actionCreate: vi.fn(),
  simulate: vi.fn(),
  runs: vi.fn(),
  folders: vi.fn(),
  friends: vi.fn(),
  stats: vi.fn(),
  confirmation: vi.fn(),
  scenario: vi.fn(),
}))

const base = vi.hoisted(() => ({
  id: 'sc-1',
  name: '新規登録フォロー',
  description: '説明',
  triggerType: 'friend_add',
  triggerTagId: null,
  isActive: true,
  contentRevision: 1,
  allowConcurrent: true,
  folderId: null as string | null,
  deliveryMode: 'absolute_time',
  onCompleteMode: 'move',
  onCompleteScenarioId: 'sc-next',
  lineAccountId: 'account-a' as string | null,
  audienceCondition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] },
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-10-01T05:02:00.000Z',
  steps: [
    {
      id: 'step-1', stepOrder: 1, delayMinutes: 30, offsetDays: 0, offsetMinutes: null, deliveryTime: '10:00',
      templateId: null, onReachTagId: null, afterSend: 'continue', messageType: 'text',
      messageContent: 'ご登録ありがとうございます。', targetCondition: null, question: null, isDraft: false,
    },
    {
      id: 'step-2', stepOrder: 2, delayMinutes: 45, offsetDays: 1, offsetMinutes: null, deliveryTime: '20:00',
      templateId: null, onReachTagId: null, afterSend: 'pause', messageType: 'text',
      messageContent: '使い方のポイント',
      targetCondition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] },
      question: null, isDraft: true,
    },
    {
      id: 'step-3', stepOrder: 3, delayMinutes: 60, offsetDays: 3, offsetMinutes: null, deliveryTime: '09:30',
      templateId: null, onReachTagId: null, afterSend: 'continue', messageType: 'text',
      messageContent: 'おわりに', targetCondition: null, question: null, isDraft: false,
    },
  ],
}))

vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor(status: number, message?: string, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
  api: {
    scenarios: {
      create: calls.create,
      get: calls.get,
      update: calls.update,
      confirmation: calls.confirmation,
      delete: calls.remove,
      reorderSteps: calls.reorderSteps,
      addStep: calls.addStep,
      simulate: calls.simulate,
      runs: calls.runs,
      moveReferrers: vi.fn(async () => ({ success: true, data: { items: [] } })),
      triggers: { list: calls.triggerList, add: calls.triggerAdd },
      actions: { list: calls.actionList, create: calls.actionCreate },
      preview: vi.fn(async () => ({ success: true, data: { steps: [] } })),
    },
    folders: { list: calls.folders },
    friends: { list: calls.friends },
    accountSettings: {
      getTestRecipients: vi.fn(async () => ({ success: true, data: [] })),
      getTestRecipientLoginUsers: vi.fn(async () => ({ success: true, data: [] })),
    },
    staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
  },
}))

vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: calls.scenario,
    stats: calls.stats,
    templates: vi.fn(async () => ({ success: true, data: [] })),
    tags: vi.fn(async () => ({ success: true, data: [{ id: 'tag-1', name: '初回案内' }] })),
    friendFields: vi.fn(async () => ({ success: true, data: [] })),
    supportMarks: vi.fn(async () => ({ success: true, data: [] })),
    scenarios: vi.fn(async () => ({ success: true, data: [] })),
    commonVars: vi.fn(async () => ({ success: true, data: [] })),
    reminders: vi.fn(async () => ({ success: true, data: [] })),
    events: vi.fn(async () => ({ success: true, data: [] })),
    invalidateScenario: vi.fn(),
  },
}))

vi.mock('@/components/scenarios/trigger-editor', () => ({
  default: ({ onChanged, onClose }: { onChanged?: (count: number) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="開始のきっかけ（試験）">
      <button type="button" onClick={() => { onChanged?.(1); onClose() }}>きっかけを保存（試験）</button>
    </div>
  ),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: calls.push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/scenarios/detail',
  useSearchParams: () => new URLSearchParams('id=sc-1'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-selected',
    selectedAccount: { id: 'account-selected', name: '選択中' },
    accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-selected', name: '選択中' }],
    loading: false,
  }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import ScenarioDetailV8 from './detail'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const ok = <T,>(data: T) => ({ success: true as const, data })

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(props: { showStarted?: boolean } = {}) {
  act(() => {
    root.render(<ScenarioDetailV8 scenarioId="sc-1" showStarted={props.showStarted ?? false} />)
  })
  await settle()
  await screen.findByRole('heading', { level: 1, name: '新規登録フォロー' })
}

function stubScenario(patch: Partial<typeof base>) {
  calls.scenario.mockResolvedValue(ok({ ...base, ...patch }))
}

function stubStats(activeNow: number | undefined) {
  calls.confirmation.mockResolvedValue(activeNow === undefined ? { success: false, error: 'offline' } : ok({ contentRevision: 1, activeCount: activeNow, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 116, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] }))
  calls.stats.mockResolvedValue(activeNow === undefined
    ? { success: false, error: 'offline' }
    : ok({ enrolledTotal: 40, activeNow, completed: 12, paused: 0, steps: [] }))
}

async function openRowMenu(stepOrder: number) {
  fireEvent.click(screen.getByRole('button', { name: `${stepOrder} 通目のその他操作` }))
  return screen.findByRole('menu')
}

async function chooseMenuItem(name: string) {
  const item = await screen.findByRole('menuitem', { name })
  await act(async () => { fireEvent.click(item) })
}

async function openStepForm(index: number) {
  const title = within(host.querySelector('ol')!).getAllByTitle('この通を編集する')[index]
  await act(async () => { fireEvent.click(title) })
  return title
}

async function openDeleteScenario() {
  fireEvent.click(screen.getByRole('button', { name: 'このシナリオのその他操作' }))
  await chooseMenuItem('このシナリオを削除')
  return screen.findByRole('alertdialog')
}

beforeEach(() => {
  verifiedStaffRole('owner')
  document.documentElement.dataset.theme = 'v8'
  for (const fn of Object.values(calls)) fn.mockReset()
  stubScenario({})
  stubStats(116)
  calls.update.mockResolvedValue(ok({ id: 'sc-1' }))
  calls.get.mockResolvedValue(ok({ ...base, steps: [] }))
  calls.remove.mockResolvedValue(ok(null))
  calls.reorderSteps.mockResolvedValue(ok(null))
  calls.addStep.mockImplementation(async (_id: string, body: { stepOrder: number }) => ok({ id: `copied-${body.stepOrder}` }))
  calls.create.mockResolvedValue(ok({ id: 'copy-1' }))
  calls.triggerList.mockImplementation(async (scenarioId: string) => ok(scenarioId === 'sc-1'
    ? [{ id: 't1', kind: 'tag_added', tagId: 'tag-1' }]
    : []))
  calls.triggerAdd.mockResolvedValue(ok([]))
  calls.actionList.mockImplementation(async (scenarioId: string) => ok(scenarioId === 'sc-1'
    ? [
        { id: 'a1', hook: 'step_sent', stepId: 'step-2', choiceIndex: null, actionType: 'add_tag', config: { tagId: 'tag-1' }, condition: null, repeatOnRefire: false, sortOrder: 0 },
        { id: 'a2', hook: 'completed', stepId: null, choiceIndex: null, actionType: 'add_tag', config: { tagId: 'tag-1' }, condition: null, repeatOnRefire: true, sortOrder: 1 },
      ]
    : []))
  calls.actionCreate.mockResolvedValue(ok({ id: 'new-action' }))
  calls.simulate.mockResolvedValue(ok({ audience: { matched: 140, alreadySubscribed: 10, newStartPlanned: 128, excluded: 2 }, steps: [] }))
  calls.runs.mockResolvedValue(ok({
    steps: [], subscriptions: [{ id: 'sub-1', startedAt: '2026-10-02T01:00:00.000Z' }], testSends: [],
    quota: { remaining: null, state: 'unlimited' },
  }))
  calls.folders.mockResolvedValue(ok([{ id: 'folder-a', name: '本店のフォルダ', color: '#06C755', kind: 'scenario' }]))
  calls.friends.mockResolvedValue(ok({ items: [{ id: 'friend-1', displayName: '試験 花子' }] }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  forgetStaffIdentity()
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

describe('シナリオ全体を削除する確認', () => {
  it('共通シナリオは全アカウントが対象だと示す', async () => {
    stubScenario({ lineAccountId: null })
    await render()
    const dialog = await openDeleteScenario()
    expect(within(dialog).getByText('すべてのLINEアカウント')).toBeTruthy()
  })
  it('通の削除にも操作先と環境を示す', async () => {
    await render()
    await openRowMenu(1)
    await chooseMenuItem('この通を削除')
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
  })
  it('配信停止と通の削除に操作先と環境を示す', async () => {
    await render()
    fireEvent.click(screen.getByRole('button', { name: '一時停止する' }))
    const stop = await screen.findByRole('alertdialog', { name: '配信を止めますか' })
    expect(within(stop).getByText('LINEアカウント')).toBeTruthy()
    expect(within(stop).getByText('環境')).toBeTruthy()
    fireEvent.click(within(stop).getByRole('button', { name: 'キャンセル' }))
    await openRowMenu(1)
    await chooseMenuItem('この通を削除')
    const step = screen.getByRole('alertdialog')
    expect(within(step).getByText('LINEアカウント')).toBeTruthy()
    expect(within(step).getByText('環境')).toBeTruthy()
  })
  it('ブラウザ標準の確認ではなく共通の取り消せない操作の窓で開き、開いただけでは消さない', async () => {
    const browserConfirm = vi.spyOn(window, 'confirm')
    await render()
    const dialog = await openDeleteScenario()
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(browserConfirm).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: '削除する' })).toBeTruthy()
    expect(calls.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls.remove).not.toHaveBeenCalled()
    browserConfirm.mockRestore()
  })

  it('購読中の人数を、取れない・0人・N人で分けて、消えるものと残るものと一緒に読ませる', async () => {
    stubStats(undefined)
    await render()
    fireEvent.click(screen.getByRole('button', { name: 'このシナリオのその他操作' }))
    await chooseMenuItem('このシナリオを削除')
    await waitFor(() => expect(host.textContent).toContain('確認できません'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(calls.remove).not.toHaveBeenCalled()
    for (const [activeNow, sentence] of [
      [0, '現在購読中の友だちは0人です。'],
      [116, '現在116 人が購読中です。途中の人は続きを受け取れません。'],
    ] as const) {
      stubStats(activeNow)
      act(() => root.unmount())
      root = createRoot(host)
      await render()
      const dialog = await openDeleteScenario()
      expect(dialog.textContent, String(activeNow)).toContain(sentence)
      expect(dialog.textContent).toContain('シナリオの設定と今後の配信が削除されます。')
      expect(dialog.textContent).toContain('これまでの配信履歴は監査記録として残ります。')
      expect(dialog.textContent).toContain('この操作は取り消せません。')
      fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    }
  })

  it('成功したときだけ窓を閉じて一覧へ戻る', async () => {
    await render()
    const dialog = await openDeleteScenario()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith('sc-1', { contentRevision: 1, activeCount: 116, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 116, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] }))
    await waitFor(() => expect(calls.push).toHaveBeenCalledWith(expect.stringMatching(/^\/scenarios(\?|$)/)))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('失敗（success:false）は窓を閉じず、日本語で読み直しを案内し、もう一度押せる', async () => {
    calls.remove.mockResolvedValueOnce({ success: false, error: 'internal error' })
    await render()
    const dialog = await openDeleteScenario()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    await waitFor(() => expect(dialog.textContent).toContain('このシナリオを削除できませんでした。状態を読み直してから、もう一度お試しください。'))
    expect(dialog.textContent).not.toContain('internal error')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(calls.push).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: '削除する' }).hasAttribute('disabled')).toBe(false)
  })

  it('削除時の409は窓の人数を読み直し、もう一度の確認を求める', async () => {
    calls.remove.mockRejectedValueOnce(new ApiError(409, 'changed', 'scenario_confirmation_conflict'))
    await render()
    const dialog = await openDeleteScenario()
    expect(dialog.textContent).toContain('現在116 人が購読中です')
    stubStats(0)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('現在購読中の友だちは0人です。'))
    expect(screen.getByRole('alertdialog').textContent).toContain('確認した内容が変わりました。もう一度確認してください。')
    expect(calls.remove).toHaveBeenCalledTimes(1)
    expect(calls.push).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })) })
    await waitFor(() => expect(calls.remove).toHaveBeenNthCalledWith(2, 'sc-1', expect.objectContaining({ activeCount: 0 })))
  })

  it('削除中に二度押しても口へは1回だけ送る', async () => {
    let finish!: (value: unknown) => void
    calls.remove.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await render()
    const dialog = await openDeleteScenario()
    const button = within(dialog).getByRole('button', { name: '削除する' })
    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(button) })
    expect(calls.remove).toHaveBeenCalledTimes(1)
    await act(async () => { finish(ok(null)); await Promise.resolve() })
  })
})

describe('通の複製は後ろをずらしてから足す', () => {
  it('後ろの通を後ろから順に +1 ずらし、すぐ後ろの番号へ写す', async () => {
    await render()
    await openRowMenu(1)
    await chooseMenuItem('この通を複製')
    await waitFor(() => expect(calls.addStep).toHaveBeenCalledOnce())
    expect(calls.reorderSteps).toHaveBeenCalledWith('sc-1', [
      { stepId: 'step-3', stepOrder: 4 },
      { stepId: 'step-2', stepOrder: 3 },
    ])
    expect(calls.reorderSteps.mock.invocationCallOrder[0]).toBeLessThan(calls.addStep.mock.invocationCallOrder[0])
    expect(calls.addStep.mock.calls[0][1]).toMatchObject({ stepOrder: 2, messageContent: 'ご登録ありがとうございます。' })
  })

  it('時刻は方式に合う欄だけ、絞り込み・質問・下書きの別・送信後の止め方まで写す', async () => {
    await render()
    await openRowMenu(2)
    await chooseMenuItem('この通を複製')
    await waitFor(() => expect(calls.addStep).toHaveBeenCalledOnce())
    const body = calls.addStep.mock.calls[0][1]
    expect(body).toMatchObject({
      stepOrder: 3,
      offsetDays: 1,
      deliveryTime: '20:00',
      targetCondition: base.steps[1].targetCondition,
      question: null,
      isDraft: true,
      afterSend: 'pause',
    })
    // R216: 時刻で指定する方式に、経過時間の欄（delayMinutes）を混ぜない。
    expect(body).not.toHaveProperty('delayMinutes')
    expect(body).not.toHaveProperty('offsetMinutes')
  })

  it('並べ替えに失敗したら足さずに理由を出す', async () => {
    calls.reorderSteps.mockResolvedValueOnce({ success: false, error: 'conflict' })
    await render()
    // 理由は通の編集欄に出る（開いていない時は出る場所が無い。報告に残した）。
    await openStepForm(0)
    await openRowMenu(1)
    await chooseMenuItem('この通を複製')
    await screen.findByText('あいだに入れるための並べ替えに失敗しました。通信を確かめて、もう一度お試しください。')
    expect(calls.addStep).not.toHaveBeenCalled()
  })

  it('足す口が success:false を返したら、その理由を通のエラーに出す', async () => {
    calls.addStep.mockResolvedValueOnce({ success: false, error: '同じ番号の通があります' })
    await render()
    await openStepForm(2)
    await openRowMenu(3)
    await chooseMenuItem('この通を複製')
    await screen.findByText('同じ番号の通があります')
    expect(calls.reorderSteps).not.toHaveBeenCalled()
  })
})

async function runDuplicate(name = '新規登録フォロー のコピー') {
  fireEvent.click(screen.getByRole('button', { name: '複製する', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: 'このシナリオを複製する' })
  fireEvent.change(within(dialog).getByLabelText('新しい名前'), { target: { value: name } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '複製する', exact: true })) })
  await settle()
  return dialog
}

describe('シナリオの複製は通の中身を落とさない', () => {
  it('停止中で作り、全体の配信対象・終了後の処理を入れ、通を時刻・絞り込み・質問・下書きの別まで写す', async () => {
    await render()
    await runDuplicate()
    await waitFor(() => expect(calls.addStep).toHaveBeenCalledTimes(3))
    expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ name: '新規登録フォロー のコピー', isActive: false, lineAccountId: 'account-a', deliveryMode: 'absolute_time' }))
    expect(calls.update).toHaveBeenCalledWith('copy-1', {
      audienceCondition: base.audienceCondition,
      onCompleteMode: 'move',
      onCompleteScenarioId: 'sc-next',
    })
    const bodies = calls.addStep.mock.calls.map(([copyId, body]) => ({ copyId, ...body }))
    expect(bodies.map((b) => b.copyId)).toEqual(['copy-1', 'copy-1', 'copy-1'])
    expect(bodies[1]).toMatchObject({ stepOrder: 2, offsetDays: 1, deliveryTime: '20:00', targetCondition: base.steps[1].targetCondition, isDraft: true, afterSend: 'pause', question: null })
    for (const body of bodies) {
      // R216: 時刻で指定する方式に、経過時間の欄を混ぜない（混ぜると口が 400 で止め、作りかけが残る）。
      expect(body).not.toHaveProperty('delayMinutes')
    }
  })

  it('SCENARIO-08: 開始のきっかけとアクションも写し、通にぶら下がるものは写した先の通へ張り替える', async () => {
    await render()
    await runDuplicate()
    await waitFor(() => expect(calls.actionCreate).toHaveBeenCalledTimes(2))
    expect(calls.triggerList).toHaveBeenCalledWith('sc-1')
    expect(calls.triggerAdd).toHaveBeenCalledWith('copy-1', 'tag_added', 'tag-1')
    expect(calls.actionList).toHaveBeenCalledWith('sc-1')
    expect(calls.actionCreate).toHaveBeenCalledWith('copy-1', expect.objectContaining({ hook: 'step_sent', stepId: 'copied-2', actionType: 'add_tag' }))
    expect(calls.actionCreate).toHaveBeenCalledWith('copy-1', expect.objectContaining({ hook: 'completed', stepId: null, repeatOnRefire: true }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'このシナリオを複製する' })).toBeNull())
  })

  it('1通でも失敗したらそこで止め、作りかけのコピーと止まった段階を見せる（成功扱いにしない）', async () => {
    calls.addStep.mockImplementation(async (_id: string, body: { stepOrder: number }) => body.stepOrder === 2
      ? { success: false, error: '通をコピーできませんでした' }
      : ok({ id: `copied-${body.stepOrder}` }))
    await render()
    await runDuplicate()
    await screen.findByText('前回の複製が途中で止まり、作りかけのコピーが残っています')
    expect(calls.addStep).toHaveBeenCalledTimes(2)
    expect(calls.triggerAdd).not.toHaveBeenCalled()
    expect(calls.actionCreate).not.toHaveBeenCalled()
    expect(host.textContent).toContain('複製が「2 通目のコピー」で止まりました。途中まで作成されたコピーが残っています。')
    expect(screen.getByRole('link', { name: 'コピーを確認する' }).getAttribute('href')).toBe('/scenarios/detail?id=copy-1')
  })

  it('SCENARIO-09: 続きからやり直すと新しいコピーを作らず、コピーに既にある通は足さない', async () => {
    calls.addStep.mockImplementation(async (_id: string, body: { stepOrder: number }) => body.stepOrder === 2
      ? { success: false, error: '通をコピーできませんでした' }
      : ok({ id: `copied-${body.stepOrder}` }))
    await render()
    await runDuplicate()
    await screen.findByText('前回の複製が途中で止まり、作りかけのコピーが残っています')
    calls.addStep.mockClear()
    calls.addStep.mockImplementation(async (_id: string, body: { stepOrder: number }) => ok({ id: `copied-${body.stepOrder}` }))
    calls.get.mockResolvedValue(ok({ ...base, id: 'copy-1', steps: [{ ...base.steps[0], id: 'copied-1' }] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '続きからやり直す' })) })
    await settle()
    expect(calls.create).toHaveBeenCalledTimes(1)
    expect(calls.get).toHaveBeenLastCalledWith('copy-1')
    expect(calls.addStep.mock.calls.map(([copyId, body]) => [copyId, body.stepOrder])).toEqual([['copy-1', 2], ['copy-1', 3]])
    await waitFor(() => expect(screen.queryByText('前回の複製が途中で止まり、作りかけのコピーが残っています')).toBeNull())
  })
})

describe('始めた直後の知らせ', () => {
  it('始めた直後だけ知らせの帯を出し、試算の人数・開始の記録を読み、配信結果へ進める', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
    stubStats(undefined)
    await render({ showStarted: true })
    const band = await waitFor(() => {
      const found = (screen.getAllByRole('status').find((el) => el.textContent?.includes('配信を始めました')) ?? querySupplementaryPageAction('配信を始めました'))
      expect(found).toBeTruthy()
      return found!
    })
    expect(calls.simulate).toHaveBeenCalledWith('sc-1', 'account-a')
    expect(calls.runs).toHaveBeenCalledWith('sc-1', 'account-a', { limit: 50 })
    expect(band.textContent).toContain('予約中の 128 人へ')
    const link = within(band).getByRole('link', { name: '始めた記録を見る' })
    expect(link.getAttribute('href')).toBe('/scenarios/results?id=sc-1')
    expect(link.getAttribute('title')).toBe('開始日時：10月2日 10:00')
  })

  it('集計と試算が両方不明のときは0人と言わず、実際に0人なら0人と示す', async () => {
    stubStats(undefined)
    calls.simulate.mockResolvedValue({ success: false, error: 'offline' })
    await render({ showStarted: true })
    let band = screen.getAllByRole('status').find(el => el.textContent?.includes('配信を始めました'))!
    expect(band.textContent).not.toContain('0 人へ')
    expect(band.textContent).toContain('人数を確認できません')
    act(() => root.unmount())
    root = createRoot(host)
    stubStats(0)
    await render({ showStarted: true })
    band = screen.getAllByRole('status').find(el => el.textContent?.includes('配信を始めました'))!
    expect(band.textContent).toContain('予約中の 0 人へ')
  })

  it('開始の記録が読めないときは、開始日時を作らず読み直しを案内する。始めていない時は帯を出さない', async () => {
    calls.runs.mockResolvedValue({ success: false, error: 'offline' })
    await render({ showStarted: true })
    const link = await screen.findByRole('link', { name: '始めた記録を見る' })
    expect(link.getAttribute('title')).toBe('開始日時を読み込めませんでした。始めた記録を読み直してください。')
    act(() => root.unmount())
    root = createRoot(host)
    await render({ showStarted: false })
    expect(screen.queryByRole('link', { name: '始めた記録を見る' })).toBeNull()
  })
})

describe('まとめてテストを送る', () => {
  it('上の「まとめてテストを送る」で全部の通のテスト送信を開き、シナリオの LINE アカウントの友だちから選ぶ', async () => {
    await render()
    await act(async () => { fireEvent.click(getPageAction({ name: 'まとめてテストを送る' })) })
    await screen.findByText('試験 花子')
    expect(calls.friends).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a' }))
    // 送る通は、配信の時刻の書き方で1通ずつ並ぶ（詳細画面の行にも同じ時刻が出るので、送る内容の行の中だけを見る）。
    for (const [order, text] of [[1, '購読開始から0日後の 10:00'], [2, '購読開始から1日後の 20:00'], [3, '購読開始から3日後の 09:30']] as const) {
      expect(screen.getByText(`${order}通目`).parentElement?.textContent, text).toContain(text)
    }
    expect(document.body.textContent).not.toContain('一括テスト送信は準備中です')
  })

  it('全アカウント共通のシナリオは、選んでいるアカウントの友だちから選ぶ', async () => {
    stubScenario({ lineAccountId: null })
    await render()
    await act(async () => { fireEvent.click(getPageAction({ name: 'まとめてテストを送る' })) })
    await screen.findByText('試験 花子')
    expect(calls.friends).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-selected' }))
  })

  it('友だちを読めなかったら、読めなかったと出す（0人と混ぜない）', async () => {
    calls.friends.mockRejectedValue(new Error('offline'))
    await render()
    await act(async () => { fireEvent.click(getPageAction({ name: 'まとめてテストを送る' })) })
    await screen.findByText('友だちを読み込めませんでした。')
  })
})

describe('置き場（フォルダ）はシナリオの所属アカウントの候補だけ', () => {
  it('所属アカウントで候補を取る。共通のシナリオは選んでいるアカウントで取る', async () => {
    await render()
    expect(calls.folders).toHaveBeenCalledWith('scenario', 'account-a')
    expect(calls.folders).not.toHaveBeenCalledWith('scenario')
    act(() => root.unmount())
    root = createRoot(host)
    calls.folders.mockClear()
    stubScenario({ lineAccountId: null })
    await render()
    expect(calls.folders).toHaveBeenCalledWith('scenario', 'account-selected')
  })

  it('候補に無い保存値は消さず「名前を確認できません」と理由を出す', async () => {
    stubScenario({ folderId: 'folder-other-account' })
    await render()
    expect(host.textContent).toContain('フォルダ：名前を確認できません')
    fireEvent.click(screen.getByRole('button', { name: '名前・説明・置き場を変える' }))
    const dialog = screen.getByRole('dialog', { name: '名前・説明・置き場を変える' })
    expect(dialog.textContent).toContain('いま入っているフォルダが見つかりません（削除されたか、別アカウントのものです）。')
    fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で保存する' }))
    await waitFor(() => expect(calls.update).toHaveBeenCalled())
    expect(calls.update.mock.calls[0][1]).toMatchObject({ folderId: 'folder-other-account' })
  })

  it('候補を読めないあいだは置き場を変えられず、読めなかったと出す', async () => {
    calls.folders.mockResolvedValue({ success: false, error: 'offline' })
    stubScenario({ folderId: 'folder-a' })
    await render()
    expect(host.textContent).toContain('フォルダ：確認できません')
    fireEvent.click(screen.getByRole('button', { name: '名前・説明・置き場を変える' }))
    const dialog = screen.getByRole('dialog', { name: '名前・説明・置き場を変える' })
    expect(dialog.textContent).toContain('フォルダ一覧を読み込めませんでした。')
    const select = dialog.querySelector<HTMLButtonElement>('[aria-label="置き場（フォルダ）"]')!
    expect(select).toBeTruthy()
    expect(select.disabled || select.getAttribute('aria-disabled') === 'true').toBe(true)
  })
})

describe('保存・開始のきっかけ・配信の3つの段', () => {
  it('保存の段は保存だけでは届かないと断り、止めているシナリオは配信の段から開始の確認を開く', async () => {
    stubScenario({ isActive: false })
    await render()
    expect(screen.getByText('保存しただけでは誰にも届きません')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /配信を再開する/ }))
    expect(await screen.findByRole('button', { name: 'この内容ではじめる' })).toBeTruthy()
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('開始のきっかけの段の「設定を変える」で開始条件の窓を開き、保存したら試算を取り直す', async () => {
    await render()
    const before = calls.simulate.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /設定を変える/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'きっかけを保存（試験）' }))
    await settle()
    expect(calls.simulate.mock.calls.length).toBeGreaterThan(before)
  })

  it('板の頭の「対象を絞る」でシナリオ全体の配信対象の窓を開く', async () => {
    await render()
    expect(screen.queryByRole('button', { name: 'その他の操作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'このシナリオのその他操作' }))
    expect(screen.getByRole('menuitem', { name: 'まとめて下見' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'まとめてテストを送る' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'このシナリオを複製' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'このシナリオを削除' })).toBeTruthy()
    await chooseMenuItem('対象を絞る')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('対象の絞り込み')
    expect(calls.update).not.toHaveBeenCalled()
  })

  it.each([['account-a', '本店'], [null, '公式アカウント']] as const)('通の追加パネルは対象アカウント %s の名前を見本へ渡す', async (accountId, expected) => {
    stubScenario({ lineAccountId: accountId })
    await render()
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを追加する' }))
    const preview = document.querySelector('aside[data-design-node="xfYLn"]') as HTMLElement
    expect(preview.textContent).toContain(expected)
  })

  it('始まる見込みは取得中と取得後を区別する', async () => {
    let resolve!: (value: ReturnType<typeof ok>) => void
    calls.simulate.mockReturnValue(new Promise(done => { resolve = done }))
    await render()
    const label = document.querySelector('[data-kpi-label][title="始まる見込み（試算）"]') as HTMLElement
    expect(label).not.toBeNull()
    const card = label.closest('[data-kpi-presentation]') as HTMLElement
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.textContent).toContain('試算中')
    await act(async () => { resolve(ok({ audience: { matched: 140, alreadySubscribed: 10, newStartPlanned: 128, excluded: 2 }, steps: [] })) })
    await waitFor(() => expect(card.textContent).toContain('128'))
    expect(card.hasAttribute('aria-busy')).toBe(false)
  })

  it('試算を取り直しているあいだは、開始の確認で古い人数を出さず「試算中」とし、始められない', async () => {
    stubScenario({ isActive: false })
    calls.simulate.mockReturnValue(new Promise(() => {}))
    await render()
    fireEvent.click(screen.getByRole('button', { name: /配信を再開する/ }))
    const dialog = (await screen.findByText('配信をはじめますか')).closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('対象：試算中…')
    expect(dialog.textContent).not.toContain('対象：128 人')
    // 試算が出るまでは「この内容ではじめる」を置かない（押せる形で残さない）。
    expect(within(dialog).queryByRole('button', { name: 'この内容ではじめる' })).toBeNull()
    expect(calls.update).not.toHaveBeenCalled()
  })
})

describe('通ごとの数と通の行', () => {
  function statRow(order: number) {
    const panel = screen.getByRole('heading', { name: '通ごとの数' }).closest('section')!
    return [...panel.querySelectorAll('li')].find((li) => li.textContent?.startsWith(`${order} 通目`))!
  }

  it('通ごとの配信対象は絞り込みの中身で言い、配信後は決まっている値を出す（「—」にしない）', async () => {
    await render()
    expect(statRow(1).textContent).toContain('購読中の全員')
    expect(statRow(2).textContent).toContain('タグ「初回案内」')
    expect(statRow(1).textContent).toContain('配信後：続ける')
    expect(statRow(2).textContent).toContain('配信後に止める')
    expect(statRow(1).textContent).not.toMatch(/—$/)
  })

  it('通の行の「…」に、編集・プレビュー・テスト・アクション・複製・削除が並ぶ', async () => {
    await render()
    const menu = await openRowMenu(1)
    const names = within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim() ?? '')
    expect(names).toHaveLength(6)
    for (const name of ['プレビュー', 'テスト', 'アクション', 'この通を複製', 'この通を削除']) expect(names, name).toContain(name)
    expect(names.some((name) => name.startsWith('編集'))).toBe(true)
  })

  it('通の題を押すとその行のすぐ下で編集欄が開き、配信対象の段に条件の中身と「条件を編集」が出る。もう一度押すと閉じる', async () => {
    await render()
    const list = host.querySelector('ol')!
    const title = within(list).getAllByTitle('この通を編集する')[1]
    await act(async () => { fireEvent.click(title) })
    const editRow = title.closest('li')!.nextElementSibling as HTMLElement
    expect(editRow.querySelector('[data-design-node="r6Gzsu"]')).toBeTruthy()
    const audience = editRow.querySelector<HTMLElement>('[data-design-node="r6Gzsu"]')!
    expect(audience.textContent).toContain('タグ「初回案内」')
    expect(within(audience).getByRole('button', { name: '条件を編集' })).toBeTruthy()
    await act(async () => { fireEvent.click(title) })
    expect(host.querySelector('[data-design-node="r6Gzsu"]')).toBeNull()
  })

  it('取れない配信前チェックに数も印も作らず、繋がっていないと書く', async () => {
    await render()
    await act(async () => { fireEvent.click(within(host.querySelector('ol')!).getAllByTitle('この通を編集する')[0]) })
    const summary = screen.getByRole('heading', { name: '設定内容' }).parentElement!
    const check = within(summary).getByText('配信前チェック').parentElement!
    expect(check.querySelector('dd')?.textContent).toBe('—')
    expect(summary.textContent).not.toContain('送信枠を超えていません')
    expect(document.body.textContent).toContain('配信前チェックはまだ繋がっていません。残りの送信枠とテスト送信の記録を返す取得口が接続されると表示されます。')
  })
})

it('古い0始まりや欠番のある通は並び順で1から表示し、操作の対象は変えない', async () => {
  stubScenario({ steps: base.steps.map((step, index) => ({ ...step, stepOrder: [0, 3, 8][index] })) })
  await render()
  expect(screen.getByRole('button', { name: '1 通目のその他操作' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '2 通目のその他操作' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '3 通目のその他操作' })).toBeTruthy()
  expect(host.textContent).not.toContain('0 通目')
  expect(host.textContent).not.toContain('8 通目')
  expect(screen.getByTitle('1 通目と2 通目のあいだに足します')).toBeTruthy()
})
