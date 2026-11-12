import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * V8 流入と計測の一覧（src/v8）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 行の「…」から QR コードの小窓が開く・停止中の行は URL を出さない・
 * 閲覧のみは作る／編集を出さない・未登録 ref は「登録する」・数の帯の未設定の数。
 */
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { currentListLocation, flushListUrlState } from '@/components/shared/list-url-state'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/inflow-links',
  useSearchParams: () => new URLSearchParams(''),
}))

const account = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [], loading: false }),
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

import InflowListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const route = (overrides: Record<string, unknown>) => ({
  id: 'er-1', refCode: 'summer-ig', genre: 'SNS', name: '夏のInstagram投稿', tagId: 'tag-1', scenarioId: null,
  redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: true,
  stoppedAt: null, stoppedReason: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
})

const ROUTES = [
  route({}),
  route({ id: 'er-6', refCode: 'flyer-26s', genre: null, name: 'チラシ計測リンク', tagId: null, isActive: false }),
  route({ id: 'er-4', refCode: 'ad-summer', genre: '広告', name: 'Google広告 夏キャンペーン', tagId: null }),
]
const SUMMARY = {
  routes: [
    { refCode: 'summer-ig', name: '夏のInstagram投稿', friendCount: 31, clickCount: 880, latestAt: '2026-09-30T09:40:00+09:00' },
    { refCode: 'mail-sign', name: 'メール署名', friendCount: 3, clickCount: 96, latestAt: '2026-09-26T11:02:00+09:00' },
  ],
  totalFriends: 115,
  friendsWithRef: 289,
  friendsWithoutRef: 23,
}

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  account.id = null
  flushListUrlState()
  window.history.replaceState(null, '', '/inflow-links')
  window.dispatchEvent(new PopStateEvent('popstate'))
  forgetStaffIdentity();
  role.value = 'owner'
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/entry-routes') return json({ success: true, data: ROUTES })
    if (url.pathname === '/api/entry-route-genres') return json({ success: true, data: [{ id: 'g-1', name: 'SNS', createdAt: '', updatedAt: '' }] })
    if (url.pathname === '/api/analytics/ref-summary') return json({ success: true, data: SUMMARY })
    if (url.pathname === '/api/tracked-links') return json({ success: true, data: [] })
    if (url.pathname === '/api/tags') return json({ success: true, data: [{ id: 'tag-1', name: 'Instagram' }] })
    return json({ success: true, data: [] })
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  flushListUrlState()
  window.history.replaceState(null, '', '/inflow-links')
  window.dispatchEvent(new PopStateEvent('popstate'))
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function render() {
  await act(async () => { root.render(<InflowListV8 />) })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}

const buttonByLabel = (label: string) =>
  [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label) as HTMLButtonElement | undefined
const rowOf = (refCode: string) => host.querySelector(`[data-row-id="${ROUTES.find(row => row.refCode === refCode)?.id ?? refCode}"]`)

