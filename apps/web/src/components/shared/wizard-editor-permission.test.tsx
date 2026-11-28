// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ActionList, { ActionAddButton, type ActionChoice } from './action-list'
import ReorderHandle from './reorder-handle'
import ConditionBuilder from './condition-builder'
import ActionRows from './action-rows'

const network = vi.hoisted(() => ({ tags: vi.fn(), scenarios: vi.fn(), count: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account' }) }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false, status: 'ready' }) }))
vi.mock('@/lib/api', async original => {
 const actual = await original<typeof import('@/lib/api')>()
 return { ...actual, api: { ...actual.api, tags: { ...actual.api.tags, list: network.tags }, scenarios: { ...actual.api.scenarios, list: network.scenarios }, segments: { ...actual.api.segments, count: network.count } } }
})
const reason = '閲覧のみのため変更できません。'
type Item = { id: string; text: string }
const initial: Item[] = [{ id: 'a', text: '最初の処理' }, { id: 'b', text: '次の処理' }]
const choices: ActionChoice<Item>[] = [{ id: 'text', label: 'テキストを送る', make: () => ({ id: 'new', text: '新しい処理' }) }]
function List({ lockedReason, disabled, onChange, appearance = 'inline' }: { lockedReason?: string; disabled?: boolean; onChange: (items: Item[]) => void; appearance?: 'inline' | 'numbered' }) {
 return <ActionList value={initial} onChange={onChange} choices={choices} idOf={item => item.id} titleOf={item => item.text} duplicateOf={item => ({ ...item, id: 'copy' })} lockedReason={lockedReason} disabled={disabled} appearance={appearance}
  renderEditor={(item, update) => <input aria-label="本文" value={item.text} onChange={event => update({ ...item, text: event.target.value })} />} />
}
beforeEach(() => {
 vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
 network.tags.mockResolvedValue({ success: true, data: [] }); network.scenarios.mockResolvedValue({ success: true, data: [] }); network.count.mockResolvedValue({ success: true, count: 3 })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers() })

it('権限のつまみは図柄/焦点/理由/属性を残し、マウス・キー・ドラッグと親の起動0', () => {
 const move=vi.fn(), pointer=vi.fn(), mouse=vi.fn(), touch=vi.fn(), drag=vi.fn(), key=vi.fn(), up=vi.fn()
 render(<div onPointerDown={pointer} onMouseDown={mouse} onTouchStart={touch}><ReorderHandle label="処理" lockedReason={reason} onMove={move} onPointerUp={up} onPointerDown={pointer} onDragStart={drag} onKeyDown={key} draggable data-count="2" aria-describedby="before" /></div>)
 const button=screen.getByRole('button') as HTMLButtonElement
 expect(button.disabled).toBe(false); expect(button.getAttribute('draggable')).toBe('false'); expect(button.querySelector('svg')).not.toBeNull()
 expect(button.getAttribute('data-count')).toBe('2'); expect(button.getAttribute('aria-describedby')?.split(' ')[0]).toBe('before')
 fireEvent.focus(button); expect(screen.getByRole('tooltip').textContent).toBe(reason)
 fireEvent.click(button); fireEvent.doubleClick(button); fireEvent.pointerDown(button); fireEvent.pointerUp(button); fireEvent.mouseDown(button); fireEvent.touchStart(button); fireEvent.dragStart(button)
 for(const value of ['ArrowUp','ArrowDown','Enter',' '])fireEvent.keyDown(button,{key:value})
 for(const callback of [move,pointer,mouse,touch,drag,key,up])expect(callback).not.toHaveBeenCalled()
})

it.each(['inline','numbered'] as const)('%sの追加/削除/並びを理由付きで残し、設定は同じ欄を読める', appearance => {
 const change=vi.fn(); const view=render(<List onChange={change} lockedReason={reason} appearance={appearance} />)
 const add=screen.getByRole('button',{name:'行うことを足す'}) as HTMLButtonElement
 expect(add.disabled).toBe(false); expect(add.getAttribute('aria-disabled')).toBe('true');fireEvent.click(add)
 expect(screen.queryByRole('menu')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:appearance==='inline'?'最初の処理':/1.*最初の処理/}))
 const input=screen.getByRole('textbox',{name:'本文'}) as HTMLInputElement
 expect(input.closest('fieldset')?.disabled).toBe(true)
 fireEvent.change(input,{target:{value:'変えようとした内容'}});expect(change).not.toHaveBeenCalled()
 if(appearance==='inline'){
  fireEvent.click(screen.getByRole('button',{name:'1つ目の行うことのその他操作'}))
  for(const label of ['削除する','複製する','下へ']){
   const item=screen.getByRole('menuitem',{name:label});expect(item.getAttribute('aria-disabled')).toBe('true');fireEvent.click(item)
  }
  expect(screen.queryByRole('dialog')).toBeNull()
 }else{
  fireEvent.click(screen.getByRole('button',{name:'1つ目の処理を下へ'}));fireEvent.click(screen.getByRole('button',{name:'1つ目の処理を削除する'}))
  expect(screen.queryByRole('dialog')).toBeNull()
 }
 expect(change).not.toHaveBeenCalled()
 view.rerender(<List onChange={change} appearance={appearance} />)
 fireEvent.click(screen.getByRole('button',{name:'行うことを足す'}));fireEvent.click(screen.getByRole('menuitem',{name:'テキストを送る'}))
 expect(change).toHaveBeenCalledTimes(1)
})

it('未知disabledは権限理由0で操作を止め、既存の入力値は保つ', () => {
 const change=vi.fn();render(<List onChange={change} disabled />)
 expect((screen.getByRole('button',{name:'行うことを足す'}) as HTMLButtonElement).disabled).toBe(true)
 expect(document.querySelector('[data-permission-locked]')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'最初の処理'}));const input=screen.getByRole('textbox',{name:'本文'}) as HTMLInputElement
 expect(input.value).toBe('最初の処理');fireEvent.change(input,{target:{value:'別の値'}});expect(change).not.toHaveBeenCalled()
})

