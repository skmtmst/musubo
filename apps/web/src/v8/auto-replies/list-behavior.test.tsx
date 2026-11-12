// @vitest-environment happy-dom
/*
 * V8 自動応答一覧の、押して確かめる動き。
 * 削除の窓（名前・失敗の理由・権限・処理中・アカウント切替）、止める理由と確認キー、再開、
 * 停止の記録、未取得を 0 にしない、重なりの数、権限で読めない時、遅れた返事、テンプレートの名前、
 * 評価順の上下キー、行の詳細パネル。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const net = vi.hoisted(() => ({
  list: vi.fn(),
  templates: vi.fn(),
  summary: vi.fn(),
  folders: vi.fn(),
  update: vi.fn(),
  stop: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
}))
const accountState = vi.hoisted(() => ({
  selectedAccountId: 'account-a' as string | null,
  accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '二号店' }],
  loading: false,
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      autoReplies: {
        ...actual.api.autoReplies,
        list: net.list,
        summary: net.summary,
        update: net.update,
        stop: net.stop,
        delete: net.remove,
        create: net.create,
      },
      templates: { ...actual.api.templates, list: net.templates },
      folders: { ...actual.api.folders, list: net.folders },
    },
  }
})
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => accountState }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner', canManageRole: () => true }
})

import { ApiError } from '@/lib/api'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import AutoRepliesListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ruleA = {
  id: 'ar-1', name: '営業時間外の自動返信', keyword: '営業時間', matchType: 'contains', keywords: null, respondToAll: false,
  isActive: true, confirmationRevision: 1, lifecycleStatus: 'published', hits: { period: 5, total: 20 } as { period: number; total: number } | undefined,
  responseContent: '営業時間外です', responseType: 'text', templateId: null as string | null, keywordMatchMode: 'any',
  activeFrom: null, activeUntil: null, responseWeekdays: null, responseHolidayRule: null, cooldownMinutes: null,
  skipWhenOperatorActive: false, oncePerFriend: false, messageKinds: null, friendConditions: null, folderId: null,
  priority: 0, lineAccountId: 'account-a', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}
const ruleB = { ...ruleA, id: 'ar-2', name: '予約変更のお問い合わせ', keyword: '予約', isActive: false, lifecycleStatus: 'stopped', priority: 1 }

let host: HTMLDivElement
const onCleanup: Array<() => void> = []
let root: Root

function renderList() {
  act(() => { root.render(<><AutoRepliesListV8 /><ToastHost /></>) })
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

function stubWideViewport() {
  const real = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }),
    configurable: true,
  })
  return () => { Object.defineProperty(window, 'matchMedia', { value: real, configurable: true }) }
}

function openMenu(name: string, item: string) {
  const more = host.querySelector(`button[aria-label="自動応答「${name}」の操作"]`) as HTMLButtonElement
  expect(more, `「${name}」の「…」がありません`).toBeTruthy()
  act(() => { more.click() })
  fireEvent.click(within(document.querySelector('[role="menu"]') as HTMLElement).getByText(item))
}

function kpiNumbers() {
  return [...host.querySelectorAll('[data-kpi-number]')].map((node) => node.textContent)
}

it('全アカウントでは停止状態を推測せず、見えている有効なルールを案内する', async () => {
  accountState.selectedAccountId = null
  renderList(); await flush()
  expect(host.textContent).toContain('確認できる自動応答に、有効なルールがあります。')
  expect(host.textContent).not.toContain('自動応答全体の送信状態を確認できません。')
  expect(net.summary).not.toHaveBeenCalled()
})

beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  window.history.replaceState(null, '', '/auto-replies')
  document.documentElement.dataset.theme = 'v8'
  accountState.selectedAccountId = 'account-a'
  net.list.mockImplementation(async () => ({ success: true, data: [ruleA, ruleB] }))
  net.templates.mockImplementation(async () => ({ success: true, data: [] }))
  net.summary.mockImplementation(async () => ({ success: true, data: { conflictCount: 0 } }))
  net.folders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 0 }))
  net.update.mockImplementation(async () => ({ success: true, data: null }))
  net.stop.mockImplementation(async () => ({ success: true, data: null }))
  net.remove.mockImplementation(async () => ({ success: true, data: null }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  forgetStaffIdentity(); forgetSessionSnapshot()
  onCleanup.splice(0).forEach((restore) => restore())
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('削除の窓', () => {
  it('消すルールの名前・止まる処理・残る記録・戻せないことを出し、削除して読み直す', async () => {
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading').textContent).toBe('「営業時間外の自動返信」を削除しますか？')
    expect(dialog.textContent).toContain('新しく届くメッセージへの自動返信と、タグ付けなどの後の処理が止まります。これまでの実行結果は消えません。')
    expect(dialog.textContent).toContain('削除は元に戻せません。')
    const calls = net.list.mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(net.remove).toHaveBeenCalledWith('ar-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(net.list.mock.calls.length).toBe(calls + 1)
  })

  it('81: 取り消しを左、実行をいちばん右（［キャンセル］［代わりに止める］［削除する］）', async () => {
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    const labels = within(dialog).getAllByRole('button')
      .map((button) => (button.textContent ?? '').replace(/\s+/g, ''))
      .filter((label) => label.length > 0)
    expect(labels).toEqual(['キャンセル', '代わりに止める', '削除する'])
  })

  it('消せなかったら窓を閉じず、窓の中に理由を出す', async () => {
    net.remove.mockResolvedValueOnce({ success: false, error: 'failed' })
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(dialog.textContent).toContain('自動応答を削除できませんでした。状態を読み直してからお試しください。'))
    expect(screen.getByRole('dialog')).toBe(dialog)
  })

  it('権限で断られたら、読み直せではなく権限が無いと出す', async () => {
    net.remove.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(dialog.textContent).toContain('操作する権限がありません'))
    expect(dialog.textContent).not.toContain('状態を読み直してから')
  })

  it('処理中は閉じられず、続けて押しても1回しか消さない', async () => {
    let finish!: (value: unknown) => void
    net.remove.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    const remove = within(dialog).getByRole('button', { name: '削除する' }) as HTMLButtonElement
    fireEvent.click(remove)
    await flush()
    expect(remove.disabled).toBe(true)
    expect((within(dialog).getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(remove)
    expect(net.remove).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ success: true, data: null }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('窓を開いたあとアカウントが切り替わったら、古い対象を消さず選び直しを求める', async () => {
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    accountState.selectedAccountId = 'account-b'
    renderList(); await flush()
    expect(dialog.textContent).toContain('アカウントが切り替わりました。削除する自動応答を選び直してください。')
    const remove = within(dialog).getByRole('button', { name: '削除する' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)
    expect(net.remove).not.toHaveBeenCalled()
  })

  it.each([
    ['共通', { ...ruleA, lineAccountId: null }, 'すべてのLINEアカウント'],
    ['対象未取得', Object.fromEntries(Object.entries(ruleA).filter(([key]) => key !== 'lineAccountId')), '名前を確認できません'],
  ])('%sの自動応答は実際の対象を表示する', async (_label, rule, expected) => {
    net.list.mockResolvedValue({ success: true, data: [rule] })
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(expected)
  })

  it('削除対象を表示しアカウントを行き来しても古い確定を拒む', async () => {
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('LINEアカウント')
    const button = within(dialog).getByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const oldConfirm = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    accountState.selectedAccountId = 'account-b'; renderList(); await flush()
    accountState.selectedAccountId = 'account-a'; renderList(); await flush()
    await act(async () => oldConfirm())
    expect(net.remove).not.toHaveBeenCalled()
  })

  it('削除中にアカウントが切り替わったら、終わっても前のアカウントの一覧を読み直さない', async () => {
    let finish!: (value: unknown) => void
    net.remove.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '削除する')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '削除する' }))
    await flush()
    accountState.selectedAccountId = 'account-b'
    renderList(); await flush()
    const before = net.list.mock.calls.filter(([query]) => query.accountId === 'account-a').length
    await act(async () => { finish({ success: true, data: null }) })
    await flush()
    expect(net.list.mock.calls.filter(([query]) => query.accountId === 'account-a').length).toBe(before)
  })
})

describe('止める・再開する', () => {
  it('止める理由（500文字まで）と確認キーを専用の停止口へ送る', async () => {
    renderList(); await flush()
    openMenu('営業時間外の自動返信', '止める')
    const dialog = await screen.findByRole('dialog', { name: '「営業時間外の自動返信」を止める' })
    const reason = within(dialog).getByLabelText(/止める理由/) as HTMLInputElement
    expect(reason.maxLength).toBe(500)
    fireEvent.change(reason, { target: { value: 'キャンペーンが終わったので' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '止める' }))
    await waitFor(() => expect(net.stop).toHaveBeenCalledTimes(1))
    const [id, body, key] = net.stop.mock.calls[0]
    expect(id).toBe('ar-1')
    expect(body).toEqual({ reason: 'キャンペーンが終わったので', expectedVersion: 1 })
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })

  it('止まっているルールを再開すると、動かす更新を送る', async () => {
    renderList(); await flush()
    openMenu('予約変更のお問い合わせ', '再開する')
    await waitFor(() => expect(net.update).toHaveBeenCalledWith('ar-2', { isActive: true }))
  })

  it('止めた記録（いつ・誰が・理由）を状態の札で読める', async () => {
    net.list.mockImplementation(async () => ({ success: true, data: [{ ...ruleB, stoppedAt: '2026-09-15T10:23:45.000', stoppedByStaffName: '管理者', stopReason: '一時停止' }] }))
    renderList(); await flush()
    const row = screen.getByText('予約変更のお問い合わせ').closest('tr') as HTMLElement
    const pill = within(row).getByText('停止中')
    const titled = [pill, ...(function* up(node: HTMLElement | null) { while (node && node !== row) { yield node; node = node.parentElement } })(pill.parentElement)]
    expect(titled.map((node) => node.getAttribute('title'))).toContain('2026-09-15 10:23 に 管理者 が停止 — 理由: 一時停止')
  })
})

describe('数を 0 に見せない', () => {
  it('行のヒット数が取れていないときは今月も累計も — にする', async () => {
    const restore = stubWideViewport()
    onCleanup.push(restore)
    net.list.mockImplementation(async () => ({ success: true, data: [{ ...ruleA, hits: undefined }] }))
    renderList(); await flush()
    const row = screen.getByText('営業時間外の自動返信').closest('tr') as HTMLElement
    expect(row.textContent).toContain('—回')
    expect(row.textContent).toContain('累計 —回')
    expect(row.textContent).not.toMatch(/(^|[^0-9])0回/)
    expect(host.textContent).not.toContain('累計 0回')
  })

  it('「今月0回」の絞り込みは、数えられた 0 回だけを残し未取得を混ぜない', async () => {
    net.list.mockImplementation(async () => ({ success: true, data: [
      { ...ruleA, id: 'zero', name: '当たらないルール', hits: { period: 0, total: 3 } },
      { ...ruleA, id: 'unknown', name: '数えられないルール', hits: undefined },
      { ...ruleA, id: 'used', name: '当たるルール', hits: { period: 4, total: 9 } },
    ] }))
    renderList(); await flush()
    fireEvent.click(host.querySelector('button[title="今月1度も当たっていないルール"]') as HTMLButtonElement)
    await flush()
    expect(host.textContent).toContain('当たらないルール')
    expect(host.textContent).not.toContain('数えられないルール')
    expect(host.textContent).not.toContain('当たるルール')
  })

  it('重なりの数は集計の口から出し、取れなければ — にする', async () => {
    net.summary.mockResolvedValueOnce({ success: true, data: { conflictCount: 3 } })
    renderList(); await flush()
    expect(net.summary).toHaveBeenCalledWith('account-a')
    expect(kpiNumbers()[3]).toBe('3')
    expect(screen.getByRole('button', { name: '重なりを見る' })).toBeTruthy()
    act(() => root.unmount())
    root = createRoot(host)
    net.summary.mockResolvedValueOnce({ success: false, error: 'failed' })
    renderList(); await flush()
    expect(kpiNumbers()[3]).toBe('—')
  })

  it('一覧を見る権限が無いときは、読み込めないではなく権限が無いと出す', async () => {
    net.list.mockRejectedValue(new ApiError(403, 'forbidden'))
    renderList(); await flush()
    expect(host.textContent).toContain('見る権限がありません')
  })
})

describe('遅れて届いた返事', () => {
  it('アカウントを行き来したあとに届いた古い返事で、新しい一覧を上書きしない', async () => {
    const held: Array<(value: unknown) => void> = []
    net.list.mockImplementation(() => new Promise((resolve) => { held.push(resolve) }))
    renderList(); await flush()
    accountState.selectedAccountId = 'account-b'
    renderList(); await flush()
    accountState.selectedAccountId = 'account-a'
    renderList(); await flush()
    expect(held).toHaveLength(3)
    await act(async () => { held[2]({ success: true, data: [{ ...ruleA, name: '新しい返事のルール' }] }) })
    await flush()
    await act(async () => { held[0]({ success: true, data: [{ ...ruleA, name: '古い返事のルール' }] }) })
    await act(async () => { held[1]({ success: true, data: [{ ...ruleA, name: '別アカウントのルール' }] }) })
    await flush()
    expect(host.textContent).toContain('新しい返事のルール')
    expect(host.textContent).not.toContain('古い返事のルール')
    expect(host.textContent).not.toContain('別アカウントのルール')
  })
})

describe('テンプレートの名前', () => {
  it('テンプレートで返すルールは、そのテンプレートの名前で出す', async () => {
    net.templates.mockImplementation(async () => ({ success: true, data: [{ id: 'tpl-1', name: '営業時間外のご案内', messageType: 'text', messageContent: 'x' }] }))
    net.list.mockImplementation(async () => ({ success: true, data: [{ ...ruleA, templateId: 'tpl-1' }] }))
    renderList(); await flush()
    expect(host.textContent).toContain('テンプレート「営業時間外のご案内」')
  })
})

describe('評価順の並べ替え', () => {
  it('評価順では上下キーで隣と入れ替えて保存する', async () => {
    const restore = stubWideViewport()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      net.list.mockImplementation(async () => ({ success: true, data: [ruleA, { ...ruleB, isActive: true, lifecycleStatus: 'published' }] }))
      renderList(); await flush()
      const handle = host.querySelector<HTMLElement>('[data-reorder-id="ar-2"] [data-reorder-handle]')
      expect(handle, '並べ替えのつまみがありません').toBeTruthy()
      act(() => { fireEvent.keyDown(handle!, { key: 'ArrowUp' }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5100) }); await flush()
      expect(net.update).toHaveBeenCalledWith('ar-2', { priority: 0 })
      expect(net.update).toHaveBeenCalledWith('ar-1', { priority: 1 })
    } finally { restore() }
  })

  it('評価順でない並びではつまみを出さず、評価順にすると動かせると伝える', async () => {
    const restore = stubWideViewport()
    window.history.replaceState(null, '', '/auto-replies?sortKey=name')
    try {
      renderList(); await flush()
      const row = host.querySelector('[data-reorder-id="ar-1"]') as HTMLElement
      expect(row.querySelector('[data-reorder-handle]')).toBeNull()
      expect(row.querySelector('[data-reorder-disabled]')?.getAttribute('title')).toBe('並びを「評価順」にすると動かせます')
    } finally { restore() }
  })
})

describe('行の詳細パネル', () => {
  it('動く言葉の要約と、時間帯・曜日などの全部の条件を出す', async () => {
    net.list.mockImplementation(async () => ({ success: true, data: [{
      ...ruleA,
      keywords: [{ keyword: '営業時間', matchType: 'exact' }, { keyword: '休み', matchType: 'contains' }, { keyword: '定休日', matchType: 'contains' }],
      activeFrom: '09:00', activeUntil: '18:00', responseWeekdays: [1, 3, 5], oncePerFriend: true,
    }] }))
    renderList(); await flush()
    const row = host.querySelector('tbody tr') as HTMLElement
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    const panel = document.body.querySelector('[data-design-part="detail-panel"]') as HTMLElement
    expect(panel, '詳細パネルが開きません').toBeTruthy()
    expect(panel.textContent).toContain('「営業時間」「休み」ほか1つ')
    for (const chip of ['09:00〜18:00', '月・水・金曜のみ', '同じ人に1回だけ']) expect(panel.textContent).toContain(chip)
  })
})

vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '二号店' }] }) }))

it('一括停止は選んだ操作先を表示し、切替後は新しいアカウント名へ置き換えず送信を止める', async () => {
  renderList(); await flush()
  fireEvent.click(within(screen.getByText('営業時間外の自動返信').closest('tr')!).getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'まとめて止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '1 件の自動応答を止めますか？' })
  const target = within(within(dialog).getByRole('region', { name: '操作の対象' }))
  await target.findByText('本店')
  accountState.selectedAccountId = 'account-b'
  renderList(); await flush()
  expect(target.getByText('本店')).toBeTruthy()
  expect(target.queryByText('二号店')).toBeNull()
  const stop = within(dialog).getByRole('button', { name: '止める', exact: true })
  expect(stop).toHaveProperty('disabled', true)
  fireEvent.click(stop)
  expect(net.stop).not.toHaveBeenCalled()
  expect(net.update).not.toHaveBeenCalled()
})

it('共通の自動応答を止める確認では全アカウントを示す', async () => {
  net.list.mockResolvedValue({ success: true, data: [{ ...ruleA, lineAccountId: null }] })
  renderList(); await flush()
  openMenu('営業時間外の自動返信', '止める')
  const dialog = await screen.findByRole('dialog', { name: '「営業時間外の自動返信」を止める' })
  expect(dialog.textContent).toContain('すべてのLINEアカウント')
})

it('一括停止で共通と対象未取得を含む時は両方を示し、アカウントを行き来した古い確定を拒む', async () => {
  const unknown = Object.fromEntries(Object.entries(ruleA).filter(([key]) => key !== 'lineAccountId'))
  net.list.mockResolvedValue({ success: true, data: [{ ...ruleA, lineAccountId: null }, { ...unknown, id: 'unknown-rule', name: '対象未取得の自動応答', priority: 1 }] })
  renderList(); await flush()
  fireEvent.click(within(screen.getByText('営業時間外の自動返信').closest('tr')!).getByRole('checkbox'))
  fireEvent.click(within(screen.getByText('対象未取得の自動応答').closest('tr')!).getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'まとめて止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '2 件の自動応答を止めますか？' })
  expect(dialog.textContent).toContain('すべてのLINEアカウント')
  expect(dialog.textContent).toContain('名前を確認できません')
  const button = within(dialog).getByRole('button', { name: '止める', exact: true })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const oldConfirm = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
  accountState.selectedAccountId = 'account-b'; renderList(); await flush()
  accountState.selectedAccountId = 'account-a'; renderList(); await flush()
  await act(async () => oldConfirm())
  expect(net.stop).not.toHaveBeenCalled()
})

it('一括停止の途中でアカウントを行き来したら残りを送らない', async () => {
  let finish!: (value: unknown) => void
  net.stop.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  net.list.mockResolvedValue({ success: true, data: [ruleA, { ...ruleA, id: 'another-rule', name: '別のルール', priority: 1 }] })
  renderList(); await flush()
  fireEvent.click(within(screen.getByText('営業時間外の自動返信').closest('tr')!).getByRole('checkbox'))
  fireEvent.click(within(screen.getByText('別のルール').closest('tr')!).getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'まとめて止める', exact: true }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: '2 件の自動応答を止めますか？' })).getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(net.stop).toHaveBeenCalledTimes(1))
  accountState.selectedAccountId = 'account-b'; renderList(); await flush()
  accountState.selectedAccountId = 'account-a'; renderList(); await flush()
  await act(async () => finish({ success: true, data: null }))
  await flush()
  expect(net.stop).toHaveBeenCalledTimes(1)
})
