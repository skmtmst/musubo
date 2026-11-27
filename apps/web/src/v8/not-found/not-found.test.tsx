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
import { frequentDestinations, missingPathLabel } from './frequent-destinations'

function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<NotFoundV8 />))
  return { host, close: () => { act(() => root.unmount()); host.remove() } }
}

const linkLabels = (host: HTMLElement) => [...host.querySelectorAll('nav[aria-label="よく使うページ"] a')].map((a) => `${a.textContent}=${a.getAttribute('href')}`)

afterEach(() => {
  nav.pathname = '/no-such-page'
  staff.role = 'owner'
  staff.permissionKeys = []
  staff.permissionViewKeys = []
})

/** ★V8 見つからない画面（板 ）。戻る道を2つ（前のページ・ダッシュボード）とよく使うページを出す。 */
describe('見つからない画面（V8）', () => {
  it('題・説明・前のページへ戻る（副）・ダッシュボードへ（主）', () => {
    const { host, close } = render()
    expect(host.querySelector('[data-design-node="Nx5dz"]')).not.toBeNull()
    expect(host.querySelector('h2')?.textContent).toBe('ページが見つかりません')
    expect(host.textContent).toContain('URL がまちがっているか、ページが移動・削除された可能性があります。')
    const dashboard = [...host.querySelectorAll('a')].find((a) => a.textContent === 'ダッシュボードへ')
    expect(dashboard?.getAttribute('href')).toBe('/')
    const back = [...host.querySelectorAll('button')].find((b) => b.textContent === '前のページへ戻る')
    expect(back).toBeTruthy()
    act(() => back!.click())
    // 直接開いた（履歴が1つ）ときはダッシュボードへ
    expect(router.back.mock.calls.length + router.push.mock.calls.length).toBe(1)
    close()
  })

  it('開けなかったページの道を小さく1行で出す', () => {
    nav.pathname = '/friends/%E5%A4%89'
    const { host, close } = render()
    const path = [...host.querySelectorAll('p')].find((p) => p.textContent?.startsWith('開こうとしたページ：'))
    expect(path?.textContent).toBe('開こうとしたページ：/friends/変')
    expect(path?.getAttribute('title')).toBe('/friends/変')
    close()
  })

  it('よく使うページ（受信箱・友だち・一斉配信）へのリンクを出す', () => {
    const { host, close } = render()
    expect(linkLabels(host)).toEqual(['受信箱=/chats', '友だち=/friends', '一斉配信=/broadcasts'])
    close()
  })

  it('一斉配信を任されていない担当者には一斉配信のリンクを出さない', () => {
    staff.role = 'staff'
    staff.permissionKeys = ['/friends']
    const { host, close } = render()
    expect(linkLabels(host)).toEqual(['受信箱=/chats', '友だち=/friends'])
    close()
  })

  it('本人の情報を読み終えるまでは一斉配信のリンクを出さない', () => {
    staff.role = null
    const { host, close } = render()
    expect(linkLabels(host)).toEqual(['受信箱=/chats', '友だち=/friends'])
    close()
  })

  it('見るだけで任された担当者には一斉配信のリンクを出す', () => {
    staff.role = 'staff'
    staff.permissionViewKeys = ['/broadcasts']
    const { host, close } = render()
    expect(linkLabels(host)).toContain('一斉配信=/broadcasts')
    close()
  })
})

describe('見つからない画面の道とリンクの決め方', () => {
  it('クエリと # は出さない（秘密値が乗ることがある）', () => {
    expect(missingPathLabel('/reset?token=abc#x')).toBe('/reset')
    expect(missingPathLabel('/a#b')).toBe('/a')
  })

  it('道が無い・ホームのときは出さない。壊れた文字はそのまま', () => {
    expect(missingPathLabel(null)).toBeNull()
    expect(missingPathLabel('/')).toBeNull()
    expect(missingPathLabel('/%E0%A4%A')).toBe('/%E0%A4%A')
  })

  it('役割を読み終えるまでは一斉配信を出さない', () => {
    expect(frequentDestinations(null, ['/broadcasts'], []).map((d) => d.href)).toEqual(['/chats', '/friends'])
    expect(frequentDestinations('admin', [], []).map((d) => d.href)).toEqual(['/chats', '/friends', '/broadcasts'])
  })
})

it('統括の未知のページでは統括内へ戻れる', () => {
  nav.pathname = '/hq/missing-example'
  const { host, close } = render()
  try {
    const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toContain('/hq')
    expect(links).toContain('/hq/attention')
    expect(links).not.toContain('/')
    expect(links).not.toContain('/chats')
    expect(links).not.toContain('/friends')
  } finally { close() }
})


it('運営の存在しないページでは運営のダッシュボードへ戻れる', () => {
  nav.pathname = '/ops/missing-example'
  const { host, close } = render()
  try {
    const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toContain('/ops/dashboard')
    expect(links).toContain('/ops/tenants')
    expect(links).toContain('/ops/support')
    expect(links).not.toContain('/')
    expect(links).not.toContain('/chats')
    expect(host.textContent).toContain('運営ダッシュボードへ')
    const historyLength = vi.spyOn(window.history, 'length', 'get').mockReturnValue(1)
    try {
      act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === '前のページへ戻る')!.click())
      expect(router.push).toHaveBeenCalledWith('/ops/dashboard')
    } finally { historyLength.mockRestore() }
  } finally { close() }
})
