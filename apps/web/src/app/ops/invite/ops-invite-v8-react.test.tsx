// @vitest-environment happy-dom
/*
 * 運営メンバーの招待 V8（板 ）。
 * 期限切れと使用済みを分け、使用済みはログインへ案内する。
 * パスワードがある人に再設定を強制しない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsInvitePage from './page'

vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const net = vi.hoisted(() => ({
  check: { status: 200, body: {} as unknown } as { status: number; body: unknown },
  checkThrows: false,
}))

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  net.checkThrows = false
  window.history.replaceState(null, '', '/ops/invite#invite=token-1')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/auth/ops-invite/check')) {
      if (net.checkThrows) throw new TypeError('fetch failed')
      return new Response(JSON.stringify(net.check.body), { status: net.check.status, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: false, error: '未設定' }), { status: 500 })
  }))
  document.documentElement.dataset.theme = 'v8'
})

afterEach(() => {
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

let host: HTMLDivElement
let root: Root

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<OpsInvitePage />) })
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

async function unmount() {
  await act(async () => { root.unmount() })
  host.remove()
}

describe('運営メンバーの招待V8（tVaUh）', () => {
  it('使用済みはログインへ案内し、やり直しは出さない', async () => {
    net.check = { status: 410, body: { success: false, error: 'この招待はすでに使われています。ログインしてください', code: 'used' } }
    await render()
    expect(host.querySelector('[data-design-node="tVaUh"]')).not.toBeNull()
    expect(host.textContent).toContain('この招待はすでに使われています')
    expect(host.textContent).toContain('運営のログインへ')
    expect(host.textContent).not.toContain('もう一度読み込む')
    expect(host.textContent).not.toContain('名前とパスワードを決める')
    await unmount()
  })

  it('期限切れは期限切れと分かる題にし、送り直しを案内する', async () => {
    net.check = { status: 410, body: { success: false, error: 'この招待は期限切れです。招待した運営メンバーに送り直しを依頼してください', code: 'expired' } }
    await render()
    expect(host.textContent).toContain('この招待は期限切れです')
    expect(host.textContent).toContain('送り直し')
    expect(host.textContent).toContain('運営のログインへ')
    expect(host.textContent).not.toContain('もう一度読み込む')
    await unmount()
  })

  it('見つからない招待でもログインへ案内し、やり直しは出さない', async () => {
    net.check = { status: 404, body: { success: false, error: 'この招待は使えません' } }
    await render()
    expect(host.textContent).toContain('この招待は使えません')
    expect(host.textContent).toContain('運営のログインへ')
    expect(host.textContent).not.toContain('もう一度読み込む')
    expect(host.textContent).not.toContain('名前とパスワードを決める')
    await unmount()
  })

  it('混雑の失敗では読み直せる口を残す', async () => {
    net.check = { status: 429, body: { success: false, error: '混み合っています' } }
    await render()
    expect(host.textContent).toContain('招待を読み込めませんでした')
    expect(host.textContent).toContain('もう一度読み込む')
    await unmount()
  })

  it('通信の失敗では読み直せる口を残す', async () => {
    net.checkThrows = true
    await render()
    expect(host.textContent).toContain('招待を読み込めませんでした')
    expect(host.textContent).toContain('もう一度読み込む')
    await unmount()
  })

  it('サーバーの失敗では読み直せる口を残す', async () => {
    net.check = { status: 500, body: { success: false, error: '混み合っています' } }
    await render()
    expect(host.textContent).toContain('招待を読み込めませんでした')
    expect(host.textContent).toContain('もう一度読み込む')
    await unmount()
  })

  it('パスワードがある人には再設定を強制しない', async () => {
    net.check = {
      status: 200,
      body: { success: true, data: { email: 'guest@example.com', name: '見本 花子', needsPassword: false } },
    }
    await render()
    expect(host.querySelector('#ops-invite-email')).not.toBeNull()
    expect(host.querySelector('#ops-invite-password')).toBeNull()
    expect(host.textContent).toContain('二段階認証へ進む')
    await unmount()
  })

  it('パスワードがない人は名前と8文字以上の確認つきで進む', async () => {
    net.check = {
      status: 200,
      body: { success: true, data: { email: 'guest@example.com', name: '', needsPassword: true } },
    }
    await render()
    expect(host.querySelector('#ops-invite-password')).not.toBeNull()
    expect(host.textContent).toContain('パスワードを設定して次へ')
    await unmount()
  })
})
