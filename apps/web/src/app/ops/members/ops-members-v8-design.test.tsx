// @vitest-environment happy-dom
/*
 * 板  メンバー管理の絵合わせ（V8）。
 * - 頭：説明、段切り替えは運営メンバー・情報
 * - 数の帯：3つ（二段階認証の札は出さない）、有効・招待中と監査ログに記録
 * - 招待の行が常に出る（開閉ボタン・キャンセルは無い）
 * - 行：（自分）、二段階認証待ちの札、短い最終ログイン
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsMembersPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn(),push:vi.fn()}),usePathname:()=>'/ops/members'}))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
vi.mock('@/v8/settings/staff', () => ({ SelfSecurity: () => <section aria-label="自分の設定">パスキーを追加</section> }))

const members = [
  { staffId: 's1', name: 'Demo Person', email: 'owner@example.com', isActive: true, totpEnabled: true, lineLinked: false, inviteStatus: '', activationState: 'active', invitedAt: null, approvedBy: null, lastLoginAt: '2026-10-02T07:10:00.000+09:00', createdAt: '2026-09-01T00:00:00.000+09:00' },
  { staffId: 's2', name: '見本 次郎', email: 'staff@example.com', isActive: true, totpEnabled: true, lineLinked: false, inviteStatus: '', activationState: 'active', invitedAt: null, approvedBy: null, lastLoginAt: '2026-10-01T22:40:00.000+09:00', createdAt: '2026-09-01T00:00:00.000+09:00' },
  { staffId: 's3', name: '見本 花子', email: 'guest@example.com', isActive: true, totpEnabled: false, lineLinked: false, inviteStatus: '', activationState: 'awaiting_totp', invitedAt: '2026-10-03T00:00:00.000+09:00', approvedBy: null, lastLoginAt: null, createdAt: '2026-10-03T00:00:00.000+09:00' },
]

const summary = { members: 3, invited: 1, awaitingTotp: 1, totpEnabled: 2, impersonationsThisMonth: 1, writeImpersonationsThisMonth: 1, piiRevealsThisMonth: 0 }

let host: HTMLDivElement
let root: Root

function text(): string {
  return host.textContent ?? ''
}

async function settle(turns = 8) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/api/ops/me')
      ? { success: true, data: { id: 's1' } }
      : { success: true, data: members, summary }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('運営メンバー管理の承認済みデザイン', () => {
  it('検索・状態切替・招待と本人のパスキー設定を一覧の左右に出す', async () => {
    await act(async () => { root.render(<OpsMembersPage />) })
    await settle()
    const body = text()
    expect(host.querySelector('input[aria-label="名前・メールで探す"]')).not.toBeNull()
    expect(body).toContain('有効')
    expect(body).toContain('止めた')
    expect(body).toContain('招待する')
    expect(body).toContain('運営メンバー')
    expect(host.querySelector('[aria-label="自分の設定"]')?.textContent).toContain('パスキーを追加')
    expect(body).toContain('Demo Person（自分）')
    expect(body).toContain('10/02 07:10')
    expect(body).toContain('二段階認証待ち')
    expect(body).toContain('招待中')
    expect(body).not.toContain('今月の代理ログイン')
    const invite = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('招待する'))!
    await act(async () => { invite.click() })
    expect(document.body.textContent).toContain('招待する人のメールアドレス')
    expect(document.body.textContent).toContain('招待メールを送る')
  })
})
