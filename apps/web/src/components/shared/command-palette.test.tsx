// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
const replace = vi.fn()
const accountState = vi.hoisted(() => ({ value: null as null | { accounts: Array<{ id: string; name: string; displayName?: string; archivedAt?: string | null }>; selectedAccountId: string; setSelectedAccountId: ReturnType<typeof vi.fn> } }))
const resolveEntry = vi.hoisted(() => vi.fn())
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => accountState.value }))
vi.mock('@/lib/line-account-entry', () => ({ resolveLineAccountEntry: resolveEntry }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
  usePathname: () => window.location.pathname,
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
  replace.mockClear()
  accountState.value = null
  resolveEntry.mockReset()
  window.history.replaceState(null, '', '/')
  document.documentElement.dataset.theme = 'v8'
})

function openPalette() {
  fireEvent.keyDown(document, { key: 'k', metaKey: true })
}

describe('CommandPalette（探す窓・F②）', () => {
  it('許可された受信箱に検索語を渡し、入口が無い場合は候補を出さない', () => {
    const view = render(<CommandPalette items={[{ href: '/chats', label: '受信箱' }]} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '山田 & 花' } })
    fireEvent.click(screen.getByRole('option', { name: 'トークの相手を探す「山田 & 花」' }))
    expect(push).toHaveBeenCalledWith('/chats?q=%E5%B1%B1%E7%94%B0%20%26%20%E8%8A%B1')
    view.unmount()
    render(<CommandPalette items={[]} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '山田' } })
    expect(screen.queryByRole('option', { name: /友だちを探す|トークの相手を探す|テンプレートを探す/ })).toBeNull()
  })

  it('表示できる店舗のみ切り替え候補に出す', () => {
    const select = vi.fn()
    accountState.value = { accounts: [{ id: 'a', name: '本店' }, { id: 'b', name: '支店' }, { id: 'x', name: '終了店', archivedAt: '2026-01-01' }], selectedAccountId: 'a', setSelectedAccountId: select }
    render(<CommandPalette items={[]} />)
    openPalette()
    expect(screen.queryByRole('option', { name: /本店|終了店/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    expect(select).toHaveBeenCalledWith('b')
  })
  it('書きかけがあると店舗切替の前に確認する', () => {
    const select = vi.fn()
    accountState.value = { accounts: [{ id: 'a', name: '本店' }, { id: 'b', name: '支店' }], selectedAccountId: 'a', setSelectedAccountId: select }
    render(<><DirtyScreen /><CommandPalette items={[]} /></>)
    openPalette()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
    expect(select).toHaveBeenCalledWith('b')
  })
  it('統括からの店舗切替は開始先の確認を通す', async () => {
    window.history.replaceState(null, '', '/hq')
    const select = vi.fn()
    accountState.value = { accounts: [{ id: 'a', name: '本店' }, { id: 'b', name: '支店' }], selectedAccountId: 'a', setSelectedAccountId: select }
    resolveEntry.mockResolvedValue({ destination: 'dashboard' })
    render(<CommandPalette items={[]} />)
    openPalette()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    await waitFor(() => expect(select).toHaveBeenCalledWith('b'))
    expect(resolveEntry).toHaveBeenCalledWith('b')
    expect(push).toHaveBeenCalledWith('/')
  })
  it('統括では前に選んだ店も切替候補に含める', () => {
    window.history.replaceState(null, '', '/hq')
    accountState.value = { accounts: [{ id: 'a', name: '本店' }], selectedAccountId: 'a', setSelectedAccountId: vi.fn() }
    render(<CommandPalette items={[]} />)
    openPalette()
    expect(screen.getByRole('option', { name: /本店/ })).toBeTruthy()
  })
  it.each([
    [{ href: '/accounts/new/handover?accountId=b' }, '/accounts/new/handover?accountId=b'],
    [{ destination: 'unavailable' }, '/accounts/new?resume=b'],
  ])('統括から未完了の店舗へは案内へ進む (%o)', async (entry, href) => {
    window.history.replaceState(null, '', '/hq')
    const select = vi.fn()
    accountState.value = { accounts: [{ id: 'b', name: '支店' }], selectedAccountId: 'a', setSelectedAccountId: select }
    resolveEntry.mockResolvedValue(entry)
    render(<CommandPalette items={[]} />)
    openPalette()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    await waitFor(() => expect(push).toHaveBeenCalledWith(href))
    expect(select).not.toHaveBeenCalled()
  })
  it('統括から店舗の確認が失敗した時は引き継ぎ画面に案内する', async () => {
    window.history.replaceState(null, '', '/hq')
    const select = vi.fn()
    accountState.value = { accounts: [{ id: 'b', name: '支店' }], selectedAccountId: 'a', setSelectedAccountId: select }
    resolveEntry.mockRejectedValue(new Error('offline'))
    render(<CommandPalette items={[]} />)
    openPalette()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/accounts/new/handover?accountId=b'))
    expect(select).not.toHaveBeenCalled()
  })
  it('統括の画面を移動した後に届いた古い店舗切替の応答は捨てる', async () => {
    window.history.replaceState(null, '', '/hq')
    let finish!: (value: unknown) => void
    resolveEntry.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const select = vi.fn()
    accountState.value = { accounts: [{ id: 'b', name: '支店' }], selectedAccountId: 'a', setSelectedAccountId: select }
    const view = render(<CommandPalette items={[]} />)
    openPalette()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    window.history.replaceState(null, '', '/hq/templates')
    view.rerender(<CommandPalette items={[]} />)
    await act(async () => { finish({ destination: 'dashboard' }); await Promise.resolve() })
    expect(resolveEntry).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
  it('ホームで店を切り替えると旧店舗の準備用パラメータを外す', () => {
    window.history.replaceState(null, '', '/?guide=old&keep=1')
    accountState.value = { accounts: [{ id: 'b', name: '支店' }], selectedAccountId: 'a', setSelectedAccountId: vi.fn() }
    render(<CommandPalette items={[]} />)
    openPalette()
    fireEvent.click(screen.getByRole('option', { name: /支店/ }))
    expect(replace).toHaveBeenCalledWith('/?keep=1')
  })
  it('閲覧のみの画面では、見えるリンクだけを候補にして隠れた操作を出さない', () => {
    render(<><nav data-design-node="J33xq"><a href="/friends">友だち</a><a href="/broadcasts/new" hidden>配信を作る</a><button disabled>配信を送る</button></nav><CommandPalette /></>)
    openPalette()
    expect(screen.getByRole('option', { name: '友だち' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /配信を作る|配信を送る/ })).toBeNull()
  })
  it('畳んだメニューの機能は検索し、閉じた別の引き出しの項目は含めない', () => {
    render(<><nav data-design-node="J33xq"><div data-group-open="false" aria-hidden="true" inert><a href="/analytics">分析</a></div><div hidden><a href="/broadcasts/new">隠れた操作</a></div></nav><CommandPalette /></>)
    openPalette()
    expect(screen.getByRole('option', { name: '分析' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '隠れた操作' })).toBeNull()
  })
  it('受信箱で同じ言葉を再検索する時はその場で画面に伝える', () => {
    window.history.replaceState(null, '', '/chats?q=old')
    const signal = vi.fn()
    window.addEventListener('musubo:command-palette-chat-search', signal)
    try {
      render(<CommandPalette items={[{ href: '/chats', label: '受信箱' }]} />)
      openPalette()
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '山田' } })
      fireEvent.click(screen.getByRole('option', { name: 'トークの相手を探す「山田」' }))
      expect(new URLSearchParams(window.location.search).get('q')).toBe('山田')
      expect((signal.mock.calls[0][0] as CustomEvent).detail).toBe('山田')
      expect(push).not.toHaveBeenCalled()
    } finally { window.removeEventListener('musubo:command-palette-chat-search', signal) }
  })

  it('探す窓では受信箱の S キーが背景に届かず、閉じると普段どおり届く', () => {
    const shortcut = vi.fn((event: KeyboardEvent) => { if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey) event.preventDefault() })
    document.addEventListener('keydown', shortcut)
    try {
      render(<CommandPalette items={items} />)
      openPalette()
      const row = screen.getByRole('option', { name: /一斉配信/ })
      row.focus()
      shortcut.mockClear()
      fireEvent.keyDown(row, { key: 's' })
      expect(shortcut).not.toHaveBeenCalled()
      fireEvent.keyDown(row, { key: 'Escape' })
      fireEvent.keyDown(document, { key: 's' })
      expect(shortcut).toHaveBeenCalledOnce()
    } finally { document.removeEventListener('keydown', shortcut) }
  })

  it('他で処理済みの ⌘K やキー連打では窓を開かない', () => {
    render(<CommandPalette items={items} />)
    const handled = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    handled.preventDefault()
    document.dispatchEvent(handled)
    fireEvent.keyDown(document, { key: 'k', metaKey: true, repeat: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('別のモーダル操作中は検索窓を重ねない', () => {
    render(<><div role="dialog" aria-modal="true" aria-label="確認中" /><CommandPalette items={items} /></>)
    openPalette()
    expect(screen.queryByRole('dialog', { name: '機能と友だちを探す' })).toBeNull()
  })
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
    expect(push).toHaveBeenCalledWith('/templates?q=%E4%BA%88%E7%B4%84%20%26%20%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B&tab=message')
  })

  it.each([['カルーセル', 'card_message'], ['リッチメッセージ', 'rich_message'], ['リッチビデオ', 'rich_video'], ['質問', 'question'], ['クーポン', 'coupon'], ['リサーチ', 'research']])('%s の検索は対応するタブに送る', (label, tab) => {
    render(<CommandPalette items={items} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), { target: { value: '予約' } })
    fireEvent.click(screen.getByRole('option', { name: `${label}のテンプレートを探す「予約」` }))
    expect(push).toHaveBeenCalledWith(`/templates?q=%E4%BA%88%E7%B4%84&tab=${tab}`)
  })

  it('テンプレートの入口が見えない人にはテンプレート検索を出さない', () => {
    render(<CommandPalette items={[{ href: '/friends', label: '友だち' }]} />)
    openPalette()
    fireEvent.change(screen.getByRole('textbox', { name: '機能と友だちを探す' }), { target: { value: '予約' } })
    expect(screen.queryByRole('option', { name: /テンプレートを探す/ })).toBeNull()
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
      expect(new URLSearchParams(window.location.search).get('tab')).toBe('message')
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
    expect(push).toHaveBeenCalledWith('/templates?q=%E4%BA%88%E7%B4%84&tab=message')
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
