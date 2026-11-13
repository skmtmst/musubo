// @vitest-environment happy-dom
/**
 * 板 ：問い合わせカード（種類｜店舗・件名・本文・画像・送信者・ボタン）と
 * 履歴の表（受付番号・件名・種類・状態・更新）。下部追従バーは出さない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  context: vi.fn(async () => ({
    success: true,
    data: {
      kinds: [{ key: 'trouble', label: '不具合' }],
      accounts: [{ id: 'line-1', name: '本店' }],
      sender: { tenantName: '統括テスト', name: '見本 141', email: 'owner@example.com', planLabel: 'スタンダード' },
    },
  })),
  list: vi.fn(async () => ({
    success: true,
    data: [
      { id: 'req-1', ticketLabel: '#1042', subject: 'Webhook が遅れる', kindLabel: '不具合', status: 'open', createdAt: '2026-09-30T11:00:00+09:00', replies: [] },
    ],
  })),
  create: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { hqSupport: calls } }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined, usePageChrome: () => ({}) }))
vi.mock('@/components/tenant-access-context', () => ({ useTenantStatus: () => 'active' }))
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => <div data-line-guide /> }))

import HqSupportPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}

describe('b8xBtZ お問い合わせの並び', () => {
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

  it('カードに種類・店舗・件名・本文・送信者と、右下にクリア・送信がある', async () => {
    await act(async () => { root.render(<HqSupportPage />) })
    await settle()
    const text = host.textContent ?? ''
    for (const word of ['種類', '関係する店舗', '件名', '本文', '画像を添える', '送信者：見本 141', '内容をクリア', '送信']) {
      expect(text).toContain(word)
    }
  })

  it('履歴に受付番号・件名・状態を出す', async () => {
    await act(async () => { root.render(<HqSupportPage />) })
    await settle()
    const text = host.textContent ?? ''
    expect(text).toContain('#1042')
    expect(text).toContain('Webhook が遅れる')
  })

  it('統括の設定メニューで今の画面が分かる', async () => {
    await act(async () => { root.render(<HqSupportPage />) })
    await settle()
    const current = host.querySelector('a[aria-current="page"]')
    expect(current?.textContent).toContain('お問い合わせ')
  })

  it('［書き方のひな形を入れる］で見出しを本文へ入れ、書いた文章は残す', async () => {
    await act(async () => { root.render(<HqSupportPage />) })
    await settle()
    const body = host.querySelector('textarea')!
    const template = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '書き方のひな形を入れる')!
    await act(async () => { template.click() })
    expect(body.value).toContain('【起きたこと】')
    expect(body.value).toContain('【期待したこと】')
    expect(body.value).toContain('【起きた日時】')
    // 書いた文章を残して足す。
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      proto.call(body, 'まず再起動しました')
      body.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { template.click() })
    expect(body.value.startsWith('まず再起動しました')).toBe(true)
    expect(body.value).toContain('【起きたこと】')
  })
})

vi.mock('next/navigation', () => ({ usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
