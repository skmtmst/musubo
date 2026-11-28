import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
// @vitest-environment happy-dom
/*
 * V8 シナリオ配信の編集：通の行と通の削除の動きの試験。
 * - 質問の通は質問文を行の題にし、種類の札は「質問」（本文が空でも空の行にしない）
 * - 下書きの通は行に下書きの札が付く
 * - 2通目を編集すると、右の下見は2通目として案内する
 * - 通の削除は共通の取り消せない操作の窓（題と押す文字は共通部品がそろえる）で確かめ、成功した時だけ閉じて読み直す
 * - 削除の失敗は窓を閉じず、日本語で読み直しを案内する。削除中は二重に送らない
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const deleteStep = vi.hoisted(() => vi.fn())
const readActions = vi.hoisted(() => vi.fn())
const readScenario = vi.hoisted(() => vi.fn())
const readStats = vi.hoisted(() => vi.fn())

const scenario = vi.hoisted(() => ({
  id: 'sc-1',
  name: '新規登録7日間フォロー',
  description: '',
  triggerType: 'friend_add',
  isActive: true,
  contentRevision: 1,
  allowConcurrent: true,
  folderId: null,
  deliveryMode: 'absolute_time',
  onCompleteMode: 'pause',
  lineAccountId: 'account-a',
  audienceCondition: null,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-10-01T05:02:00.000Z',
  steps: [
    {
      id: 'step-1', stepOrder: 1, delayMinutes: 0, offsetDays: 0, offsetMinutes: null, deliveryTime: '10:00',
      templateId: null, onReachTagId: null, afterSend: 'continue', messageType: 'text',
      messageContent: 'ご登録ありがとうございます。', targetCondition: null, question: null, isDraft: false,
    },
    {
      id: 'step-2', stepOrder: 2, delayMinutes: 0, offsetDays: 1, offsetMinutes: null, deliveryTime: '20:00',
      templateId: null, onReachTagId: null, afterSend: 'continue', messageType: 'text',
      messageContent: ' ', targetCondition: null,
      question: { text: '体調はいかがですか？', tapMode: 'single', choices: [] }, isDraft: false,
    },
    {
      id: 'step-3', stepOrder: 3, delayMinutes: 0, offsetDays: 2, offsetMinutes: null, deliveryTime: '20:00',
      templateId: null, onReachTagId: null, afterSend: 'pause', messageType: 'text',
      messageContent: 'まだ送らない案内', targetCondition: null, question: null, isDraft: true,
    },
  ],
}))

vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message?: string) {
      super(message)
      this.status = status
    }
  },
  api: {
    scenarios: {
      get: vi.fn(async () => ({ success: true, data: scenario })),
      update: vi.fn(async () => ({ success: true, data: { id: 'sc-1' } })),
      deleteStep,
      simulate: vi.fn(async () => ({ success: true, data: { audience: { newStartPlanned: 116 }, steps: [] } })),
      runs: vi.fn(async () => ({
        success: true,
        data: { steps: [], subscriptions: [], testSends: [], quota: { remaining: null, state: 'unlimited' } },
      })),
      triggers: { list: vi.fn(async () => ({ success: true, data: [] })) },
      actions: { list: readActions },
      preview: vi.fn(async () => ({ success: true, data: { steps: [] } })),
    },
    folders: { list: vi.fn(async () => ({ success: true, data: [] })) },
    staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
  },
}))

vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: readScenario,
    stats: readStats,
    templates: vi.fn(async () => ({ success: true, data: [] })),
    tags: vi.fn(async () => ({ success: true, data: [] })),
    friendFields: vi.fn(async () => ({ success: true, data: [] })),
    supportMarks: vi.fn(async () => ({ success: true, data: [] })),
    scenarios: vi.fn(async () => ({ success: true, data: [] })),
    commonVars: vi.fn(async () => ({ success: true, data: [] })),
    reminders: vi.fn(async () => ({ success: true, data: [] })),
    events: vi.fn(async () => ({ success: true, data: [] })),
    invalidateScenario: vi.fn(),
  },
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/scenarios/detail',
  useSearchParams: () => new URLSearchParams('id=sc-1'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: '本店' },
    accounts: [{ id: 'account-a', name: '本店' }],
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

async function render() {
  act(() => {
    root.render(<ScenarioDetailV8 scenarioId="sc-1" showStarted={false} />)
  })
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  await screen.findByRole('heading', { level: 1, name: '新規登録7日間フォロー' })
}

function stepRow(order: number) {
  const label = [...host.querySelectorAll('li')].find((item) => item.firstElementChild?.textContent === `${order} 通目`)
  expect(label, `${order} 通目の行`).toBeTruthy()
  return label as HTMLElement
}

async function openDeleteDialog(order: number) {
  fireEvent.click(screen.getByRole('button', { name: `${order} 通目のその他操作` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'この通を削除' }))
  return screen.findByRole('alertdialog')
}

beforeEach(() => {
  verifiedStaffRole('owner')
  document.documentElement.dataset.theme = 'v8'
  scenario.steps[0].id = 'step-1'
  readActions.mockReset()
  readActions.mockResolvedValue({ success: true, data: [] })
  deleteStep.mockReset()
  readScenario.mockReset()
  readScenario.mockResolvedValue({ success: true, data: scenario })
  readStats.mockReset()
  readStats.mockResolvedValue({
    success: true,
    data: { enrolledTotal: 428, activeNow: 116, completed: 312, paused: 0, steps: [] },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  forgetStaffIdentity()
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

it.each(['constructor', 'toString', '__proto__'])('通の識別子が %s でもアクション件数を表示する', async id => {
  scenario.steps[0].id = id
  readActions.mockResolvedValue({ success: true, data: [{ hook: 'step', stepId: id }, { hook: 'step', stepId: id }] })
  await render()
  fireEvent.click(screen.getByRole('button', { name: '1 通目のその他操作' }))
  expect(await screen.findByRole('menuitem', { name: 'アクション 2' })).toBeTruthy()
})

it('件数の取得前も未知の識別子をアクション数にしない', async () => {
  scenario.steps[0].id = 'constructor'
  readActions.mockReturnValue(new Promise(() => {}))
  await render()
  fireEvent.click(screen.getByRole('button', { name: '1 通目のその他操作' }))
  expect(await screen.findByRole('menuitem', { name: 'アクション' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('[native code]')
})
