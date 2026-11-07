// @vitest-environment happy-dom
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ floors: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api/helpers/reservation-board', () => ({ reservationBoardApi: { floors: net.floors, saveFloor: net.save } }))
vi.mock('next/navigation', () => ({ useRouter:()=>({push:vi.fn(),replace:vi.fn()}),usePathname:()=>'/restaurant-test/front-desk' }))
import RestaurantFloorEditor from './restaurant-floor-editor'
import { ApiError } from '@/lib/api'
afterEach(cleanup)
it('REM3-01 actual API fields.tables is displayed beside the editable seat map', async () => {
 net.floors.mockResolvedValue({ success: true, data: [{ id:'f',storeId:'s',name:'1階',width:800,height:600,version:1,outline:[],fixtures:[],tables:[{id:'t',x:10,y:10,width:100,height:80,rotation:0,shape:'rectangle',joinGroup:null}] }] })
 net.save.mockRejectedValue(new ApiError(400,'座席図の形・位置・版を確認してください',undefined,undefined,undefined,undefined,{tables:'卓の位置を確認してください',expectedVersion:'版を確認してください'}))
 render(<RestaurantFloorEditor accountId="a" storeId="s" resources={[{id:'t',label:'t',capacity:2,active:true}]} canEdit onSelect={()=>{}} />)
 const table=await screen.findByRole('button',{name:'t'})
 fireEvent.keyDown(table,{key:'ArrowRight'})
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 const reason=await screen.findByText('卓の位置を確認してください')
 const map=screen.getByRole('group',{name:'1階の座席表'})
 expect(map.getAttribute('aria-invalid')).toBe('true')
 expect(map.getAttribute('aria-describedby')).toContain(reason.id)
 expect(table.getAttribute('transform')).toContain('20 10')
})
