// @vitest-environment happy-dom
import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}))

import ActionMenu from './action-menu'
import CommandPalette from './command-palette'
import Dialog from './dialog'

/*
 * 動きの点検（2026-10-07）2・3 番：
 * - 行の「…」メニューを開くと、最初の項目へフォーカスが入り、↑↓・Home・End で動き、
 *   Esc・Tab で閉じて開いたボタンへ戻る（WAI-ARIA のメニューの決まり）。
 * - メニューから開いた窓・⌘K を閉じると、フォーカスは BODY ではなく開いたボタンへ戻る。
 */

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
})

function RowMenu({ withDialog = false }: { withDialog?: boolean }) {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button type="button">前のボタン</button>
      <button ref={anchorRef} type="button" aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        行「A」の操作
      </button>
      <ActionMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        items={[
          { id: 'edit', label: '編集する', onSelect: () => undefined },
          { id: 'copy', label: '複製する', onSelect: () => undefined },
          { id: 'off', label: '止める', disabled: true, onSelect: () => undefined },
          { id: 'delete', label: '削除する', tone: 'danger', onSelect: () => (withDialog ? setDialog(true) : undefined) },
        ]}
      />
      <button type="button">次のボタン</button>
      <Dialog open={dialog} title="削除しますか" onCancel={() => setDialog(false)} onConfirm={() => setDialog(false)} />
    </div>
  )
}

const opener = () => screen.getByRole('button', { name: '行「A」の操作' })
const item = (name: string) => screen.getByRole('menuitem', { name })

async function openMenu() {
  opener().focus()
  fireEvent.click(opener())
  await waitFor(() => expect(document.activeElement).toBe(item('編集する')))
}

describe('行の「…」メニューのキーボード操作', () => {
  it('開くと最初の項目へフォーカスが入る', async () => {
    render(<RowMenu />)
    await openMenu()
  })

  it('↓↑・Home・End で項目を移る（押せない項目は飛ばす）', async () => {
    render(<RowMenu />)
    await openMenu()
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('複製する'))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('削除する'))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('編集する'))
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('削除する'))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(item('編集する'))
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(item('削除する'))
  })

  it('Esc で閉じて、開いたボタンへ戻る', async () => {
    render(<RowMenu />)
    await openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(opener())
  })

  it('Tab で閉じる（フォーカスは開いたボタンを起点に進む）', async () => {
    render(<RowMenu />)
    await openMenu()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(opener())
  })

  it('メニューから開いた窓を閉じると、メニューを開いたボタンへ戻る', async () => {
    render(<RowMenu withDialog />)
    await openMenu()
    fireEvent.click(item('削除する'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '削除しますか' })).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener())
  })
})

function WrappedMenu() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      {/* 右クリックのメニュー（ContextMenu）で囲んだ形。位置の基準は囲みになる。 */}
      <span data-wrapper="">
        <button type="button" onClick={() => setOpen((v) => !v)}>囲みの中の操作</button>
      </span>
      <ActionMenu open={open} onClose={() => setOpen(false)} items={[{ id: 'a', label: '編集する', onSelect: () => undefined }]} />
    </div>
  )
}

describe('開くボタンが囲みの中にあるとき', () => {
  it('Esc で閉じると、囲みではなく中の開くボタンへ戻る', async () => {
    render(<WrappedMenu />)
    const button = screen.getByRole('button', { name: '囲みの中の操作' })
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(document.activeElement).toBe(item('編集する')))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(button)
  })
})

describe('⌘K を閉じたあとのフォーカス', () => {
  it('Esc で閉じると、開く前にいたボタンへ戻る', async () => {
    document.documentElement.dataset.theme = 'v8'
    render(<div><button type="button">失敗を見る</button><CommandPalette items={[{ href: '/a', label: 'あ' }]} /></div>)
    const before = screen.getByRole('button', { name: '失敗を見る' })
    before.focus()
    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }) })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '機能と友だちを探す' })))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(before))
  })

  it('候補へ Tab で移ってから Esc で閉じても、開く前のボタンへ戻る', async () => {
    document.documentElement.dataset.theme = 'v8'
    render(<div><button type="button">失敗を見る</button><CommandPalette items={[{ href: '/a', label: 'あ' }, { href: '/b', label: 'い' }]} /></div>)
    const before = screen.getByRole('button', { name: '失敗を見る' })
    before.focus()
    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }) })
    await waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'))
    screen.getByRole('option', { name: 'い' }).focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(before))
  })
})
