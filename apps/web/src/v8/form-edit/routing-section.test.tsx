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

it('予約先が取得できない時は空の一覧と誤認させず知らせる', () => {
  render(<RoutingSection blocks={[
    {id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{bookingGroupsError:true} as never} routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} onChange={() => {}} />)
  expect(screen.getByText(/予約先の候補を読み込めませんでした/)).toBeTruthy()
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
  // いくつでも選ぶ質問は「就職も転職も選んだ」のように、同じ質問の条件を重ねられる。まだ使っていない答えを足す。
  const question={id:'q',kind:'input',type:'checkbox',name:'needs',label:'相談内容',choices:[{id:'a',label:'就職'},{id:'b',label:'転職'},{id:'c',label:'副業'},{id:'d',label:'起業'}]}
  const rule={conditions:[{questionId:'q',op:'is' as const,value:'就職'}],target:{menuId:'m'}}
  const {rerender}=render(<RoutingSection blocks={[question,{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never} routing={{enabled:true,rules:[rule],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
  fireEvent.click(screen.getByText('選んだ質問の条件を追加'))
  expect(onChange.mock.calls[0][0].rules[0].conditions).toEqual([rule.conditions[0],{questionId:'q',op:'is',value:'転職'}])
  // 使っていない答え（起業）が残っていても、4つ目は足せない。
  const three=[rule.conditions[0],{questionId:'q',op:'is' as const,value:'転職'},{questionId:'q',op:'is' as const,value:'副業'}]
  rerender(<RoutingSection blocks={[question,{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never} routing={{enabled:true,rules:[{...rule,conditions:three}],fallback:{menuId:'m'}}} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
  expect(screen.queryByText('選んだ質問の条件を追加')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
  fireEvent.click(screen.getByRole('button',{name:'1 行目の条件 2 を外す'}))
  expect(onChange.mock.calls[1][0].rules[0].conditions).toEqual([three[0],three[2]])
})

it('答えが1つの質問には、同じ行へ2つ目の条件を足さず、別の質問の条件は足せる', () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[
    {id:'q1',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'就職'},{id:'y',label:'転職'}]},
    {id:'q2',kind:'input',type:'rating',name:'score',label:'満足度'},
    {id:'q3',kind:'input',type:'select',name:'region',label:'地域',choices:[{id:'t',label:'東京'},{id:'o',label:'大阪'}]},
    {id:'book',kind:'input',type:'booking'},
  ] as never} refs={{} as never}
  routing={{enabled:true,rules:[{conditions:[{questionId:'q1',op:'is',value:'就職'},{questionId:'q2',op:'between',value:[3,5]}],target:{menuId:'m'}}],fallback:{menuId:'m'}}} onChange={onChange} />)
  const pickQuestion=(name:string) => {
    fireEvent.click(screen.getByRole('button',{name:'分ける質問'}))
    fireEvent.click(screen.getByRole('radio',{name}))
    fireEvent.click(screen.getByRole('button',{name:'選ぶ'}))
  }
  const menuHasAdd=() => {
    fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
    const found=screen.queryByText('選んだ質問の条件を追加')
    if(!found) fireEvent.click(screen.getByRole('button',{name:'1 行目のそのほかの操作'}))
    return found
  }
  expect(menuHasAdd()).toBeNull()
  pickQuestion('満足度（5段階評価）')
  expect(menuHasAdd()).toBeNull()
  pickQuestion('地域（プルダウン）')
  fireEvent.click(menuHasAdd()!)
  expect(onChange.mock.calls[0][0].rules[0].conditions).toEqual([
    {questionId:'q1',op:'is',value:'就職'},{questionId:'q2',op:'between',value:[3,5]},{questionId:'q3',op:'is',value:'東京'},
  ])
})

it('答えが1つの質問に同時に満たせない条件が重なった行は赤くし、理由を出す', () => {
  const radio={id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'就職'},{id:'y',label:'転職'}]}
  const rule={conditions:[{questionId:'q',op:'is' as const,value:'就職'},{questionId:'q',op:'is' as const,value:'転職'}],target:{menuId:'m'}}
  const {rerender}=render(<RoutingSection blocks={[radio,{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never}
    routing={{enabled:true,rules:[rule],fallback:{menuId:'m'}}} onChange={() => {}} />)
  expect(screen.getByText('1 行目の「相談内容」の条件は同時に満たせません。どちらかを外すか、行を分けてください。')).toBeTruthy()
  expect(screen.getByRole('button',{name:'1 行目の条件 1 の答え'}).closest('[data-invalid]')).toBeTruthy()
  // いくつでも選ぶ質問なら「両方選んだ」で当たるため、同じ条件でも止めない（対照）。
  rerender(<RoutingSection blocks={[{...radio,type:'checkbox'},{id:'book',kind:'input',type:'booking'}] as never} refs={{} as never}
    routing={{enabled:true,rules:[rule],fallback:{menuId:'m'}}} onChange={() => {}} />)
  expect(screen.queryByText(/同時に満たせません/)).toBeNull()
  expect(screen.getByRole('button',{name:'1 行目の条件 1 の答え'}).closest('[data-invalid]')).toBeNull()
})

it('ほかの店でも使うフォームでは、行き先を分けるをオンにさせず理由を出す', () => {
  const onChange=vi.fn()
  render(<RoutingSection blocks={[{id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},{id:'book',kind:'input',type:'booking'}] as never}
    refs={{} as never} routing={{enabled:false,rules:[],fallback:{menuId:''}}} stores="shared" onChange={onChange} />)
  const toggle=screen.getByRole('switch',{name:'答えで予約の行き先を分ける'}) as HTMLButtonElement
  expect(toggle.disabled).toBe(true)
  expect(toggle.getAttribute('aria-describedby')).toContain('fe-routing-stores')
  expect(document.getElementById('fe-routing-stores')?.textContent).toContain('ほかの店でも使うフォームのため、答えで予約の行き先は分けられません')
  fireEvent.click(toggle)
  expect(onChange).not.toHaveBeenCalled()
})

it('ほかの店でも使うフォームで行き先を分けていたら、オフにして保存するよう知らせる', () => {
  const onChange=vi.fn()
  const props={blocks:[{id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},{id:'book',kind:'input',type:'booking'}] as never,
    refs:{} as never, routing:{enabled:true,rules:[],fallback:{menuId:'m'}}, stores:'shared' as const, onChange}
  const {rerender}=render(<RoutingSection {...props} />)
  expect(screen.getByText(/行き先を分けたままでは保存できません。オフにしてから保存してください/)).toBeTruthy()
  fireEvent.click(screen.getByRole('switch',{name:'答えで予約の行き先を分ける'}))
  expect(onChange.mock.calls[0][0].enabled).toBe(false)
  // 閲覧のみ（代理ログインを含む）は行き先を変えられないため、保存の知らせは出さない。
  rerender(<RoutingSection {...props} readOnly />)
  expect(document.getElementById('fe-routing-stores')).toBeNull()
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

it('使えなくなった行き先を閲覧だけの人にも知らせる', () => {
  render(<RoutingSection blocks={[{id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},{id:'book',kind:'input',type:'booking'}] as never}
    refs={{routingMenus:[{id:'m',name:'相談',durationMinutes:30}],routingMenuStaff:{m:[{id:'s',name:'担当'}]},bookingGroups:[]} as never}
    routing={{enabled:true,rules:[{conditions:[{questionId:'q',op:'is',value:'相談'}],target:{menuId:'old'}}],fallback:{menuId:'m'}}} readOnly onChange={() => {}} />)
  expect(screen.getByText(/1 行目の行き先が使えません/)).toBeTruthy()
})

it('担当できる人がいなくなった組の行き先を知らせる', () => {
  render(<RoutingSection blocks={[{id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},{id:'book',kind:'input',type:'booking'}] as never}
    refs={{routingMenus:[{id:'m',name:'相談',durationMinutes:30}],routingMenuStaff:{m:[{id:'s',name:'別の担当'}]},bookingGroups:[{id:'g',name:'相談組',menuIds:[]}]} as never}
    routing={{enabled:true,rules:[{conditions:[{questionId:'q',op:'is',value:'相談'}],target:{menuId:'m',staffGroupId:'g'}}],fallback:{menuId:'m'}}} readOnly onChange={() => {}} />)
  expect(screen.getByText(/1 行目の行き先が使えません/)).toBeTruthy()
})

it('使う店を確かめている間と確かめられない時は、行き先を分けるをオンにさせない。オフにはできる', () => {
  const onChange=vi.fn()
  const blocks=[{id:'q',kind:'input',type:'radio',name:'subject',label:'相談内容',choices:[{id:'x',label:'相談'}]},{id:'book',kind:'input',type:'booking'}] as never
  const off={enabled:false,rules:[],fallback:{menuId:''}}
  const {rerender}=render(<RoutingSection blocks={blocks} refs={{} as never} routing={off} stores="checking" onChange={onChange} />)
  const toggle=() => screen.getByRole('switch',{name:'答えで予約の行き先を分ける'}) as HTMLButtonElement
  // 確かめている間は押せないスイッチを置かない（押せない部品を置かない決まり）。
  expect(screen.queryByRole('switch',{name:'答えで予約の行き先を分ける'})).toBeNull()
  expect(document.getElementById('fe-routing-stores')).toBeNull()
  rerender(<RoutingSection blocks={blocks} refs={{} as never} routing={off} stores="unknown" onChange={onChange} />)
  expect(toggle().disabled).toBe(true)
  expect(document.getElementById('fe-routing-stores')?.textContent).toContain('このフォームを使う店を確かめられないため、今は行き先を分けられません')
  fireEvent.click(toggle())
  expect(onChange).not.toHaveBeenCalled()
  // この店だけと確かめられたらオンにできる（対照）。
  rerender(<RoutingSection blocks={blocks} refs={{} as never} routing={off} stores="single" onChange={onChange} />)
  expect(toggle().disabled).toBe(false)
  expect(document.getElementById('fe-routing-stores')).toBeNull()
  fireEvent.click(toggle())
  expect(onChange.mock.calls[0][0].enabled).toBe(true)
  // すでに分けている行き先は、確かめられない時もオフにできる（保存の検査に任せ、止めない）。
  rerender(<RoutingSection blocks={blocks} refs={{} as never} routing={{enabled:true,rules:[],fallback:{menuId:'m'}}} stores="unknown" onChange={onChange} />)
  expect(document.getElementById('fe-routing-stores')).toBeNull()
  fireEvent.click(toggle())
  expect(onChange.mock.calls[1][0].enabled).toBe(false)
})

// 質問名と答えは同じ段に置く。狭いときは質問名だけを1行で省略し、全文は title に残す。
it('条件の質問名は答えの欄と同じ段に置き、省略されても全文を title に残す', () => {
  const longLabel='今日のご来店の目的を、いちばん近いものからひとつ選んでください'
  const blocks=[
    {id:'q',kind:'input',type:'radio',name:'purpose',label:longLabel,choices:[{id:'x',label:'ご相談'},{id:'y',label:'トリミング'}]},
    {id:'r',kind:'input',type:'rating',name:'score',label:'担当の対応はいかがでしたか？'},
    {id:'book',kind:'input',type:'booking'},
  ] as never
  const routing={enabled:true,rules:[{conditions:[{questionId:'q',op:'is' as const,value:'ご相談'},{questionId:'r',op:'between' as const,value:[3,5]}],target:{menuId:'m'}}],fallback:{menuId:'m'}}
  const refs={bookingMenus:[{id:'m',name:'シャンプーとカットのセット（大型犬・長毛）',durationMinutes:150}]} as never
  const {rerender}=render(<RoutingSection blocks={blocks} refs={refs} routing={routing} onChange={() => {}} />)
  const line=(label:string) => screen.getByTitle(label).parentElement!
  // 質問名の後ろに「：」を足さず、全文を title に入れる。
  expect(screen.getByTitle(longLabel).textContent).toBe(longLabel)
  const question=line(longLabel)
  expect(question.contains(screen.getByRole('button',{name:'1 行目の条件 1 の答え'}))).toBe(true)
  expect(question.contains(screen.getByRole('button',{name:'1 行目の条件 1 を外す'}))).toBe(true)
  const range=line('担当の対応はいかがでしたか？')
  expect(range).not.toBe(question)
  expect(range.contains(screen.getByRole('button',{name:'1 行目の範囲の始まり'}))).toBe(true)
  expect(range.contains(screen.getByRole('button',{name:'1 行目の範囲の終わり'}))).toBe(true)
  // どれにも当たらない行も同じ形の段に置き、行の高さをそろえる。
  const fallback=line('どれにも当たらない')
  expect(fallback.textContent).toContain('消せない')
  expect(fallback.className).toBe(question.className)
  // 閲覧のみでも、質問名と答えは同じ段。行き先の名前も1行で省略し、全文を title に残す。
  rerender(<RoutingSection blocks={blocks} refs={refs} routing={routing} readOnly onChange={() => {}} />)
  expect(line(longLabel).textContent).toBe(`${longLabel}〈ご相談〉`)
  expect(screen.getAllByTitle('シャンプーとカットのセット（大型犬・長毛）')).toHaveLength(2)
})
