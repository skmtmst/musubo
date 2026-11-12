// @vitest-environment happy-dom
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
/*
 * シナリオ一覧（V8）の絞り込み・フォルダ・まとめての操作を、描いて押して確かめる。
 * - 「今月作った」は日本時間の月初を、「停止中のみ」「有効のみ」は1つの値にまとめて、一覧の口へ渡す
 * - 左のフォルダの列は共通の部品で、変えられる人にだけ「フォルダを追加」を出す
 * - まとめて選んで「フォルダへ移す」：移動先を選んで、選んだ行ごとに保存の口へフォルダを渡す。失敗は知らせる
 * - まとめて「止める」：確かめてから止め、止めたら一覧を読み直す
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scenario = (id: string, name: string, isActive = true) => ({
  id, name, contentRevision: 3, description: null, triggerType: 'friend_add', triggerTagId: null, isActive,
  deliveryMode: 'relative', allowConcurrent: true, displayOrder: 0, folderId: null, lineAccountId: 'account-a',
  subscriberCount: 10, completedCount: 2, stepCount: 3,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
})

const state = vi.hoisted(() => ({
  role: 'owner' as string,
  listPage: vi.fn(),
  update: vi.fn(),
  bulkStop: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/lib/undoable', async () => {
  const { scheduledConfirmation } = await import('@/test-utils/confirmed-undo-test-handle')
  return ({
  runUndoable: (options: Parameters<typeof import('@/lib/undoable').runUndoable>[0] & { confirmation?: boolean }) => {
    if (options.confirmation) { const scheduled = scheduledConfirmation(options); void Promise.resolve().then(() => scheduled.execute()).catch(() => {}); return scheduled.handle }
    void options.commit().then(() => options.onCommitted?.()).catch(() => { options.undo(); state.toast(options.failureMessage) })
  },
  runOptimistic: (options: { request: () => Promise<unknown>; onSuccess?: () => void; revert: () => void; failureMessage?: string }) => {
    void options.request().then(() => options.onSuccess?.()).catch(() => { options.revert(); state.toast(options.failureMessage) })
  },
  notifyToast: () => {},
})
})

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', loading: false }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', { href, ...rest }, children),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => state.role, useStaffIdentity: () => ({ id: 'staff-one' }) }
})

/* 共通の選ぶ欄は listbox の部品で、その操作は部品自身の試験が持つ。ここでは選んだあとの一覧の判断を見る。 */
const nativeSelect = vi.hoisted(() => function NativeSelect({ 'aria-label': label, value, onChange, options, folders }: {
  'aria-label'?: string
  value: string
  onChange: (value: string) => void
  options?: Array<{ value: string; label: string }>
  folders?: Array<{ value: string; label: string }>
}) {
  return React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    [{ value: '', label: '（なし）' }, ...(options ?? folders ?? [])].map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  )
})
vi.mock('@/components/shared/select', () => ({ default: nativeSelect }))
vi.mock('@/components/shared/folder-select', () => ({ default: nativeSelect }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      scenarios: { ...api.scenarios, confirmation: vi.fn(async () => ({ success: true, data: { contentRevision: 3, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 0, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] } })), listPage: state.listPage, update: state.update, bulkStop: state.bulkStop },
      folders: {
        ...api.folders,
        list: () => Promise.resolve({
          success: true,
          data: [{ id: 'sf-onboarding', kind: 'scenario', name: '初回案内', parentId: null, displayOrder: 0, itemCount: 0, color: '#2f6fde' }],
          unfiledCount: 2,
        }),
      },
      listStats: { get: () => Promise.resolve({ success: false }) },
    },
  }
})

import ScenariosListV8 from './list'

const ROWS = [scenario('s-1', '新規登録フォロー'), scenario('s-2', '休眠の呼び戻し')]

beforeEach(() => {
  forgetStaffIdentity(); forgetSessionSnapshot()
  rememberStaffIdentity({ id: 'scenario-owner', role: 'owner', permissionKeys: [] } as unknown as StaffMember)
  state.role = 'owner'
  state.listPage.mockImplementation(async (input: { limit?: number }) => ({ success: true, data: { items: ROWS, total: ROWS.length, limit: input.limit ?? 20, sort: [] } }))
  state.update.mockResolvedValue({ success: true, data: {} })
  state.bulkStop.mockResolvedValue({ success: true, data: { stopped: 1 } })
})

