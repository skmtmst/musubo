// @vitest-environment happy-dom
/*
 * V8 リマインダの詳細（src/v8/reminders/detail.tsx）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 一時停止は確かめの窓を通す・最近の実行は送った物だけ・閲覧のみには押せない操作を置かない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const state = vi.hoisted(() => ({
  accountId: 'account-a',
  ownerId: 'account-a' as string | null,
  role: 'owner' as string,
  tab: '' as string,
  updates: [] as Array<Record<string, unknown>>,
  deletes: [] as string[],
  retry: vi.fn(),
  plannedTotal: 2,
  onlyPlanned: false,
  omitId: false,
  urlId: 'reminder-1',
  management:false,
}))

vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '別店舗' }] }) }))

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    React.createElement('a', { href, className }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/reminders/detail',
  useSearchParams: () => new URLSearchParams(`${state.omitId ? '' : `id=${state.urlId}`}${state.tab ? `${state.omitId ? '' : '&'}tab=${state.tab}` : ''}`),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: state.accountId, selectedAccount: { id: state.accountId, name: '本店' }, accounts: [], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => state.role }
})

const soon = () => new Date(Date.now() + 3_600_000).toISOString()

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  const run = (id: string, domainStatus: string, friendName: string) => ({
    id, friendId: `f-${id}`, friendName, stepNumber: 1, domainStatus, scheduledAt: soon(), startedAt: null, completedAt: null,
    nextRetryAt: null, attemptCount: 1, lineRequestId: null, lastErrorMessage: null, canRetry: false,
  })
  return {
    ApiError,
    fetchApi: vi.fn(async () => ({ success: true, data: {} })),
    api: {
      reminders: {
        runs: vi.fn(async (_id: string, params?: { status?: string }) => ({
          success: true,
          data: {
            reminder: { id: 'reminder-1', lineAccountId: state.ownerId, name: '予約前日のご案内', isActive: true, lifecycleStatus: 'published', stopConditions: null, hasPublishedVersion: true },
            summary: { sent: 3, scheduled: 2, stopped: 0, errors: 2, targetCount: 186, nextScheduledAt: soon(), sentThisMonth: 386, scheduledNext7Days: 124 },
            steps: [{ id: 'st1', stepNumber: 1, offsetMinutes: -1440, messageType: 'text', messageContent: '明日のご案内です。', sent: 212, openRate: null, errors: 1 }],
            items: params?.status === 'planned'
              ? [run('p1', 'planned', '見本 122'), run('p2', 'planned', '見本 29')]
              : state.onlyPlanned
                ? [run('r3', 'planned', '予定の人')]
                : [run('r1', 'succeeded', '見本 122'), run('r2', 'permanent_failed', '見本 176'), run('r3', 'planned', '予定の人')],
            pagination: { total: params?.status === 'planned' ? state.plannedTotal : state.onlyPlanned ? 40 : 2, limit: 100, offset: 0 },
          },
        })),
        get: vi.fn(async () => ({ success: true, data: { id: 'reminder-1', name: '予約前日のご案内', isActive: true, triggerType: 'booking', deliveryMode: 'time', ...(state.management?{followupManagement:{storeId:'store',storeName:'食堂',effectiveSendingStatus:'stopped',reason:'内容が変わったため、止まっています',path:'/restaurant-test/line-followup?store_id=store'}}:{}), createdAt: '', updatedAt: '2026-09-28T01:00:00Z', steps: [{ id: 'st1', reminderId: 'reminder-1', offsetMinutes: 0, offsetDays: -1, sendAtTime: '18:00', messageType: 'text', messageContent: '', createdAt: '' }] } })),
        update: vi.fn(async (_id: string, body: Record<string, unknown>) => {
          state.updates.push(body)
          return { success: true, data: null }
        }),
        delete: vi.fn(async (id: string) => { state.deletes.push(id); return { success: true, data: null } }),
        retryRun: state.retry,
        registrants: {
          list: vi.fn(async () => ({
            success: true,
            data: [
              { id: 'e1', friendId: 'f1', friendName: '見本 141', targetDate: '2026-10-02T05:00:00Z', status: 'active', reminderVersionId: null, sourceKind: 'form', createdAt: '', updatedAt: '', cancelledAt: null, lockVersion: 1 },
              { id: 'e2', friendId: 'f2', friendName: '見本 176', targetDate: '2026-10-03T01:00:00Z', status: 'cancelled', reminderVersionId: null, sourceKind: 'form', createdAt: '', updatedAt: '', cancelledAt: '', lockVersion: 1 },
            ],
          })),
        },
      },
    },
  }
})

import ReminderDetailV8Page from './detail'
import { api } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  state.accountId = 'account-a'
  state.ownerId = 'account-a'
  document.documentElement.dataset.theme = 'v8'
  state.role = 'owner'
  state.tab = ''
  state.updates = []
  state.deletes = []
  state.retry.mockReset()
  state.plannedTotal = 2
  state.onlyPlanned = false
  state.omitId = false
  state.urlId = 'reminder-1'
  state.management=false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

async function render() {
  await act(async () => { root.render(<ReminderDetailV8Page />) })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}

const buttons = () => [...document.querySelectorAll('button, a')].map((el) => el.textContent?.trim() ?? '')
const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === text) as HTMLButtonElement | undefined

describe('V8 リマインダの詳細', () => {
  it('実行結果を表示中にURLを変えた後、古い結果が遅れても再送できない', async () => {
    state.tab = 'runs'
    const runs = vi.mocked(api.reminders.runs), get = vi.mocked(api.reminders.get)
    const originalRuns = runs.getMockImplementation()!, originalGet = get.getMockImplementation()!
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    runs.mockImplementation(async (id, params) => {
      const res = await originalRuns(id, params)
      if (id === 'reminder-1' && params?.limit === 20) await pending
      if (!res.success) return res
      return { ...res, data: { ...res.data, reminder: { ...res.data.reminder, id }, items: res.data.items.map(item => ({ ...item, friendName: id === 'reminder-1' ? '古いお客さま' : '新しいお客さま', canRetry: true })) } }
    })
    get.mockImplementation(async id => { const res = await originalGet(id); return res.success ? { ...res, data: { ...res.data, id } } : res })
    try {
      await render()
      state.urlId = 'reminder-2'; await render()
      expect(host.textContent).toContain('新しいお客さま')
      await act(async () => { release(); await pending })
      expect(host.textContent).toContain('新しいお客さま')
      expect(host.textContent).not.toContain('古いお客さま')
      expect(state.retry).not.toHaveBeenCalled()
    } finally { runs.mockImplementation(originalRuns); get.mockImplementation(originalGet) }
  })
  it('実行結果の応答が別のリマインダなら行を表示せず再送できない', async () => {
    state.tab = 'runs'
    const runs = vi.mocked(api.reminders.runs)
    const original = runs.getMockImplementation()!
    runs.mockImplementation(async (id, params) => {
      const res = await original(id, params)
      if (!res.success || params?.limit !== 20) return res
      return { ...res, data: { ...res.data, reminder: { ...res.data.reminder, id: 'old-id' }, items: res.data.items.map(item => ({ ...item, friendName: '古いお客さま', canRetry: true })) } }
    })
    try {
      await render()
      expect(host.textContent).not.toContain('古いお客さま')
      expect(buttons()).not.toContain('再試行する')
      expect(host.textContent).toContain('実行結果を読み込めませんでした')
      expect(state.retry).not.toHaveBeenCalled()
    } finally { runs.mockImplementation(original) }
  })
  it('停止の返事が遅れても、移動後の別リマインダを停止中にしない', async () => {
    const runs = vi.mocked(api.reminders.runs), get = vi.mocked(api.reminders.get), update = vi.mocked(api.reminders.update)
    const originalRuns = runs.getMockImplementation()!, originalGet = get.getMockImplementation()!, originalUpdate = update.getMockImplementation()!
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    runs.mockImplementation(async (id, params) => { const res = await originalRuns(id, params); return res.success ? { ...res, data: { ...res.data, reminder: { ...res.data.reminder, id, name: id === 'reminder-2' ? '新しい対象' : '古い対象' } } } : res })
    get.mockImplementation(async id => { const res = await originalGet(id); return res.success ? { ...res, data: { ...res.data, id } } : res })
    update.mockImplementation(async () => { await pending; return { success: true, data: null } as never })
    try {
      await render()
      await act(async () => { buttonByText('一時停止する')!.click() })
      const dialog = document.querySelector('[data-design-node="RwVo5"]')!
      const confirm = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === '一時停止する') as HTMLButtonElement
      await act(async () => { confirm.click() })
      state.urlId = 'reminder-2'; await render()
      expect(host.textContent).toContain('新しい対象')
      await act(async () => { release(); await pending })
      expect(host.textContent).toContain('新しい対象')
      expect(buttonByText('一時停止する')).toBeTruthy()
      expect(host.textContent).not.toContain('リマインダを一時停止しました')
    } finally { runs.mockImplementation(originalRuns); get.mockImplementation(originalGet); update.mockImplementation(originalUpdate) }
  })
  it('URLを変更した後に古い応答が届いても現在の対象を保つ', async () => {
    const runs = vi.mocked(api.reminders.runs)
    const get = vi.mocked(api.reminders.get)
    const originalRuns = runs.getMockImplementation()!
    const originalGet = get.getMockImplementation()!
    let release!: () => void
    const oldResponse = new Promise<void>(resolve => { release = resolve })
    runs.mockImplementation(async (id, params) => {
      const result = await originalRuns(id, params)
      if (id === 'reminder-1' && !params?.status) await oldResponse
      if (!result.success) return result
      return { ...result, data: { ...result.data, reminder: { ...result.data.reminder, id, name: id === 'reminder-2' ? '新しい対象' : '古い対象' } } }
    })
    get.mockImplementation(async id => {
      const result = await originalGet(id)
      return result.success ? { ...result, data: { ...result.data, id } } : result
    })
    try {
      await render()
      state.urlId = 'reminder-2'
      await render()
      expect(host.textContent).toContain('新しい対象')
      await act(async () => { release(); await oldResponse })
      expect(host.textContent).toContain('新しい対象')
      expect(host.textContent).not.toContain('古い対象')
    } finally {
      runs.mockImplementation(originalRuns)
      get.mockImplementation(originalGet)
    }
  })
  it('応答のIDがURLと違うとき、古い対象と操作を表示せず読み直せる', async () => {
    state.urlId = 'reminder-2'
    await render()
    expect(host.textContent).not.toContain('予約前日のご案内')
    expect(buttons()).not.toContain('一時停止する')
    expect(host.querySelector('[aria-label*="その他の操作"]')).toBeNull()
    expect(host.textContent).toContain('読み込めませんでした')
    expect(buttons()).toContain('もう一度読み込む')
    expect(state.updates).toEqual([])
  })
  it('削除確認を開いて別のアカウントに切り替えたら古い窓を閉じる', async () => {
    await render()
    const more = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label')?.includes('その他の操作')) as HTMLButtonElement
    await act(async () => { more.click() })
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('削除する')) as HTMLElement
    await act(async () => { remove.click() })
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy()
    state.accountId = 'account-b'
    await render()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
  it('削除確認を開いた後で店を往復しても古い確定は送れない', async () => {
    await render()
    const more = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label')?.includes('その他の操作')) as HTMLButtonElement
    await act(async () => { more.click() })
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('削除する')) as HTMLElement
    await act(async () => { remove.click() })
    const dialog = document.querySelector('[role="alertdialog"]')!
    const confirm = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === '削除する') as HTMLButtonElement
    const key = Object.keys(confirm).find(k => k.startsWith('__reactProps$'))!
    const old = (confirm as unknown as Record<string, { onClick: () => void }>)[key].onClick
    state.accountId = 'account-b'; await render()
    state.accountId = 'account-a'; await render()
    await act(async () => old())
    expect(state.deletes).toEqual([])
  })
  it('削除確認は所属が取れない場合に不明と環境を示す', async () => {
    state.ownerId = null
    await render()
    const more = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label')?.includes('その他の操作')) as HTMLButtonElement
    await act(async () => { more.click() })
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('削除する')) as HTMLElement
    await act(async () => { remove.click() })
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('不明')
    expect(dialog?.textContent).toContain('環境')
  })
  it('削除確認に操作対象の店名を示す', async () => {
    await render()
    const more = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label')?.includes('その他の操作')) as HTMLButtonElement
    await act(async () => { more.click() })
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('削除する')) as HTMLElement
    await act(async () => { remove.click(); await Promise.resolve(); await Promise.resolve() })
    const dialog = document.querySelector('[role="alertdialog"]')
    await waitFor(() => expect(dialog?.textContent).toContain('本店'))
    expect(dialog?.textContent).not.toContain('別店舗')
  })
  it('URLに対象が無いときは共通の対象なし画面を出す', async () => {
    state.omitId = true
    await render()
    expect(host.querySelector('[data-target-missing="unspecified"]')).toBeTruthy()
    expect(host.textContent).toContain('リマインダ一覧へ戻る')
    expect(host.querySelector('[aria-label="最近の実行"]')).toBeNull()
  })

  it('概要（rbAig）：最近の実行は送った・送れなかった物だけ（予定は配信予定タブ）', async () => {
    await render()
    expect(host.querySelector('[data-design-node="rbAig"]')).toBeTruthy()
    const recent = host.querySelector('[aria-label="最近の実行"]')
    expect(recent?.textContent).toContain('見本 122')
    expect(recent?.textContent).toContain('見本 176')
    expect(recent?.textContent).not.toContain('予定の人')
    expect(host.textContent).toContain('1日前 18:00')
  })

  it('一時停止は確かめの窓（RwVo5）を通し、今後24時間の予定数を言ってから止める', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')!.click() })
    const dialog = document.querySelector('[data-design-node="RwVo5"]')
    expect(dialog?.textContent).toContain('「予約前日のご案内」を一時停止する')
    expect(dialog?.textContent).toContain('今後24時間で送る予定の 2 通 が送られなくなります。')
    expect(state.updates).toHaveLength(0)
    const confirm = [...dialog!.querySelectorAll('button')].find((el) => el.textContent?.trim() === '一時停止する') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await act(async () => {})
    expect(state.updates).toEqual([{ isActive: false }])
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(document.querySelector('[data-design-node="RwVo5"]')).toBeNull()
  })

  it('一時停止の対象は選択中の店ではなくリマインダの所属先を示す', async () => {
    state.ownerId = 'account-b'
    await render()
    await act(async () => { buttonByText('一時停止する')!.click() })
    const dialog = document.querySelector('[data-design-node="RwVo5"]')
    await waitFor(() => expect(dialog?.textContent).toContain('別店舗'))
    expect(dialog?.textContent).not.toContain('本店')
  })

  it('停止の窓は所属が不明なら不明と環境を示す', async () => {
    state.ownerId = null
    await render()
    await act(async () => { buttonByText('一時停止する')!.click() })
    const dialog = document.querySelector('[data-design-node="RwVo5"]')!
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('不明')
    expect(dialog.textContent).toContain('環境')
  })

  it('停止確認を開いた後でアカウントを切り替えると古い確認では送れない', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')!.click() })
    const dialog = document.querySelector('[data-design-node="RwVo5"]')!
    const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === '一時停止する') as HTMLButtonElement
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const old = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    state.accountId = 'account-b'; await act(async () => { root.render(<ReminderDetailV8Page />) })
    state.accountId = 'account-a'; await act(async () => { root.render(<ReminderDetailV8Page />) })
    await act(async () => old())
    expect(state.updates).toEqual([])
  })

  it('停止の窓はアカウントを切り替えたら閉じる', async () => {
    await render()
    await act(async () => { buttonByText('一時停止する')!.click() })
    expect(document.querySelector('[data-design-node="RwVo5"]')).not.toBeNull()
    state.accountId = 'account-b'; await act(async () => { root.render(<ReminderDetailV8Page />) })
    expect(document.querySelector('[data-design-node="RwVo5"]')).toBeNull()
    expect(state.updates).toEqual([])
  })

  it('停止の窓は URL を変えて別のリマインダを開いたら閉じる', async () => {
    const runs = vi.mocked(api.reminders.runs), get = vi.mocked(api.reminders.get)
    const originalRuns = runs.getMockImplementation()!, originalGet = get.getMockImplementation()!
    runs.mockImplementation(async (id, params) => { const res = await originalRuns(id, params); return res.success ? { ...res, data: { ...res.data, reminder: { ...res.data.reminder, id } } } : res })
    get.mockImplementation(async id => { const res = await originalGet(id); return res.success ? { ...res, data: { ...res.data, id } } : res })
    try {
      await render()
      await act(async () => { buttonByText('一時停止する')!.click() })
      expect(document.querySelector('[data-design-node="RwVo5"]')).not.toBeNull()
      state.urlId = 'reminder-2'; await render()
      expect(document.querySelector('[data-design-node="RwVo5"]')).toBeNull()
      expect(state.updates).toEqual([])
    } finally { runs.mockImplementation(originalRuns); get.mockImplementation(originalGet) }
  })

  it('閲覧のみ：一時停止・編集・複製・削除を置かず、書き出しだけ残す', async () => {
    state.role = 'viewer'
    await render()
    expect(buttons()).not.toContain('一時停止する')
    expect(buttons()).not.toContain('編集する')
    const more = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label')?.includes('その他の操作')) as HTMLButtonElement
    await act(async () => { more.click() })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())
    expect(items).toEqual(['実行結果をCSVで書き出す'])
  })

  it('登録者（loVfW）：閲覧のみには取り消す・再開するを置かない。管理者には出す', async () => {
    state.tab = 'registrants'
    await render()
    expect(host.querySelector('[data-design-node="loVfW"]')).toBeTruthy()
    // 行の操作は「…」1つの中。開くと取り消す・再開するが出る。
    const rowMenu = (name: string) => document.querySelector(`button[aria-label="${name}の操作"]`) as HTMLButtonElement | null
    expect(rowMenu('見本 141')).toBeTruthy()
    await act(async () => { rowMenu('見本 141')!.click() })
    expect(buttons()).toContain('取り消す')
    await act(async () => { rowMenu('見本 141')!.click() })
    await act(async () => { rowMenu('見本 176')!.click() })
    expect(buttons()).toContain('再開する')
    act(() => { root.unmount() })
    root = createRoot(host)
    state.role = 'viewer'
    await render()
    expect(host.textContent).toContain('見本 141')
    expect(document.querySelector('button[aria-label="見本 141の基準日"]')).toBeNull()
    expect(document.querySelector('button[aria-label="見本 141の操作"]')).toBeNull()
    expect(buttons()).not.toContain('取り消す')
    expect(buttons()).not.toContain('再開する')
  })

  it('状態欄を開閉しても登録者の日時入力を作り直さず、保存や名前の入口を保つ', async () => {
    state.tab = 'registrants'
    await render()
    const toggle = buttonByText('いまの状態と操作を開く')!
    const date = host.querySelector('button[aria-label="見本 141の基準日"]')!
    const friend = host.querySelector('a[href="/friends/f1"]')!
    expect(friend.textContent).toBe('見本 141')
    expect(friend.querySelector('[title="見本 141"]')).toBeTruthy()
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('いまの状態と操作を閉じる')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.getAttribute('data-expanded')).toBe('true')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('button[aria-label="見本 141の基準日"]')).toBe(date)
    expect(host.querySelector('a[href="/friends/f1"]')).toBe(friend)
    expect(state.updates).toHaveLength(0)
  })

  it.each(['loading', 'failed'])('予定の取得が %s の時は0通と断定しない', async (status) => {
    const runs = vi.mocked(api.reminders.runs)
    const original = runs.getMockImplementation()!
    runs.mockImplementation(async (id, params) => {
      if (params?.status === 'planned') {
        if (status === 'loading') return await new Promise<never>(() => {})
        throw new Error('取得できませんでした')
      }
      return original(id, params)
    })
    try {
      await render()
      await act(async () => { buttonByText('一時停止する')!.click() })
      const dialog = document.querySelector('[data-design-node="RwVo5"]')!
      expect(dialog.textContent).toContain('送る予定の通知の件数は確認できません')
      expect(dialog.textContent).not.toContain('予定の 0 通')
    } finally { runs.mockImplementation(original) }
  })

  it('WEB084：予定を読み切れていないとき、一時停止の窓で今後24時間の数を言い切らない', async () => {
    state.plannedTotal = 340
    await render()
    await act(async () => { buttonByText('一時停止する')!.click() })
    const dialog = document.querySelector('[data-design-node="RwVo5"]')
    expect(dialog?.textContent).toContain('今後24時間の分は数え切れませんでした')
    expect(dialog?.textContent).not.toContain('今後24時間で送る予定の 2通')
  })

  it('WEB084：先頭が予定ばかりで実行が見えないときは「まだありません」と言わない', async () => {
    state.onlyPlanned = true
    await render()
    const section = host.querySelector('[aria-labelledby="rm-detail-recent"]')
    expect(section?.textContent).toContain('最近の実行をここでは読み切れませんでした')
    expect(section?.textContent).not.toContain('まだ実行した通知はありません')
  })
})

it('定義が有効でも承認と内容が合わなければ、管理元と停止の理由を出す',async()=>{
 state.management=true;await render();
 expect(host.textContent).toContain('来店フォロー（食堂）で管理しています。内容が変わったため、止まっています');
 expect(host.querySelector('a[href="/restaurant-test/line-followup?store_id=store"]')?.textContent).toContain('来店フォローを見る');
 expect(host.querySelector('[data-tone="ok"]')?.textContent).not.toBe('有効');
});
