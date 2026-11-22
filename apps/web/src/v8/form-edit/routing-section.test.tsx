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
  expect(screen.getByRole('button',{name:'1 行目の条件 1 の答え'})).toBeTruthy()
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

it('5段階評価の質問に数値の範囲を持つ行を追加できる', () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[
    {id:'q',kind:'input',type:'rating',name:'score',label:'満足度'},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{bookingMenus:[{id:'m',name:'相談',durationMinutes:30}]} as never}
  routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'行き先を追加'}))
  expect(onChange.mock.calls[0][0].rules[0].conditions).toEqual([{questionId:'q',op:'between',value:[1,5]}])
})

it('1行に質問の条件を追加でき、3つまでに制限する', () => {
  const onChange=vi.fn()
  const question={id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]}
  const rule={conditions:[{questionId:'q',op:'is' as const,value:'相談'}],target:{menuId:'m'}}
  const {rerender}=render(<RoutingSection blocks={[question,{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never} routing={{enabled:true,rules:[rule],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
  fireEvent.click(screen.getByText('選んだ質問の条件を追加'))
  expect(onChange.mock.calls[0][0].rules[0].conditions).toHaveLength(2)
  rerender(<RoutingSection blocks={[question,{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never} routing={{enabled:true,rules:[{...rule,conditions:[rule.conditions[0],rule.conditions[0],rule.conditions[0]]}],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
  expect(screen.queryByText('選んだ質問の条件を追加')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
  fireEvent.click(screen.getByRole('button',{name:'1 行目の条件 2 を外す'}))
  expect(onChange.mock.calls[1][0].rules[0].conditions).toHaveLength(2)
})

it('数値の範囲を変更すると数値としてルールに反映する', () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[{id:'q',kind:'input',type:'rating',name:'score',label:'満足度'},{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never}
    routing={{enabled:true,rules:[{conditions:[{questionId:'q',op:'between',value:[1,5]}],target:{menuId:'m'}}],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'1 行目の範囲の始まり'}))
  fireEvent.click(screen.getByRole('option',{name:'3'}).querySelector('button')!)
  expect(onChange.mock.calls[0][0].rules[0].conditions[0].value).toEqual([3,5])
})

it('複数選択の答えをまとめて試す', async () => {
  const preview=vi.fn().mockResolvedValue({matchedIndex:-1,target:{menuId:'m'},fellBack:false})
  render(<RoutingSection blocks={[
    {id:'q',kind:'input',type:'checkbox',name:'needs',label:'相談内容',choices:[{id:'x',label:'就職'},{id:'y',label:'転職'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{} as never} routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} onChange={() => {}} onPreview={preview} />)
  fireEvent.click(screen.getByRole('button',{name:'試しに答える'}))
  fireEvent.click(screen.getByRole('checkbox',{name:'就職'}))
  fireEvent.click(screen.getByRole('checkbox',{name:'転職'}))
  expect(preview).toHaveBeenLastCalledWith({needs:['就職','転職']})
})

it('遅れて返った古い試行結果で新しい答えの結果を上書きしない', async () => {
  let finishFirst!: (value:{matchedIndex:number;target:{menuId:string};fellBack:boolean}) => void
  const preview=vi.fn().mockImplementationOnce(() => new Promise(resolve => {finishFirst=resolve}))
    .mockResolvedValueOnce({matchedIndex:-1,target:{menuId:'fallback'},fellBack:false})
  render(<RoutingSection blocks={[
    {id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'就職'},{id:'y',label:'転職'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{bookingMenus:[{id:'fallback',name:'既定の相談',durationMinutes:30}]} as never}
    routing={{enabled:true,rules:[],fallback:{menuId:'fallback'}}} onChange={() => {}} onPreview={preview} />)
  fireEvent.click(screen.getByRole('button',{name:'試しに答える'}))
  fireEvent.click(screen.getByRole('button',{name:'相談内容の試しの答え'}))
  fireEvent.click(screen.getByRole('option',{name:'就職'}).querySelector('button')!)
  fireEvent.click(screen.getByRole('button',{name:'相談内容の試しの答え'}))
  fireEvent.click(screen.getByRole('option',{name:'転職'}).querySelector('button')!)
  expect(await screen.findByText(/どれにも当たらないとき：既定の相談/)).toBeTruthy()
  finishFirst({matchedIndex:0,target:{menuId:'old'},fellBack:false})
  await Promise.resolve()
  expect(screen.getByText(/どれにも当たらないとき：既定の相談/)).toBeTruthy()
})