afterEach(() => {
  forgetStaffIdentity(); forgetSessionSnapshot()
  cleanup()
  vi.clearAllMocks()
})

const lastQuery = () => state.listPage.mock.calls.at(-1)![0] as Record<string, unknown>

async function renderList() {
  render(<ScenariosListV8 />)
  await screen.findByText('新規登録フォロー')
}

async function select(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: `${name}を選択` })) })
}

describe('状態で絞り込む', () => {
  it('「今月作った」は日本時間の今月初日を一覧の口へ渡し、外すと渡さない', async () => {
    await renderList()
    expect(lastQuery().createdFrom).toBeUndefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /今月作った/ })) })
    await waitFor(() => expect(lastQuery().createdFrom).toMatch(/^\d{4}-\d{2}-01T00:00:00\+09:00$/))
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date())
    expect(lastQuery().createdFrom).toBe(`${month}-01T00:00:00+09:00`)
    expect(lastQuery().accountId).toBe('account-a')
  })

  it('「停止中のみ」は active=0、よく使う絞り込みの「有効のみ」は active=1 で渡し、同時には掛けない', async () => {
    await renderList()
    expect(lastQuery().active).toBeUndefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /停止中のみ/ })) })
    await waitFor(() => expect(lastQuery().active).toBe(0))
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'よく使う絞り込み' }), { target: { value: 'active' } }) })
    await waitFor(() => expect(lastQuery().active).toBe(1))
  })
})

describe('左のフォルダの列', () => {
  it('フォルダ追加を両方に出し、閲覧のみには理由付きで拒否する', async () => {
    await renderList()
    expect(screen.getAllByRole('button', { name: /フォルダを追加/ }).length).toBeGreaterThan(0)
    cleanup()
    state.role = 'staff'
    rememberStaffIdentity({ id: 'scenario-staff', role: 'staff', permissionKeys: [] } as unknown as StaffMember)
    await renderList()
    await expectPermissionLocked(screen.getByRole('button', { name: /フォルダを追加/ }))
  })
})

describe('まとめての操作', () => {
  it('選んで「フォルダへ移す」：移動先を選ぶと、選んだ行ごとに保存の口へフォルダを渡し、終わったら読み直す', async () => {
    await renderList()
    await select('新規登録フォロー')
    await select('休眠の呼び戻し')
    fireEvent.click(screen.getByRole('button', { name: /フォルダへ移す/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('combobox', { name: '移動先のフォルダ' }), { target: { value: 'sf-onboarding' } })
    const before = state.listPage.mock.calls.length
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '移動する' })) })
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2))
    expect(state.update).toHaveBeenCalledWith('s-1', { folderId: 'sf-onboarding' })
    expect(state.update).toHaveBeenCalledWith('s-2', { folderId: 'sf-onboarding' })
    await waitFor(() => expect(state.listPage.mock.calls.length).toBeGreaterThan(before))
    expect(state.toast).not.toHaveBeenCalled()
  })

  it('移動先に「未分類」を選ぶとフォルダから外す（null を渡す）。1件でも失敗したら知らせて戻す', async () => {
    state.update.mockResolvedValueOnce({ success: false, error: 'forbidden' })
    await renderList()
    await select('新規登録フォロー')
    fireEvent.click(screen.getByRole('button', { name: /フォルダへ移す/ }))
    const dialog = await screen.findByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '移動する' })) })
    await waitFor(() => expect(state.update).toHaveBeenCalledWith('s-1', { folderId: null }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/全 1 件中 0 件の保存を確認しました。1 件目で止めました。未送信は 0 件です。理由：/))
    expect(state.toast).not.toHaveBeenCalled()
  })

  it('まとめて「止める」は確かめてから止め、止めたら一覧を読み直す', async () => {
    await renderList()
    await select('新規登録フォロー')
    fireEvent.click(screen.getByRole('button', { name: /^止める$/ }))
    const dialog = (await screen.findByText('選んだシナリオを停止しますか？')).closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')!
    expect(state.update).not.toHaveBeenCalled()
    expect(state.bulkStop).not.toHaveBeenCalled()
    const before = state.listPage.mock.calls.length
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '停止する' })) })
    await waitFor(() => expect(state.bulkStop).toHaveBeenCalledWith([{ id: 's-1', revision: 3, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }]))
    await waitFor(() => expect(state.listPage.mock.calls.length).toBeGreaterThan(before))
  })
})
