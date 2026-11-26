// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, prefetch: vi.fn() }),
}))

import CommandPalette from './command-palette'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'

/* 書きかけの画面の代わり。未保存の確認を待つ間の状態を見せ、「保存せずに移る」を押せる。 */
function DirtyScreen() {
  const guard = useUnsavedGuard({ dirty: true })
  return guard.leaveTarget ? <button type="button" onClick={guard.confirmLeave}>保存せずに移る</button> : null
}

const items = [
  { href: '/broadcasts', label: '一斉配信', section: '配信' },
  { href: '/templates', label: 'テンプレート', section: '配信' },
  { href: '/friends', label: '友だち', section: '友だち' },
]

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

beforeEach(() => {
  push.mockClear()
  window.history.replaceState(null, '', '/')
  document.documentElement.dataset.theme = 'v8'
})

function openPalette() {
  fireEvent.keyDown(document, { key: 'k', metaKey: true })
}

describe('CommandPalette（探す窓・F②）', () => {
  it('⌘K で開き、Esc で閉じる', () => {
    render(<CommandPalette items={items} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openPalette()
    expect(screen.getByRole('dialog', { name: '機能と友だちを探す' })).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Ctrl+K でも開く（Windows）', () => {
    render(<CommandPalette items={items} />)
    fireEvent.keyDown(document, { key: 'K', ctrlKey: true })
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('古いDOMの値で現役の探す窓を止めない', () => {
    document.documentElement.dataset.theme = 'v7'
    render(<CommandPalette items={items} />)
    openPalette()
    expect(screen.getByRole('dialog', { name: '機能と友だちを探す' })).not.toBeNull()
  })

  it('名前で絞り、Enter で行く', () => {
    render(<CommandPalette items={items} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), {
      target: { value: 'テンプレ' },
    })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(push).toHaveBeenCalledWith('/templates')
  })

  it('文字を入れると友だちを探す行が出て、友だち一覧の受け口へ送る', () => {
    render(<CommandPalette items={items} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), {
      target: { value: '山田' },
    })
    fireEvent.click(screen.getByRole('option', { name: '友だちを探す「山田」' }))
    expect(push).toHaveBeenCalledWith('/friends?q=%E5%B1%B1%E7%94%B0')
  })

  it('テンプレートが見える人には検索の行を出し、言葉をURLに安全に渡す', () => {
    render(<CommandPalette items={items} />)
    openPalette()
    const input = screen.getByRole('textbox', { name: '機能と友だちを探す' })
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.queryByRole('option', { name: /メッセージのテンプレートを探す「/ })).toBeNull()
    fireEvent.change(input, { target: { value: '  予約 & お知らせ  ' } })
    fireEvent.click(screen.getByRole('option', { name: 'メッセージのテンプレートを探す「予約 & お知らせ」' }))
    expect(push).toHaveBeenCalledWith('/templates?q=%E4%BA%88%E7%B4%84%20%26%20%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B')
  })

  it('テンプレートの入口が見えない人にはテンプレート検索を出さない', () => {
    render(<CommandPalette items={[{ href: '/friends', label: '友だち' }]} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), { target: { value: '予約' } })
    expect(screen.queryByRole('option', { name: /メッセージのテンプレートを探す/ })).toBeNull()
  })

  it('テンプレート一覧で検索をやり直すとURLと一覧へ変更を伝える', () => {
    window.history.replaceState(null, '', '/templates?q=old&tab=question')
    const onLocation = vi.fn()
    window.addEventListener('popstate', onLocation)
    try {
      render(<CommandPalette items={items} />)
      openPalette()
      fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), { target: { value: '予約' } })
      fireEvent.click(screen.getByRole('option', { name: 'メッセージのテンプレートを探す「予約」' }))
      expect(window.location.pathname).toBe('/templates')
      expect(new URLSearchParams(window.location.search).get('q')).toBe('予約')
      expect(new URLSearchParams(window.location.search).get('tab')).toBeNull()
      expect(onLocation).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener('popstate', onLocation) }
  })

  it('テンプレート検索も未保存の確認を通す', () => {
    render(<><DirtyScreen /><CommandPalette items={items} /></>)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), { target: { value: '予約' } })
    fireEvent.click(screen.getByRole('option', { name: 'メッセージのテンプレートを探す「予約」' }))
    expect(push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
    expect(push).toHaveBeenCalledWith('/templates?q=%E4%BA%88%E7%B4%84')
  })

  it('書きかけの画面では、選んでもすぐ移らず未保存の確認を通す', () => {
    render(<><DirtyScreen /><CommandPalette items={items} /></>)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), {
      target: { value: 'テンプレ' },
    })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
    expect(push).toHaveBeenCalledWith('/templates')
  })

  it('日本語の変換を確定する Enter では行き先へ飛ばない', () => {
    render(<CommandPalette items={items} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), {
      target: { value: 'てんぷれ' },
    })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', isComposing: true })
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).not.toBeNull()
  })
})

it('WEB-008/240: 日本語変換中のEscapeはパレットも閉じない', () => {
  render(<CommandPalette items={items} />)
  openPalette()
  fireEvent.keyDown(screen.getByRole('textbox', { name: '機能と友だちを探す' }), { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog')).toBeTruthy()
})
