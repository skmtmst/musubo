import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
// @vitest-environment happy-dom
/**
 * V8 シナリオの通し試験（見た目のみ）。
 * 流れ：作る→1通目を足す→詳細で保存→配信を始める→止める。
 * 各段で「押せる・窓の開閉・保存後の知らせ・一覧の変化」を確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const navigation = vi.hoisted(() => ({
  pathname: '/scenarios',
  query: '',
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
  useParams: () => ({}),
}))

const accountState = vi.hoisted(() => ({
  selectedAccountId: 'account-a',
  selectedAccount: { id: 'account-a', name: '本店' },
  accounts: [{ id: 'account-a', name: '本店' }],
  loading: false,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => accountState,
}))

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  scenario: null as unknown as Record<string, unknown> | null,
  isActive: false,
}))

const createScenario = vi.hoisted(() => vi.fn(async () => ({ success: true, data: { id: 'sc-new' } })))
const updateScenario = vi.hoisted(() => vi.fn(async (id: string, patch: Record<string, unknown>) => {
  if ('isActive' in patch) store.isActive = patch.isActive as boolean
  return { success: true, data: { id } }
}))
const addStep = vi.hoisted(() => vi.fn(async () => ({ success: true, data: { id: 'step-1' } })))
const listPage = vi.hoisted(() => vi.fn(async () => ({
  success: true,
  data: { items: store.rows, total: store.rows.length, limit: 20, sort: [] },
})))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  api: {
    scenarios: {
      create: createScenario,
      update: updateScenario,
      confirmation: vi.fn(async () => ({ success: true, data: { contentRevision: 1, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 0, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] } })),
      addStep,
      listPage,
      updateStep: vi.fn(async () => ({ success: true, data: { id: 'step-1' } })),
      simulate: vi.fn(async () => ({
        success: true,
        data: { audience: { newStartPlanned: 5 }, steps: [] },
      })),
      runs: vi.fn(async () => ({
        success: true,
        data: { steps: [], testSends: [], quota: { remaining: null, state: 'unlimited' } },
      })),
      triggers: { list: vi.fn(async () => ({ success: true, data: [] })) },
      actions: { list: vi.fn(async () => ({ success: true, data: [] })) },
      preview: vi.fn(async () => ({ success: true, data: { steps: [] } })),
      stats: vi.fn(async () => ({ success: true, data: { activeNow: 0, steps: [] } })),
    },
    folders: { list: vi.fn(async () => ({ success: true, data: [] })) },
    featureSettings: { visibility: vi.fn(async () => ({ success: true, data: {} })) },
    listStats: {
      get: vi.fn(async () => ({
        success: true,
        data: { scenarios: { active: 1, subscribers: 10, completed: 4, sentThisWeek: 3 } },
      })),
    },
    staff: { me: vi.fn(async () => ({ success: true, data: readStaffIdentity() })) },
  },
}))

vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: vi.fn(async () => ({ success: true, data: store.scenario })),
    stats: vi.fn(async () => ({ success: true, data: { activeNow: 0, steps: [] } })),
    templates: vi.fn(async () => ({ success: true, data: [] })),
    tags: vi.fn(async () => ({ success: true, data: [] })),
    invalidateScenario: vi.fn(),
  },
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/components/shared/date-time-field', () => ({
  default: ({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; [key: string]: unknown }) => (
    <input
      aria-label={typeof rest['aria-label'] === 'string' ? rest['aria-label'] : '日時'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  TimeField: ({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; [key: string]: unknown }) => (
    <input
      aria-label={typeof rest['aria-label'] === 'string' ? rest['aria-label'] : '時刻'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import ScenariosPage from './page'
import ScenarioModePage from './mode/page'
import FirstStepPage from './first-step/page'
import ScenarioDetailPage from './detail/page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function renderNode(node: React.ReactNode) {
  act(() => {
    root.render(<>{node}<ToastHost /></>)
  })
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  forgetSessionSnapshot()
  verifiedStaffRole('owner')
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  if (!g.crypto) g.crypto = {}
  if (!g.crypto.randomUUID) g.crypto.randomUUID = () => 'test-uuid-1'
  document.documentElement.dataset.theme = 'v8'
  store.rows = [{
    id: 'sc-1',
    name: '流れのシナリオ',
    isActive: true,
    folderId: null,
    deliveryMode: 'absolute_time',
    stepCount: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  }]
  store.isActive = false
  store.scenario = {
    id: 'sc-new',
    name: '流れの型2',
    description: '',
    triggerType: 'friend_add',
    contentRevision: 1,
    isActive: false,
    allowConcurrent: true,
    folderId: null,
    deliveryMode: 'absolute_time',
    lineAccountId: 'account-a',
    steps: [],
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
  }
  navigation.query = ''
  navigation.pathname = '/scenarios'
  navigation.push.mockClear()
  navigation.replace.mockClear()
  createScenario.mockClear()
  updateScenario.mockClear()
  addStep.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  forgetStaffIdentity()
  forgetSessionSnapshot()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

describe('V8 シナリオの通し：作る→1通目→詳細', () => {
  it('一覧の「＋ シナリオを作る」は方式選びへ進む', async () => {
    renderNode(<ScenariosPage />)
    await flush()
    await screen.findByText('流れのシナリオ')
    // 絵では「＋」は文字ではなく印。読み上げ名は「シナリオを作る」。
    const creates = screen.getAllByRole('button', { name: 'シナリオを作る' })
    expect(creates.length).toBeGreaterThan(0)
    fireEvent.click(creates[0])
    expect(navigation.push).toHaveBeenCalledWith('/scenarios/mode')
  })

  it('名前と方式で作る→知らせ→1通目へ進む', async () => {
    navigation.pathname = '/scenarios/mode'
    renderNode(<ScenarioModePage />)
    await flush()

    const nameInput = host.querySelector("input[placeholder=\"例：友だち追加ウェルカム\"]") as HTMLInputElement
    expect(nameInput, 'シナリオ名の入力が見つかりません').toBeTruthy()
    await act(async () => { setInputValue(nameInput, '流れの型2') })

    const timeMode = host.querySelector('input[name="delivery-mode"][value="absolute_time"]') as HTMLInputElement
    expect(timeMode, '時刻指定の選択が見つかりません').toBeTruthy()
    fireEvent.click(timeMode)

    // ★V8 作る①（src/v8/scenarios/create.tsx・）の主ボタンは絵どおり「この方式で保存する」。
    fireEvent.click(screen.getByRole('button', { name: 'この方式で保存する' }))
    await waitFor(() => expect(createScenario).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/scenarios/first-step?id=sc-new'))
  })

  it('本文と時刻を入れて保存→知らせ→詳細へ進む', async () => {
    navigation.pathname = '/scenarios/first-step'
    navigation.query = 'id=sc-new'
    renderNode(<FirstStepPage />)
    await flush()

    const body = host.querySelector('#first-step-body') as HTMLTextAreaElement
    expect(body, '本文の入力が見つかりません').toBeTruthy()
    fireEvent.change(body, { target: { value: 'ようこそ' } })
    // ★V8（src/v8/scenario-first-step）の時刻は共通の時刻の欄（提案 YCOoR・30分きざみ）。この試験では欄を打てる入力に差し替えている。
    fireEvent.change(screen.getByLabelText('配信する時刻'), { target: { value: '15:00' } })

    fireEvent.click(screen.getByRole('button', { name: '作って編集へ' }))
    await waitFor(() => expect(addStep).toHaveBeenCalledTimes(1))
    expect((addStep.mock.calls[0] as unknown[])[1]).toMatchObject({ deliveryTime: '15:00', messageContent: 'ようこそ' })
    await screen.findByText('1通目を保存しました')
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/scenarios/detail?id=sc-new'))
  })
})

describe('V8 シナリオの通し：配信を始める→止める', () => {
  it('確認の窓は開いて閉じる・始めると知らせと状態が変わる', async () => {
    if (store.scenario) {
      store.scenario = {
        ...store.scenario,
        steps: [{ id: 'step-1', stepOrder: 1, messageType: 'text', messageContent: 'ようこそ' }],
      }
    }
    navigation.pathname = '/scenarios/detail'
    navigation.query = 'id=sc-new'
    renderNode(<ScenarioDetailPage />)
    await flush()

    // 止まっているので「配信を再開する」が出る。
    const resume = await screen.findByRole('button', { name: '配信を再開する' })
    fireEvent.click(resume)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('配信をはじめますか')
    // 閉じる。
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(updateScenario).not.toHaveBeenCalled()

    // チェックを入れて始める。
    fireEvent.click(await screen.findByRole('button', { name: '配信を再開する' }))
    const dialog2 = await screen.findByRole('dialog')
    fireEvent.click(within(dialog2).getByRole('checkbox', { name: '内容と対象を確かめました' }))
    fireEvent.click(within(dialog2).getByRole('button', { name: 'この内容ではじめる' }))
    await waitFor(() => expect(updateScenario).toHaveBeenCalledWith('sc-new', { isActive: true }))
    await screen.findByText('配信を始めました')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('止めると知らせが出る', async () => {
    store.isActive = true
    if (store.scenario) {
      store.scenario = {
        ...store.scenario,
        isActive: true,
        steps: [{ id: 'step-1', stepOrder: 1, messageType: 'text', messageContent: 'ようこそ' }],
      }
    }
    navigation.pathname = '/scenarios/detail'
    navigation.query = 'id=sc-new'
    renderNode(<ScenarioDetailPage />)
    await flush()

    // ★V8（・）：③の箱のボタンは「一時停止する」、確認の窓は「配信を止めますか」。
    fireEvent.click(await screen.findByRole('button', { name: '一時停止する' }))
    // 止める窓は destructive のため role は alertdialog。
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('配信を止めますか')
    fireEvent.click(within(dialog).getByRole('button', { name: '一時停止する' }))
    await waitFor(() => expect(updateScenario).toHaveBeenCalledWith('sc-new', { isActive: false, expectedContentRevision: 1, expectedSubscriptions: { activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 } }))
    await screen.findByText('配信を一時停止しました')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })
})
