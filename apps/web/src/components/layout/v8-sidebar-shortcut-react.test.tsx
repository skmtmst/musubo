// @vitest-environment happy-dom
/*
 * V8-1085-KEYBOARD-01: V8外枠の ⌘\ / Ctrl+\ は1回だけ畳む。
 *
 * 二重発火の実形: TopBarのkeydownが SIDEBAR_TOGGLE_EVENT を投げ(1回目)、
 * Sidebar自身のkeydownも同じ押下でtoggleする(2回目)。登録順によらず
 * 2回畳みが走り、開閉が元に戻って畳まれない。受け手はSidebarの1か所に
 * 統一し、TopBarのkeydownだけが投げる。
 */
import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  visibility: vi.fn(),
  get: vi.fn(),
  selected: 'account-1' as string | null,
}))

const localStorageValues = new Map<string, string>()
const testLocalStorage = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
  removeItem: (key: string) => { localStorageValues.delete(key) },
  clear: () => { localStorageValues.clear() },
}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
})
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
})

vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...props }, children) }
})
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.selected, loading: false }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: '会社', iconUrl: null }) }))
vi.mock('@/components/layout/sidebar-identity', () => ({ default: () => <div>identity</div> }))
vi.mock('@/components/hq/account-menu', () => ({ default: () => <div>hq</div>, SidebarAccountMenu: ({ hq }: { hq: boolean }) => <div data-testid="sidebar-account">{hq ? 'me-hq' : 'me-store'}</div> }))
vi.mock('@/lib/api', () => ({
  api: {
    featureSettings: {
      visibility: fixture.visibility,
      get: fixture.get,
    },
    inbox: { unanswered: { count: vi.fn(async () => ({ success: true, data: { total: 0 } })) } },
    nenMembers: { overview: vi.fn(async () => ({ success: true, data: { pendingPhotos: 0 } })) },
    health: { summary: vi.fn(async () => ({ success: true, data: { warningCount: 0, dangerCount: 0 } })) },
  },
}))

// この試験は既存の権限・旗・並びを検査する。業種の対照はstyle-menu.testで行う。
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'restaurant' }, status: 'ready', error: null, reload: vi.fn() }) }))
import Sidebar from './sidebar'
import TopBar from '../shared/top-bar'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const COLLAPSED_KEY = 'lh-sidebar-collapsed'

