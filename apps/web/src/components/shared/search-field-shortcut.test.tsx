// @vitest-environment happy-dom
import React from 'react'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import SearchField from './search-field'
import CommandPalette from './command-palette'
import Button from './button'
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),prefetch:vi.fn()}),usePathname:()=>'/'}))
afterEach(()=>{cleanup();delete document.documentElement.dataset.theme})
it('古い指定があっても ⌘K は探す窓だけを開く',()=>{
 document.documentElement.dataset.theme='v8'
 render(<><SearchField aria-label="友だちを探す" value="" onChange={()=>{}} shortcut="⌘K"/><CommandPalette items={[{href:'/friends',label:'友だち'}]}/></>)
 expect(screen.queryByText('⌘K')).toBeNull()
 fireEvent.keyDown(document.body,{key:'k',metaKey:true})
 expect(screen.getByRole('dialog',{name:'機能と友だちを探す'})).toBeTruthy()
 expect(document.activeElement).not.toBe(screen.getByLabelText('友だちを探す'))
})
it('窓が無い所でも探す欄は Ctrl+K を奪わない',()=>{
 render(<SearchField aria-label="友だちを探す" value="" onChange={()=>{}} shortcut="⌘K"/>)
 fireEvent.keyDown(document.body,{key:'k',ctrlKey:true})
 expect(document.activeElement).not.toBe(screen.getByLabelText('友だちを探す'))
})
it('変換中・別の合図では窓を開かない',()=>{
 document.documentElement.dataset.theme='v8';render(<CommandPalette items={[]}/>)
 for(const flags of [{isComposing:true},{altKey:true},{shiftKey:true}])fireEvent.keyDown(document,{key:'k',metaKey:true,...flags})
 expect(screen.queryByRole('dialog')).toBeNull()
})
it('図柄だけの操作は title を読み上げ名にし、文字の操作の名前は保つ',()=>{
 const clicked=vi.fn();render(<><Button title="項目を削除" onClick={clicked}><svg aria-hidden="true"/></Button><Button title="詳しい補足">保存</Button></>)
 const icon=screen.getByRole('button',{name:'項目を削除'});expect(icon.getAttribute('aria-label')).toBe('項目を削除');fireEvent.click(icon);expect(clicked).toHaveBeenCalledOnce()
 expect(screen.getByRole('button',{name:'保存'}).hasAttribute('aria-label')).toBe(false)
})
