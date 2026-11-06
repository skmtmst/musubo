// @vitest-environment happy-dom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRestaurantReservationForm, type RestaurantFollowupTrigger } from '@line-crm/shared'
const f = vi.hoisted(() => ({
  role: 'owner' as string | null, account: 'a', store: 's', read: vi.fn(), saveForm: vi.fn(),
  initialize: vi.fn(), saveRow: vi.fn(), test: vi.fn(), start: vi.fn(), notUsing: vi.fn(), push: vi.fn(),
  confirm: null as (() => void) | null,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: f.account }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => f.role }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: f.push, replace: vi.fn(), back: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/v8/restaurant/common-a/public/frame/index', () => ({ RestaurantFrame: ({ children }: { children: (ctx: unknown) => React.ReactNode }) => children({ store: { id: f.store, name: '試験店' } }) }))
vi.mock('@/lib/api/helpers/restaurant-followup-board', () => ({ followupBoardApi: { read: f.read, saveForm: f.saveForm, initialize: f.initialize, saveRow: f.saveRow, test: f.test, start: f.start, notUsing: f.notUsing } }))
vi.mock('@/lib/unsaved-leave-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/unsaved-leave-dialog')>()
  return { ...actual, UnsavedLeaveDialog: (props: React.ComponentProps<typeof actual.UnsavedLeaveDialog>) => {
    if (props.open) f.confirm = props.onConfirm
    return <actual.UnsavedLeaveDialog {...props} />
  } }
})
import LineFollowupV8 from './line-followup'
import { FollowupEditor } from './followup-editor'
import { FOLLOWUP_ORDER, FOLLOWUP_NAMES, boardRows } from './board-model'
import type { FollowupBoardSnapshot } from '@/lib/api/helpers/restaurant-followup-board'
function initial(){
 const timing=(trigger:RestaurantFollowupTrigger)=>trigger==='anniversary_before'?{mode:'time',offsetDays:-7,sendAtTime:'10:00'}:trigger==='reservation_24h'?{mode:'time',offsetDays:-1,sendAtTime:'18:00'}:{mode:'countdown',offsetMinutes:trigger==='reservation_2h'?-120:trigger==='post_visit'?180:0}
 return {page:{setup:{notUsing:false,decidedAt:null,version:0},template:null,bindings:[],jobs:[],editor:'common_scenario',rows:FOLLOWUP_ORDER.map(trigger=>({store_id:'s',trigger,enabled:['reservation_created','reservation_24h'].includes(trigger),version:1,step_id:null,initial_key:trigger,default_offset_minutes:0,initial_message:`${FOLLOWUP_NAMES[trigger]}の本文`}))},board:{testRecipient:{state:'ready',recipientKind:'self',recipient:{id:'self',displayName:'本人',pictureUrl:null}},legacyContents:FOLLOWUP_ORDER.map(trigger=>({trigger,content:{timing:timing(trigger),messageParts:[{messageType:'text',messageContent:`${FOLLOWUP_NAMES[trigger]}の本文`}]}})),engines:FOLLOWUP_ORDER.map(trigger=>({trigger,engine:['reservation_24h','reservation_2h','anniversary_before'].includes(trigger)?'reminder':'automation',targetId:`resource-${trigger}`,targetVersion:1,contentRevision:'revision1',enabled:['reservation_created','reservation_24h'].includes(trigger),effectiveSendingStatus:'stopped',reason:'まだ送っていません',detailPath:trigger==='reservation_24h'?'/reminders/detail?id=resource-reservation_24h':`/automations/drafts?id=resource-${trigger}`,editorContent:{timing:timing(trigger),messageParts:[{messageType:'text',messageContent:`${FOLLOWUP_NAMES[trigger]}の本文`}]}}))},form:{version:0,definition:defaultRestaurantReservationForm()}}
}
let snapshot: ReturnType<typeof initial>
beforeEach(() => {
  vi.clearAllMocks()
  f.role = 'owner'; f.account = 'a'; f.store = 's'; f.confirm = null
  snapshot = initial()
  f.read.mockImplementation(async () => structuredClone(snapshot))
  f.saveRow.mockResolvedValue({}); f.saveForm.mockResolvedValue({})
  window.history.replaceState(null, '', '/restaurant-test/line-followup')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const card = (trigger: RestaurantFollowupTrigger) => screen.getByRole('article', { name: FOLLOWUP_NAMES[trigger] })
const leave = () => screen.getByRole('dialog', { name: '保存していない変更があります' })
const editor = () => screen.getByRole('dialog', { name: '予約したときを変える' })
async function ready(strict = false) {
  const view = render(strict ? <StrictMode><LineFollowupV8 /></StrictMode> : <LineFollowupV8 />)
  await screen.findByRole('article', { name: '予約の回答フォーム' })
  return view
}
async function open(trigger: RestaurantFollowupTrigger = 'reservation_created') {
  fireEvent.click(within(card(trigger)).getByRole('button', { name: '変える' }))
  await screen.findByRole('dialog', { name: `${FOLLOWUP_NAMES[trigger]}を変える` })
}
async function text(value: string) {
  const input = screen.getByRole('textbox', { name: '本文' })
  await act(async () => { input.textContent = value; fireEvent.input(input) })
}
async function accept() {
  fireEvent.click(screen.getByRole('button', { name: 'この内容でオンにする' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'この内容でオンにする' })).toBeNull())
}
async function setup(parent: boolean, child: boolean, strict = false) {
  const view = await ready(strict)
  if (parent) { await open('reservation_24h'); await text('親に確定した未保存本文'); await accept() }
  await open()
  if (child) await text('窓内だけの未保存本文')
  return view
}
function link() { return screen.getByRole('link', { name: '新しく作る →' }) }
function clickLink() {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  act(() => { link().dispatchEvent(event) })
  return event
}
function assertNoWrites() {
  for (const request of [f.saveRow, f.saveForm, f.initialize, f.test, f.start, f.notUsing]) expect(request).not.toHaveBeenCalled()
}
const matrix = [[false, false], [false, true], [true, false], [true, true]] as const

describe('予約フォームの窓とページの未保存変更', () => {
  it.each(matrix)('親%s・窓%sの戻るを一つの確認で守る', async (parent, child) => {
    await ready()
    if (parent) { await open('reservation_24h'); await text('親の変更'); await accept() }
    fireEvent.click(within(screen.getByRole('article', { name: '予約の回答フォーム' })).getByRole('button', { name: '変える' }))
    const dialog = await screen.findByRole('dialog', { name: '予約の回答フォームを変える' })
    if (child) fireEvent.change(within(dialog).getByRole('textbox', { name: /題名/ }), { target: { value: '窓内の題名' } })
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledTimes(parent || child ? 1 : 0)
    if (parent || child) {
      expect(screen.getAllByRole('dialog', { name: '保存していない変更があります' })).toHaveLength(1)
      fireEvent.click(within(leave()).getByRole('button', { name: '編集を続ける' }))
      if (child) expect(within(dialog).getByRole('textbox', { name: /題名/ })).toHaveProperty('value', '窓内の題名')
      if (parent) expect(within(card('reservation_24h')).queryByText('親の変更')).not.toBeNull()
    }
    assertNoWrites()
  })
  it.each(matrix)('親%s・窓%sのリンクで破棄を選んだときだけ変更を戻す', async (parent, child) => {
    await ready()
    if (parent) { await open('reservation_24h'); await text('親の変更'); await accept() }
    fireEvent.click(within(screen.getByRole('article', { name: '予約の回答フォーム' })).getByRole('button', { name: '変える' }))
    const dialog = await screen.findByRole('dialog', { name: '予約の回答フォームを変える' })
    if (child) fireEvent.change(within(dialog).getByRole('textbox', { name: /題名/ }), { target: { value: '窓内の題名' } })
    const a = document.createElement('a'); a.href = '/templates'; document.body.appendChild(a)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    act(() => { a.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(parent || child)
    if (parent || child) {
      expect(screen.getAllByRole('dialog', { name: '保存していない変更があります' })).toHaveLength(1)
      fireEvent.click(within(leave()).getByRole('button', { name: '保存せずに移る' }))
      expect(f.push).toHaveBeenCalledExactlyOnceWith('/templates')
      expect(screen.queryByRole('dialog', { name: '予約の回答フォームを変える' })).toBeNull()
      expect(within(card('reservation_24h')).queryByText('親の変更')).toBeNull()
    }
    a.remove()
    assertNoWrites()
  })
  it('窓だけ閉じた後は親の未保存変更を保持し、親の確認が戻る', async () => {
    await ready(); await open('reservation_24h'); await text('親の変更'); await accept()
    fireEvent.click(within(screen.getByRole('article', { name: '予約の回答フォーム' })).getByRole('button', { name: '変える' }))
    const dialog = await screen.findByRole('dialog', { name: '予約の回答フォームを変える' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(within(card('reservation_24h')).queryByText('親の変更')).not.toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'リマインダ', exact: true }))
    expect(leave()).toBeTruthy()
    assertNoWrites()
  })
  it('両方に変更がある戻るでは明示破棄後に一度だけ戻る', async () => {
    await ready(); await open('reservation_24h'); await text('親の変更'); await accept()
    fireEvent.click(within(screen.getByRole('article', { name: '予約の回答フォーム' })).getByRole('button', { name: '変える' }))
    const dialog = await screen.findByRole('dialog', { name: '予約の回答フォームを変える' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /題名/ }), { target: { value: '窓内の題名' } })
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledExactlyOnceWith(1)
    fireEvent.popState(window)
    fireEvent.click(within(leave()).getByRole('button', { name: '保存せずに移る' }))
    expect(back).toHaveBeenCalledTimes(1)
    expect(within(card('reservation_24h')).queryByText('親の変更')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '予約の回答フォームを変える' })).toBeNull()
    assertNoWrites()
  })
  it('窓内だけの破棄は親の変更を保ち、開き直しでは保留先を残さない', async () => {
    await ready(); await open('reservation_24h'); await text('親の変更'); await accept()
    const formCard = screen.getByRole('article', { name: '予約の回答フォーム' })
    fireEvent.click(within(formCard).getByRole('button', { name: '変える' }))
    const dialog = await screen.findByRole('dialog', { name: '予約の回答フォームを変える' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /題名/ }), { target: { value: '窓内の題名' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).getByRole('button', { name: '破棄する' }))
    expect(within(card('reservation_24h')).queryByText('親の変更')).not.toBeNull()
    fireEvent.click(within(formCard).getByRole('button', { name: '変える' }))
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    expect(within(screen.getByRole('dialog', { name: '予約の回答フォームを変える' })).getByRole('textbox', { name: /題名/ })).not.toHaveProperty('value', '窓内の題名')
    assertNoWrites()
  })
  it('窓の破棄確認中に戻るとEscはページの確認だけ閉じる', async () => {
    await ready()
    fireEvent.click(within(screen.getByRole('article', { name: '予約の回答フォーム' })).getByRole('button', { name: '変える' }))
    const dialog = await screen.findByRole('dialog', { name: '予約の回答フォームを変える' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /題名/ }), { target: { value: '窓内の題名' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledExactlyOnceWith(1)
    expect(leave()).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    expect(within(dialog).getByRole('textbox', { name: /題名/ })).toHaveProperty('value', '窓内の題名')
    assertNoWrites()
  })
})

describe('編集窓とページの未保存変更', () => {
  it.each(matrix)('親%s・窓%sのリンクは唯一の確認へ渡し、続行で入力を保つ', async (parent, child) => {
    await setup(parent, child)
    const event = clickLink()
    expect(event.defaultPrevented).toBe(parent || child)
    if (parent || child) {
      expect(screen.getAllByRole('dialog', { name: '保存していない変更があります' })).toHaveLength(1)
      expect(f.push).not.toHaveBeenCalled()
      fireEvent.click(within(leave()).getByRole('button', { name: '編集を続ける' }))
      expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe(child ? '窓内だけの未保存本文' : '予約したときの本文')
    } else expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    assertNoWrites()
  })
  it.each(matrix)('親%s・窓%sの戻るでは履歴を1回だけ復元する', async (parent, child) => {
    await setup(parent, child)
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledTimes(parent || child ? 1 : 0)
    if (parent || child) {
      expect(go).toHaveBeenCalledWith(1)
      expect(screen.getAllByRole('dialog', { name: '保存していない変更があります' })).toHaveLength(1)
      fireEvent.popState(window)
      expect(go).toHaveBeenCalledTimes(1)
      fireEvent.click(within(leave()).getByRole('button', { name: '保存せずに移る' }))
      expect(back).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'この内容でオンにする' })).toBeNull()
      fireEvent.popState(window)
      expect(go).toHaveBeenCalledTimes(1)
    }
    assertNoWrites()
  })
  it('親と窓の明示破棄は入力を両方戻してから元のリンクへ1回だけ移る', async () => {
    await setup(true, true)
    clickLink()
    fireEvent.click(within(leave()).getByRole('button', { name: '保存せずに移る' }))
    expect(f.push).toHaveBeenCalledExactlyOnceWith('/templates')
    expect(screen.queryByRole('button', { name: 'この内容でオンにする' })).toBeNull()
    expect(within(card('reservation_24h')).queryByText('親に確定した未保存本文')).toBeNull()
    expect(screen.getByRole('button', { name: '保存して作る' }).hasAttribute('disabled')).toBe(true)
    await open()
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('予約したときの本文')
    expect(clickLink().defaultPrevented).toBe(false)
    assertNoWrites()
  })
  it('親だけ未保存なら窓は確認なしで閉じ、次の離脱は親が守る', async () => {
    await setup(true, false)
    fireEvent.click(within(editor()).getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    expect(within(card('reservation_24h')).queryByText('親に確定した未保存本文')).not.toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'リマインダ', exact: true }))
    expect(leave()).toBeTruthy()
    expect(f.push).not.toHaveBeenCalled()
    assertNoWrites()
  })
  it('窓だけの破棄は親の入力を消さず、閉じ直しで前の行き先を持ち越さない', async () => {
    await setup(true, true)
    clickLink()
    fireEvent.click(within(leave()).getByRole('button', { name: '編集を続ける' }))
    fireEvent.click(within(editor()).getByRole('button', { name: 'キャンセル' }))
    const local = screen.getByRole('dialog', { name: '入力を破棄しますか？' })
    fireEvent.click(within(local).getByRole('button', { name: '破棄する' }))
    expect(within(card('reservation_24h')).queryByText('親に確定した未保存本文')).not.toBeNull()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    await open()
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('予約したときの本文')
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    expect(clickLink().defaultPrevented).toBe(true)
    expect(f.push).not.toHaveBeenCalled()
  })
  it('同じページのクエリへ移る場合も両方の変更を明示破棄する', async () => {
    await setup(true, true)
    const a = document.createElement('a'); a.href = '/restaurant-test/line-followup?view=settings'; a.textContent = '設定の表示'
    document.body.appendChild(a)
    fireEvent.click(a)
    fireEvent.click(within(leave()).getByRole('button', { name: '保存せずに移る' }))
    expect(f.push).toHaveBeenCalledExactlyOnceWith('/restaurant-test/line-followup?view=settings')
    expect(within(card('reservation_24h')).queryByText('親に確定した未保存本文')).toBeNull()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    a.remove()
  })
  it('StrictModeで親も未保存の時に履歴の捕捉は1つで、unmount後は残らない', async () => {
    const view = await setup(true, true, true)
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledExactlyOnceWith(1)
    view.unmount()
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledTimes(1)
    assertNoWrites()
  })
  it.each(['account', 'store'] as const)('%s切替で旧確定口と窓内入力を引き継がない', async key => {
    const view = await setup(true, true)
    clickLink(); const oldConfirm = f.confirm!
    f[key] = 'other'
    view.rerender(<LineFollowupV8 />)
    await waitFor(() => expect(f.read).toHaveBeenCalledWith(f.account, f.store))
    act(() => oldConfirm())
    expect(f.push).not.toHaveBeenCalled()
    await open()
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('予約したときの本文')
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  })
  it('閉じた窓の旧確定口は新しい窓を破棄しない', async () => {
    await setup(false, true)
    clickLink(); const oldConfirm = f.confirm!
    fireEvent.click(within(leave()).getByRole('button', { name: '編集を続ける' }))
    await accept(); await open()
    act(() => oldConfirm())
    expect(f.push).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('窓内だけの未保存本文')
  })
  it('新しいbusyで旧確定口を止め、解除後だけ同じ保留先へ進む', async () => {
    const row = boardRows(snapshot as unknown as FollowupBoardSnapshot)[0]!
    const discard = vi.fn()
    const props = { row, accountId: 'a', storeName: '店', pageDirty: true, pageBusy: false, onDiscardPage: discard, onCancel: vi.fn(), onConfirm: vi.fn() }
    const view = render(<FollowupEditor {...props} />)
    clickLink(); const oldConfirm = f.confirm!
    view.rerender(<FollowupEditor {...props} pageBusy />)
    act(() => oldConfirm())
    expect(discard).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled()
    view.rerender(<FollowupEditor {...props} />)
    fireEvent.click(within(leave()).getByRole('button', { name: '保存せずに移る' }))
    expect(discard).toHaveBeenCalledTimes(1); expect(f.push).toHaveBeenCalledExactlyOnceWith('/templates')
  })
  it('行き先が無い確定口は守りを解除せず、次のリンクも確認する', async () => {
    await setup(false, true)
    clickLink(); const oldConfirm = f.confirm!
    fireEvent.click(within(leave()).getByRole('button', { name: '編集を続ける' }))
    act(() => oldConfirm())
    expect(f.push).not.toHaveBeenCalled()
    expect(clickLink().defaultPrevented).toBe(true)
    expect(leave()).toBeTruthy()
    assertNoWrites()
  })
  it('窓の破棄確認中の戻るはページ確認を前面に出し、Escは最前面だけ閉じる', async () => {
    await setup(true, true)
    fireEvent.click(within(editor()).getByRole('button', { name: 'キャンセル' }))
    expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.popState(window)
    expect(go).toHaveBeenCalledExactlyOnceWith(1)
    expect(leave()).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('窓内だけの未保存本文')
    assertNoWrites()
  })

  it.each(FOLLOWUP_ORDER)('%sの窓内入力もリンクで失わず、保存や送り始めを呼ばない', async trigger => {
    await ready(); await open(trigger); await text('その送り方だけの未保存本文')
    expect(clickLink().defaultPrevented).toBe(true)
    expect(leave()).toBeTruthy()
    fireEvent.click(within(leave()).getByRole('button', { name: '編集を続ける' }))
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('その送り方だけの未保存本文')
    assertNoWrites()
  })

})
