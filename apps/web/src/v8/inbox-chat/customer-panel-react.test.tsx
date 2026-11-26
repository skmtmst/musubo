// @vitest-environment happy-dom
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InboxCustomerPanel from './inbox-customer-panel'

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
let root: Root
let container: HTMLDivElement
const onChange = vi.fn()
const panelRef = createRef<HTMLElement>()
const render = async (wide: boolean, open = true) => {
  await act(async () => {
    root.render(<InboxCustomerPanel
      lineContent={<><p>選んだ相手の情報</p><input aria-label="編集中の顧客メモ" defaultValue="" /></>}
      showFriendInfo={open}
      selectedChatId="chat-a"
      selectedEmail={null}
      wideInfoPanel={wide}
      setShowFriendInfo={onChange}
      customerPanelRef={panelRef}
    />)
  })
}
beforeEach(() => {
  onChange.mockClear()
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('顧客欄の列と重なりの切替', () => {
  it('狭い幅は名前付きの窓で開き、閉じる操作と参照が届く', async () => {
    await render(false)
    const panel = document.querySelector('[role="dialog"][aria-label="顧客情報"]')!
    expect(panel.textContent).toContain('選んだ相手の情報')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panelRef.current).toBe(panel)
    await act(async () => { panel.querySelector<HTMLButtonElement>('button[aria-label="顧客情報を閉じる"]')!.click() })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false)
    await render(false, false)
    expect(document.querySelector('[role="dialog"][aria-label="顧客情報"]')).toBeNull()
    expect(panelRef.current).toBeNull()
  })

  it('デスクトップの重なりでは会話側も操作できる', async () => {
    vi.mocked(window.matchMedia).mockImplementation(query => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList)
    await render(false)
    const panel = document.querySelector('[role="region"][aria-label="顧客情報"]')!
    expect(panel.textContent).toContain('選んだ相手の情報')
    expect(panel.hasAttribute('aria-modal')).toBe(false)
  })

  it('広い幅へ移すと通常の列へ戻り、二重の欄や窓を残さない', async () => {
    await render(false)
    const input = document.querySelector<HTMLInputElement>('input[aria-label="編集中の顧客メモ"]')!
    input.value = 'まだ保存していないメモ'
    input.focus()
    await render(true)
    expect(document.querySelector<HTMLInputElement>('input[aria-label="編集中の顧客メモ"]')!.value).toBe('まだ保存していないメモ')
    expect(document.activeElement).toBe(input)
    expect(document.querySelectorAll('[data-inbox-v4="customer-panel"]')).toHaveLength(1)
    expect(container.textContent).toContain('選んだ相手の情報')
    expect(document.querySelector('[role="dialog"][aria-label="顧客情報"]')).toBeNull()
    expect(panelRef.current?.hasAttribute('aria-modal')).toBe(false)
    expect(document.querySelector('button[aria-label="顧客情報を閉じる"]')).toBeNull()
  })
})

describe('メールの相手の欄', () => {
  it('受信経路を出し、長いメールアドレスは途中で折り返さず全文を title で読める', async () => {
    const email = 'mihon-very-long-customer-address-0001@example.com'
    await act(async () => {
      root.render(<InboxCustomerPanel
        lineContent={null}
        showFriendInfo
        selectedChatId={null}
        selectedEmail={{ source: 'store', threadId: 's1' }}
        selectedEmailItem={{ id: 'email:s1', threadId: 's1', source: 'store', customerName: '見本 店舗の客', customerIdentifier: email, subject: '見本の件名', preview: '見本の本文', status: 'unread', revision: 1, lastIncomingAt: '2026-11-24T01:00:00.000Z', isUnread: true }}
        wideInfoPanel
        setShowFriendInfo={onChange}
        customerPanelRef={panelRef}
      />)
    })
    const panel = document.querySelector('[data-inbox-v4="customer-panel"]')!
    expect(panel.textContent).toContain('受信経路')
    expect(panel.textContent).toContain('店舗メール')
    const shown = [...panel.querySelectorAll<HTMLElement>(`[title="${email}"]`)]
    expect(shown).toHaveLength(2)
    for (const element of shown) expect(element.className).not.toContain('break-all')
  })
})
