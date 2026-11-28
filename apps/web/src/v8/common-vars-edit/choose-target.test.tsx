// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('@/lib/api',()=>({api:{commonVars:{list:net.list}}}))
vi.mock('next/link',()=>({default:({children,href}: {children:React.ReactNode;href:string})=><a href={href}>{children}</a>}))
import ChooseTarget from './choose-target'
beforeEach(()=>net.list.mockResolvedValue({success:true,data:[{id:'target-a',name:'営業時間'}]}))
afterEach(cleanup)
it('戻る道と選ぶ窓を出し、確認した対象を正規URLの移動処理へ渡す',async()=>{
 const select=vi.fn();render(<ChooseTarget accountId="account-a" onSelect={select}/>)
 expect(screen.getByRole('link',{name:'共通情報一覧へ戻る'}).getAttribute('href')).toBe('/contents/vars')
 fireEvent.click(screen.getByRole('button',{name:'編集する共通情報を選択する'}))
 fireEvent.click(await screen.findByRole('radio',{name:/営業時間/}))
 fireEvent.click(screen.getByRole('button',{name:'編集する'}))
 expect(select).toHaveBeenCalledWith('target-a');expect(net.list).toHaveBeenCalledWith('account-a')
})
it('失敗を空件数にせず、窓の中で読み直せる',async()=>{
 net.list.mockRejectedValueOnce(new Error('offline'))
 render(<ChooseTarget accountId="account-a" onSelect={()=>{}}/>)
 fireEvent.click(screen.getByRole('button',{name:'編集する共通情報を選択する'}))
 await screen.findByText('共通情報を読み込めませんでした')
 fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}))
 await screen.findByRole('radio',{name:/営業時間/})
 expect(net.list).toHaveBeenCalledTimes(2)
})
it('店舗を替えたら古い応答を選べない',async()=>{
 let resolve!: (data:unknown)=>void;net.list.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
 const select=vi.fn(),view=render(<ChooseTarget accountId="account-a" onSelect={select}/>)
 fireEvent.click(screen.getByRole('button',{name:'編集する共通情報を選択する'}))
 view.rerender(<ChooseTarget accountId="account-b" onSelect={select}/>)
 await screen.findByRole('radio',{name:/営業時間/})
 await act(async()=>resolve({success:true,data:[{id:'old',name:'前の店舗'}]}))
 expect(screen.queryByText('前の店舗')).toBeNull()
})
