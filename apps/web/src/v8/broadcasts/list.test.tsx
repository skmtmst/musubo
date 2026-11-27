// @vitest-environment happy-dom
import { findDetailMenuItem } from '@/test-utils/detail-menu'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 一斉配信一覧（src/v8）の動きの試験。BEHAVIOR.md の主要な動きを守る。
 * 行が出る・言葉で絞れる・札と並びが口へ渡る・閲覧のみは帯が出て作れない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const heldConfirm = vi.hoisted(() => ({ broadcast: null as null | (() => void), folder: null as null | (() => void) }))
vi.mock('@/components/shared/confirm-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.onConfirm) {
      if (props.description.startsWith('削除すると配信設定')) heldConfirm.broadcast = props.onConfirm
      if (props.description.startsWith('削除しても、中の配信は未分類')) heldConfirm.folder = props.onConfirm
    }
    return <actual.default {...props} />
  } }
})
vi.mock('@/lib/line-accounts-cache', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/line-accounts-cache')>()),
  loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '選択中の店' }, { id: 'account-b', name: 'フォルダの所有店' }] })),
}))

const formImport = vi.hoisted(() => ({ evaluations: 0, props: null as unknown }))
vi.mock('@/components/broadcasts/broadcast-form', () => {
  formImport.evaluations += 1
  return { default: (props: unknown) => { formImport.props = props; return <div data-loaded-broadcast-form /> } }
})
const listBroadcasts = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const deleteFolder = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const createFolder = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const updateFolder = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const swapFolders = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const createView = vi.hoisted(() => vi.fn(async (_accountId: string, input: Record<string, unknown>) => ({ success: true, data: { id: 'new-view', ...input } })))
const listViews = vi.hoisted(() => vi.fn())
const dashboardOverview = vi.hoisted(() => vi.fn(async () => ({ success: true, data: { delivery: { quotaLimit: 5000, quotaUsed: 1842 } } })))
const deleteBroadcast = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const updateBroadcast = vi.hoisted(() => vi.fn(async () => ({ success: true, data: null })))
const narrow = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => narrow.value }))
const role = vi.hoisted(() => ({ current: 'owner' as string | null }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: {
        ...actual.api.broadcasts,
        list: listBroadcasts,
        update: updateBroadcast,
        delete: deleteBroadcast,
        getInsight: async () => ({ success: false }),
        savedViews: { ...actual.api.broadcasts.savedViews, list: listViews, create: createView },
      },
      folders: { ...actual.api.folders, list: listFolders, delete: deleteFolder, swapOrder: swapFolders, create: createFolder, update: updateFolder },
      tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }) },
      scenarios: { ...actual.api.scenarios, list: async () => ({ success: true, data: [] }) },
      dashboard: {
        ...actual.api.dashboard,
        overview: dashboardOverview,
      },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))

const routerPush = vi.hoisted(() => vi.fn())
const account = vi.hoisted(() => ({ id: 'account-a' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useOptionalAccount: () => ({ selectedAccountId: account.id }),
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.current }
})

import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { deferImpersonationSnapshot, forgetSessionSnapshot, readSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import type { StaffMember } from '@line-crm/shared'
import BroadcastListV8 from './list'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
const initialFormEvaluations = formImport.evaluations
import { flushListUrlState } from '@/components/shared/list-url-state'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

/* 試験の環境に localStorage が無いことがあるので、手で置く。 */
const store = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  },
})

const base = {
  id: 'bc-1',
  title: '8月キャンペーンのお知らせ',
  messageType: 'text',
  messageContent: 'セールのご案内',
  targetType: 'all',
  targetTagId: null,
  status: 'scheduled',
  displayStatus: 'scheduled',
  displayStatusLabel: '予約中',
  scheduledAt: '2026-08-24T01:00:00.000Z',
  sentAt: null,
  successCount: 0,
  folderId: null,
}
const rowB = { ...base, id: 'bc-2', title: '未購入者フォロー', messageContent: 'まだお買い物していない方へ', status: 'draft', displayStatus: 'draft', displayStatusLabel: '下書き', scheduledAt: null }

beforeEach(() => {
  account.id = 'account-a'
  updateBroadcast.mockClear()
  heldConfirm.broadcast = null; heldConfirm.folder = null
  deleteFolder.mockClear(); swapFolders.mockClear(); createFolder.mockClear(); updateFolder.mockClear()
  forgetStaffIdentity(); forgetSessionSnapshot()
  document.documentElement.dataset.theme = 'v8'
  role.current = verifiedStaffRole('owner')
  store.clear()
  /* 広い板（1440）のふり。happy-dom は狭い板扱いになる。 */
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }),
  })
  listBroadcasts.mockImplementation(async () => ({
    success: true,
    data: [base, rowB],
    kpis: { scheduled: 4, thisMonth: 12, delivered: 1842, openRate: 69.4, drafts: 3 },
    statusCounts: { all: 24, scheduled: 4, draft: 3, pending_approval: 1, sent: 15, failed: 1 },
    pagination: { total: 2, limit: 20, cursor: 0, nextCursor: null },
  }))
  listFolders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: 0 }))
  listViews.mockImplementation(async () => ({ success: true, data: [] }))
  dashboardOverview.mockImplementation(async () => ({ success: true, data: { delivery: { quotaLimit: 5000, quotaUsed: 1842 } } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
  forgetStaffIdentity(); forgetSessionSnapshot()
})

async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined
}

describe('V8 一斉配信一覧の結果の列', () => {
  const sentRow = { ...base, id: 'bc-3', title: '新商品発売のお知らせ', status: 'sent', displayStatus: 'sent', displayStatusLabel: '送信済み', scheduledAt: null, sentAt: '2026-08-20T03:00:00.000Z', successCount: 624, insightSummary: { delivered: 624, uniqueImpression: 444, uniqueClick: 96, openRate: 0.712, clickRate: 0.154 } }
  const renderRows = async () => {
    listBroadcasts.mockImplementation(async () => ({
      success: true, data: [base, sentRow, rowB], kpis: { scheduled: 1, thisMonth: 1, delivered: 624, openRate: 71.2, drafts: 1 },
      statusCounts: { all: 3, scheduled: 1, sent: 1, draft: 1 }, pagination: { total: 3, limit: 20, cursor: 0, nextCursor: null },
    }))
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const rowOf = (title: string) => [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(title)) as HTMLTableRowElement
    return { sent: rowOf('新商品発売のお知らせ'), unsent: rowOf('8月キャンペーンのお知らせ'), draft: rowOf('未購入者フォロー'), heads: [...host.querySelectorAll('thead th')].map((th) => th.textContent?.trim()) }
  }

  it('広い幅は届いた・開封・クリックの3列に右そろえで、送っていない行は — で数を作らない', async () => {
    narrow.value = false
    const { sent, unsent, heads } = await renderRows()
    expect(heads).toEqual(expect.arrayContaining(['届いた', '開封', 'クリック']))
    const right = [...sent.querySelectorAll('td[data-align="right"]')].map((td) => td.textContent?.trim())
    expect(right).toEqual(['624 人', '71.2%', '15.4%'])
    const unsentRight = [...unsent.querySelectorAll('td[data-align="right"]')].map((td) => td.textContent?.trim())
    expect(unsentRight).toHaveLength(3)
    for (const text of unsentRight) expect(text).not.toMatch(/\d/)
  })

  it('配信日時は日本時間で、日時の無い下書きは薄い「—」1つ', async () => {
    narrow.value = false
    const { sent, unsent, draft } = await renderRows()
    expect(unsent.querySelector('[data-upcoming]')?.textContent).toContain('10:00')
    expect(sent.textContent).toContain('12:00')
    expect(draft.textContent).not.toContain('未設定')
    expect(draft.querySelector('[data-empty-value]')?.textContent).toBe('—')
  })

  it('配信日時は日時だけの1行で「予約」を重ねず、予約中の日時だけ少し濃くする', async () => {
    narrow.value = false
    const { sent, unsent } = await renderRows()
    const upcoming = unsent.querySelector('[data-upcoming]')
    expect(upcoming?.textContent).toMatch(/\d/)
    expect([...unsent.querySelectorAll('td span')].some((el) => el.textContent?.trim() === '予約')).toBe(false)
    expect(sent.querySelector('[data-upcoming]')).toBeNull()
  })

  it('［この条件を保存する］は［保存した検索］の中にまとめ、絞り込み中だけ横に小さな点を出す', async () => {
    narrow.value = false
    await renderRows()
    expect(buttonByText('この条件を保存する')).toBeUndefined()
    expect(host.querySelector('[data-savable-dot]')).toBeNull()
    act(() => { buttonByText('保存した検索')!.click() })
    await flush()
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
    expect(items.at(-1)).toBe('＋ 今の条件を保存する')
    // 保存した検索は「1つ選ぶ一覧」。操作メニューの鉛筆などの印を付けない。
    expect(document.querySelector('[role="menu"] [role="menuitem"] svg')).toBeNull()
    act(() => { (document.querySelector('[role="menuitem"]') as HTMLElement).click() })
    await flush()
    const chip = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('予約中')) as HTMLButtonElement
    act(() => { chip.click() })
    await flush()
    expect(host.querySelector('[data-savable-dot]')).not.toBeNull()
  })

  it('狭い幅は1列の2段（上に人数・下に開封とクリック）で、送っていない行は — で数を作らない', async () => {
    narrow.value = true
    const { sent, unsent, heads } = await renderRows()
    narrow.value = false
    expect(heads).toContain('結果')
    expect(heads).not.toContain('クリック')
    expect(sent.textContent).toContain('624 人')
    expect(sent.textContent).toContain('開封 71.2%・クリック 15.4%')
    const resultCell = [...sent.querySelectorAll('td')].find((cell) => cell.textContent?.includes('開封 71.2%・クリック 15.4%'))
    expect(resultCell?.getAttribute('data-align')).toBe('right')
    expect(unsent.textContent).not.toMatch(/0\s*人/)
  })
})

