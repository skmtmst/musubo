// @vitest-environment happy-dom
/*
 * 監査 WEB055/056：休業日のタブ。
 * - 056：31日より長い休みも、32日目から先を休みとして扱う（打ち切らない）
 * - 055：削除の失敗は、開いている削除の確認の中に出し、窓を閉じない
 */
import React from 'react'
import { act, cleanup, render, screen, waitFor,fireEvent,within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingException, BookingSettings } from '@/lib/api'
import { closedOn, closedRanges, closedSpan } from './lib/closed-ranges'
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'

const net = vi.hoisted(() => ({ deleteException: vi.fn(), listRequests: vi.fn().mockResolvedValue({ requests: [], total: 0 }) }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, deleteException: net.deleteException, listRequests: net.listRequests } }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}))

const { HolidaysTabV8 } = await import('./tabs/holidays-tab')

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T03:00:00.000Z')) })
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.clearAllMocks(); vi.useRealTimers() })

const exception = (id: string, dateFrom: string, dateTo: string): BookingException => ({
  id, lineAccountId: 'a', scopeKind: 'store', scopeId: null, date: null, dateFrom, dateTo, kind: 'closed',
  intervals: [], reason: '改装', note: null, version: 1, createdAt: '', updatedAt: '',
})

describe('長い休み（WEB056）', () => {
  it('45日の休みの40日目も休み', () => {
    const ranges = closedRanges([exception('e1', '2026-12-01', '2027-01-14')])
    expect(closedOn(ranges, '2027-01-09')?.id).toBe('e1')
    expect(closedOn(ranges, '2027-01-15')).toBeUndefined()
    expect(closedSpan(ranges)).toEqual({ from: '2026-12-01', to: '2027-01-14' })
  })
})

describe('休業日の削除の失敗（WEB055）', () => {
  it('失敗の理由を削除の確認の中に出し、窓は開いたまま', async () => {
    const { ApiError } = await import('@/lib/api')
    net.deleteException.mockRejectedValue(new ApiError(500, 'down'))
    const item = exception('e1', '2026-10-20', '2026-10-20')
    const settings = { exceptions: [item] } as unknown as BookingSettings
    render(<HolidaysTabV8 accountId="a" settings={settings} status="ready" error={null} exceptions={[item]} closedWeekdays={[]} bookingCountOnClosed={0} canEdit onSaved={() => undefined} onReload={() => undefined} />)
    await act(async () => { screen.getByRole('button', { name: '削除' }).click() })
    await act(async () => { screen.getByRole('button', { name: '削除する', exact: true }).click() })
    await waitFor(() => expect(net.deleteException).toHaveBeenCalled())
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'))
    expect(dialog.textContent).toContain('削除')
    expect(dialog.textContent).toContain('休業日を消せませんでした')
  })
})

it.each(['cancel','close','escape','backdrop'])('DC-UI-03：実休業日入力の%sでも同じ破棄確認を出して入力を残す',async path=>{
 document.documentElement.dataset.theme='v8'
 const item=exception('e1','2026-10-20','2026-10-20')
 render(<HolidaysTabV8 accountId="a" settings={{exceptions:[item]} as BookingSettings} status="ready" error={null} exceptions={[item]} closedWeekdays={[]} bookingCountOnClosed={0} canEdit onSaved={()=>{}} onReload={()=>{}}/>)
 fireEvent.click(screen.getByText('改装').previousElementSibling!)
 fireEvent.change(screen.getByLabelText('休業の理由'),{target:{value:'入力を保持'}})
 const dialog=screen.getByRole('dialog',{name:'休業日を直す'})
 if(path==='cancel')fireEvent.click(within(dialog).getByRole('button',{name:'キャンセル'}))
 else if(path==='close')fireEvent.click(within(dialog).getByRole('button',{name:'閉じる'}))
 else if(path==='escape')fireEvent.keyDown(document,{key:'Escape'})
 else fireEvent.mouseDown(dialog.parentElement!)
 const confirm=screen.getByRole('dialog',{name:'入力を破棄しますか？'})
 fireEvent.click(within(confirm).getByRole('button',{name:'編集を続ける'}))
 expect((screen.getByLabelText('休業の理由') as HTMLInputElement).value).toBe('入力を保持')
 delete document.documentElement.dataset.theme
})

