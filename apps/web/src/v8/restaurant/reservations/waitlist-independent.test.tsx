// @vitest-environment happy-dom
import React from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
const fx=vi.hoisted(()=>({listSeatWaitlist:vi.fn(),cancelSeatWaitlist:vi.fn()}))
vi.mock('@/lib/restaurant-test-api',()=>({restaurantTestApi:fx}))
import SeatWaitlistDialog from './waitlist'
const entry={id:'fixture-wait',customer_name:'検証用',status:'waiting',starts_at:'2026-10-20T10:00:00+09:00',guest_count:2,confirmation_revision:4}
beforeEach(()=>{fx.listSeatWaitlist.mockResolvedValue({data:{waitlist:[entry]}});fx.cancelSeatWaitlist.mockResolvedValue({success:true})})
afterEach(()=>{cleanup();vi.resetAllMocks()})
async function openConfirm(){render(<SeatWaitlistDialog accountId="fixture-account" storeId="fixture-store" onClose={()=>{}}/>);fireEvent.click(await screen.findByRole('button',{name:'取り消す',exact:true}));return screen.getByRole('alertdialog',{name:'キャンセル待ちを取り消しますか？'})}
it('取消成功は同じ待ちを一度送り、読み直して確認窓を閉じる',async()=>{const d=await openConfirm();fireEvent.click(within(d).getByRole('button',{name:'取り消す',exact:true}));await waitFor(()=>expect(fx.listSeatWaitlist).toHaveBeenCalledTimes(2));expect(fx.cancelSeatWaitlist).toHaveBeenCalledExactlyOnceWith('fixture-account','fixture-wait',4);expect(screen.queryByRole('alertdialog',{name:'キャンセル待ちを取り消しますか？'})).toBeNull()})
it('取消確認に対象アカウント・店舗・環境を示す',async()=>{const d=await openConfirm();expect(d.textContent).toContain('LINEアカウント');expect(d.textContent).toContain('店舗');expect(d.textContent).toContain('環境')})
it('確認中にアカウントを変えると古い窓から取り消せない',async()=>{const view=render(<SeatWaitlistDialog accountId="fixture-account" storeId="fixture-store" onClose={()=>{}}/>);fireEvent.click(await screen.findByRole('button',{name:'取り消す',exact:true}));const d=screen.getByRole('alertdialog',{name:'キャンセル待ちを取り消しますか？'});const confirm=within(d).getByRole('button',{name:'取り消す',exact:true});view.rerender(<SeatWaitlistDialog accountId="other-account" storeId="fixture-store" onClose={()=>{}}/>);fireEvent.click(confirm);expect(fx.cancelSeatWaitlist).not.toHaveBeenCalled()})
it('初期取得失敗は再読込で回復する',async()=>{fx.listSeatWaitlist.mockRejectedValueOnce(new Error('fixture network'));render(<SeatWaitlistDialog accountId="fixture-account" storeId="fixture-store" onClose={()=>{}}/>);fireEvent.click(await screen.findByRole('button',{name:'もう一度読み込む'}));await screen.findByText(/検証用/);expect(fx.listSeatWaitlist).toHaveBeenCalledTimes(2)})
it.each(['network','conflict409'])('取消の%s失敗を再取得後も示し、確認のやり直しへつなぐ',async kind=>{fx.cancelSeatWaitlist.mockRejectedValueOnce(Object.assign(new Error(kind),{status:kind==='conflict409'?409:503}));const d=await openConfirm();fireEvent.click(within(d).getByRole('button',{name:'取り消す',exact:true}));await waitFor(()=>expect(fx.listSeatWaitlist).toHaveBeenCalledTimes(2));expect(within(d).getByRole('alert').textContent).toContain(kind==='conflict409'?'状態が変わった':'通信');expect(screen.getByRole('alertdialog',{name:'キャンセル待ちを取り消しますか？'})).toBeTruthy()})

it('取消と再取得が両方失敗しても、それぞれの理由を残し、読み直し成功でも取消理由を消さない',async()=>{
 const d=await openConfirm()
 fx.cancelSeatWaitlist.mockRejectedValueOnce(new TypeError('network'))
 fx.listSeatWaitlist.mockRejectedValueOnce(new TypeError('refresh network'))
 fireEvent.click(within(d).getByRole('button',{name:'取り消す',exact:true}))
 await waitFor(()=>expect(within(d).getByRole('alert').textContent).toContain('通信'))
 await screen.findByText('キャンセル待ちを読み込めませんでした。')
 // 既存一覧がある場合も、再取得の失敗から読み直せる。
 fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}))
 await waitFor(()=>expect(fx.listSeatWaitlist).toHaveBeenCalledTimes(3))
 expect(within(d).getByRole('alert').textContent).toContain('通信')
 expect(screen.queryByText('キャンセル待ちを読み込めませんでした。')).toBeNull()
})
it('失敗後に取消をやり直せて、成功時は理由と確認窓を閉じる',async()=>{
 fx.cancelSeatWaitlist.mockRejectedValueOnce(Object.assign(new Error('conflict'),{status:409}))
 const d=await openConfirm()
 fireEvent.click(within(d).getByRole('button',{name:'取り消す',exact:true}))
 await waitFor(()=>expect(within(d).getByRole('alert').textContent).toContain('状態が変わった'))
 await waitFor(()=>expect(within(d).getByRole('button',{name:'取り消す',exact:true}).hasAttribute('disabled')).toBe(false))
 fireEvent.click(within(d).getByRole('button',{name:'取り消す',exact:true}))
 await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull())
 expect(fx.cancelSeatWaitlist).toHaveBeenCalledTimes(2)
})
