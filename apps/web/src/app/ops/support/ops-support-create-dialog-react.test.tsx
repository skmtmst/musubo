// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor, screen } from '@testing-library/react'

import OpsSupportPage from './page'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('') }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * お問い合わせの「チケット作成」は小窓で出す。
 * 契約先・種類・優先度・件名・内容を持ち、送ったら知らせが出て閉じる。再発防止。
 */

let postedBody: unknown = null

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  postedBody = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/ops/me')) return new Response(JSON.stringify({ success: true, data: { id: 'ops-1', readOnly: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const method = init?.method ?? 'GET'
    if (url.includes('/api/ops/support/summary')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          byStage: { all: 0, new: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 },
          kpis: {
            untouched: 0, untouchedFromLine: 0, avgFirstReplyMinutes: null, prevAvgFirstReplyMinutes: null,
            resolutionRate: null, prevResolutionRate: null, avgResolutionMinutes: null, prevAvgResolutionMinutes: null,
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/api/ops/support/tickets') && method === 'GET') {
      return new Response(JSON.stringify({ success: true, data: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/api/ops/tenants')) {
      return new Response(JSON.stringify({ success: true, data: [{ id: 'c1', name: '検証商事', status: 'active' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/ops/support/tickets') && method === 'POST') {
      postedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ success: true, data: { id: 'tk1', ticketLabel: '#1047' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: false, error: `unexpected ${method} ${url}` }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.querySelectorAll('[data-design-node="Izau1"]').forEach((node) => node.remove())
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve() })
}

function openButton(): HTMLElement {
  const buttons = Array.from(host.querySelectorAll('button'))
  const open = buttons.find((button) => (button.textContent ?? '').includes('チケット作成'))
  if (!open) throw new Error('「チケット作成」ボタンがない')
  return open as HTMLElement
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-design-node="Izau1"]') as HTMLElement | null
}

function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('value の setter がない')
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('チケット作成の小窓', () => {
  it('一覧には出さず、押したときだけ小窓が出る', async () => {
    await act(async () => { root.render(<OpsSupportPage />) })
    await flush()
    expect(dialog()).toBeNull()
    await act(async () => { openButton().click() })
    await flush()
    const window = dialog()
    expect(window, '小窓が出ない').not.toBeNull()
    const text = window?.textContent ?? ''
    for (const row of ['チケット作成', '契約先', '種類', '優先度', '件名', '内容', '相手にはメールは届きません', 'キャンセル', '作成する']) {
      expect(text, `「${row}」がない`).toContain(row)
    }
  })

  it('書いて送ると起票され、知らせが出て閉じる', async () => {
    await act(async () => { root.render(<OpsSupportPage />) })
    await flush()
    await act(async () => { openButton().click() })
    await flush()
    await act(async () => { dialog()!.querySelector<HTMLButtonElement>('button[aria-label="契約先"]')!.click() })
    await act(async () => { screen.getByRole('radio', { name: /検証商事/ }).click() })
    await act(async () => { screen.getByRole('button', { name: '選ぶ', exact: true }).click() })
    await waitFor(() => expect(screen.queryByRole('button', { name: '選ぶ', exact: true })).toBeNull())
    const subject = dialog()?.querySelector('input[aria-label="件名"]') as HTMLInputElement | null
    const body = dialog()?.querySelector('textarea[aria-label="内容"]') as HTMLTextAreaElement | null
    expect(subject, '件名の欄がない').not.toBeNull()
    expect(body, '内容の欄がない').not.toBeNull()
    await act(async () => {
      setFieldValue(subject!, '電話で受けた配信の相談')
      setFieldValue(body!, '9月から友だち追加が止まっているとのこと')
    })
    const buttons = Array.from(document.body.querySelectorAll('[data-design-node="Izau1"] button'))
    const create = buttons.find((button) => (button.textContent ?? '').trim().endsWith('作成する'))
    await act(async () => { create?.click() })
    await flush()
    expect(postedBody).toMatchObject({ subject: '電話で受けた配信の相談', body: '9月から友だち追加が止まっているとのこと' })
    await waitFor(() => expect(dialog(), '送ったのに小窓が残っている').toBeNull())
    expect(host.textContent ?? '').toContain('#1047 を作りました')
  })
})
