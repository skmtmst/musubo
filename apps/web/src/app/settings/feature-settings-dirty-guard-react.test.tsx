// @vitest-environment happy-dom
/*
 * N-445: 文字列ではなく機能設定画面を実際に描画し、未保存の切替から
 * 画面内遷移・ブラウザ離脱・保存・アカウント切替までを操作する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ accountId: 'account-a' }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
const network = vi.hoisted(() => ({ saveFails: false, puts: 0 }))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => '/settings',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))

const { default: SettingsPage } = await import('./page')

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

let host: HTMLDivElement
let root: Root
let mounted = false

function featureResponse(accountId: string) {
  return {
    success: true,
    data: {
      features: { scenarios: true, broadcasts: true, templates: true, forms: true },
      sidebarItemOrder: {}, specializedFeatureKeys: [], version: accountId === 'account-a' ? 3 : 8,
    },
  }
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  navigation.push.mockReset()
  network.saveFails = false
  network.puts = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path.includes('/api/staff/me')) return Promise.resolve(response({ success: true, data: { role: 'owner' } }))
    const accountId = new URL(path, 'http://localhost').searchParams.get('account_id') ?? 'account-a'
    if (path.includes('/api/settings/features/impact')) {
      return response({ success: true, data: { version: 3, impacts: [], requiresConfirmation: false, impactToken: null } })
    }
    if (path.includes('/api/settings/features') && init?.method === 'PUT') {
      network.puts += 1
      return network.saveFails
        ? response({ success: false, error: 'save failed' }, 500)
        : response({ success: true, data: { version: 4 } })
    }
    if (path.includes('/api/settings/features')) return response(featureResponse(accountId))
    if (path.includes('/api/analytics/usage')) return response({ success: true, data: { categories: [] } })
    return response({ success: false, error: 'not found' }, 404)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mounted = true
})

afterEach(async () => {
  if (mounted) await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => {
    root.render(<SettingsPage />)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  if (!found) throw new Error(`ボタンが見つかりません: ${label}`)
  return found
}

async function makeDirty() {
  const toggle = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]:not([aria-label*="まとめて"])')]
    .find((item) => !item.disabled && String((item as HTMLElement).getAttribute('aria-checked') === 'true') === 'false')
    ?? [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]:not([aria-label*="まとめて"])')].find((item) => !item.disabled)
  if (!toggle) throw new Error('切替可能な機能がありません')
  await act(async () => { toggle.click(); await Promise.resolve() })
  expect(button('機能設定を保存').disabled).toBe(false)
}

/** 保存に必須の変更理由を入れる。 */
async function fillReason(text = 'テスト') {
  const input = host.querySelector<HTMLInputElement>('#feature-settings-reason')
  if (!input) throw new Error('変更理由の入力欄がありません')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function beforeUnload() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('N-445 機能設定の未保存離脱確認', () => {
  it('dirtyの画面内遷移は確認し、「残る」は編集を保ち「離れる」だけrouterへ進める', async () => {
    await render()
    await makeDirty()
    await act(async () => { button('並びを変更する').click() })
    expect(host.querySelector('a[href="/accounts"]')).toBeNull()
    expect(host.querySelector('a[href="/line-notifications"]')).toBeNull()
    const link = [...host.querySelectorAll('a')].find((item) => item.getAttribute('href') === '/emergency')
    if (!link) throw new Error('画面内遷移のLinkがありません')
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    expect(document.body.textContent).toContain('保存していない変更があります')
    expect(navigation.push).not.toHaveBeenCalled()
    await act(async () => { button('編集を続ける').click() })
    expect(document.body.textContent).not.toContain('保存せずに移る')
    expect(button('機能設定を保存').disabled).toBe(false)
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    await act(async () => { button('保存せずに移る').click() })
    expect(navigation.push).toHaveBeenCalledTimes(1)
    expect(navigation.push).toHaveBeenCalledWith('/emergency')
  })

  it('dirtyの戻る操作は復元側popstateを一度だけ通し、次の戻るで確認を出す', async () => {
    const go = vi.spyOn(window.history, 'go')
    const back = vi.spyOn(window.history, 'back')
    await render()
    await makeDirty()
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledWith(1)
    expect(document.body.textContent).toContain('保存していない変更があります')
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledTimes(1)
    await act(async () => { button('編集を続ける').click() })
    expect(back).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledTimes(2)
    await act(async () => { button('保存せずに移る').click() })
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('dirtyだけbeforeunloadを登録し、保存成功・失敗・unmountで正しく切り替える', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    await render()
    expect(beforeUnload().defaultPrevented).toBe(false)
    await makeDirty()
    await fillReason()
    expect(beforeUnload().defaultPrevented).toBe(true)
    expect(add.mock.calls.filter(([name]) => name === 'beforeunload')).toHaveLength(1)

    network.saveFails = true
    await act(async () => { button('機能設定を保存').click(); await settle() })
    expect(network.puts).toBe(1)
    expect(beforeUnload().defaultPrevented).toBe(true)

    network.saveFails = false
    await act(async () => { button('機能設定を保存').click(); await settle(); await settle() })
    expect(network.puts).toBe(2)
    expect(beforeUnload().defaultPrevented).toBe(false)
    expect(remove.mock.calls.some(([name]) => name === 'beforeunload')).toBe(true)
  })

  it('account切替でAのdirtyと離脱窓をBへ残さず、beforeunloadも二重登録しない', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const addDocument = vi.spyOn(document, 'addEventListener')
    await render()
    await makeDirty()
    expect(beforeUnload().defaultPrevented).toBe(true)
    fixture.accountId = 'account-b'
    await render()
    expect(beforeUnload().defaultPrevented).toBe(false)
    expect(document.body.textContent).not.toContain('保存していない変更があります')
    expect([...document.body.querySelectorAll('button')].some(button => button.textContent?.includes('機能設定を保存'))).toBe(false)
    expect(add.mock.calls.filter(([name]) => name === 'beforeunload')).toHaveLength(1)
    expect(addDocument.mock.calls.filter(([name]) => name === 'click')).toHaveLength(1)
  })

  it('dirtyな画面をunmountするとbeforeunloadを残さない', async () => {
    await render()
    await makeDirty()
    expect(beforeUnload().defaultPrevented).toBe(true)
    await act(async () => { root.unmount() })
    mounted = false
    expect(beforeUnload().defaultPrevented).toBe(false)
  })
})