describe('V8 流入と計測の一覧', () => {
  it('集計に記録がない経路は追加なしの件数と一覧に含まれる', async () => {
    await render()
    const presets = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('よく使う絞り込み'))!
    await act(async () => { presets.click() })
    const dialog = host.querySelector('[role="dialog"][aria-label="よく使う絞り込みと並び順"]')!
    const zero = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('友だち追加なし'))!
    expect(zero.textContent).toMatch(/友だち追加なし\s*2/)
    await act(async () => { zero.click() })
    expect(rowOf('flyer-26s')).toBeTruthy()
    expect(rowOf('ad-summer')).toBeTruthy()
    expect(rowOf('ad-summer')?.querySelector('[class*="colFriends"]')?.textContent).toContain('0 人')
    expect(rowOf('summer-ig')).toBeNull()
  })

  it('集計を読めない場合は友だちの数を不明と表示する', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/api/analytics/ref-summary') return json({ success: false, error: 'offline' })
      return originalFetch(input, init)
    })
    await render()
    expect(rowOf('ad-summer')?.querySelector('[class*="colFriends"]')?.textContent).toBe('—')
    const presets = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('よく使う絞り込み'))!
    await act(async () => { presets.click() })
    const dialog = host.querySelector('[role="dialog"][aria-label="よく使う絞り込みと並び順"]')!
    const buttons = [...dialog.querySelectorAll('button')]
    expect(buttons.find(button => button.textContent?.includes('友だち追加あり'))?.textContent?.trim()).toBe('友だち追加あり')
    expect(buttons.find(button => button.textContent?.includes('友だち追加なし'))?.textContent?.trim()).toBe('友だち追加なし')
  })

  it('アカウントを切り替えて戻しても古い停止確認は実行しない', async () => {
    const originalFetch = globalThis.fetch
    const updates: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') updates.push(String(input))
      return originalFetch(input, init)
    })
    account.id = 'account-a'
    await render()
    await act(async () => buttonByLabel('「夏のInstagram投稿」の操作')!.click())
    await act(async () => (([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('受付を止める')) ?? querySupplementaryPageAction('受付を止める')) as HTMLElement).click())
    const button = [...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent === '受付を停止する') as HTMLButtonElement
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const old = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    account.id = 'account-b'; await act(async () => root.render(<InflowListV8 />))
    account.id = 'account-a'; await act(async () => root.render(<InflowListV8 />))
    await act(async () => old())
    expect(updates).toEqual([])
  })
  it('アカウントを切り替えて戻しても古い削除確認は実行しない', async () => {
    const originalFetch = globalThis.fetch
    const deletes: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') deletes.push(String(input))
      return originalFetch(input, init)
    })
    account.id = 'account-a'
    await render()
    await act(async () => buttonByLabel('「夏のInstagram投稿」の操作')!.click())
    await act(async () => ([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('削除する')) as HTMLElement).click())
    const dialog = document.querySelector('[role="alertdialog"]')!
    const input = dialog.querySelector('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '夏のInstagram投稿'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.includes('削除する')) as HTMLButtonElement
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const old = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    account.id = 'account-b'; await act(async () => root.render(<InflowListV8 />))
    account.id = 'account-a'; await act(async () => root.render(<InflowListV8 />))
    await act(async () => old())
    expect(deletes).toEqual([])
  })
  it('未分類が0件でもフォルダから選んで空の一覧を見られる', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/entry-routes') return json({ success: true, data: ROUTES.filter(row => row.genre) })
      if (url.pathname === '/api/analytics/ref-summary') return json({ success: true, data: { ...SUMMARY, routes: [] } })
      return originalFetch(input, init)
    })
    await render()
    const folder = [...host.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('未分類'))
    expect(folder).toBeTruthy()
    await act(async () => { folder!.click() })
    expect(host.textContent).not.toContain('夏のInstagram投稿')
    expect(host.textContent).toContain('未分類')
  })

  it('受付を止める時だけ確認し、再開は押した直後に反映する', async () => {
    const originalFetch = globalThis.fetch
    const updates: Array<{ url: string; active: boolean }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/entry-routes/') && init?.method === 'PATCH') {
        updates.push({ url, active: JSON.parse(String(init.body)).isActive })
        return json({ success: true, data: route({}) })
      }
      return originalFetch(input, init)
    })
    await render()
    await act(async () => buttonByLabel('「夏のInstagram投稿」の操作')!.click())
    await act(async () => (([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('受付を止める')) ?? querySupplementaryPageAction('受付を止める')) as HTMLElement).click())
    expect(updates).toHaveLength(0)
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('受付を停止しますか？')
    const stop = ([...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent === '受付を停止する') ?? querySupplementaryPageAction('受付を停止する')) as HTMLElement
    await act(async () => stop.click())
    expect(updates).toHaveLength(1)
    expect(updates[0].active).toBe(false)
    await act(async () => buttonByLabel('「チラシ計測リンク」の操作')!.click())
    await act(async () => (([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('受付を再開する')) ?? querySupplementaryPageAction('受付を再開する')) as HTMLElement).click())
    expect(updates).toHaveLength(2)
    expect(updates[1].active).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('経路を止める確認に経路の所属アカウントと環境を示す', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/entry-routes') return json({ success: true, data: [route({ lineAccountId: 'account-a' })] })
      if (url.pathname === '/api/line-accounts') return json({ success: true, data: [{ id: 'account-a', name: '本店' }] })
      return originalFetch(input, init)
    })
    await render()
    await act(async () => buttonByLabel('「夏のInstagram投稿」の操作')!.click())
    await act(async () => (([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('受付を止める')) ?? querySupplementaryPageAction('受付を止める')) as HTMLElement).click())
    for (let i = 0; i < 4; i += 1) await act(async () => {})
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('LINEアカウント')
    expect(dialog?.textContent).toContain('本店')
    expect(dialog?.textContent).toContain('環境')
    expect(dialog?.textContent).toContain('受付先のすべてのアカウントは確認できません')
  })

  it('行の「…」から「QRコードを見る」を選ぶと、その経路の QR コードの小窓が開く', async () => {
    await render()
    const more = buttonByLabel('「夏のInstagram投稿」の操作')
    expect(more).toBeTruthy()
    await act(async () => { more!.click() })
    const qr = ([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('QRコードを見る')) ?? querySupplementaryPageAction('QRコードを見る')) as HTMLElement
    expect(qr).toBeTruthy()
    await act(async () => { qr.click() })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('夏のInstagram投稿 の QR コード')
    expect(dialog?.querySelector('textarea')?.value).toContain('/r/summer-ig')
    expect(dialog?.querySelector('a[href*="download=1"]')?.getAttribute('href')).toContain('summer-ig')
    expect(dialog?.textContent).toContain('画像をダウンロード')
    expect(dialog?.textContent).toContain('PDFで印刷')
  })

  it('停止の札と再開操作を保ち、正本QR窓でQR保存を止める', async () => {
    await render()
    const row = rowOf('flyer-26s')
    expect(row?.textContent).toContain('停止中')
    expect(buttonByLabel('チラシ計測リンクのURLをコピー')).toBeUndefined() // コピーは共通のその他操作へ
    await act(async () => { buttonByLabel('「チラシ計測リンク」の操作')!.click() })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    expect(labels.some((text) => text?.includes('QRコード'))).toBe(true)
    const qr = ([...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('QRコード')) ?? querySupplementaryPageAction('QRコード')) as HTMLElement
    await act(async () => qr.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止しています')
    expect([...document.querySelectorAll('a')].some(a => a.download.endsWith('.png'))).toBe(false)
    expect(labels.some((text) => text?.includes('受付を再開する'))).toBe(true)
  })

  it('未登録の ref の行は「登録する」、登録済みの編集はメニューへ', async () => {
    await render()
    expect(rowOf('mail-sign')?.textContent).toContain('未設定')
    expect(rowOf('mail-sign')?.textContent).toContain('登録する')
    expect(buttonByLabel('夏のInstagram投稿のリンクを編集')).toBeFalsy()
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="「夏のInstagram投稿」の操作"]')!.click() })
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('リンクを編集')
  })

  it('数の帯の「動きが未設定」は、タグもシナリオも無い登録済みの数（停止中も含む）', async () => {
    await render()
    const chips = host.querySelector('[role="group"][aria-label="流入経路の絞り込み"]')
    expect(chips?.textContent).toContain('動きが未設定 2')
  })

  it('数の帯は名前付き操作で未設定へ絞り込み、広告の2つの行き先と行の操作を保つ', async () => {
    await render()
    const band = host.querySelector('[data-kpi-strip]')!
    expect(band.querySelector('[data-row-menu],button[aria-haspopup="menu"]')).toBeNull()
    expect(band.querySelector('a[href*="tab=ads"]')?.textContent).toContain('広告連携を開く')
    expect(host.querySelector('a[href*="tab=connections"]')?.textContent).toContain('広告とのつなぎ')
    const filter = ([...band.querySelectorAll('button')].find(button => button.textContent === '未設定を見る') ?? querySupplementaryPageAction('未設定を見る'))!
    expect(rowOf('summer-ig')).toBeTruthy()
    await act(async () => { filter.click() })
    expect(currentListLocation().search).toContain('filter=unconfigured')
    expect(rowOf('summer-ig')).toBeNull()
    expect(rowOf('ad-summer')).toBeTruthy()
    expect(host.querySelector('tbody [data-row-menu]')).toBeTruthy()
  })

  // 2026-10-06 オーナー決定：閲覧のみには押せないボタンを置かずに隠す（帯は出す）。
  it('閲覧のみ（staff）は選ぶ枠と作る・編集・一括操作を出さない', async () => {
    role.value = 'staff'
    rememberStaffIdentity({ role: 'staff', permissionKeys: [] } as StaffMember)
    await render()
    expect(host.textContent).toContain('この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。')
    const create = [...host.querySelectorAll('button')].filter((button) => button.textContent?.includes('流入リンクを作る'))
    expect(create).toHaveLength(0)
    expect(buttonByLabel('夏のInstagram投稿のリンクを編集')).toBeFalsy()
    const selection = host.querySelector('[aria-label="夏のInstagram投稿をまとめて操作の対象にする"]') as HTMLInputElement
    expect(selection).toBeNull()
    expect(host.querySelector('[data-bulk-bar]')).toBeNull()
  })

  it('WEB032: 一覧を読み直しても、遅れて届いた候補（タグ名）を捨てない', async () => {
    let routeCalls = 0
    let releaseTags: () => void = () => undefined
    const tagsReady = new Promise<void>((resolve) => { releaseTags = resolve })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/entry-routes') {
        routeCalls += 1
        if (routeCalls === 1) return new Response(JSON.stringify({ success: false, error: 'down' }), { status: 503 })
        return json({ success: true, data: ROUTES })
      }
      if (url.pathname === '/api/entry-route-genres') return json({ success: true, data: [] })
      if (url.pathname === '/api/analytics/ref-summary') return json({ success: true, data: SUMMARY })
      if (url.pathname === '/api/tracked-links') return json({ success: true, data: [] })
      if (url.pathname === '/api/tags') {
        await tagsReady
        return json({ success: true, data: [{ id: 'tag-1', name: 'インスタ札' }] })
      }
      return json({ success: true, data: [] })
    })
    await render()
    const retry = ([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('もう一度')) ?? querySupplementaryPageAction('もう一度'))
    expect(retry).toBeTruthy()
    await act(async () => { retry!.click() })
    for (let i = 0; i < 4; i += 1) await act(async () => {})
    await act(async () => { releaseTags() })
    for (let i = 0; i < 6; i += 1) await act(async () => {})
    expect(rowOf('summer-ig')?.textContent).toContain('インスタ札')
  })

  it('WEB034（対照）: オーナーにはフォルダを追加がある', async () => {
    const requests = vi.fn(globalThis.fetch)
    vi.stubGlobal('fetch', requests)
    await render()
    expect([...host.querySelectorAll('button')].some((el) => (el.textContent ?? '').includes('フォルダを追加'))).toBe(true)
    const createLinks = [...host.querySelectorAll('a')].filter(link => link.textContent?.trim() === '流入リンクを作る')
    expect(createLinks.length).toBeGreaterThan(0)
    expect(createLinks.map(link => link.getAttribute('href'))).toEqual(createLinks.map(() => '/inflow-links/new'))
    const addFolder = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'フォルダを追加')!
    await act(async () => { addFolder.click() })
    expect(document.querySelector('[role="dialog"] input')).toBeTruthy()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('フォルダを追加')
    expect(requests.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET')).toHaveLength(0)
  })

  it('WEB034: 「流入」を任された staff には作る・編集を出し、フォルダの作成は出さない', async () => {
    const requests = vi.fn(globalThis.fetch)
    vi.stubGlobal('fetch', requests)
    role.value = 'staff'
    rememberStaffIdentity({ role: 'staff', permissionKeys: ['/inflow-links'] } as StaffMember)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'lh_staff_permissions' ? JSON.stringify(['/inflow-links']) : key === 'lh_staff_role' ? 'staff' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    })
    await render()
    expect(host.textContent).not.toContain('閲覧のみで見ています')
    expect([...host.querySelectorAll('a, button')].some((el) => el.textContent?.includes('流入リンクを作る'))).toBe(true)
    expect(buttonByLabel('夏のInstagram投稿のリンクを編集')).toBeFalsy()
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="「夏のInstagram投稿」の操作"]')!.click() })
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('リンクを編集')
    expect([...host.querySelectorAll('button')].some((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').includes('フォルダを追加'))).toBe(false)
    expect(requests.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET')).toHaveLength(0)
  })
})