function keydown(target: EventTarget, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

/** 外枠そのまま: 畳むボタンを持つTopBar + 受け手のSidebarを一緒に置く。 */
function renderShell() {
  render(
    <>
      <TopBar
        title="友だち"
        manualHref={null}
        accounts={[{ id: 'account-1', label: '店舗A' }]}
        selectedAccountId="account-1"
        onAccountChange={() => undefined}
        roleLabel="統括"
        userName="山田"
        onLogout={() => undefined}
        v8Chrome
      />
      <Sidebar />
      {/* 帯の探す欄は V8 で外した。入力中の合図を確かめる欄は fixture で持つ。 */}
      <input data-testid="field" aria-label="件名" />
      <textarea data-testid="memo" defaultValue="" />
      <div data-testid="editor" contentEditable />
    </>,
  )
}

function collapsedValue() {
  return window.localStorage.getItem(COLLAPSED_KEY)
}

function isCollapsed() {
  return document.querySelector('aside[data-collapsed]') !== null
}

describe('V8-1085-KEYBOARD-01: ⌘\\ は1回だけ畳む', () => {
  beforeEach(() => {
    clearFeatureVisibilityCache()
    fixture.selected = 'account-1'
    fixture.visibility.mockReset()
    fixture.get.mockReset()
    fixture.visibility.mockResolvedValue({ success: true, data: { features: {} } })
    fixture.get.mockResolvedValue({
      success: true,
      data: { features: {}, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] },
    })
    document.documentElement.dataset.theme = 'v8'
    window.localStorage.clear()
    window.localStorage.setItem(COLLAPSED_KEY, '0')
    window.localStorage.setItem('lh_staff_role', 'owner')
  })

  afterEach(() => {
    cleanup()
    delete document.documentElement.dataset.theme
  })

  it('⌘\\ 1回で1回だけ畳む(2回発火なら元に戻って赤)', () => {
    renderShell()
    expect(isCollapsed()).toBe(false)
    keydown(window, { key: '\\', metaKey: true })
    expect(collapsedValue()).toBe('1')
    expect(isCollapsed()).toBe(true)
  })

  it('もう1回押すと広がる(動きが詰まらない)', () => {
    renderShell()
    keydown(window, { key: '\\', metaKey: true })
    expect(collapsedValue()).toBe('1')
    keydown(window, { key: '\\', metaKey: true })
    expect(collapsedValue()).toBe('0')
    expect(isCollapsed()).toBe(false)
  })

  it('Ctrl+\\ でも1回だけ畳む', () => {
    renderShell()
    keydown(window, { key: '\\', ctrlKey: true })
    expect(collapsedValue()).toBe('1')
    expect(isCollapsed()).toBe(true)
  })

  it('未選択の案内を左メニューに表示しない', () => {
    fixture.selected = null
    renderShell()
    expect(document.body.textContent).not.toContain('LINE公式アカウントを選ぶと、ほかの機能が出ます')
  })

  it('畳むボタン1回で1回だけ畳む', async () => {
    renderShell()
    const button = document.querySelector('button[aria-label="メニューを畳む・広げる"]') as HTMLButtonElement
    expect(button, '畳むボタンがありません').not.toBeNull()
    await act(async () => { button.click() })
    expect(collapsedValue()).toBe('1')
    expect(isCollapsed()).toBe(true)
  })

  it('入力欄・複数行・直接編集での文字入力は畳まない', () => {
    renderShell()
    const field = document.querySelector('[data-testid="field"]') as HTMLInputElement
    const memo = document.querySelector('[data-testid="memo"]') as HTMLTextAreaElement
    const editor = document.querySelector('[data-testid="editor"]') as HTMLDivElement
    keydown(field, { key: 'a' })
    keydown(memo, { key: 'あ' })
    keydown(editor, { key: 'a' })
    keydown(field, { key: '\\' })
    expect(collapsedValue()).toBe('0')
    expect(isCollapsed()).toBe(false)
  })

  it('入力欄にいても ⌘\\ は1回だけ畳む', () => {
    renderShell()
    const field = document.querySelector('[data-testid="field"]') as HTMLInputElement
    field.focus()
    keydown(field, { key: '\\', metaKey: true })
    expect(collapsedValue()).toBe('1')
    expect(isCollapsed()).toBe(true)
  })

  it('旧テーマ指定でも ⌘\\ とボタンはそれぞれ1回だけ畳みを切り替える', async () => {
    document.documentElement.dataset.theme = 'v7'
    renderShell()
    keydown(window, { key: '\\', metaKey: true })
    expect(collapsedValue()).toBe('1')
    expect(isCollapsed()).toBe(true)
    const button = document.querySelector('button[aria-label="メニューを畳む・広げる"]') as HTMLButtonElement
    await act(async () => { button.click() })
    expect(collapsedValue()).toBe('0')
    expect(isCollapsed()).toBe(false)
  })
})

describe('保存が無い時の左メニュー：iPad 横（1024px）だけ畳む', () => {
  const realWidth = window.innerWidth
  beforeEach(() => {
    clearFeatureVisibilityCache()
    fixture.visibility.mockReset()
    fixture.get.mockReset()
    fixture.visibility.mockResolvedValue({ success: true, data: { features: {} } })
    fixture.get.mockResolvedValue({
      success: true,
      data: { features: {}, sidebarOrder: null, sidebarItemOrder: null, specializedFeatureKeys: [] },
    })
    document.documentElement.dataset.theme = 'v8'
    window.localStorage.clear()
    window.localStorage.setItem('lh_staff_role', 'owner')
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth })
    delete document.documentElement.dataset.theme
  })

  it.each([
    [1024, true],
    [1025, false],
    [1100, false],
    [1152, false],
  ])('幅 %ipx で畳むか：%s', (width, collapsed) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    renderShell()
    expect(isCollapsed()).toBe(collapsed)
  })

  it('保存した開き方が幅より優先される', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    window.localStorage.setItem(COLLAPSED_KEY, '0')
    renderShell()
    expect(isCollapsed()).toBe(false)
  })
})
