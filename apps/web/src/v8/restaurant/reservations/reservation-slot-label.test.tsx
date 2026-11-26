// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ReservationBoard from '@/components/shared/reservation-board'

afterEach(cleanup)

it.each([false, true])('空き枠の追加操作に＋を出し、卓と時刻を渡す（枠の指定：%s）', explicit => {
  const onSlot = vi.fn()
  const startsAt = '2026-10-01T08:00:00.000Z'
  render(<ReservationBoard entries={[]} resources={[{id:'t1',label:'T1',capacity:2,active:true}]} dates={['2026-10-01']} canWrite onOpen={()=>{}} onSlot={onSlot} slots={explicit ? [{resourceId:'t1',startsAt}] : undefined} />)
  const slot = screen.getByRole('button',{name:'T1 2名 17:00に予約を入れる'})
  expect(slot.textContent).toBe(explicit ? '＋ 空き' : '＋ 予約追加')
  fireEvent.click(slot)
  expect(onSlot).toHaveBeenCalledWith('t1',startsAt)
})

it('人の横向きの台帳は毎時の表示を保ち、座席向けの間引きを適用しない',()=>{
 render(<ReservationBoard kind="people" entries={[]} resources={[{id:'staff',label:'担当者',capacity:1,active:true}]} dates={['2026-10-01']} onOpen={()=>{}}/>)
 const ruler=screen.getByRole('group',{name:'時間の目盛り'})
 expect([...ruler.querySelectorAll('span')].map(e=>e.textContent)).toEqual(['9:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'])
})