it.each(['/api/entry-route-genres','/api/scenarios','/api/message-templates','/api/tags'])('%sの拒否は空の候補として隠さず読み直す',async(path)=>{
 const fixtureFetch=globalThis.fetch
 let failed=true,reads=0
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(new URL(String(input)).pathname===path){reads++;if(failed)throw new Error('fixture failure')}
  return fixtureFetch(input,init)
 })
 await render()
 const error=([...host.querySelectorAll('[data-list-state="error"]')].find(el=>el.textContent?.includes('読み込めませんでした')) ?? querySupplementaryPageAction('読み込めませんでした'))
 expect(error).toBeTruthy()
 failed=false
 await act(async()=>{(error!.querySelector('button') as HTMLButtonElement).click()})
 for(let i=0;i<8;i++)await act(async()=>{})
 expect(host.querySelector('[data-list-state="error"]')).toBeNull()
 expect(reads).toBeGreaterThanOrEqual(2)
})


it('D-18: 一覧から名前確認の後に削除し、失敗時は窓と入力を残す', async () => {
  const originalFetch = globalThis.fetch
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/entry-routes/er-1') && init?.method === 'DELETE') {
      requests.push(init)
      return new Response(JSON.stringify({success:false,code:'ENTRY_ROUTE_IN_USE',error:'利用履歴があるため削除できません'}), {status:409,headers:{'Content-Type':'application/json'}})
    }
    return originalFetch(input, init)
  })
  await render()
  await act(async () => buttonByLabel('「夏のInstagram投稿」の操作')!.click())
  const action = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('削除する')) as HTMLElement
  expect(action).toBeTruthy()
  await act(async () => action.click())
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('利用履歴がない経路だけ')
  expect(dialog.querySelector('[data-required-badge]')?.textContent).toBe('必須')
  const confirm = [...dialog.querySelectorAll('button')].find(el => el.textContent?.includes('削除する')) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  const input = dialog.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input, '夏のInstagram投稿'); input.dispatchEvent(new Event('input',{bubbles:true})) })
  expect(confirm.disabled).toBe(false)
  await act(async () => confirm.click())
  expect(requests).toHaveLength(1)
  expect(JSON.parse(String(requests[0].body))).toEqual({confirmationName:'夏のInstagram投稿'})
  expect(dialog.textContent).toContain('利用履歴があるため削除できません')
  expect(input.value).toBe('夏のInstagram投稿')
  expect(rowOf('summer-ig')).toBeTruthy()
})