describe('V8 一斉配信一覧（src/v8）の動き', () => {
  it('does not evaluate the creation module while only the list is open', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    expect(initialFormEvaluations).toBe(0)
    expect(host.querySelector('[data-loaded-broadcast-form]')).toBeNull()
  })

  it('未分類の件数を選択中の店舗に絞り、ほかの店舗の配信を足さない', async () => {
    listFolders.mockImplementation(async (_kind, accountId) => ({ success: true, data: [], unfiledCount: accountId === 'account-a' ? 0 : 2 }))
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    expect(listFolders).toHaveBeenCalledWith('broadcast', 'account-a')
    expect(host.querySelector('button[title="未分類"]')?.textContent).toBe('未分類0')
  })

  it('狭い幅でも送信枠を保持し、下書きの絞り込みは使える', async () => {
    narrow.value = true
    try {
      act(() => { root.render(<BroadcastListV8 />) })
      await flush()
      expect(host.querySelector('[data-kpi-label][title="今月の送信枠"]')).not.toBeNull()
      expect(host.querySelector('[data-kpi-label][title="下書き"]')).toBeNull()
      const draft = buttonByText('下書き 3')
      expect(draft).toBeTruthy()
      act(() => draft!.click())
      await flush()
      expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'draft' }))
    } finally { narrow.value = false }
  })

  it('行を選ぶと下にまとめての帯が出て、選んだ配信をまとめてフォルダへ移す（l5V9a）', async () => {
    listFolders.mockImplementation(async () => ({ success: true, data: [{ id: 'f-1', kind: 'broadcast', name: 'キャンペーン', parentId: null, displayOrder: 0, itemCount: 0, color: '#10B981', createdAt: '', updatedAt: '' }], unfiledCount: 2 }))
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const pick = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement
    expect(pick('8月キャンペーンのお知らせを選ぶ'), '行の選ぶ欄がありません').toBeTruthy()
    act(() => { fireEvent.click(pick('8月キャンペーンのお知らせを選ぶ')) })
    act(() => { fireEvent.click(pick('未購入者フォローを選ぶ')) })
    await flush()
    const move = buttonByText('フォルダへ移す')
    expect(move, 'まとめての帯がありません').toBeTruthy()
    act(() => { move!.click() })
    expect(updateBroadcast).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"]')!
    act(() => { fireEvent.click(dialog.querySelector('input[aria-label="キャンペーン"]')!) })
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'フォルダへ移す')!
    await act(async () => { fireEvent.click(confirm) })
    await flush()
    expect(updateBroadcast).toHaveBeenCalledWith('bc-1', expect.objectContaining({ folderId: 'f-1' }))
    expect(updateBroadcast).toHaveBeenCalledWith('bc-2', expect.objectContaining({ folderId: 'f-1' }))
    await waitFor(() => expect(buttonByText('フォルダへ移す'), '移した後も帯が残っています').toBeUndefined())
  })

  it('行と数の帯・札の件数が出る', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    expect(host.textContent).toContain('8月キャンペーンのお知らせ')
    expect(host.textContent).toContain('未購入者フォロー')
    expect(host.textContent).toContain('5,000 通のうち 1,842 通を使用')
    expect(buttonByText('すべて 24'), '札「すべて 24」がありません').toBeTruthy()
  })

  it('言葉で絞ると1件になる', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const search = host.querySelector('input[placeholder="タイトル・内容で探す"]') as HTMLInputElement
    expect(search, '探す欄がありません').toBeTruthy()
    fireEvent.change(search, { target: { value: '未購入' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await flush()
    expect(host.textContent).not.toContain('8月キャンペーンのお知らせ')
    expect(host.textContent).toContain('未購入者フォロー')
  })

  it('札を押すと状態で、並びを押すと古い順で読み直す', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    act(() => { buttonByText('下書き 3')?.click() })
    await flush()
    expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'draft', cursor: 0 }))
    act(() => { fireEvent.click(host.querySelector('[aria-label="並び"]')!) })
    act(() => { fireEvent.click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes('古い順'))!.querySelector('button')!) })
    await flush()
    expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'oldest' }))
    expect(host.querySelector('[aria-label="並び"]'), '並びの字が入れ替わっていません').toBeTruthy()
  })

  it('編集キーの無い担当者も検索保存とフォルダ追加を理由付きで残し、書き込まない', async () => {
    role.current = verifiedStaffRole('staff')
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    expect(host.textContent).toContain('この画面を変える権限がありません。')
    expect(host.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
    const rowCheckbox = host.querySelector('input[type="checkbox"]')!
    expect(rowCheckbox.getAttribute('aria-disabled')).toBe('true')
    const buttons = [...host.querySelectorAll('button')]
    const create = buttons.find((b) => b.textContent?.includes('配信を作る'))!
    expect(create.getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.click(create))
    expect(document.querySelector('[role="menu"][aria-label="配信の作り方"]')).toBeNull()
    expect(buttons.find((b) => b.textContent?.includes('条件を保存する')), '閲覧のみに「条件を保存する」が出ています').toBeUndefined()
    act(() => { buttonByText('保存した検索')!.click() })
    await flush()
    const save = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('今の条件を保存する'))!
    expect(save.getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.click(save))
    expect(host.querySelector('input[aria-label="保存する検索の名前"]')).toBeNull()
    const add = buttons.find(b => b.textContent?.includes('フォルダを追加'))!
    expect(add.getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.click(add))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(createFolder).not.toHaveBeenCalled()
  })

  it('編集キーを持つ運用担当は作れる', async () => {
    role.current = verifiedStaffRole('staff')
    rememberStaffIdentity({ role: 'staff', permissionKeys: ['/broadcasts', 'broadcast.definition.edit'] } as StaffMember)
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    expect(host.textContent).not.toContain('閲覧のみで見ています')
    const create = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('配信を作る')) as HTMLButtonElement
    expect(create.disabled).toBe(false)
  })

  it('配信を作る ▾ は絵（Xr6eu）の分け方：かんたんに送る・詳しく作る（説明つき）。詳しく作るは5つの手順へ移る', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const create = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('配信を作る')) as HTMLButtonElement
    act(() => { create.click() })
    await flush()
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const labels = items.map((item) => item.textContent ?? '')
    expect(labels[0]).toContain('かんたんに送る')
    expect(labels[0]).toContain('文字1通を、全員かタグで。1画面で送れる')
    expect(labels[1]).toContain('詳しく作る')
    expect(labels[1]).toContain('画像・カード・絞り込み・承認（5手順）')
    routerPush.mockClear()
    act(() => { (items[1] as HTMLElement).click() })
    expect(routerPush).toHaveBeenCalledWith('/broadcasts/new')
  })

  it('配信を作るメニューは左のフォルダの列から左へはみ出さないよう、左端をそろえて開く（align=start）', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const create = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('配信を作る')) as HTMLButtonElement
    act(() => { create.click() })
    await flush()
    const portal = document.querySelector('[data-menu-portal]')
    expect(portal?.querySelector('[role="menu"][aria-label="配信の作り方"]'), '配信の作り方のメニューが開いていません').toBeTruthy()
    expect(portal?.getAttribute('data-align')).toBe('start')
  })

  it('loads the same inline form for template entry and keeps its cancel callback', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const create = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('配信を作る'))!
    act(() => create.click())
    await flush()
    const template = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('テンプレートから作る'))!
    await act(async () => template.click())
    await waitFor(() => expect(host.querySelector('[data-loaded-broadcast-form]')).toBeTruthy())
    const form = formImport.props as { openTemplatePickerInitially: boolean; onCancel: () => void; tags: unknown[] }
    expect(form.openTemplatePickerInitially).toBe(true)
    expect(form.tags).toEqual([])
    act(() => form.onCancel())
    expect(host.querySelector('[data-loaded-broadcast-form]')).toBeNull()
  })

  it('決まり2：下書きも予約済みも確認してから削除する', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
    try {
      deleteBroadcast.mockClear()
      // 前の試験の検索語（URL に置かれる）を外す。
      flushListUrlState()
      window.history.replaceState(null, '', '/broadcasts')
      act(() => { root.render(<BroadcastListV8 />) })
      await flush()
      const openMenuOf = (title: string) => {
        const row = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(title))
        const trigger = row?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
        act(() => { trigger.click() })
      }
      const clickMenuItem = (label: string) => {
        const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes(label)) as HTMLElement
        act(() => { item.click() })
      }
      openMenuOf('未購入者フォロー')
      clickMenuItem('削除する')
      await flush()
      expect(document.body.textContent).toContain('「未購入者フォロー」を削除しますか？')
      expect(document.querySelector('[role="alertdialog"] h2')?.textContent).toBe('「未購入者フォロー」を削除しますか？')
      expect([...host.querySelectorAll('tr')].some((tr) => tr.textContent?.includes('未購入者フォロー'))).toBe(true)
      await act(async () => { vi.advanceTimersByTime(5100) })
      expect(deleteBroadcast).not.toHaveBeenCalled()
      const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((el) => el.textContent?.trim() === '削除する') as HTMLButtonElement
      act(() => confirm.click())
      await flush()
      expect(deleteBroadcast).toHaveBeenCalledWith('bc-2')

      openMenuOf('8月キャンペーンのお知らせ')
      clickMenuItem('削除する')
      await flush()
      expect(document.querySelector('[role="alertdialog"] h2')?.textContent).toBe('「8月キャンペーンのお知らせ」を削除しますか？')
    } finally {
      vi.useRealTimers()
    }
  })
  it('統括から来た配信（提案 E-9・l3RQH）は「統括から」の札と鍵を出し、「…」は見る・複製だけ（編集・削除を出さない）', async () => {
    flushListUrlState()
    window.history.replaceState(null, '', '/broadcasts')
    const hqRow = { ...base, id: 'bc-hq', title: '1月の限定メニュー', fromHeadquarters: true, hqRunId: 'run-1', editable: false }
    listBroadcasts.mockImplementation(async () => ({
      success: true,
      data: [hqRow, rowB],
      kpis: { scheduled: 1, thisMonth: 2, delivered: 0, openRate: 0, drafts: 1 },
      statusCounts: { all: 2, scheduled: 1, draft: 1, pending_approval: 0, sent: 0, failed: 0 },
      pagination: { total: 2, limit: 20, cursor: 0, nextCursor: null },
    }))
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    const rowOf = (title: string) => [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(title))
    expect(rowOf('1月の限定メニュー')?.textContent).toContain('統括から')
    expect(rowOf('1月の限定メニュー')?.querySelector('input[type="checkbox"]')).toBeNull()
    expect(rowOf('未購入者フォロー')?.textContent).not.toContain('統括から')
    const trigger = rowOf('1月の限定メニュー')?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
    act(() => { trigger.click() })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
    expect(labels).toContain('配信の詳細を見る')
    expect(labels).toContain('複製')
    expect(labels.some((label) => label?.includes('削除'))).toBe(false)
    expect(labels.some((label) => label?.includes('編集'))).toBe(false)
    expect(labels.some((label) => label?.includes('フォルダへ移す'))).toBe(false)
  })
})

