// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Tenants from './tenants/page'
import Announcements from './announcements/page'
import Audit from './audit/page'
import Members from './members/page'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const cases = [
  { name: '契約先', Page: Tenants, path: '/api/ops/tenants', empty: '該当する契約先がありません' },
  { name: 'お知らせ', Page: Announcements, path: '/api/ops/announcements', empty: 'まだお知らせはありません' },
  { name: '監査', Page: Audit, path: '/api/ops/audit', empty: '記録がありません' },
  { name: 'メンバー', Page: Members, path: '/api/ops/members', empty: '運営メンバーがいません' },
]

describe.each(cases)('$name の一覧', ({ Page, path, empty }) => {
  it('取得失敗は空欄と区別し、再取得が成功すると空の案内に変わる', async () => {
    let fail = true
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === path) {
        calls += 1
        if (fail) return new Response(JSON.stringify({ error: 'private failure' }), { status: 500 })
        return new Response(JSON.stringify({ success: true, data: [], total: 0 }), { status: 200 })
      }
      if (url.pathname === '/api/ops/me') return new Response(JSON.stringify({ success: true, data: { id: 'me', readOnly: false } }), { status: 200 })
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
    }))
    const { container } = render(<Page />)
    await waitFor(() => expect(container.querySelector('[data-list-state="error"]')).not.toBeNull())
    expect(screen.queryByText(empty)).toBeNull()
    const before = calls
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.getByText(empty)).toBeTruthy())
    expect(container.querySelector('[data-list-state="error"]')).toBeNull()
    expect(calls).toBeGreaterThan(before)
  })
})

it('自分の情報取得が失敗してもメンバー一覧は読込中に固まらない', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/ops/me') return new Response(JSON.stringify({ error: 'private failure' }), { status: 500 })
    return new Response(JSON.stringify({ success: true, data: [], total: 0 }), { status: 200 })
  }))
  const { container } = render(<Members />)
  await waitFor(() => expect(screen.getByText('運営メンバーがいません')).toBeTruthy())
  expect(container.querySelector('[data-list-state="loading"]')).toBeNull()
})
