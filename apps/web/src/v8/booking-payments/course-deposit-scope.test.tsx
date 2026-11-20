// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api=vi.hoisted(()=>({courseDeposit:vi.fn(),saveCourseDeposit:vi.fn()}))
vi.mock('@/lib/api/helpers/booking-advanced',()=>({bookingAdvancedApi:api}))
import { CourseDepositFields, useMenuDeposit } from './menu-deposit'
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

it('予約金の選択状態を表示し、切り替えると更新する', async () => {
 api.courseDeposit.mockResolvedValue(rule(40))
 function Form() { const deposit = useMenuDeposit('account', 'a', 'course'); return <CourseDepositFields deposit={deposit} readOnly={false} /> }
 render(<Form />)
 const selected = await screen.findByRole('radio', { name: '料金の割合' })
 expect(selected.getAttribute('aria-checked')).toBe('true')
 fireEvent.click(screen.getByRole('radio', { name: 'なし' }))
 expect(screen.getByRole('radio', { name: 'なし' }).getAttribute('aria-checked')).toBe('true')
})