it('選ぶ窓の確定を保持しても、ロックへ変わったら追加0で閉じ、解除しても窓を復活させない', () => {
 const add=vi.fn();let confirm: ((ids:string[])=>void) | undefined
 const picker:ActionChoice<Item>[]=[{...choices[0],picker:{title:'選ぶ',items:[],apply:item=>item,render:props=>{confirm=props.onConfirm;return <div role="dialog">選択中</div>}}}]
 const view=render(<ActionAddButton choices={picker} onAdd={add} />)
 fireEvent.click(screen.getByRole('button',{name:'行うことを足す'}));fireEvent.click(screen.getByRole('menuitem',{name:'テキストを送る'}))
 expect(screen.getByRole('dialog')).toBeTruthy();const held=confirm!
 view.rerender(<ActionAddButton choices={picker} onAdd={add} lockedReason={reason} />)
 act(()=>held(['id']));expect(add).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull()
 view.rerender(<ActionAddButton choices={picker} onAdd={add} />);expect(screen.queryByRole('dialog')).toBeNull()
})

it('条件の入力/変更は止めても、候補GETの再読込と人数の読取を残す', async () => {
 network.tags.mockRejectedValueOnce(new Error('network'))
 const change=vi.fn(); const value={operator:'AND' as const,rules:[{type:'name',value:{text:'確認',targets:['display']}}],groups:[]}
 const view=render(<ConditionBuilder value={value} onChange={change} lockedReason={reason} />)
 await act(async()=>{});expect(screen.getByRole('button',{name:'読み直す'})).toBeTruthy()
 const input=screen.getByRole('textbox',{name:'名前に含む文字'}) as HTMLInputElement
 expect(input.value).toBe('確認');expect(input.closest('fieldset')?.disabled).toBe(true)
 fireEvent.change(input,{target:{value:'別の値'}});fireEvent.click(screen.getByRole('button',{name:'この条件を外す'}));fireEvent.click(screen.getByRole('button',{name:'追加する条件を選択する'}))
 expect(change).not.toHaveBeenCalled();expect(screen.queryByRole('dialog')).toBeNull()
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'読み直す'}))})
 expect(network.tags).toHaveBeenCalledTimes(2)
 await act(async()=>{await vi.advanceTimersByTimeAsync(450)})
 expect(network.count).toHaveBeenCalled();expect(screen.getByText('3 人')).toBeTruthy()
 view.rerender(<ConditionBuilder value={value} onChange={change} />)
 fireEvent.change(screen.getByRole('textbox',{name:'名前に含む文字'}),{target:{value:'通常の変更'}})
 expect(change).toHaveBeenCalledTimes(1)
})

it('自動応答の行うことwrapperも同じ権限口を転送し、候補の再読込は止めない', () => {
 const change=vi.fn(), retry=vi.fn()
 render(<ActionRows actions={[{key:'action',actionType:'send_message',config:{content:'確認の本文'},onFailure:'continue'}]} onChange={change} tags={[]} fields={[]} marks={[]} scenarios={[]} vars={[]} lockedReason={reason} targetsError="候補を読み込めませんでした" retryTargets={retry} />)
 const add=screen.getByRole('button',{name:'行うことを足す'})
 expect(add.getAttribute('aria-disabled')).toBe('true');fireEvent.click(add)
 fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}))
 expect(retry).toHaveBeenCalledTimes(1);expect(change).not.toHaveBeenCalled()
})
