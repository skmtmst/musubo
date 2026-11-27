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

it('小数の到達人数を切り捨てて実数として表示しない', async () => {
  calls.stats.mockResolvedValue(ok({ enrolledTotal: 40, activeNow: 2, completed: 12, paused: 0, steps: [{ stepOrder: 1, reachedCount: 1.8, reachRate: 0.5 }] }))
  await render()
  const panel = screen.getByRole('heading', { name: '通ごとの数' }).closest('section')!
  expect(panel.textContent).toContain('到達 —')
  expect(panel.textContent).not.toContain('到達 1 人')
})