function resetUrl() {
  flushListUrlState()
  window.history.replaceState(null, '', '/broadcasts')
}
it('2ページ目を含む全配信を検索し、検索結果を20件ずつ表示する', async () => {
  resetUrl()
  const rows = Array.from({ length: 125 }, (_, i) => ({ ...rowB, id: `row-${i}`, title: i < 100 ? `通常${i}` : `検索対象${i}` }))
  listBroadcasts.mockImplementation(async (params) => {
    const cursor = Number(params.cursor ?? 0)
    const limit = params.limit ?? 20
    return { success: true, data: rows.slice(cursor, cursor + limit), pagination: { total: rows.length, nextCursor: cursor + limit < rows.length ? String(cursor + limit) : null } }
  })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  fireEvent.change(host.querySelector('input[placeholder="タイトル・内容で探す"]')!, { target: { value: '検索対象' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  await flush()
  expect(host.textContent).toContain('検索対象100')
  expect(host.textContent).not.toContain('検索対象124')
  expect(host.textContent).toContain('25件中 1〜20件')
  const next = host.querySelector('button[aria-label="次のページ"]') as HTMLButtonElement
  expect(next).toBeTruthy()
  act(() => next.click())
  await flush()
  expect(host.textContent).toContain('検索対象124')
  expect(host.textContent).toContain('25件中 21〜25件')
  fireEvent.change(host.querySelector('input[placeholder="タイトル・内容で探す"]')!, { target: { value: '見つからない' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  await flush()
  expect(host.querySelector('[data-pagination-summary]')?.textContent).toBe('0件')
  fireEvent.change(host.querySelector('input[placeholder="タイトル・内容で探す"]')!, { target: { value: '' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  await flush()
  expect(host.textContent).toContain('通常0')
// 複数ページの取得・検索・ページ移動を全部確認し、混雑時も操作全体を待つ。
}, 20_000)

it('全件検索が上限を超えたら部分的な検索結果を表示しない', async () => {
  resetUrl()
  listBroadcasts.mockResolvedValue({ success: true, data: [rowB], pagination: { total: 10001, nextCursor: '100' } })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  fireEvent.change(host.querySelector('input[placeholder="タイトル・内容で探す"]')!, { target: { value: '未購入' } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  await flush()
  expect(host.textContent).toContain('10,000件')
  expect(host.querySelector('tbody')?.textContent ?? '').not.toContain('未購入者フォロー')
})
it('配信日の共通入口から期間を指定し、選択表示と解除を保つ', async () => {
  resetUrl()
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  const trigger = buttonByText('配信日：指定なし')!
  expect(trigger.getAttribute('aria-pressed')).toBe('false')
  act(() => { trigger.click() })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => { (document.querySelector('button[aria-label="配信日（開始）"]') as HTMLButtonElement).click() })
  await flush()
  const month = document.querySelector('[role="grid"]')!.getAttribute('aria-label')!.match(/(\d+)年(\d+)月/)!
  const prefix = `${month[1]}-${month[2].padStart(2,'0')}`
  const chooseDay = (day:string) => ([...document.querySelectorAll<HTMLButtonElement>('[role="grid"] button:not([data-outside])')].find(button=>button.textContent===day)!).click()
  act(() => { chooseDay('1') })
  act(() => { ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="日付を選ぶ"] button')].find(button => button.textContent?.trim() === '確定')!).click() })
  act(() => { (document.querySelector('button[aria-label="配信日（終了）"]') as HTMLButtonElement).click() })
  await flush()
  act(() => { chooseDay('2') })
  act(() => { ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="日付を選ぶ"] button')].find(button => button.textContent?.trim() === '確定')!).click() })
  await flush()
  expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({from:`${prefix}-01`,to:`${prefix}-02`}))
  expect(trigger.getAttribute('aria-pressed')).toBe('true')
  act(() => { ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === '外す')!).click() })
  await flush()
  expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({from:undefined,to:undefined}))
  expect(trigger.getAttribute('aria-pressed')).toBe('false')
  act(() => { ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === '閉じる')!).click() })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
it('保存した検索の送信済み・表示件数・古い順も復元する', async () => {
  resetUrl()
  listViews.mockResolvedValue({ success: true, data: [{ id: 'v1', name: '前月の送信', filters: { statusFilter: 'sent' }, sortKey: 'oldest', pageSize: 50 }] })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  act(() => { buttonByText('保存した検索')!.click() })
  await flush()
  act(() => { ([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('前月の送信')) as HTMLElement).click() })
  await flush()
  expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'sent', limit: 50, sort: 'oldest', cursor: 0 }))
})
it('検索保存は現在の並び順と表示件数を保存する', async () => {
  resetUrl()
  createView.mockClear()
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  act(() => { fireEvent.click(host.querySelector('[aria-label="並び"]')!) })
  act(() => { fireEvent.click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes('古い順'))!.querySelector('button')!) })
  act(() => { buttonByText('保存した検索')!.click() })
  await flush()
  act(() => { ([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('今の条件を保存する')) as HTMLElement).click() })
  await flush()
  fireEvent.change(host.querySelector('input[aria-label="保存する検索の名前"]')!, { target: { value: '古い配信' } })
  act(() => { buttonByText('保存する')!.click() })
  await flush()
  expect(createView).toHaveBeenCalledWith('account-a', expect.objectContaining({ sortKey: 'oldest', pageSize: 20 }))
})

it('検索の通信失敗は内部の英語を出さず、読み直す案内を出す', async () => {
  listBroadcasts.mockRejectedValue(new Error('API error: 500'))
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  expect(host.textContent).not.toContain('API error: 500')
  expect(host.textContent).toContain('管理者にお問い合わせください。')
  expect(buttonByText('もう一度読み込む')).toBeTruthy()
  expect(host.textContent).not.toContain('まだ一斉配信がありません')
  const calls = listBroadcasts.mock.calls.length
  listBroadcasts.mockResolvedValue({ success: true, data: [base], pagination: { total: 1, limit: 20, offset: 0 } })
  act(() => { buttonByText('もう一度読み込む')!.click() })
  await flush()
  expect(listBroadcasts.mock.calls.length).toBe(calls + 1)
  expect(host.textContent).toContain(base.title)
  expect(buttonByText('もう一度読み込む')).toBeUndefined()
})

it('取得に成功して0件だったときだけ、空の一覧を出す', async () => {
  listBroadcasts.mockResolvedValue({ success: true, data: [], pagination: { total: 0, limit: 20, offset: 0 } })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  expect(host.textContent).toContain('まだ一斉配信がありません')
  expect(buttonByText('もう一度読み込む')).toBeUndefined()
})

it('空の作成と上の詳しく作るは同じページへ移り、一覧内にフォームを開かない', async () => {
  listBroadcasts.mockResolvedValue({ success: true, data: [], pagination: { total: 0, limit: 20, offset: 0 } })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  routerPush.mockClear()
  act(() => { buttonByText('最初の一斉配信を作る')!.click() })
  expect(routerPush).toHaveBeenCalledTimes(1)
  const emptyDestination = routerPush.mock.lastCall?.[0] as string
  expect(emptyDestination.split('?')[0]).toBe('/broadcasts/new')
  expect(host.querySelector('[data-loaded-broadcast-form]')).toBeNull()
  act(() => { buttonByText('配信を作る')!.click() })
  await flush()
  const detailed = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('詳しく作る')) as HTMLElement
  act(() => { detailed.click() })
  expect(routerPush).toHaveBeenCalledTimes(2)
  expect(routerPush).toHaveBeenLastCalledWith(emptyDestination)
})

it('WEB-014：一斉配信には手動順・つまみ・上下移動を置かない', async () => {
    await act(async () => root.render(<BroadcastListV8 />)); await flush()
    expect(host.querySelector('[data-reorder-handle]')).toBeNull()
    expect(host.textContent).not.toContain('手動順')
    expect(host.querySelector('[draggable="true"]')).toBeNull()
  })
it('選んだ配信だけを、確認後にその版のままフォルダへ移す', async () => {
  listBroadcasts.mockResolvedValueOnce({ success: true, data: [{ ...base, version: 7 }, { ...rowB, version: 9 }], pagination: { total: 2, limit: 20, cursor: 0 } })
  listFolders.mockResolvedValue({ success: true, data: [{ id: 'campaign', name: 'キャンペーン', color: null }], unfiledCount: 2 })
  act(() => root.render(<BroadcastListV8 />))
  await flush()
  act(() => fireEvent.click(host.querySelector('input[aria-label="8月キャンペーンのお知らせを選ぶ"]')!))
  expect(host.querySelector('[data-row-id="bc-1"]')?.getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector('[data-row-id="bc-2"]')?.getAttribute('aria-selected')).toBe('false')
  const move = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'フォルダへ移す')!
  act(() => fireEvent.click(move))
  expect(updateBroadcast).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="dialog"]')!
  act(() => fireEvent.click(dialog.querySelector('input[aria-label="キャンペーン"]')!))
  const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'フォルダへ移す')!
  await act(async () => { fireEvent.click(confirm) })
  await flush()
  expect(updateBroadcast.mock.calls).toEqual([['bc-1', { folderId: 'campaign', expectedVersion: 7 }]])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('並び順の読み直しでは行と件数を残し、状態条件の切替では旧行を隠す', async () => {
  resetUrl()
  act(() => root.render(<BroadcastListV8 />))
  await flush()
  let resolve!: (value: unknown) => void
  listBroadcasts.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  act(() => fireEvent.click(host.querySelector('[aria-label="並び"]')!))
  act(() => fireEvent.click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes('古い順'))!.querySelector('button')!))
  await flush()
  expect(host.querySelector('[data-row-id="bc-1"]')).not.toBeNull()
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
  await act(async () => resolve({ success: true, data: [rowB, base], pagination: { total: 2 } }))
  await flush()
  listBroadcasts.mockImplementationOnce(() => new Promise(() => {}))
  act(() => buttonByText('下書き')?.click())
  await flush()
  expect(host.querySelector('[data-row-id="bc-1"]')).toBeNull()
})

