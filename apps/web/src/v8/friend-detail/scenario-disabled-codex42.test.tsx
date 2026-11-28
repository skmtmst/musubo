// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useScenarioPicker } from './dialogs'
const fixture=vi.hoisted(()=>({list:vi.fn(),enroll:vi.fn()}))
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,scenarios:{...actual.api.scenarios,list:fixture.list,enroll:fixture.enroll}}}})
afterEach(()=>{cleanup();vi.resetAllMocks()})
function Harness(){const p=useScenarioPicker('friend','見本','account',()=>{});return <><button onClick={()=>void p.openPicker()}>開く</button>{p.dialog}</>}
it('シナリオを選ぶまで理由を示し、登録を実行しない',async()=>{
 fixture.list.mockResolvedValue({success:true,data:[{id:'sc',name:'見本シナリオ',isActive:true}]})
 render(<Harness />);fireEvent.click(screen.getByRole('button',{name:'開く'}))
 expect(await screen.findByText('登録するシナリオを選んでください。')).toBeTruthy()
 const confirm=screen.getByRole('button',{name:'このシナリオに登録する'}) as HTMLButtonElement
 expect(confirm.disabled).toBe(true);fireEvent.click(confirm);expect(fixture.enroll).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'登録するシナリオ：選択する'}))
 fireEvent.click(screen.getByRole('radio',{name:'見本シナリオ'}))
 fireEvent.click(screen.getByRole('button',{name:'選択する'}))
 expect(confirm.disabled).toBe(false)
 fixture.enroll.mockResolvedValue({success:true})
 fireEvent.click(confirm);expect(fixture.enroll).toHaveBeenCalledWith('sc','friend')
})
