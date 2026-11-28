// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 オートメーションの見本の動きの試験。BEHAVIOR.md の「見本」の節を守る。
 * きっかけの札（先に出てきた順に6つまで・かっこの補足はまとめる）、見本から下書きを作る、
 * 閲覧のみでは押せない「この見本で下書きを作る」「見本から作る」を置かない。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/automations',
  useSearchParams: () => new URLSearchParams('tab=templates'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import AutomationTemplatesV8 from '@/v8/automations/templates'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const template = (key: string, name: string, triggerLabel: string) => ({ key, name, description: '', triggerLabel, actionLabel: 'メッセージを送る' })
const templates = [
  template('a', '友だち追加のあいさつ', '友だちになったとき'),
  template('b', '「予約」と送られたら担当へ', 'メッセージを受け取ったとき（含まれる言葉）'),
  template('c', 'VIP タグでシナリオ開始', 'タグが付いたとき'),
  template('d', 'アンケートの回答でタグ', 'フォームに答えたとき'),
  template('e', '予約のお礼', '予約が確定したとき'),
  template('f', '購入のお礼', '注文が確定したとき'),
  template('g', '初回購入でマイル', '注文が確定したとき（初回）'),
  template('h', '発送のお知らせ', '注文が発送されたとき'),
]

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const posted: string[] = []
const postDetails: Array<{ account: string | null; operationKey: unknown }> = []

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  role.value = verifiedStaffRole('owner')
  push.mockReset()
  posted.length = 0
  postDetails.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST' && url.pathname.startsWith('/api/automation-templates/')) {
      posted.push(url.pathname)
      postDetails.push({ account: url.searchParams.get('account_id'), operationKey: JSON.parse(String(init.body)).operationKey })
      return json({ success: true, data: { id: 'draft-1', draftVersionId: 'draft-1-v1' } }, 201)
    }
    if (url.pathname === '/api/automation-templates') return json({ success: true, data: templates })
    if (url.pathname === '/api/automations') {
      return json({ success: true, data: [], summary: { active: 0, stopped: 0, executionCount30d: 0, failureCount30d: 0 } })
    }
    if (url.pathname === '/api/automation-runs') return json({ success: true, data: { summary: { skipped: 0 } } })
    if (url.pathname === '/api/common-actions') return json({ success: true, data: [] })
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function render() {
  await act(async () => { root.render(<AutomationTemplatesV8 />) })
  for (let i = 0; i < 60 && !(host.textContent ?? '').includes('友だち追加のあいさつ'); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  }
}

const buttons = () => [...host.querySelectorAll('button, a')] as HTMLElement[]
const named = (text: string) => buttons().filter((element) => (element.textContent ?? '').trim() === text)


describe('見本の表示と下書き', () => {
  it('選んだアカウントの見本を読み、きっかけを選ぶと該当だけ表示する', async () => {
    const seen: string[] = []
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input)); return originalFetch(input, init)
    })
    await render()
    const requests = seen.map(url => new URL(url)).filter(url => url.pathname === '/api/automation-templates')
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.map(url => url.searchParams.get('account_id'))).toEqual(requests.map(() => 'account-a'))
    expect(host.querySelector('[data-design-node="c7dxp"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="きっかけで絞り込む"]')).not.toBeNull()
    expect(host.textContent).toContain('きっかけ')
    const reload = named('見本を再読み込み')[0]!
    expect(reload).toBeTruthy()
    const beforeReload = requests.length
    await act(async () => { reload.click() })
    for (let i = 0; i < 40 && seen.filter(url => new URL(url).pathname === '/api/automation-templates').length <= beforeReload; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(seen.filter(url => new URL(url).pathname === '/api/automation-templates').length).toBeGreaterThan(beforeReload)
    expect(host.textContent).not.toContain('誕生日クーポン')
    await act(async () => { named('+2')[0]!.click() })
    await act(async () => { named('注文が確定した')[0]!.click() })
    expect([...host.querySelectorAll('[role="listitem"] h2')].map(e => e.textContent)).toEqual(['購入のお礼', '初回購入でマイル'])
  })

  it('見本を選ぶと対象の下書きを作り、編集へ移動する', async () => {
    await render()
    await act(async () => { named('この見本で下書きを作る')[0]!.click() })
    for (let i = 0; i < 40 && push.mock.calls.length === 0; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(posted).toEqual(['/api/automation-templates/a/drafts'])
    expect(postDetails).toEqual([{ account: 'account-a', operationKey: expect.any(String) }])
    expect(postDetails[0]!.operationKey).not.toBe('')
    expect(push).toHaveBeenCalledWith('/automations/drafts?id=draft-1')
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining('/automations/new?draftId='))
  })

  it('見本の取得に失敗したら、まだ下書きがないことと再読込を案内する', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/api/automation-templates') return json({ success: false, error: 'internal secret' }, 500)
      return originalFetch(input, init)
    })
    await act(async () => { root.render(<AutomationTemplatesV8 />) })
    for (let i = 0; i < 40 && !host.textContent?.includes('見本を読み込めませんでした'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(host.textContent).toContain('見本を読み込めませんでした')
    expect(host.textContent).toContain('まだ下書きは作っていません')
    expect(host.textContent).not.toContain('internal secret')
    expect(posted).toEqual([])
    expect(push).not.toHaveBeenCalled()
  })

  it('下書きを作れなかったら内部エラーを出さず、編集へ移動しない', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ success: false, error: 'internal secret' }, 500)
      return originalFetch(input, init)
    })
    await render()
    await act(async () => { named('この見本で下書きを作る')[0]!.click() })
    for (let i = 0; i < 40 && !host.textContent?.includes('下書きを作れませんでした'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(host.textContent).toContain('下書きを作れませんでした')
    expect(host.textContent).not.toContain('internal secret')
    expect(push).not.toHaveBeenCalled()
  })
})
