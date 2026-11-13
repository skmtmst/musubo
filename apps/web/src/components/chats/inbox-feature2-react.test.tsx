// @vitest-environment happy-dom
/*
 * 受信箱の顧客情報の出し方と絞り込みパネルを描いて押す。
 * - 顧客情報は、開いていても閉じていても同じ1つのボタンで切り替え、文言と aria-expanded が実表示と一致する
 * - 狭い幅のドロワーは、背景の暗幕・Escape・閉じるボタンで閉じる（閉じるボタンと窓の形は v8/inbox-chat/customer-panel-react.test.tsx）
 * - 絞り込みパネルは選ぶとすぐ反映し、下の段は「リセット」「閉じる」だけ
 */
import React, { act, createRef } from 'react'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConversationHead from '@/v8/inbox-chat/conversation-head'
import InboxCustomerPanel from '@/v8/inbox-chat/inbox-customer-panel'
import { useInboxPanel } from '@/v8/inbox-chat/use-inbox-panel'
import InboxFilterPanel, { type InboxFilterValue } from './inbox-filter-panel'

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('H3lAOB トーク見出しの顧客情報ボタン', () => {
  const head = (open: boolean, onToggle = vi.fn()) => (
    <ConversationHead
      name="見本 25"
      operator={{ value: 'op-k', operators: [{ id: 'op-k', name: 'Kenta' }], onChange: vi.fn() }}
      status={{ value: 'unread', onChange: vi.fn() }}
      panel={{ open, onToggle }}
    />
  )

  it('開いていても閉じていても同じ1つのボタンで切り替え、文言と aria-expanded を開閉に合わせる', () => {
    const onToggle = vi.fn()
    const { rerender } = render(head(false, onToggle))
    const closed = screen.getByRole('button', { name: '顧客情報を表示' })
    expect(closed.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(closed)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(head(true, onToggle))
    const opened = screen.getByRole('button', { name: '顧客情報を閉じる' })
    expect(opened).toBe(closed)
    expect(opened.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: '顧客情報を表示' })).toBeNull()
  })
})

describe('LAY-01/LAY-02 顧客情報のドロワー', () => {
  const mount = (wide: boolean, setShowFriendInfo = vi.fn()) => {
    render(<InboxCustomerPanel
      lineContent={<p>選んだ相手の情報</p>}
      showFriendInfo
      selectedChatId="chat-a"
      selectedThreadId={null}
      wideInfoPanel={wide}
      setShowFriendInfo={setShowFriendInfo}
      customerPanelRef={createRef<HTMLElement>()}
      emailItems={[]}
    />)
    return setShowFriendInfo
  }
  const backdrop = () => document.querySelector('[data-inbox-v4="customer-panel"]')?.previousElementSibling as HTMLElement | null

  it('狭い幅では背景の暗幕を押しても閉じる', () => {
    const setShowFriendInfo = mount(false)
    expect(backdrop()?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.mouseDown(backdrop()!)
    expect(setShowFriendInfo).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('広い幅（右の列）では暗幕を置かない', () => {
    mount(true)
    expect(document.querySelector('[data-inbox-v4="customer-panel"]')).toBeTruthy()
    expect(backdrop()).toBeNull()
  })

  it('狭い幅では既定で閉じ、開いたドロワーは Escape で閉じる。広い幅は既定で開き、Escape で畳まない', () => {
    const media = (matches: boolean) => () => ({ matches, addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('matchMedia', media(false))
    const narrow = renderHook(() => useInboxPanel())
    expect(narrow.result.current.showFriendInfo).toBe(false)
    act(() => narrow.result.current.setShowFriendInfo((current) => !current))
    expect(narrow.result.current.showFriendInfo).toBe(true)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(narrow.result.current.showFriendInfo).toBe(false)
    narrow.unmount()

    vi.stubGlobal('matchMedia', media(true))
    const wide = renderHook(() => useInboxPanel())
    expect(wide.result.current.showFriendInfo).toBe(true)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(wide.result.current.showFriendInfo).toBe(true)
  })
})

describe('LAY-04 絞り込みパネル', () => {
  const VALUE: InboxFilterValue = { status: 'all', assignee: 'all', channel: 'all', unreadOnly: false }

  it('選ぶとすぐ反映し、下の段は「リセット」「閉じる」だけ', () => {
    const onChange = vi.fn()
    const onReset = vi.fn()
    const onClose = vi.fn()
    render(<InboxFilterPanel open value={VALUE} operators={[]} onChange={onChange} onReset={onReset} onClose={onClose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /未読だけ表示/ }))
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, unreadOnly: true })

    const footer = screen.getByText('条件は選ぶとすぐ一覧に反映されます').closest('footer')!
    expect([...footer.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['リセット', '閉じる'])
    fireEvent.click(screen.getByRole('button', { name: 'リセット' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'この条件で絞り込む' })).toBeNull()
  })
})
