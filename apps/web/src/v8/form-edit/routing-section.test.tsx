// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import RoutingSection from './routing-section'

afterEach(cleanup)

// 決まり2: 行き先の決まりは帯にせず、題の横の「？」へ入れる。
it('行き先の決まりは帯に出さず題の「？」に入れる', async () => {
  render(<RoutingSection blocks={[
    { kind: 'input', type: 'booking' },
    { kind: 'input', type: 'radio', label: '来店の目的', choices: [{ label: '相談' }] },
  ] as never} refs={{}} routing={undefined} onChange={() => {}} />)
  await screen.findByText('答えで予約の行き先を分ける')
  expect(screen.queryByText(/行き先はこの表で決まる/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '答えで予約の行き先を分けるの説明' }))
  expect(await screen.findByText(/行き先はこの表で決まる/)).toBeTruthy()
})

it('質問なしでも既定の行き先を設定できる', () => {
  render(<RoutingSection blocks={[{ id:'book', kind:'input', type:'booking' }] as never} refs={{} as never} routing={{enabled:true,rules:[],fallback:{menuId:''}}} onChange={() => {}} />)
  expect(screen.getByText('使える質問を追加してください。')).toBeTruthy()
  expect(screen.getByText('どれにも当たらない')).toBeTruthy()
})

it('閲覧のみでも試しの結果と既定先を表示し保存しない', async () => {
  const onPreview=vi.fn().mockResolvedValue({matchedIndex:-1,target:{menuId:'m'},fellBack:true})
  const onChange=vi.fn()
  render(<RoutingSection blocks={[
    { id:'q', kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}] },
    { id:'book',kind:'input',type:'booking' },
  ] as never} refs={{ bookingMenus:[{id:'m',name:'無料相談',durationMinutes:30}] } as never} routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} readOnly onChange={onChange} onPreview={onPreview} />)
  fireEvent.click(screen.getByRole('button',{name:'試しに答える'}))
  fireEvent.click(screen.getByRole('button',{name:'相談内容の試しの答え'}))
  fireEvent.click(screen.getByRole('option',{name:'相談'}).querySelector('button')!)
  expect(await screen.findByText(/元の行き先が使えないため既定の行き先/)).toBeTruthy()
  expect(onPreview).toHaveBeenCalledWith({subject:'相談'})
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('button',{name:'行き先を追加'})).toBeNull()
})

it('試行に失敗したら知らせ、設定は変更しない', async () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[
    { id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}] },
    { id:'book',kind:'input',type:'booking' },
  ] as never} refs={{} as never} routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} onChange={onChange} onPreview={vi.fn().mockRejectedValue(new Error('offline'))} />)
  fireEvent.click(screen.getByRole('button',{name:'試しに答える'}))
  fireEvent.click(screen.getByRole('button',{name:'相談内容の試しの答え'}))
  fireEvent.click(screen.getByRole('option',{name:'相談'}).querySelector('button')!)
  expect((await screen.findByRole('alert')).textContent).toContain('試せませんでした')
  expect(onChange).not.toHaveBeenCalled()
})

it('質問を切り替えても保存済みの行を消さない', async () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[
    {id:'q1',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},
    {id:'q2',kind:'input',type:'radio',name:'region',label:'地域',choices:[{id:'y',label:'東京'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{bookingMenus:[{id:'m',name:'無料相談',durationMinutes:30}]} as never}
  routing={{enabled:true,rules:[{conditions:[{questionId:'q1',op:'is',value:'相談'}],target:{menuId:'m'}}],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'分ける質問'}))
  fireEvent.click(screen.getByRole('radio',{name:'地域（1 つ選ぶ）'}))
  fireEvent.click(screen.getByRole('button',{name:'選ぶ'}))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByText(/相談内容：〈相談〉/)).toBeTruthy()
})

it('行き先の担当に組を選び、担当者ではなく組のIDを保存する', () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[
    {id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{bookingMenus:[{id:'m',name:'無料相談',durationMinutes:30}],bookingGroups:[{id:'g',name:'相談担当'}],bookingMenuStaff:{m:[{id:'s',name:'山田'}]}} as never}
  routing={{enabled:true,rules:[{conditions:[{questionId:'q',op:'is',value:'相談'}],target:{menuId:'m',staffId:'s'}}],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'1 行目の担当'}))
  fireEvent.click(screen.getByRole('radio',{name:'組：相談担当'}))
  fireEvent.click(screen.getByRole('button',{name:'選ぶ'}))
  expect(onChange.mock.calls[0][0].rules[0].target).toEqual({menuId:'m',staffId:undefined,staffGroupId:'g'})
})

it('担当の組が取得できない時は空の一覧と誤認させず知らせる', () => {
  render(<RoutingSection blocks={[
    {id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{bookingGroupsError:true} as never} routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} onChange={() => {}} />)
  expect(screen.getByText(/担当の組を読み込めませんでした/)).toBeTruthy()
})