it('D-18: 閲覧者には一覧の削除操作を出さない', async () => {
  role.value = 'viewer'
  await render()
  await act(async () => buttonByLabel('「夏のInstagram投稿」の操作')!.click())
  expect([...document.querySelectorAll('[role="menuitem"]')].some(el => el.textContent?.includes('削除する'))).toBe(false)
})

it('経路の数は含む範囲を説明する', async () => {
  await render()
  expect(host.textContent).toContain('停止中を含むすべての経路')
})

it('経路の取得中はフォルダ件数を0件と見せず、取得後に本当の件数を出す', async () => {
  const originalFetch = globalThis.fetch
  let complete!: (response: Response) => void
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/api/entry-routes') {
      return new Promise<Response>((resolve) => { complete = resolve })
    }
    if (new URL(String(input)).pathname === '/api/analytics/ref-summary') return Promise.resolve(json({ success: true, data: { ...SUMMARY, routes: [] } }))
    return originalFetch(input, init)
  })
  await act(async () => { root.render(<InflowListV8 />) })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
  const countFor = (name: string) => host.querySelector<HTMLButtonElement>(`[data-folder-select][title="${name}"]`)?.textContent?.trim()
  expect(countFor('すべて')).toBe('すべて')
  expect(countFor('未分類')).toBe('未分類')
  await act(async () => { complete(json({ success: true, data: ROUTES })) })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
  expect(countFor('すべて')).toBe('すべて3')
  expect(countFor('未分類')).toBe('未分類1')
})
