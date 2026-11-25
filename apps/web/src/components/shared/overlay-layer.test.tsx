// @vitest-environment happy-dom
/*
 * 窓の上に開いた引き出し・窓は、後ろに回らず前に出る（共通の Dialog・Drawer・準備中の窓）。
 * 画面ごとに z-index を書かず、開いた順に番号を持つ。
 */
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Dialog from './dialog'
import Drawer from './drawer'
import PreparingDialog from './preparing-dialog'
import MenuPortal from './menu-portal'
import Select from './select'
import DateField from './date-field'

afterEach(cleanup)

const layerOf = (name: string) => {
  const panel = screen.getByRole('dialog', { name })
  return Number((panel.closest('[role="presentation"]') as HTMLElement).style.zIndex)
}

function DialogThenDrawer() {
  const [drawer, setDrawer] = useState(false)
  return <>
    <Dialog open title="顧客情報" onCancel={() => {}}><button type="button" onClick={() => setDrawer(true)}>引き出しを開く</button></Dialog>
    <Drawer open={drawer} title="配信の受け取り" onClose={() => setDrawer(false)} />
  </>
}

function DrawerThenDialog() {
  const [dialog, setDialog] = useState(false)
  return <>
    <Drawer open title="引き出し" onClose={() => {}}><button type="button" onClick={() => setDialog(true)}>窓を開く</button></Drawer>
    <Dialog open={dialog} title="確かめの窓" onCancel={() => setDialog(false)} />
  </>
}

describe('後から開いた窓・引き出しが前に出る', () => {
  it('通知のような既存のポータル小窓は、新しいモーダルが開くと閉じる', async () => {
    function Both() {
      const [panel, setPanel] = useState(false)
      const [dialog, setDialog] = useState(false)
      const anchor = React.useRef<HTMLButtonElement>(null)
      return <>
        <button ref={anchor} type="button" onClick={() => setPanel(true)}>通知を開く</button>
        <button type="button" onClick={() => setDialog(true)}>設定を開く</button>
        <MenuPortal open={panel} getAnchor={() => anchor.current} onClose={() => setPanel(false)}>
          <section role="dialog" aria-label="通知パネル">通知</section>
        </MenuPortal>
        <Dialog open={dialog} title="設定" onCancel={() => setDialog(false)} />
      </>
    }
    render(<Both />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '通知を開く' })) })
    expect(screen.getByRole('dialog', { name: '通知パネル' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '設定を開く' })) })
    expect(screen.getByRole('dialog', { name: '設定' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '通知パネル' })).toBeNull()
  })

  it('窓の上に開いた引き出しは、窓より前', async () => {
    render(<DialogThenDrawer />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '引き出しを開く' })) })
    expect(layerOf('配信の受け取り')).toBeGreaterThan(layerOf('顧客情報'))
  })
  it('引き出しの上に開いた窓は、引き出しより前', async () => {
    render(<DrawerThenDialog />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '窓を開く' })) })
    expect(layerOf('確かめの窓')).toBeGreaterThan(layerOf('引き出し'))
  })
  it('窓の上に出した準備中の窓は、窓より前', async () => {
    function Both() {
      const [on, setOn] = useState(false)
      return <><Dialog open title="詳細条件" onCancel={() => {}}><button type="button" onClick={() => setOn(true)}>準備中を開く</button></Dialog><PreparingDialog open={on} feature="来店の回数での絞り込み" onClose={() => setOn(false)} /></>
    }
    render(<Both />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '準備中を開く' })) })
    expect(layerOf('現在準備中です')).toBeGreaterThan(layerOf('詳細条件'))
  })
})


it('モーダルを先に開いた時は外の通知を開かず、窓内の選ぶメニューだけ使える',async()=>{
 function Trigger({name}: {name:string}) {
  const [open,setOpen]=useState(false),anchor=React.useRef<HTMLButtonElement>(null)
  return <><button ref={anchor} onClick={()=>setOpen(true)}>{name}</button>
    <MenuPortal open={open} getAnchor={()=>anchor.current} onClose={()=>setOpen(false)}><section role="menu" aria-label={name+'の内容'}>候補</section></MenuPortal></>
 }
 render(<><Trigger name="通知を開く"/><Dialog open title="設定" onCancel={()=>{}}><Trigger name="窓内で選ぶ"/></Dialog></>)
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'通知を開く'}))})
 expect(screen.queryByRole('menu',{name:'通知を開くの内容'})).toBeNull()
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'窓内で選ぶ'}))})
 expect(screen.getByRole('menu',{name:'窓内で選ぶの内容'})).toBeTruthy()
})


it('手作りのモーダル内では選択欄・日付欄を開け、外の通知は拒否する', async () => {
  function ManualModal() {
    const [open, setOpen] = useState(false)
    const anchor = React.useRef<HTMLButtonElement>(null)
    return <>
      <button ref={anchor} onClick={() => setOpen(true)}>外の通知</button>
      <MenuPortal open={open} getAnchor={() => anchor.current} onClose={() => setOpen(false)}>
        <section role="menu" aria-label="外の通知の内容">通知</section>
      </MenuPortal>
      <section role="dialog" aria-modal="true" aria-label="手作りの絞り込み">
        <Select aria-label="手作り窓の選択" value="a" onChange={() => {}} options={[{ value: 'a', label: 'すべて' }, { value: 'b', label: '未対応' }]} />
        <DateField aria-label="手作り窓の日付" value="2026-10-30" onChange={() => {}} />
      </section>
    </>
  }
  render(<ManualModal />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '外の通知' })) })
  expect(screen.queryByRole('menu', { name: '外の通知の内容' })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '手作り窓の選択' })) })
  expect(screen.getByRole('listbox')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: '未対応' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '手作り窓の日付' })) })
  expect(screen.getByRole('dialog', { name: '日付を選ぶ' })).toBeTruthy()
  expect(screen.getAllByRole('gridcell')).toHaveLength(42)
})

it('引き出し内の窓の後に開く全画面の窓も一番前に出る', async () => {
 function Both() {
  const [nested,setNested]=useState(false),[global,setGlobal]=useState(false)
  return <><Drawer open title="引き出し" onClose={()=>{}}><Dialog open={nested} title="引き出し内の窓" onCancel={()=>setNested(false)} /><button onClick={()=>setNested(true)}>子を開く</button></Drawer>
    <button onClick={()=>setGlobal(true)}>全画面の窓を開く</button><Dialog open={global} title="全画面の窓" onCancel={()=>setGlobal(false)} /></>
 }
 render(<Both />)
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'子を開く'})))
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'全画面の窓を開く'})))
 expect(layerOf('全画面の窓')).toBeGreaterThan(layerOf('引き出し内の窓'))
})
