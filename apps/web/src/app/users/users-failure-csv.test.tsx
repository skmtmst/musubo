// @vitest-environment happy-dom
/*
 * 監査 WEB322/323：統合ユーザーの一覧が読めなかったとき、人数を 0 と言わない。
 * CSV は画面の件数（読めていないと 0）を信じず、1ページ目から読み直して最後まで集める。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/users',
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', useStaffIdentity: () => ({ name: '試験担当', role: 'owner', accountScope: 'all', permissionKeys: [] }), canManageRole: () => true }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      usersGrouped: { ...actual.api.usersGrouped, list: fixture.list },
      lineAccounts: { ...actual.api.lineAccounts, list: () => Promise.resolve({ success: true, data: [] }) },
      duplicates: { ...actual.api.duplicates, stats: fixture.stats },
    },
  }
})

const { useMergedUsers } = await import('../../v8/users/use-merged-users')
const { default: UsersV8 } = await import('./users-screen')
const { useUsersSummary } = await import('@/components/users/use-users-summary')
const { default: MergedUsersV8 } = await import('@/v8/friends/merged/merged')

const person = (id: string) => ({
  id, displayName: `人${id}`, emails: [], phones: [], accounts: [{ accountName: 'A' }],
  identityKeyKind: 'uid', lastActivityAt: '2026-10-01T00:00:00Z',
})

beforeEach(() => {
  fixture.list.mockReset()
  fixture.stats.mockReset().mockResolvedValue({ success: false, error: 'x' })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('統合ユーザーの失敗と0件（WEB322）', () => {
  it('数の帯は利用者向けの名前と取得した友だち数を出す', async () => {
    fixture.list.mockResolvedValue({ success: true, data: { rows: [], total: 0 } })
    fixture.stats.mockResolvedValue({ success: true, data: { uniquePeople: 2, totalFollowing: 7, friendDups: 0 } })
    render(<UsersV8 />)
    expect(await screen.findByTitle('紐付く友だち：7件（各アカウントの友だち登録）')).toBeTruthy()
    expect(screen.getByLabelText('統合ユーザーの集計')).toBeTruthy()
    expect(within(screen.getByLabelText('統合ユーザーの集計')).getByText('統合ユーザー')).toBeTruthy()
    expect(screen.getByText('UID連携済み')).toBeTruthy()
    expect(document.body.textContent).not.toContain('重複配信の削減')
    expect(document.querySelector('[title="重複配信の削減"]')).toBeNull()
    expect(document.body.textContent).not.toContain('余分な行数')
    expect(document.body.textContent).not.toContain('余分率')
  })
  it('読込中・失敗・空を分け、失敗後に再取得できる', async () => {
    let reject!: (reason: Error) => void
    fixture.list.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
      .mockResolvedValue({ success: true, data: { rows: [], total: 0 } })
    render(<UsersV8 />)
    await waitFor(() => expect(fixture.list).toHaveBeenCalled())
    const table = screen.getByRole('table')
    expect(table.parentElement?.getAttribute('aria-busy')).toBe('true')
    expect(table.querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(5)
    expect(screen.queryByText('条件に合う人はいません')).toBeNull()
    expect(screen.queryByText('統合ユーザーを読み込めませんでした')).toBeNull()
    await act(async () => { reject(new Error('offline')) })
    expect(await screen.findByText('統合ユーザーを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('条件に合う人はいません')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }))
    expect(await screen.findByText('条件に合う人はいません')).toBeTruthy()
    expect(screen.queryByText('統合ユーザーを読み込めませんでした')).toBeNull()
  })
  it('一覧が読めなかったとき、数の帯と件数に 0人を出さない', async () => {
    fixture.list.mockRejectedValue(new Error('down'))
    render(<UsersV8 />)
    await waitFor(() => expect(screen.getByText('—人')).toBeTruthy())
    const kpis = document.body.textContent ?? ''
    expect(kpis).not.toContain('0人')
  })

  it('集計の失敗を表示し、画面の再試行で実値0と紐付く友だちを取得する', async () => {
    fixture.list.mockResolvedValue({ success: true, data: { rows: [], total: 0 } })
    fixture.stats.mockRejectedValueOnce(new Error('down')).mockResolvedValue({
      success: true, data: { uniquePeople: 0, totalFollowing: 7, friendDups: 0 },
    })
    render(<UsersV8 />)
    await waitFor(() => expect(screen.getByText('読み込めませんでした')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    await waitFor(() => expect(screen.getByTitle('紐付く友だち：7件（各アカウントの友だち登録）')).toBeTruthy())
    const count = within(screen.getByLabelText('統合ユーザーの集計'))
    expect(count.getByText('0')).toBeTruthy()
    expect(count.getByText('人')).toBeTruthy()
    expect(fixture.stats).toHaveBeenCalledTimes(2)
  })

  it('友だちの統合タブは店舗の集計を再試行し、取得した実値0を表示する', async () => {
    let summaryCalls = 0
    fixture.list.mockImplementation(async (input: { memberAccountId?: string; pageSize?: number }) => {
      if (input.pageSize === 1 && ++summaryCalls === 1) throw new Error('down')
      return { success: true, data: { memberAccountId: input.memberAccountId, rows: [], total: 0 } }
    })
    render(<MergedUsersV8 />)
    await waitFor(() => expect(screen.getByText('読み込めませんでした')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    await waitFor(() => expect(screen.queryByText('読み込めませんでした')).toBeNull())
    const card = screen.getByRole('button', { name: '統合ユーザーの説明' }).closest('[data-kpi-presentation]')!
    expect(card.querySelector('[data-kpi-number]')?.textContent).toBe('0')
    expect(within(card as HTMLElement).getByText('人')).toBeTruthy()
    expect(summaryCalls).toBe(2)
    expect(fixture.list.mock.calls.every(([input]) => input.memberAccountId === 'a')).toBe(true)
    expect(fixture.stats).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('新しい集計を、古い%sの返答で上書きしない', async (response) => {
    let resolveOld!: (value: unknown) => void
    let rejectOld!: (reason: unknown) => void
    fixture.stats.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
      .mockResolvedValue({ success: true, data: { uniquePeople: 20, totalFollowing: 30, friendDups: 10 } })
    const { result } = renderHook(() => useUsersSummary())
    await waitFor(() => expect(fixture.stats).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.load() })
    expect(result.current.stats?.uniquePeople).toBe(20)
    await act(async () => {
      if (response === 'success') resolveOld({ success: true, data: { uniquePeople: 1, totalFollowing: 1, friendDups: 0 } })
      else rejectOld(new Error('old down'))
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.stats?.uniquePeople).toBe(20)
  })

  it('再取得に失敗したら以前の人数を残さず、再試行で取り直す', async () => {
    fixture.stats.mockResolvedValueOnce({ success: true, data: { uniquePeople: 20, totalFollowing: 30, friendDups: 10 } })
      .mockResolvedValueOnce({ success: false, error: 'down' })
      .mockResolvedValue({ success: true, data: { uniquePeople: 0, totalFollowing: 0, friendDups: 0 } })
    const { result } = renderHook(() => useUsersSummary())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => { await result.current.load() })
    expect(result.current.status).toBe('error')
    expect(result.current.stats).toBeNull()
    await act(async () => { await result.current.load() })
    expect(result.current.status).toBe('ready')
    expect(result.current.stats?.uniquePeople).toBe(0)
  })
})

describe('統合ユーザーのCSV（WEB323）', () => {
  it('画面の件数が読めていなくても、書き出しは API から読み直す', async () => {
    const created = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: () => undefined }))
    fixture.list
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ success: true, data: { rows: [person('1'), person('2')], total: 2 } })
    const { result } = renderHook(() => useMergedUsers())
    await waitFor(() => expect(result.current.error).not.toBe(''))
    expect(result.current.total).toBe(0)
    await act(async () => { await result.current.exportCsv() })
    expect(fixture.list.mock.calls.some((call) => (call[0] as { pageSize?: number }).pageSize === 200)).toBe(true)
    expect(created).toHaveBeenCalledTimes(1)
    const blob = (created.mock.calls[0] as unknown as [Blob])[0]
    expect(await blob.text()).toContain('人1')
  })
})
