// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BookingStaff } from '@/lib/api'
const net = vi.hoisted(() => ({ remove: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, bookingApi: { ...actual.bookingApi, deleteStaff: net.remove, updateStaff: net.update } } })
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/v8/booking-payments/public/assignment/index', () => ({ useAssignment: () => ({ dirty: false, saving: false, resources: {}, status: 'ready', save: vi.fn(), reset: vi.fn() }), AssignmentSection: () => null, AssignmentConflict: () => null, AssignmentRowDialog: () => null, PRIORITY: { normal: { tone: 'neutral', label: '通常' } } }))
vi.mock('./staff-calendar', () => ({ StaffCalendarPanel: () => null }))
import { StaffTabV8 } from './tabs/staff-tab'
afterEach(() => { cleanup(); vi.clearAllMocks() })
const person = { id:'s1', name:'佐藤', display_name:'佐藤', is_active:1, sort_order:1 } as BookingStaff
it.each([true, false])('担当スタッフの操作説明は編集権限 %s に合う', (canEdit) => {
 render(<StaffTabV8 staff={[person]} status="ready" error={null} matrices={{}} extras={{}} members={[]} canEdit={canEdit} onReload={vi.fn()} accountId="a" />)
 fireEvent.click(screen.getByRole('button', { name: '担当スタッフの操作の説明' }))
 expect(screen.getByText(/名前を押すと勤務とシフトが開きます/)).toBeTruthy()
 expect(Boolean(screen.queryByText(/編集・止める/))).toBe(canEdit)
})
it.each(['止める', '削除する'])('%sの対象を示し切替前の確定を拒む', (action) => {
 const props = { staff:[person], status:'ready' as const, error:null, matrices:{}, extras:{}, members:[], canEdit:true, onReload:vi.fn() }
 const view=render(<StaffTabV8 {...props} accountId="a" />)
 fireEvent.click(screen.getByRole('button', { name:'佐藤のそのほかの操作' }))
 fireEvent.click(screen.getByRole('menuitem', { name:action }))
 const dialog=screen.getByRole('alertdialog')
 expect(dialog.textContent).toContain('LINEアカウント')
 const confirm=within(dialog).getByRole('button',{name:action})
 const key=Object.keys(confirm).find(item=>item.startsWith('__reactProps$'))!
 const oldConfirm=(confirm as unknown as Record<string,{onClick:(event:unknown)=>void}>)[key].onClick
 view.rerender(<StaffTabV8 {...props} accountId="b" />)
 view.rerender(<StaffTabV8 {...props} accountId="a" />)
 act(()=>oldConfirm({preventDefault(){},stopPropagation(){}}))
 expect(net.remove).not.toHaveBeenCalled();expect(net.update).not.toHaveBeenCalled()
})

it.each(['止める', '削除する'])('%sは確認後に対象のアカウントへ送る', async (action) => {
 net.remove.mockResolvedValue({success:true});net.update.mockResolvedValue({success:true})
 const props={staff:[person],status:'ready' as const,error:null,matrices:{},extras:{},members:[],canEdit:true,onReload:vi.fn()}
 render(<StaffTabV8 {...props} accountId="a" />)
 fireEvent.click(screen.getByRole('button',{name:'佐藤のそのほかの操作'}))
 fireEvent.click(screen.getByRole('menuitem',{name:action}))
 const dialog=screen.getByRole('alertdialog')
 expect(net.remove).not.toHaveBeenCalled();expect(net.update).not.toHaveBeenCalled()
 fireEvent.click(within(dialog).getByRole('button',{name:action}))
 if(action==='止める') await waitFor(()=>expect(net.update).toHaveBeenCalledWith('a','s1',{is_active:0}))
 else await waitFor(()=>expect(net.remove).toHaveBeenCalledWith('a','s1'))
})
