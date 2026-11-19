// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api=vi.hoisted(()=>({courseDeposit:vi.fn(),saveCourseDeposit:vi.fn()}))
vi.mock('@/lib/api/helpers/booking-advanced',()=>({bookingAdvancedApi:api}))
import { useMenuDeposit } from './menu-deposit'
const rule=(value:number)=>({success:true as const,data:{kind:'percent' as const,value,inherit:false,version:1,conditions:{always:true,minPeople:null,weekdays:null,timeBand:null}}})
afterEach(()=>{cleanup();vi.resetAllMocks()})
it('別のコースへ切り替えた後に古い保存が完了しても表示を上書きしない',async()=>{
 let finish!:(value:ReturnType<typeof rule>)=>void
 api.courseDeposit.mockImplementation(async (_account:string,id:string)=>rule(id==='a'?20:40))
 api.saveCourseDeposit.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
 const view=renderHook(({id})=>useMenuDeposit('account',id,'course'),{initialProps:{id:'a'}})
 await waitFor(()=>expect(view.result.current.ready).toBe(true))
 act(()=>view.result.current.setDraft({...view.result.current.draft!,value:25}))
 let pending!:Promise<void>
 act(()=>{pending=view.result.current.save()})
 view.rerender({id:'b'})
 await waitFor(()=>expect(view.result.current.draft?.value).toBe(40))
 await act(async()=>{finish(rule(25));await pending})
 expect(view.result.current.draft?.value).toBe(40)
 expect(api.saveCourseDeposit).toHaveBeenCalledWith('account','a',expect.objectContaining({value:25}))
})