async function confirmDraftDeletion() {
  const trigger = host.querySelector<HTMLButtonElement>('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!
  act(() => { trigger.focus(); trigger.click() })
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('削除する'))!
  act(() => remove.click())
  await flush()
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === '削除する')!
  act(() => confirm.click())
  await flush()
}

it('削除成功後にだけ150ms薄め、次の行へ焦点を移し、再取得失敗を削除失敗にしない', async () => {
  resetUrl()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  try {
    let resolveDelete!: (value: { success: boolean; data: null }) => void
    deleteBroadcast.mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve }))
    act(() => root.render(<BroadcastListV8 />))
    await flush()
    await confirmDraftDeletion()
    expect(host.querySelector('tr[data-row-id="bc-2"]')?.hasAttribute('data-leaving')).toBe(false)
    listBroadcasts.mockRejectedValueOnce(new Error('reload failed'))
    await act(async () => resolveDelete({ success: true, data: null }))
    await flush()
    expect(host.querySelector('tr[data-row-id="bc-2"]')?.getAttribute('data-leaving')).toBe('true')
    await act(async () => vi.advanceTimersByTime(20))
    expect(document.activeElement?.closest('tr')?.getAttribute('data-row-id')).toBe('bc-1')
    await act(async () => vi.advanceTimersByTime(129))
    expect(host.querySelector('tr[data-row-id="bc-2"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTime(1))
    await flush()
    expect(document.body.textContent).toContain('一斉配信を読み込めませんでした')
    expect(document.body.textContent).not.toContain('この配信を削除できませんでした')
    expect(document.querySelector('[role="alertdialog"]:not([aria-hidden="true"])')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('削除失敗は行と確認窓を残し、動きを減らす設定の成功は待たずに行を外す', async () => {
  resetUrl()
  deleteBroadcast.mockRejectedValueOnce(new Error('delete failed'))
  act(() => root.render(<BroadcastListV8 />))
  await flush()
  await confirmDraftDeletion()
  expect(host.querySelector('tr[data-row-id="bc-2"]')?.hasAttribute('data-leaving')).toBe(false)
  expect(document.body.textContent).toContain('この配信を削除できませんでした')
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
  listBroadcasts.mockImplementationOnce(() => new Promise(() => {}))
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === '削除する')!
  act(() => confirm.click())
  await flush()
  expect(host.querySelector('tr[data-row-id="bc-2"]')).toBeNull()
  expect(host.querySelector('tr[data-row-id="bc-1"]')).not.toBeNull()
  vi.restoreAllMocks()
})

it('行が消える途中で別の絞り込みを選んでも、古い条件を読み直さない', async () => {
  resetUrl()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    act(() => root.render(<BroadcastListV8 />))
    await flush()
    await confirmDraftDeletion()
    expect(host.querySelector('tr[data-row-id="bc-2"]')?.hasAttribute('data-leaving')).toBe(true)
    const draft = buttonByText('下書き 3')!
    act(() => draft.click())
    await flush()
    const reads = listBroadcasts.mock.calls.length
    expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'draft' }))
    await act(async () => vi.advanceTimersByTime(150))
    await flush()
    expect(listBroadcasts).toHaveBeenCalledTimes(reads)
  } finally { vi.useRealTimers() }
})

afterEach(() => { verifiedStaffRole(null) })

