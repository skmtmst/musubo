// @vitest-environment happy-dom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {EditReservationDialog,InboundTrialDialog} from './dialogs'
import {reservation} from '../booking-kit/test-data'
afterEach(cleanup)
it('OP-R05 日時を変えず保存しても端末の時間帯で予約を動かさない', async()=>{
 const onSave=vi.fn()
 render(<EditReservationDialog accountId="account-1" storeId="store" reservation={reservation('synthetic',{customer_name:'人工のお客さま',starts_at:'2026-10-20T09:00:00.000Z',ends_at:'2026-10-20T11:00:00.000Z'})} tables={[]} courses={[]} busy={false} canWrite onClose={()=>{}} onSave={onSave} onCancelReservation={()=>{}} onRestore={()=>{}}/>)
 const save=screen.getByRole('button',{name:'保存する'})
 expect(save.querySelectorAll('svg.lucide-check')).toHaveLength(1)
 fireEvent.click(save)
 await waitFor(()=>expect(onSave).toHaveBeenCalledTimes(1))
 expect(onSave.mock.calls[0][0]).toMatchObject({startsAt:'2026-10-20T09:00:00.000Z',endsAt:'2026-10-20T11:00:00.000Z'})
})
it.each([false,true])('受信の取り込み印を残し、処理中は送信しない（busy=%s）',busy=>{
 const onSubmit=vi.fn()
 render(<InboundTrialDialog open busy={busy} onClose={()=>{}} onSubmit={onSubmit}/>)
 const submit=screen.getByRole('button',{name:'受信として取り込む'})
 expect(submit.querySelectorAll('svg.lucide-download')).toHaveLength(1)
 expect(submit.hasAttribute('disabled')).toBe(busy)
 if(busy) fireEvent.click(submit)
 expect(onSubmit).not.toHaveBeenCalled()
})
