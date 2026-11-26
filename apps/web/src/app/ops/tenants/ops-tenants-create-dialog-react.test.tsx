// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsTenantsPage from './page'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/ops/tenants', useRouter: () => ({ push: mockPush }) }))
const mockPush = vi.fn()

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 契約先一覧の「作る」は V8-B 板  の小窓で出す。
 * 統括名と案内文を表示し、空のままでは作らず理由を出す。
 */

const summary = { active: 1, trialing: 0, suspended: 0, pastDue: 0 }
let postedBody: unknown = null
let tenantRows: Array<Record<string, unknown>> = []

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  mockPush.mockReset()
  postedBody = null
  tenantRows = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/ops/me')) return new Response(JSON.stringify({ success: true, data: { id: 'ops-1', readOnly: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/api/ops/tenants') && (!init || !init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ success: true, data: tenantRows, summary }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/tenants') && init?.method === 'POST') {
      postedBody = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ success: true, data: { id: 't9', name: '検証商事' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: false, error: `unexpected ${url}` }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.querySelectorAll('[data-design-node="i0FTN"]').forEach((node) => node.remove())
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

function openCreateDialog(): HTMLElement {
  const buttons = Array.from(host.querySelectorAll('button'))
  const open = buttons.find((button) => (button.textContent ?? '').includes('契約先を作る'))
  if (!open) throw new Error('「契約先を作る」ボタンがない')
  return open as HTMLElement
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-design-node="i0FTN"]') as HTMLElement | null
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('value の setter がない')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('契約先の請求状態', () => {
  it('未知の状態を解約済みと決めつけず、既知の解約はそのまま出す', async () => {
    const base = { status: 'active', featurePacks: [], plan_key: 'standard', trial_ends_at: null, current_period_ends_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', account_count: 1, staff_count: 1, last_login_at: null }
    tenantRows = [
      { ...base, id: 'unknown', name: '見本 未知', plan_status: 'constructor' },
      { ...base, id: 'known', name: '見本 解約', plan_status: 'canceled' },
    ]
    await act(async () => { root.render(<OpsTenantsPage />) })
    await flush()
    const rows = Array.from(host.querySelectorAll('tbody tr'))
    const unknown = rows.find((row) => row.textContent?.includes('見本 未知'))!
    const known = rows.find((row) => row.textContent?.includes('見本 解約'))!
    expect(unknown.textContent).toContain('確認が必要')
    expect(unknown.textContent).not.toContain('請求解約')
    expect(unknown.querySelector('[title*="請求"]')?.getAttribute('title')).toContain('請求 constructor')
    expect(known.textContent).toContain('請求解約')
  })
})

describe('契約先を作る小窓（板 i0FTN）', () => {
  it('一覧には出さず、押したときだけ小窓が出る', async () => {
    await act(async () => { root.render(<OpsTenantsPage />) })
    await flush()
    expect(dialog()).toBeNull()
    await act(async () => { openCreateDialog().click() })
    const window = dialog()
    expect(window, '小窓が出ない').not.toBeNull()
    const text = window?.textContent ?? ''
    for (const row of ['契約先を作る', '統括名（会社名）', '最初の権限者へ招待', 'キャンセル', '作る']) {
      expect(text, `「${row}」がない`).toContain(row)
    }
    expect(text).not.toContain('飲食店機能')
  })

  it('統括名が空のままでは作らず理由を出す', async () => {
    await act(async () => { root.render(<OpsTenantsPage />) })
    await flush()
    await act(async () => { openCreateDialog().click() })
    const buttons = Array.from(document.body.querySelectorAll('[data-design-node="i0FTN"] button'))
    const create = buttons.find((button) => (button.textContent ?? '').trim().endsWith('作る'))
    await act(async () => { create?.click() })
    expect(postedBody, '空のまま送られている').toBeNull()
    expect((dialog()?.textContent ?? '')).toContain('統括名を入力してください')
  })

  it('統括名を入れると送り、作成した契約先を一覧で示す', async () => {
    await act(async () => { root.render(<OpsTenantsPage />) })
    await flush()
    await act(async () => { openCreateDialog().click() })
    const input = dialog()?.querySelector('input[aria-label="統括名（会社名）"]') as HTMLInputElement | null
    expect(input, '統括名の欄がない').not.toBeNull()
    await act(async () => { setInputValue(input!, '検証商事') })
    const buttons = Array.from(document.body.querySelectorAll('[data-design-node="i0FTN"] button'))
    const create = buttons.find((button) => (button.textContent ?? '').trim().endsWith('作る'))
    await act(async () => { create?.click() })
    await flush()
    expect(postedBody).toEqual({ name: '検証商事' })
    expect(mockPush).toHaveBeenCalledWith('/ops/tenants?highlight=t9')
  })
})
