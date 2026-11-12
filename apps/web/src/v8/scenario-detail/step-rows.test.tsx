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
      actions: { list: vi.fn(async () => ({ success: true, data: [] })) },
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

describe('通の行', () => {
  it('「配信結果を見る」はこのシナリオの配信結果へつなぐ', async () => {
    await render()
    expect(screen.getByRole('link', { name: '配信結果を見る' }).getAttribute('href')).toBe('/scenarios/results?id=sc-1')
  })

  it('質問の通は質問文を題にし、種類の札は「質問」。本文が空でも空の行にしない', async () => {
    await render()
    const row = stepRow(2)
    expect(within(row).getByRole('button', { name: '体調はいかがですか？' })).toBeTruthy()
    expect(within(row).getByLabelText('種類「質問」')).toBeTruthy()
    expect(row.textContent).not.toContain('（空）')
    expect(within(stepRow(1)).getByLabelText('種類「テキスト」')).toBeTruthy()
  })

  it('下書きの通だけ行に下書きの札が付く', async () => {
    await render()
    expect(stepRow(3).textContent).toContain('下書き')
    expect(stepRow(1).textContent).not.toContain('下書き')
  })

  it('2通目を編集すると、右の下見は2通目として案内する', async () => {
    await render()
    fireEvent.click(within(stepRow(2)).getByRole('button', { name: '体調はいかがですか？' }))
    expect(await screen.findByRole('complementary', { name: '2通目の下見' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '1通目の下見' })).toBeNull()
  })
})

describe('通を削除する確認', () => {
  it('何が消え何が残るか・取り消せないことを読ませ、キャンセルでは消さない', async () => {
    await render()
    const dialog = await openDeleteDialog(2)
    expect(dialog.textContent).toContain('「2 通目」を削除しますか？')
    expect(dialog.textContent).toContain('2 通目と、その配信対象・送信後アクションが削除されます。')
    expect(dialog.textContent).toContain('到達済みの履歴は監査記録として残ります。')
    expect(dialog.textContent).toContain('この操作は取り消せません。')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleteStep).not.toHaveBeenCalled()
  })

  it('閉じた確認の古い確定は新しい確認を開いても送らない', async () => {
    await render()
    const oldDialog = await openDeleteDialog(2)
    const button = within(oldDialog).getByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    fireEvent.click(within(oldDialog).getByRole('button', { name: 'キャンセル' }))
    await openDeleteDialog(1)
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(deleteStep).not.toHaveBeenCalled()
  })

  it('成功したときだけ窓を閉じ、シナリオと到達実績を読み直す', async () => {
    deleteStep.mockResolvedValue({ success: true, data: null })
    await render()
    readScenario.mockClear()
    readStats.mockClear()
    const dialog = await openDeleteDialog(2)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    expect(deleteStep).toHaveBeenCalledWith('sc-1', 'step-2', 1)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(readScenario).toHaveBeenCalledWith('sc-1', true)
    expect(readStats).toHaveBeenCalledWith('sc-1', true)
  })

  it('失敗しても窓を閉じず、日本語で読み直しを案内する（success:false も同じ）', async () => {
    deleteStep.mockResolvedValueOnce({ success: false, error: 'Internal Server Error' })
    await render()
    const dialog = await openDeleteDialog(1)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    await waitFor(() => expect(dialog.textContent).toContain('この通を削除できませんでした。状態を読み直してから、もう一度お試しください。'))
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    expect(dialog.textContent).not.toContain('Internal Server Error')
  })

  it('削除中は二度押しで送らず、窓を閉じない', async () => {
    let finish!: (value: unknown) => void
    deleteStep.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await render()
    const dialog = await openDeleteDialog(1)
    const confirm = within(dialog).getByRole('button', { name: '削除する' })
    await act(async () => { fireEvent.click(confirm) })
    await act(async () => { fireEvent.click(confirm) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(deleteStep).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    await act(async () => { finish({ success: true, data: null }) })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })
})