describe('読込骨格の表示時間と完了への切替', () => {
  it.each(['ready', 'error'])('遅い応答から%sへ進むとき表示後400msを保つ', async (outcome) => {
    vi.useFakeTimers()
    let complete!: (value: unknown) => void
    listBroadcasts.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const shownBones = () => [...host.querySelectorAll('[aria-busy="true"] [data-skeleton]')]
      .filter(bone => !bone.closest('[data-skeleton-reserve]'))
    try {
      act(() => { root.render(<BroadcastListV8 />) })
      await flush()
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(shownBones()).toHaveLength(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(shownBones().length).toBeGreaterThan(0)
      const table = host.querySelector('[aria-busy="true"] table')!
      expect(table.querySelector('tbody tr')?.children.length).toBe(table.querySelectorAll('thead th').length)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      await act(async () => { complete(outcome === 'ready'
        ? { success: true, data: [base] }
        : { success: false, error: '画面確認用の読込失敗' }) })
      await flush()
      expect(shownBones().length).toBeGreaterThan(0)
      expect(host.querySelector('[data-row-id]')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(349) })
      expect(shownBones().length).toBeGreaterThan(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(shownBones()).toHaveLength(0)
      if (outcome === 'ready') expect(host.querySelector('[data-row-id]')).toBeTruthy()
      else expect(host.textContent).toContain('読み込めませんでした')
    } finally { vi.useRealTimers() }
  })

  it('300ms以内の応答は骨格を見せず行へ切り替える', async () => {
    vi.useFakeTimers()
    let complete!: (value: unknown) => void
    listBroadcasts.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    try {
      act(() => { root.render(<BroadcastListV8 />) }); await flush()
      await act(async () => { await vi.advanceTimersByTimeAsync(250); complete({ success: true, data: [base] }) })
      await flush()
      expect(host.querySelector('[data-row-id]')).toBeTruthy()
      expect(host.querySelector('[aria-busy="true"] [data-skeleton]')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(host.querySelector('[aria-busy="true"] [data-skeleton]')).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

describe('R4 受け付けた数と届いた数を分ける', () => {
  /* 集計の無い送信済み。口の getInsight は失敗のふりなので受け付け数が残る。 */
  const acceptedRow = { ...base, id: 'bc-9', title: '集計まちのお知らせ', status: 'sent', displayStatus: 'sent', displayStatusLabel: '送信済み', scheduledAt: null, sentAt: '2026-08-20T03:00:00.000Z', successCount: 937, insightSummary: null }
  const renderAccepted = async () => {
    narrow.value = false
    listBroadcasts.mockImplementation(async () => ({
      success: true, data: [acceptedRow], kpis: { scheduled: 1, thisMonth: 1, delivered: 1842, openRate: null, drafts: 0 },
      statusCounts: { all: 1, sent: 1 }, pagination: { total: 1, limit: 20, cursor: 0, nextCursor: null },
    }))
    act(() => { root.render(<BroadcastListV8 />) })
    await flush()
    return [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('集計まちのお知らせ')) as HTMLTableRowElement
  }

  it('数の帯の今月の配信は受け付けの言葉で出し、届いたと言わない', async () => {
    await renderAccepted()
    expect(host.textContent).toContain('LINEが受け付けました：1,842人')
    expect(host.textContent).not.toContain('1,842人に届いた')
  })

  it('集計の無い送信済みの行は数を出し、受け付けの説明は title に残す', async () => {
    const row = await renderAccepted()
    const right = [...row.querySelectorAll('td[data-align="right"]')]
    expect(right[0].textContent?.trim()).toBe('937 人')
    expect(right[0].querySelector('span')?.getAttribute('title')).toBe('LINEが受け付けました：937人')
    expect(right[0].textContent).not.toContain('LINEが受け付けました')
  })

  it('集計の無い送信済みの詳細パネルは受け付けの言葉で出す', async () => {
    const row = await renderAccepted()
    act(() => { fireEvent.click(row) })
    await flush()
    const panel = document.body.querySelector('[data-design-part="detail-panel"]') as HTMLElement
    expect(panel.textContent).toContain('LINEが受け付けました：937人')
    expect(panel.textContent).not.toContain('人に届いた')
  })
})
it('下書き削除後は一覧と未分類の件数を同じデータへ更新する', async () => {
  resetUrl()
  let rows = [base, rowB]
  listBroadcasts.mockImplementation(async () => ({ success: true, data: rows, statusCounts: { all: rows.length }, pagination: { total: rows.length, nextCursor: null } }))
  listFolders.mockImplementation(async () => ({ success: true, data: [], unfiledCount: rows.length }))
  deleteBroadcast.mockImplementationOnce(async (id: string) => { rows = rows.filter(row => row.id !== id); return { success: true, data: null } })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  expect(buttonByText('未分類2')).toBeTruthy()
  const trigger = host.querySelector<HTMLButtonElement>('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!
  act(() => trigger.click())
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('削除する'))!
  act(() => remove.click())
  await flush()
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === '削除する')!
  act(() => confirm.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  await flush()
  await waitFor(() => expect(buttonByText('未分類1')).toBeTruthy())
  expect(buttonByText('すべて1')).toBeTruthy()
}, 20_000)

it('2ページ目で削除して1ページになると1ページ目に戻って行を出す', async () => {
  resetUrl()
  let rows = Array.from({ length: 21 }, (_, i) => ({ ...rowB, id: `pg-${i}`, title: `通常${i}` }))
  listBroadcasts.mockImplementation(async (params) => {
    const cursor = Number(params.cursor ?? 0)
    const limit = params.limit ?? 20
    return { success: true, data: rows.slice(cursor, cursor + limit), pagination: { total: rows.length, nextCursor: cursor + limit < rows.length ? String(cursor + limit) : null } }
  })
  deleteBroadcast.mockImplementation(async (id: string) => { rows = rows.filter((row) => row.id !== id); return { success: true, data: null } })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  act(() => { (host.querySelector('button[aria-label="次のページ"]') as HTMLButtonElement).click() })
  await flush()
  expect(host.textContent).toContain('通常20')
  const trigger = host.querySelector<HTMLButtonElement>('tr[data-row-id="pg-20"] button[aria-haspopup="menu"]')!
  act(() => { trigger.focus(); trigger.click() })
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('削除する'))!
  act(() => remove.click())
  await flush()
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === '削除する')!
  act(() => confirm.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  await flush()
  expect(host.textContent).toContain('通常0')
  expect(host.querySelector('[data-pagination-summary]')?.textContent).toBe('20件中 1〜20件')
}, 20_000)

it('総件数が未取得のときは補正せず2ページ目の行を出す', async () => {
  flushListUrlState()
  window.history.replaceState(null, '', '/broadcasts?page=2')
  const rows = Array.from({ length: 21 }, (_, i) => ({ ...rowB, id: `nt-${i}`, title: `通常${i}` }))
  listBroadcasts.mockImplementation(async (params) => {
    const cursor = Number(params.cursor ?? 0)
    const limit = params.limit ?? 20
    return { success: true, data: rows.slice(cursor, cursor + limit), pagination: { nextCursor: null } }
  })
  act(() => { root.render(<BroadcastListV8 />) })
  await flush()
  expect(host.textContent).toContain('通常20')
  flushListUrlState()
  expect(window.location.search).toContain('page=2')
}, 20_000)

describe('V8 一斉配信一覧の送信枠の行き先', () => {
  it('未接続・取得失敗のときはトークンを入れ直す場所（アカウント設定）への行き先を出す', async () => {
    dashboardOverview.mockResolvedValue({ success: true, data: { delivery: { quotaLimit: null, quotaUsed: null }, metrics: { monthlyQuota: { state: 'unavailable', reason: 'not_connected', value: null } } } })
    act(() => { root.render(<BroadcastListV8 />) })
    await waitFor(() => expect(host.textContent).toContain('送信枠を確認できません'))
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('アカウント設定へ'))
    expect(link?.getAttribute('href')).toBe('/accounts/detail?id=account-a')
  })

  it('口そのものが失敗したときは理由が分からないので行き先を出さない', async () => {
    dashboardOverview.mockResolvedValue({ success: false })
    act(() => { root.render(<BroadcastListV8 />) })
    await waitFor(() => expect(host.textContent).toContain('送信枠を確認できません'))
    expect([...host.querySelectorAll('a')].some((a) => a.textContent?.includes('アカウント設定へ'))).toBe(false)
  })

  it('送信枠が読めたときは行き先を出さない', async () => {
    act(() => { root.render(<BroadcastListV8 />) })
    await waitFor(() => expect(host.textContent).toContain('5,000 通のうち 1,842 通を使用'))
    expect([...host.querySelectorAll('a')].some((a) => a.textContent?.includes('アカウント設定へ'))).toBe(false)
  })

  it('上限なしの契約では使用数と「上限なし」を出し、行き先を出さない', async () => {
    dashboardOverview.mockResolvedValue({ success: true, data: { delivery: { quotaLimit: null, quotaUsed: 1842 }, metrics: { monthlyQuota: { state: 'available', reason: null, value: { used: 1842, limit: null, remaining: null, unlimited: true } } } } })
    act(() => { root.render(<BroadcastListV8 />) })
    await waitFor(() => expect(host.textContent).toContain('上限なし'))
    expect(host.textContent).toContain('1,842')
    expect(host.textContent).not.toContain('送信枠を確認できません')
    expect([...host.querySelectorAll('a')].some((a) => a.textContent?.includes('アカウント設定へ'))).toBe(false)
  })

  it('読み込み中は骨組みで待ち、行き先を出さない', async () => {
    dashboardOverview.mockImplementation(() => new Promise<never>(() => {}))
    act(() => { root.render(<BroadcastListV8 />) })
    await waitFor(() => expect(host.textContent).toContain('読み込んでいます'))
    expect(host.textContent).not.toContain('送信枠を確認できません')
    expect([...host.querySelectorAll('a')].some((a) => a.textContent?.includes('アカウント設定へ'))).toBe(false)
  })

  it('metric が失敗のときも行き先を出す', async () => {
    dashboardOverview.mockResolvedValue({ success: true, data: { delivery: { quotaLimit: null, quotaUsed: null }, metrics: { monthlyQuota: { state: 'unavailable', reason: 'fetch_failed', value: { used: null, limit: null, remaining: null } } } } })
    act(() => { root.render(<BroadcastListV8 />) })
    await waitFor(() => expect(host.textContent).toContain('送信枠を確認できません'))
    expect([...host.querySelectorAll('a')].some((a) => a.textContent?.includes('アカウント設定へ'))).toBe(true)
  })
})

describe('保持した一斉配信一覧の変更操作', () => {
  let toastHost: HTMLDivElement
  let toastRoot: Root
  beforeEach(() => {
    clearToastsForTest()
    toastHost = document.createElement('div'); document.body.appendChild(toastHost)
    toastRoot = createRoot(toastHost)
    act(() => toastRoot.render(<ToastHost />))
  })
  afterEach(() => { act(() => toastRoot.unmount()); toastHost.remove(); clearToastsForTest() })
  const person = (value: string, permissionKeys: string[] = []) => ({ id: 'person', role: value, permissionKeys }) as unknown as StaffMember
  const proxy = (mode: 'read' | 'write') => rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: { mode } as never })
  const revoke = (value: string) => {
    role.current = value === 'unknown' ? null : ['readOnly', 'view_only'].includes(value) ? 'viewer' : value === 'read-proxy' ? 'owner' : value
    if (value === 'unknown') forgetStaffIdentity()
    else if (value === 'read-proxy') proxy('read')
    else if (value === 'readOnly') rememberStaffIdentity({ ...person('owner'), readOnly: true })
    else if (value === 'view_only') rememberStaffIdentity({ ...person('owner'), roleBundle: 'view_only' } as StaffMember)
    else rememberStaffIdentity(person(value))
  }
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.getAttribute('aria-label') === label || e.textContent?.trim() === label)!
  const openDraftDelete = async () => {
    act(() => fireEvent.click(host.querySelector('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!))
    act(() => fireEvent.click(menuItem('削除する')))
    await flush()
    return [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(e => e.textContent?.trim() === '削除する')!
  }
  const openSearchSave = async () => {
    act(() => buttonByText('保存した検索')!.click()); await flush()
    act(() => fireEvent.click(menuItem('＋ 今の条件を保存する'))); await flush()
    act(() => fireEvent.change(host.querySelector('input[aria-label="保存する検索の名前"]')!, { target: { value: '残しておく条件' } }))
  }

  it('配信の削除確認に記録されたLINEアカウントと環境を出す', async () => {
    resetUrl()
    act(() => root.render(<BroadcastListV8 />)); await flush()
    await openDraftDelete()
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).toContain('名前を確認できません')
  })
  it('アカウントを切り替えて戻しても古い配信削除を実行しない', async () => {
    deleteBroadcast.mockClear(); resetUrl()
    act(() => root.render(<BroadcastListV8 />)); await flush()
    await openDraftDelete()
    const retained = heldConfirm.broadcast!
    account.id = 'account-b'; act(() => root.render(<BroadcastListV8 />)); await flush()
    account.id = 'account-a'; act(() => root.render(<BroadcastListV8 />)); await flush()
    await act(async () => { await retained() })
    expect(deleteBroadcast).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'viewer', 'staff', 'read-proxy', 'readOnly', 'view_only'])('削除確認を開いた後の%sでは確定を書き込まず、窓を残す', async denied => {
    deleteBroadcast.mockClear(); resetUrl()
    act(() => root.render(<BroadcastListV8 />)); await flush()
    const confirm = await openDraftDelete()
    const retained = heldConfirm.broadcast
    expect(retained).toBeTypeOf('function')
    act(() => revoke(denied))
    expect(confirm.disabled).toBe(denied === 'unknown')
    expect(confirm.getAttribute('aria-disabled')).toBe(denied === 'unknown' ? null : 'true')
    act(() => fireEvent.click(confirm)); await flush()
    expect(confirm.isConnected).toBe(true)
    expect(deleteBroadcast).not.toHaveBeenCalled()
    await act(async () => retained!())
    expect(deleteBroadcast).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('権限が変わったため、配信の削除を中止しました。')
    listBroadcasts.mockClear()
    act(() => buttonByText('下書き 3')!.click()); await flush()
    expect(listBroadcasts).toHaveBeenCalledWith(expect.objectContaining({ displayStatus: 'draft' }))
  })

  it.each(['admin', 'staff'])('%sの正規編集者は削除を1回だけ保存する', async editor => {
    deleteBroadcast.mockClear(); resetUrl()
    role.current = editor
    rememberStaffIdentity(person(editor, ['/broadcasts', 'broadcast.definition.edit']))
    act(() => root.render(<BroadcastListV8 />)); await flush()
    const confirm = await openDraftDelete()
    act(() => fireEvent.click(confirm)); await flush()
    expect(deleteBroadcast).toHaveBeenCalledExactlyOnceWith('bc-2')
  })

  it.each(['staff', 'read-proxy', 'unknown'])('開いた検索の保存も%sでは送らず、保存済み条件のGETを残す', async denied => {
    createView.mockClear(); resetUrl()
    act(() => root.render(<BroadcastListV8 />)); await flush(); await openSearchSave()
    act(() => {
      if (denied === 'staff') rememberStaffIdentity(person('staff', ['/broadcasts', 'broadcast.definition.edit']))
      else revoke(denied)
      buttonByText('保存する')!.click()
    })
    await flush()
    expect(createView).not.toHaveBeenCalled()
    expect(host.querySelector('input[aria-label="保存する検索の名前"]')).toBeTruthy()
    expect(host.textContent).toContain('権限が変わったため、検索条件の保存を中止しました。')
  })

  it.each(['owner', 'admin'])('%sは保存した検索を1回保存できる', async manager => {
    createView.mockClear(); resetUrl(); role.current = manager; rememberStaffIdentity(person(manager))
    act(() => root.render(<BroadcastListV8 />)); await flush(); await openSearchSave()
    act(() => buttonByText('保存する')!.click()); await flush()
    expect(createView).toHaveBeenCalledTimes(1)
  })

  it.each(['staff', 'read-proxy', 'unknown'])('フォルダの削除・並び順も%sの古い操作から送らない', async denied => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }, { id: 'b', name: '分類B', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    const order = menuItem('並べ替える（下へ）')
    act(() => { revoke(denied); fireEvent.click(order) }); await flush()
    expect(swapFolders).not.toHaveBeenCalled()
    expect(host.textContent).toContain('権限が変わったため、フォルダの並べ替えを中止しました。')
    act(() => { role.current = 'owner'; rememberStaffIdentity(person('owner')); forgetSessionSnapshot() })
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('消す'))); await flush()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(e => e.textContent?.trim() === '削除する')!
    const retained = heldConfirm.folder
    expect(retained).toBeTypeOf('function')
    act(() => revoke(denied))
    act(() => fireEvent.click(confirm)); await flush()
    expect(confirm.isConnected).toBe(true)
    expect(deleteFolder).not.toHaveBeenCalled()
    await act(async () => retained!())
    expect(deleteFolder).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('権限が変わったため、フォルダの削除を中止しました。')
  })

  it('折りたたんだフォルダ欄でも削除入口を出す', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[data-folder-select][title="分類A"]')!)); await flush()
    expect(document.querySelectorAll('[aria-label="フォルダ「分類A」の操作"]')).toHaveLength(2)
  })

  it('フォルダに記録された所有先を表示する', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast', accountId: 'account-b' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('消す'))); await flush()
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('フォルダの所有店'))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).not.toContain('選択中の店')
  })

  it('共通フォルダの削除は共通の対象を示す', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast', accountId: null }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('消す'))); await flush()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('共通（全アカウント）')
  })

  it('閉じたフォルダ削除の古い確定は実行しない', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('消す'))); await flush()
    const retained = heldConfirm.folder!
    const dialog = document.querySelector('[role="alertdialog"]')!
    act(() => fireEvent.click([...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'キャンセル')!)); await flush()
    await act(async () => retained())
    expect(deleteFolder).not.toHaveBeenCalled()
  })

  it('フォルダ削除は対象と環境を出し、別アカウントに切り替えたら確定できない', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('消す'))); await flush()
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    const retained = heldConfirm.folder!
    account.id = 'account-b'
    act(() => root.render(<BroadcastListV8 />)); await flush()
    expect(document.querySelector('[role="alertdialog"]')?.getAttribute('data-closing')).toBe('true')
    await act(async () => retained())
    expect(deleteFolder).not.toHaveBeenCalled()
  })

  it('adminはフォルダの並び順と削除を各1回保存できる', async () => {
    resetUrl(); role.current = 'admin'; rememberStaffIdentity(person('admin'))
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }, { id: 'b', name: '分類B', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('並べ替える（下へ）'))); await flush()
    expect(swapFolders).toHaveBeenCalledExactlyOnceWith('a', 'b')
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('消す'))); await flush()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(e => e.textContent?.trim() === '削除する')!
    act(() => fireEvent.click(confirm)); await flush()
    expect(deleteFolder).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('まとめ移動の1件目の間にread→writeを往復しても、残りを自動で書き込まない', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'campaign', kind: 'broadcast', name: 'キャンペーン', color: null }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('[aria-label="このページを全部選ぶ"]')!))
    act(() => buttonByText('フォルダへ移す')!.click()); await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    act(() => fireEvent.click(dialog.querySelector('input[aria-label="キャンペーン"]')!))
    updateBroadcast.mockImplementationOnce(async () => { proxy('read'); proxy('write'); return { success: true, data: null } })
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === 'フォルダへ移す')!
    await act(async () => fireEvent.click(confirm)); await flush()
    expect(updateBroadcast).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('1件を移せませんでした')
  })

  it.each(['read', 'read-write'] as const)('行の即時移動でも送信前の%s切替を確認し、見た目を戻して書込0', async change => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'campaign', kind: 'broadcast', name: 'キャンペーン', color: null }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!))
    act(() => fireEvent.click(menuItem('フォルダへ移す'))); await flush()
    act(() => { fireEvent.click(menuItem('キャンペーン')); proxy('read'); if (change === 'read-write') proxy('write') })
    await flush()
    expect(updateBroadcast).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('フォルダへ移せませんでした')
    expect(host.querySelector('tr[data-row-id="bc-2"] [data-folder-dot]')?.getAttribute('data-folder-dot')).toBe('unfiled')
  })
  it('ownerは同じ行メニューからフォルダへ1回移せる', async () => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'campaign', kind: 'broadcast', name: 'キャンペーン', color: null }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!))
    act(() => fireEvent.click(menuItem('フォルダへ移す'))); await flush()
    act(() => fireEvent.click(menuItem('キャンペーン'))); await flush()
    expect(updateBroadcast).toHaveBeenCalledExactlyOnceWith('bc-2', { folderId: 'campaign', expectedVersion: 0 })
  })

  it('配信編集鍵だけのstaffにも管理操作を残し、検索の読取を保って理由付きで拒む', async () => {
    resetUrl(); createView.mockClear(); role.current = 'staff'; rememberStaffIdentity(person('staff', ['/broadcasts', 'broadcast.definition.edit']))
    listViews.mockResolvedValue({ success: true, data: [{ id: 'v', name: '保存済み条件', filters: {}, sortKey: 'newest', pageSize: 20 }] })
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }, { id: 'b', name: '分類B', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    const add = buttonByText('フォルダを追加')!
    expect(add.getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.focus(add))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('この操作はオーナーか管理者だけができます。')
    act(() => fireEvent.click(add)); expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    for (const label of ['名前を変更する', '色を変更する', '並べ替える（下へ）', '消す']) {
      expect(menuItem(label).getAttribute('aria-disabled')).toBe('true')
      act(() => fireEvent.click(menuItem(label)))
    }
    expect(createFolder).not.toHaveBeenCalled(); expect(updateFolder).not.toHaveBeenCalled()
    expect(swapFolders).not.toHaveBeenCalled(); expect(deleteFolder).not.toHaveBeenCalled()
    act(() => fireEvent.keyDown(document, { key: 'Escape' }))
    act(() => buttonByText('保存した検索')!.click()); await flush()
    expect(menuItem('＋ 今の条件を保存する').getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.click(menuItem('＋ 今の条件を保存する')))
    expect(host.querySelector('input[aria-label="保存する検索の名前"]')).toBeNull()
    listBroadcasts.mockClear()
    act(() => fireEvent.click(menuItem('保存済み条件'))); await flush()
    expect(buttonByText('保存済み条件')).toBeTruthy()
    expect(createView).not.toHaveBeenCalled()
    act(() => buttonByText('下書き 3')!.click()); await flush()
    expect(listBroadcasts).toHaveBeenCalledWith(expect.objectContaining({ displayStatus: 'draft' }))
  })

  it.each([false, true])('開いたフォルダ%sの保存はread代理への切替直後にも送らず理由を残す', async editing => {
    resetUrl()
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    if (editing) {
      act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
      act(() => fireEvent.click(menuItem('名前を変更する')))
    } else act(() => buttonByText('フォルダを追加')!.click())
    await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    const input = dialog.querySelector('input')!
    act(() => fireEvent.change(input, { target: { value: '残す名前' } }))
    act(() => { proxy('read'); fireEvent.keyDown(input, { key: 'Enter' }) }); await flush()
    expect(createFolder).not.toHaveBeenCalled(); expect(updateFolder).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('権限が変わったため、フォルダの保存を中止しました。')
    expect(dialog.isConnected).toBe(true)
    expect((input as HTMLInputElement).value).toBe('残す名前')
  })

  it.each(['owner', 'admin'])('%sの左のフォルダ欄から追加と名前変更が実際の保存へつながる', async manager => {
    resetUrl(); role.current = manager; rememberStaffIdentity(person(manager))
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '分類A', kind: 'broadcast' }], unfiledCount: 2 })
    act(() => root.render(<BroadcastListV8 />)); await flush()
    const add = buttonByText('フォルダを追加')!
    expect(add.closest('nav[aria-label="フォルダ"]')).toBeTruthy()
    act(() => fireEvent.click(add)); await flush()
    let dialog = document.querySelector('[role="dialog"]')!
    act(() => fireEvent.change(dialog.querySelector('input')!, { target: { value: '新しい分類' } }))
    let confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '追加する')!
    expect(confirm.disabled).toBe(false)
    act(() => fireEvent.click(confirm)); await flush()
    expect(createFolder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'broadcast', name: '新しい分類', accountId: 'account-a' }))
    expect(dialog.isConnected).toBe(false)
    act(() => fireEvent.click(host.querySelector('[aria-label="フォルダ「分類A」の操作"]')!))
    act(() => fireEvent.click(menuItem('名前を変更する'))); await flush()
    dialog = document.querySelector('[role="dialog"]')!
    act(() => fireEvent.change(dialog.querySelector('input')!, { target: { value: '変更した分類' } }))
    confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '保存する')!
    act(() => fireEvent.click(confirm)); await flush()
    expect(updateFolder).toHaveBeenCalledExactlyOnceWith('a', expect.objectContaining({ name: '変更した分類' }), undefined)
    expect(dialog.isConnected).toBe(false)
  })

  it.each(['viewer', 'staff', 'read-proxy', 'readOnly', 'view_only'])('%sも作成・選択・行操作を同じ位置に残し、理由付きで拒否して読取を続ける', async denied => {
    resetUrl(); deleteBroadcast.mockClear(); createView.mockClear()
    act(() => { revoke(denied); root.render(<BroadcastListV8 />) }); await flush()
    const reason = denied === 'read-proxy' ? PERMISSION_LOCK_REASON.impersonation : denied === 'staff' ? PERMISSION_LOCK_REASON.feature : PERMISSION_LOCK_REASON.viewer
    expect(host.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
    const create = buttonByText('配信を作る')!
    expect(create.disabled).toBe(false); expect(create.getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.focus(create))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(reason)
    act(() => { fireEvent.blur(create); fireEvent.click(create) })
    expect(document.querySelector('[role="menu"][aria-label="配信の作り方"]')).toBeNull()
    const select = host.querySelector<HTMLInputElement>('tr[data-row-id="bc-2"] input[type="checkbox"]')!
    expect(select.disabled).toBe(false); expect(select.getAttribute('aria-disabled')).toBe('true')
    act(() => fireEvent.click(select))
    expect(select.checked).toBe(false)
    act(() => fireEvent.click(host.querySelector('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!))
    for (const label of ['編集を続ける', '複製', 'フォルダへ移す', '削除する']) {
      const item = menuItem(label)
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.hasAttribute('href')).toBe(false)
      act(() => fireEvent.click(item))
    }
    act(() => fireEvent.keyDown(document, { key: 'Escape' }))
    listBroadcasts.mockClear()
    act(() => buttonByText('下書き 3')!.click()); await flush()
    expect(listBroadcasts).toHaveBeenCalledWith(expect.objectContaining({ displayStatus: 'draft' }))
    expect(updateBroadcast).not.toHaveBeenCalled(); expect(deleteBroadcast).not.toHaveBeenCalled()
    expect(createFolder).not.toHaveBeenCalled(); expect(createView).not.toHaveBeenCalled()
  })
  it('閲覧者の右クリックでも同じ4操作に理由が届き、APIも移動も起動しない', async () => {
    resetUrl(); deleteBroadcast.mockClear(); routerPush.mockClear()
    act(() => { revoke('viewer'); root.render(<BroadcastListV8 />) }); await flush()
    const trigger = host.querySelector('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!
    act(() => fireEvent.contextMenu(trigger, { clientX: 300, clientY: 250 })); await flush()
    const context = document.querySelector('[data-context-menu="true"]')!
    expect(context).toBeTruthy()
    for (const label of ['編集を続ける', '複製', 'フォルダへ移す', '削除する']) {
      const item = [...context.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.getAttribute('aria-label') === label || e.textContent?.trim() === label)!
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.hasAttribute('href')).toBe(false)
      act(() => fireEvent.focus(item))
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(PERMISSION_LOCK_REASON.viewer)
      act(() => { fireEvent.blur(item); fireEvent.click(item) })
    }
    expect(updateBroadcast).not.toHaveBeenCalled(); expect(deleteBroadcast).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
  })
  it('開いた詳細パネルもread代理で書込だけ灰色にし、本文と開く操作を残す', async () => {
    resetUrl(); deleteBroadcast.mockClear(); routerPush.mockClear()
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => fireEvent.click(host.querySelector('tr[data-row-id="bc-2"]')!)); await flush()
    const panel = document.querySelector('[data-design-part="detail-panel"]')!
    expect(panel).toBeTruthy()
    act(() => revoke('read-proxy')); await flush()
    expect(panel.isConnected).toBe(true)
    expect(panel.textContent).toContain('下書き')
    for (const label of ['編集を続ける', '複製する', '削除する']) {
      const button = label === '編集を続ける'
        ? [...panel.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === label)!
        : await findDetailMenuItem(label, panel)
      expect(button.hasAttribute('disabled')).toBe(false); expect(button.getAttribute('aria-disabled')).toBe('true')
      act(() => fireEvent.focus(button))
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(PERMISSION_LOCK_REASON.impersonation)
      act(() => { fireEvent.blur(button); fireEvent.click(button) })
    }
    expect(updateBroadcast).not.toHaveBeenCalled(); expect(deleteBroadcast).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    const read = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === '開く')!
    expect(read.disabled).toBe(false); expect(read.hasAttribute('aria-disabled')).toBe(false)
    act(() => fireEvent.click(read))
    expect(routerPush).toHaveBeenCalledTimes(1)
    const destination = new URL(routerPush.mock.calls[0][0], 'http://localhost')
    expect(destination.pathname).toBe('/broadcasts/detail'); expect(destination.searchParams.get('id')).toBe('bc-2')
  })
  it('本人未確認は帯と権限印を出さず、管理と編集の入口を普通disabledで残す', async () => {
    resetUrl(); deleteBroadcast.mockClear(); createView.mockClear()
    act(() => { revoke('unknown'); root.render(<BroadcastListV8 />) }); await flush()
    expect(host.querySelectorAll('[data-read-only-notice]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-permission-locked]')).toHaveLength(0)
    for (const label of ['配信を作る', 'フォルダを追加']) {
      const button = buttonByText(label)!
      expect(button.disabled).toBe(true)
      act(() => fireEvent.click(button))
    }
    for (const input of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) expect(input.disabled).toBe(true)
    act(() => buttonByText('保存した検索')!.click()); await flush()
    const save = menuItem('＋ 今の条件を保存する') as HTMLButtonElement
    expect(save.disabled).toBe(true); expect(save.hasAttribute('data-permission-locked')).toBe(false)
    act(() => fireEvent.click(save))
    expect(host.querySelector('input[aria-label="保存する検索の名前"]')).toBeNull()
    act(() => fireEvent.keyDown(document, { key: 'Escape' }))
    act(() => fireEvent.click(host.querySelector('tr[data-row-id="bc-2"] button[aria-haspopup="menu"]')!))
    for (const label of ['編集を続ける', '複製', '削除する']) {
      const item = menuItem(label) as HTMLButtonElement
      expect(item.disabled).toBe(true); expect(item.hasAttribute('href')).toBe(false)
      expect(item.hasAttribute('data-permission-locked')).toBe(false)
      act(() => fireEvent.click(item))
    }
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(updateBroadcast).not.toHaveBeenCalled(); expect(deleteBroadcast).not.toHaveBeenCalled()
    expect(createFolder).not.toHaveBeenCalled(); expect(createView).not.toHaveBeenCalled()
  })
  it('代理切替のsession読込中も、ownerにmanagerの理由を出さずread代理の理由で止める', async () => {
    resetUrl(); deleteBroadcast.mockClear(); createView.mockClear()
    act(() => root.render(<BroadcastListV8 />)); await flush()
    act(() => deferImpersonationSnapshot({ id: 'pending-proxy', tenantId: 'tenant-a', mode: 'write', piiRevealed: false, startedAt: '' }))
    expect(readSessionSnapshot()).toBeNull()
    expect(host.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
    for (const label of ['配信を作る', 'フォルダを追加']) {
      const button = buttonByText(label)!
      expect(button.getAttribute('aria-disabled')).toBe('true')
      act(() => fireEvent.focus(button))
      const text = document.querySelector('[role="tooltip"]')?.textContent
      expect(text).toContain(PERMISSION_LOCK_REASON.impersonation)
      expect(text).not.toContain(PERMISSION_LOCK_REASON.manager)
      act(() => { fireEvent.blur(button); fireEvent.click(button) })
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    listBroadcasts.mockClear(); act(() => buttonByText('下書き 3')!.click()); await flush()
    expect(listBroadcasts).toHaveBeenCalledWith(expect.objectContaining({ displayStatus: 'draft' }))
    expect(updateBroadcast).not.toHaveBeenCalled(); expect(deleteBroadcast).not.toHaveBeenCalled()
    expect(createFolder).not.toHaveBeenCalled(); expect(createView).not.toHaveBeenCalled()
  })

})

it('状態の切り替えは件数とAPI条件を保ち、矢印で1つだけ選べる', async () => {
  act(() => root.render(<BroadcastListV8 />)); await flush()
  const group = host.querySelector('[data-segmented-control][aria-label="状態"]')!
  expect(group).toBeTruthy()
  const options = [...group.querySelectorAll('button')]
  expect(options).toHaveLength(6)
  expect(group.querySelector('svg')).toBeNull()
  fireEvent.keyDown(options[0], { key: 'Home' }); await flush()
  fireEvent.keyDown(options[0], { key: 'ArrowRight' }); await flush()
  expect(options.filter(button => button.getAttribute('aria-pressed') === 'true')).toEqual([options[1]])
  expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'scheduled', cursor: 0 }))
  expect(document.activeElement).toBe(options[1])
  fireEvent.keyDown(options[1], { key: 'End' }); await flush()
  expect(options[5].getAttribute('aria-pressed')).toBe('true')
  expect(listBroadcasts).toHaveBeenLastCalledWith(expect.objectContaining({ displayStatus: 'failed,partial_failed', cursor: 0 }))
})

