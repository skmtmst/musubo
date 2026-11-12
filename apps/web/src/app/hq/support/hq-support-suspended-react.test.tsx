// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  context: vi.fn(async () => ({
    success: true,
    data: {
      kinds: [{ key: 'billing', label: '料金・契約について' }],
      accounts: [{ id: 'line-1', name: '表参道店' }],
      sender: { tenantName: '株式会社サンプル', name: '見本 141', email: 'owner@example.com', planLabel: 'スタンダード' },
    },
  })),
  list: vi.fn(async () => ({ success: true, data: [] })),
  create: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { hqSupport: calls } }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined, usePageChrome: () => ({}) }))
vi.mock('@/components/tenant-access-context', () => ({ useTenantStatus: () => 'suspended' }))
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => <div data-line-guide /> }))

import HqSupportPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}

describe('停止中のお問い合わせ本文（管理画面 IwfA0）', () => {
  beforeEach(() => {
    calls.context.mockClear()
    calls.list.mockClear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('問い合わせ専用contextだけで店舗・送信者・プランを表示し、LINE登録案内を出さない', async () => {
    await act(async () => { root.render(<HqSupportPage />) })
    await settle()

    expect(calls.context).toHaveBeenCalledTimes(1)
    expect(calls.list).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('関係する店舗')
    expect(host.textContent).toContain('株式会社サンプル')
    expect(host.textContent).toContain('見本 141')
    expect(host.textContent).toContain('owner@example.com')
    expect(host.textContent).toContain('スタンダード')
    expect(host.querySelector('[data-line-guide]')).toBeNull()
    expect(host.textContent).not.toContain('契約者専用LINEの登録案内')
  })
})

vi.mock('next/navigation', () => ({ usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
