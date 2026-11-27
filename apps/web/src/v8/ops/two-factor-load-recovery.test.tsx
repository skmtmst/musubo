// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}))
vi.mock('@/lib/qr-image', () => ({
  qrToDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AAA'),
}))

import OpsTwoFactorV8 from './two-factor'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

const sessionJson = () => new Response(JSON.stringify({
  success: true,
  data: { id: 'ops-1', name: '運営 太郎', platformAdmin: false, platformAdminState: 'awaiting_totp' },
  csrfToken: 'csrf-token',
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('OpsTwoFactorV8 QR準備失敗の分類と再読み込み復旧', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    window.history.replaceState(null, '', '/ops/two-factor')
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('429 応答の待ち秒数を案内して壊れた入力フォームを隠し、もう一度読み込むでQR設定へ復旧できる', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/session')) return sessionJson()
      if (url.includes('/two-factor/setup')) {
        attempt += 1
        if (attempt === 1) {
          return new Response(JSON.stringify({ success: false, error: 'Too many requests', retryAfterSeconds: 45 }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '45' },
          })
        }
        return new Response(JSON.stringify({
          success: true,
          data: { provisioningUri: 'otpauth://totp/musubo?secret=RETRYOK', manualKey: 'RETRYOK' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    render(<OpsTwoFactorV8 />)

    expect(await screen.findByText('混み合っています')).toBeTruthy()
    expect(screen.getByText('45秒ほど待ってから、もう一度読み込んでください。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /登録する/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect(screen.getByText('RETRYOK')).toBeTruthy()
      expect(screen.getByRole('button', { name: /登録する/ })).toBeTruthy()
    })
  })

  it('403 応答では運営向け権限案内を表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/session')) return sessionJson()
      if (url.includes('/two-factor/setup')) {
        return new Response(JSON.stringify({ success: false, error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    render(<OpsTwoFactorV8 />)

    expect(await screen.findByText('この画面を見る権限がありません')).toBeTruthy()
    expect(screen.getByText('この操作の権限がありません。統括の管理者に頼んでください。')).toBeTruthy()
  })
})