it('Q01：日付は必須・理由は任意。空と逆順は欄下に示して入力を残す', async () => {
  render(<HolidaysTabV8 accountId="a" settings={{ exceptions: [] } as unknown as BookingSettings} status="ready" error={null} exceptions={[]} closedWeekdays={[]} bookingCountOnClosed={0} canEdit onSaved={() => {}} onReload={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '臨時休業を足す' }))
  const dialog = screen.getByRole('dialog', { name: '臨時休業を足す' })
  const from = within(dialog).getByLabelText<HTMLButtonElement>('休業の開始日')
  const to = within(dialog).getByLabelText<HTMLButtonElement>('休業の終了日')
  const reason = within(dialog).getByLabelText<HTMLInputElement>('休業の理由')
  expect(within(dialog).getAllByText('必須')).toHaveLength(2)
  expect(within(dialog).getAllByText('任意')).toHaveLength(1)
  fireEvent.change(reason, { target: { value: '入力を残す' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '休業日を保存する' }))
  expect(from.getAttribute('aria-invalid')).toBe('true')
  expect(to.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(from.getAttribute('aria-describedby')!.split(' ').at(-1)!)?.textContent).toBe('開始日を入れてください。')
  fireEvent.click(from)
  fireEvent.click(screen.getByRole('button', { name: /2026年10月20日/ }))
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
  fireEvent.click(to)
  fireEvent.click(screen.getByRole('button', { name: /2026年10月19日/ }))
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '休業日を保存する' }))
  expect(within(dialog).getByText('終了日は開始日以降にしてください。')).toBeTruthy()
  expect(from.textContent).toContain('2026年10月20日')
  expect(to.textContent).toContain('2026年10月19日')
  expect(reason.value).toBe('入力を残す')
})

it('期間の途中の日を選んだら、その日の予約を確かめる', async () => {
  const { jstDate } = await import('@/lib/jst-datetime')
  const today = jstDate()
  const first = `${today.slice(0, 7)}-01`
  const item = exception('range', first, today)
  render(<HolidaysTabV8 accountId="a" settings={{ exceptions: [item] } as unknown as BookingSettings} status="ready" error={null} exceptions={[item]} closedWeekdays={[]} bookingCountOnClosed={null} canEdit onSaved={() => {}} onReload={() => {}} />)
  const day = Number(today.slice(8, 10))
  fireEvent.click(screen.getAllByRole('gridcell').find((cell) => cell.querySelector('span')?.textContent === String(day))!)
  const dialog = screen.getByRole('dialog', { name: '休業日を直す' })
  await waitFor(() => expect(within(dialog).getByRole('link', { name: 'この日の予約へ' }).getAttribute('href')).toContain(`date=${today}`))
})

it('閲覧のみの休業削除は理由付きで拒否し、確認もAPIも開かない', async () => {
  rememberStaffIdentity({ id: 'viewer', role: 'viewer' } as StaffMember)
  const item = exception('closed', '2026-10-13', '2026-10-14')
  render(<HolidaysTabV8 accountId="a" settings={{ exceptions: [item] } as unknown as BookingSettings} status="ready" error={null} exceptions={[item]} closedWeekdays={[]} bookingCountOnClosed={null} canEdit={false} onSaved={() => {}} onReload={() => {}} />)
  await expectPermissionLocked(screen.getByRole('button', { name: '削除', exact: true }))
  const grid = screen.getByRole('grid', { name: /の休業日$/ })
  expect(within(grid).getAllByRole('gridcell').length).toBeGreaterThan(27)
  expect(grid.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')).toHaveLength(0)
  for (const cell of within(grid).getAllByRole('gridcell')) {
    fireEvent.click(cell)
    fireEvent.keyDown(cell, { key: 'Enter' })
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(net.deleteException).not.toHaveBeenCalled()
})

it('休業日削除の対象を示し、切替後の古い確定では削除しない', () => {
 const item = exception('e1', '2026-10-20', '2026-10-20')
 const props = { settings: { exceptions: [item] } as BookingSettings, status: 'ready' as const, error: null, exceptions: [item], closedWeekdays: [], bookingCountOnClosed: 0, canEdit: true, onSaved: vi.fn(), onReload: vi.fn() }
 const view = render(<HolidaysTabV8 {...props} accountId="a" />)
 fireEvent.click(screen.getByRole('button', { name: '削除' }))
 const dialog = screen.getByRole('alertdialog')
 expect(dialog.textContent).toContain('LINEアカウント')
 const button = within(dialog).getByRole('button', { name: '削除する' })
 const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
 const oldConfirm = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
 view.rerender(<HolidaysTabV8 {...props} accountId="b" />)
 view.rerender(<HolidaysTabV8 {...props} accountId="a" />)
 act(() => oldConfirm({ preventDefault() {}, stopPropagation() {} }))
 expect(net.deleteException).not.toHaveBeenCalled()
})

it.each([true, false])('休業日の操作案内は編集可否 %s に合う', (canEdit) => {
  render(<HolidaysTabV8 accountId="a" settings={{ exceptions: [] } as unknown as BookingSettings} status="ready" error={null} exceptions={[]} closedWeekdays={[]} bookingCountOnClosed={0} canEdit={canEdit} onSaved={() => {}} onReload={() => {}} />)
  expect(Boolean(screen.queryByText(/日にちを押すと休みにできます/))).toBe(canEdit)
  expect(screen.getByText(/定休日（毎週）は受付枠で決めます/)).toBeTruthy()
})
