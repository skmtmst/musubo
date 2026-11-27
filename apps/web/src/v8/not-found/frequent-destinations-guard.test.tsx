// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }))
const nav = vi.hoisted(() => ({ pathname: '/no-such-page' as string | null }))
const staff = vi.hoisted(() => ({ role: 'owner' as string | null, permissionKeys: [] as string[], permissionViewKeys: [] as string[] }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => nav.pathname }))
vi.mock('@/lib/staff-role', () => ({ useStaffIdentity: () => (staff.role ? staff : null) }))

import NotFoundV8 from './not-found'
import { missingPathLabel } from './frequent-destinations'

function renderNotFound() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<NotFoundV8 />))
  return { host, close: () => { act(() => root.unmount()); host.remove() } }
}

afterEach(() => {
  nav.pathname = '/no-such-page'
  staff.role = 'owner'
  staff.permissionKeys = []
  staff.permissionViewKeys = []
})

describe('not-found の空白パス・制御文字ガード', () => {
  it('空白のみ・制御文字のみのパスでは空の「開こうとしたページ」を出さない', () => {
    expect(missingPathLabel('   ')).toBeNull()
    expect(missingPathLabel('   ?token=secret')).toBeNull()
    expect(missingPathLabel('/%0a%0d')).toBeNull()

    nav.pathname = '   ?token=secret'
    const first = renderNotFound()
    try {
      expect(first.host.textContent).not.toContain('開こうとしたページ：')
    } finally {
      first.close()
    }

    nav.pathname = '/%0a%0d'
    const second = renderNotFound()
    try {
      expect(second.host.textContent).not.toContain('開こうとしたページ：')
    } finally {
      second.close()
    }
  })

  it('URL エンコードされた改行などの制御文字を取り除いて1行のパス表示を保つ', () => {
    nav.pathname = '/friends/%0a%0dmissing'
    const { host, close } = renderNotFound()
    try {
      const pathEl = [...host.querySelectorAll('p')].find((p) => p.textContent?.startsWith('開こうとしたページ：'))
      expect(pathEl?.textContent).toBe('開こうとしたページ：/friends/missing')
      expect(pathEl?.getAttribute('title')).toBe('/friends/missing')
    } finally {
      close()
    }
  })
})