describe('配信状態ごとの削除入口', () => {
  const statuses = [
    ['draft', true], ['scheduled', true], ['sending', false], ['sent', false], ['failed', false],
  ] as const
  function givenStatus(status: string) {
    listBroadcasts.mockImplementation(async () => ({
      success: true, data: [{ ...base, id: 'status-row', status, displayStatus: status }],
      kpis: {}, statusCounts: { all: 1 }, pagination: { total: 1, limit: 20, cursor: 0, nextCursor: null },
    }))
  }
  it.each(statuses)('行メニュー: %s は削除入口 %s', async (status, allowed) => {
    resetUrl(); givenStatus(status)
    act(() => root.render(<BroadcastListV8 />)); await flush()
    const trigger = host.querySelector<HTMLButtonElement>('tr[data-row-id="status-row"] button[aria-haspopup="menu"]')!
    expect(trigger).toBeTruthy()
    act(() => trigger.click()); await flush()
    const menu = document.querySelector('[role="menu"]')!
    expect(menu).toBeTruthy()
    expect([...menu.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === '削除する')).toBe(allowed)
  })
  it.each(statuses)('詳細パネル: %s は削除入口 %s', async (status, allowed) => {
    resetUrl(); givenStatus(status)
    act(() => root.render(<BroadcastListV8 />)); await flush()
    const row = host.querySelector<HTMLElement>('tr[data-row-id="status-row"]')!
    expect(row).toBeTruthy()
    act(() => row.click()); await flush()
    const panel = document.querySelector('[data-design-part="detail-panel"]')!
    expect(panel).toBeTruthy()
    const trigger = panel.querySelector<HTMLButtonElement>('footer [data-row-menu]')!
    expect(trigger).toBeTruthy()
    act(() => trigger.click()); await flush()
    const menu = document.querySelector('[role="menu"]')!
    expect(menu).toBeTruthy()
    expect([...menu.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === '削除する')).toBe(allowed)
  })
})
