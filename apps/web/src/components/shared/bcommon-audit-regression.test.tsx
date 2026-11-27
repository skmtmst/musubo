// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Tabs } from './tabs'
import ReorderHandle from './reorder-handle'
import TemplateFolderSelect from '../chats/template-folder-select'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme') })

it('WEB-046: 後から変わったタブの幅に下線を合わせる', async () => {
  document.documentElement.dataset.theme = 'v8'
  let resize: ResizeObserverCallback
  const targets = new Set<Element>()
  const unobserve = vi.fn((target: Element) => { targets.delete(target) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe(target: Element) { targets.add(target) }
    unobserve = unobserve
    disconnect() {}
  })
  let tabWidth = 80
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: 0, width: this.getAttribute('role') === 'tab' ? tabWidth : 300, height: 20 } as DOMRect
  })
  const view = render(<Tabs items={[{ label: '会員', count: 1, current: true }]} />)
  await act(async () => { await Promise.resolve() })
  expect(view.container.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('width: 80px')
  const tab = screen.getByRole('tab')
  tabWidth = 108
  const entries = [...targets].map(target => ({ target, contentRect: target.getBoundingClientRect(),
    borderBoxSize: [{ inlineSize: target.getBoundingClientRect().width, blockSize: 20 }], contentBoxSize: [], devicePixelContentBoxSize: [],
  }))
  await act(async () => { resize(entries, {} as ResizeObserver); await Promise.resolve() })
  expect(view.container.querySelector('[aria-hidden="true"]')?.getAttribute('style')).toContain('width: 108px')
  view.unmount()
  expect(unobserve).toHaveBeenCalledWith(tab)
})

it('WEB-019: マウスの移動口が無いつまみは出さない', () => {
  document.documentElement.dataset.theme = 'v8'
  render(<ReorderHandle label="行" onMove={vi.fn()} />)
  expect(screen.queryByRole('button', { name: /行を並び替え/ })).toBeNull()
})

it('WEB-019: 接続済みのマウスの移動口は保つ', () => {
  document.documentElement.dataset.theme = 'v8'
  render(<ReorderHandle label="行" onPointerDown={vi.fn()} />)
  expect(screen.getByRole('button', { name: /行を並び替え/ })).toBeTruthy()
})

it('フォルダ候補への焦点移動で閉じず、確定するまで絞り込みを保つ', () => {
  const change=vi.fn()
  render(<TemplateFolderSelect value="" status="ready" options={[{ value: '', label: 'すべて', count: 1 }]} onChange={change} />)
  const trigger = screen.getByRole('button', { name: 'テンプレートのフォルダ' })
  fireEvent.click(trigger)
  const option = screen.getByRole('radio', { name: /すべて/ })
  fireEvent.blur(trigger, { relatedTarget: option })
  expect(screen.queryByRole('dialog')).toBeTruthy()
  fireEvent.click(option)
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'キャンセル',exact:true}))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('WEB-019: 薄くする指定でも未接続のつまみは見せない', () => {
  document.documentElement.dataset.theme = 'v8'
  const view = render(<ReorderHandle label="行" disabledLook="dim" />)
  expect(view.container.querySelector('[data-reorder-disabled]')).toBeTruthy()
})

it('フォルダを確定した時だけ元のIDを返し、すべても空のIDで選び直せる', () => {
  const change=vi.fn(), options=[{value:'',label:'すべて',count:3},{value:'案内/"親"',label:'案内',count:2,depth:1}]
  const view=render(<TemplateFolderSelect value="" status="ready" options={options} onChange={change} />)
  fireEvent.click(screen.getByRole('button',{name:'テンプレートのフォルダ'}))
  fireEvent.click(screen.getByRole('radio',{name:'案内 2'}))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'選択する',exact:true}))
  expect(change).toHaveBeenLastCalledWith('案内/"親"')
  view.rerender(<TemplateFolderSelect value={'案内/"親"'} status="ready" options={options} onChange={change} />)
  fireEvent.click(screen.getByRole('button',{name:'テンプレートのフォルダ'}))
  fireEvent.click(screen.getByRole('radio',{name:'すべて 3'}))
  fireEvent.click(screen.getByRole('button',{name:'選択する',exact:true}))
  expect(change).toHaveBeenLastCalledWith('')
})

it('WEB-019: つまみの親でマウスのドラッグが接続されていれば上下キーも保つ', () => {
  document.documentElement.dataset.theme = 'v8'
  const drag = vi.fn()
  const move = vi.fn()
  render(<span draggable onDragStart={drag}><ReorderHandle label="親で動く行" onMove={move} /></span>)
  const handle = screen.getByRole('button', { name: /親で動く行を並び替え/ })
  fireEvent.dragStart(handle)
  expect(drag).toHaveBeenCalledOnce()
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(move).toHaveBeenCalledWith(1)
})
