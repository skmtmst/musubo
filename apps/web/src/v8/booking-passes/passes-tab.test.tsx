// @vitest-environment happy-dom
/*
 * 予約設定「回数券・月謝」（B2-1）：表・数の帯・販売の始め／やめ・閲覧のみの扱い。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ list: vi.fn(), holders: vi.fn(), start: vi.fn(), stop: vi.fn(), create: vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ bookingPassPlansApi: api }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, listMenus: async () => ({ menus: [{ id: 'm1', name: 'ヨガ（初級）' }, { id: 'm2', name: '朝ヨガ' }, { id: 'm3', name: 'カット' }] }) } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/booking/menus', useSearchParams: () => new URLSearchParams() }))

const { default: PassesTabV8 } = await import('./passes-tab')

const plan = (over: Record<string, unknown>) => ({ id: 'p', kind: 'ticket', name: '回数券', price: 1000, count: 5, monthlyLimit: null, validDays: 180, menuIds: [], allowWithoutPass: true, status: 'draft', version: 1, ...over })
const PLANS = [
  plan({ id: 'p1', name: 'ヨガ 10 回券', price: 15000, count: 10, menuIds: ['m1', 'm2'], status: 'on_sale', version: 2 }),
  plan({ id: 'p2', kind: 'monthly', name: 'ヨガ 月 4 回', price: 9800, count: null, monthlyLimit: 4, validDays: 30, status: 'draft' }),
]

beforeEach(() => {
  api.list.mockResolvedValue({ success: true, data: { items: PLANS, total: 2, summary: { onSale: 1, holders: 86, expiringIn30d: 9, billingFailed: null, billingStatus: 'unconfigured', billingSimulationFailed: 1, billingSimulationCancelled: 2 } } })
  api.holders.mockImplementation(async (_a: string, id: string) => ({ success: true, data: { items: [], total: id === 'p1' ? 42 : 0 } }))
  api.start.mockResolvedValue({ success: true, data: { status: 'on_sale', version: 2 } })
  api.stop.mockResolvedValue({ success: true, data: { status: 'stopped', version: 3 } })
  api.create.mockResolvedValue({ success: true, data: PLANS[1] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('回数券・月謝の表', () => {
  it('数の帯と、種類ごとの回数・期限・値段・使える予約・持っている人・状態を出す', async () => {
    render(<PassesTabV8 accountId="a" canEdit />)
    await screen.findByText('ヨガ 10 回券')
    expect(screen.getByText('86')).toBeTruthy()
    const billingCard = screen.getByText(/実課金は未接続/).closest('[data-kpi-presentation]')!
    expect(billingCard.textContent).toContain('—')
    expect(billingCard.textContent).toContain('試験：失敗1・正常解約2')
    expect(within(billingCard as HTMLElement).getByRole('button', { name: '引き落としの失敗の説明' })).toBeTruthy()
    expect(screen.getByText('10 回')).toBeTruthy()
    expect(screen.getByText('月 4 回')).toBeTruthy()
    expect(screen.getByText('買って 6 か月')).toBeTruthy()
    expect(screen.getByText('毎月')).toBeTruthy()
    expect(screen.getByText('¥15,000')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('ヨガ（初級）・朝ヨガ')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('42 人')).toBeTruthy())
    expect(within(screen.getByText('ヨガ 10 回券').closest('tr')!).getByText('販売中')).toBeTruthy()
    expect(screen.getByText('下書き')).toBeTruthy()
  })

  it('種類を API に渡し、絞った総数でページを送り、種類変更で最初に戻る', async () => {
    api.list.mockImplementation(async (_a: string, _q: string, offset: number, _limit: number, kind?: string) => ({
      success: true,
      data: { items: [plan({ id: `${kind || 'all'}-${offset}`, kind: kind || 'ticket', name: `${kind || 'all'} ${offset}` })], total: kind === 'monthly' ? 21 : 41, summary: { onSale: 1, holders: 0, expiringIn30d: 0, billingFailed: null, billingStatus: 'unconfigured', billingSimulationFailed: 0, billingSimulationCancelled: 0 } },
    }))
    render(<PassesTabV8 accountId="a" canEdit={false} />)
    await screen.findByText('all 0')
    fireEvent.click(screen.getByLabelText('種類で絞り込む'))
    fireEvent.click(within(await screen.findByRole('option', { name: '月謝' })).getByRole('button'))
    await screen.findByText('monthly 0')
    expect(api.list).toHaveBeenLastCalledWith('a', '', 0, 20, 'monthly')
    expect(screen.getByText('21 件中 1〜20 件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    await screen.findByText('monthly 20')
    expect(api.list).toHaveBeenLastCalledWith('a', '', 20, 20, 'monthly')
    expect(screen.getByText('21 件中 21〜21 件')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('種類で絞り込む'))
    fireEvent.click(within(await screen.findByRole('option', { name: 'すべて' })).getByRole('button'))
    await screen.findByText('all 0')
    expect(api.list).toHaveBeenLastCalledWith('a', '', 0, 20, undefined)
    expect(screen.getByText('41 件中 1〜20 件')).toBeTruthy()
  })

  it('前の種類の応答が遅れても、選び直した結果を上書きしない', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise((resolve) => { resolveOld = resolve })
    const summary = { onSale: 1, holders: 0, expiringIn30d: 0, billingFailed: null, billingStatus: 'unconfigured', billingSimulationFailed: 0, billingSimulationCancelled: 0 }
    api.list.mockImplementation((_a: string, _q: string, _offset: number, _limit: number, kind?: string) =>
      kind === 'monthly' ? Promise.resolve({ success: true, data: { items: [PLANS[1]], total: 1, summary } }) : old)
    render(<PassesTabV8 accountId="a" canEdit={false} />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('種類で絞り込む'))
    fireEvent.click(within(await screen.findByRole('option', { name: '月謝' })).getByRole('button'))
    await screen.findByText('ヨガ 月 4 回')
    await act(async () => { resolveOld({ success: true, data: { items: [PLANS[0]], total: 99, summary } }); await old })
    expect(screen.queryByText('ヨガ 10 回券')).toBeNull()
    expect(screen.getByText('1 件中 1〜1 件')).toBeTruthy()
  })

  it('試験が0件でも未接続の実課金を0件にせず、説明から集計の境界を読める', async () => {
    api.list.mockResolvedValueOnce({ success: true, data: { items: PLANS, total: 2, summary: { onSale: 1, holders: 86, expiringIn30d: 9, billingFailed: null, billingStatus: 'unconfigured', billingSimulationFailed: 0, billingSimulationCancelled: 0 } } })
    render(<PassesTabV8 accountId="a" canEdit={false} />)
    await screen.findByText('ヨガ 10 回券')
    const billingCard = screen.getByText(/実課金は未接続/).closest('[data-kpi-presentation]') as HTMLElement
    expect(billingCard.querySelector('[data-kpi-number]')?.textContent).toBe('—')
    expect(billingCard.textContent).toContain('試験：失敗0・正常解約0')
    const trigger = within(billingCard).getByRole('button', { name: '引き落としの失敗の説明' })
    fireEvent.click(trigger)
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toContain('実際の引き落とし失敗に含めません')
  })

  it('下書きの販売を始めるときは確かめの窓を出し、いまの版を添えて始める', async () => {
    render(<PassesTabV8 accountId="a" canEdit />)
    await screen.findByText('ヨガ 月 4 回')
    fireEvent.click(screen.getByRole('button', { name: 'ヨガ 月 4 回の操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '販売を始める' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('変えられません')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '販売を始める' })) })
    await waitFor(() => expect(api.start).toHaveBeenCalledWith('a', 'p2', 1))
  })

  it('販売中の券はやめることだけできる（編集は出ない）', async () => {
    render(<PassesTabV8 accountId="a" canEdit />)
    await screen.findByText('ヨガ 10 回券')
    fireEvent.click(screen.getByRole('button', { name: 'ヨガ 10 回券の操作' }))
    expect(await screen.findByRole('menuitem', { name: '販売をやめる' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '編集する' })).toBeNull()
  })

  it('閲覧のみの人には、変える操作を置かない（持っている人を見るだけ）', async () => {
    render(<PassesTabV8 accountId="a" canEdit={false} />)
    await screen.findByText('ヨガ 10 回券')
    fireEvent.click(screen.getByRole('button', { name: 'ヨガ 10 回券の操作' }))
    expect(await screen.findByRole('menuitem', { name: '持っている人を見る' })).toBeTruthy()
    for (const name of ['編集する', '販売を始める', '販売をやめる', '複製']) expect(screen.queryByRole('menuitem', { name })).toBeNull()
  })

  it('読み込みに失敗したら「もう一度」を出す', async () => {
    api.list.mockRejectedValueOnce(new Error('down'))
    render(<PassesTabV8 accountId="a" canEdit />)
    expect(await screen.findByRole('button', { name: /もう一度/ })).toBeTruthy()
    const billingCard = screen.getByText('引き落としの失敗').closest('[data-kpi-presentation]') as HTMLElement
    expect(billingCard.querySelector('[data-kpi-number]')?.textContent).toBe('—')
    expect(billingCard.textContent).toContain('読み込めませんでした')
    expect(billingCard.textContent).not.toContain('試験：失敗0')
  })
})
