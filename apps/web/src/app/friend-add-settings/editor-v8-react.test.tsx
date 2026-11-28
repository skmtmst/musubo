import { getPageAction, querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

// apiクライアントは起動時にAPI URLを要求する。実通信はfetch差替で止める。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import FriendAddSettingsPage from './page'

/*
 * ★V8 友だち追加時の配信を作る手順（板 ・・・
 * ・）の契約。`<html data-theme="v8">` の下でだけ
 * 新しい作る手順に切り替わり、手順の輪・右の「設定内容」・下の帯が
 */
const navigation = vi.hoisted(() => ({ account: 'account-a', query: 'view=new&step=basic' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/friend-add-settings',
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: navigation.account, selectedAccount: null, loading: false, accounts: [{ id: 'account-a' }],
}) }))
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...original, useStaffRole: () => 'admin' }
})

let root: Root
let host: HTMLDivElement
const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const listData = {
  items: [],
  total: 0,
  nextCursor: null,
  folderCounts: [],
  summary: { rules: 0, active: 0, recentAdds: 0, captured: 0, unknownRoute: 0, delivered: 0, failed: 0 },
  options: {
    routes: [{ id: 'route-shop', name: '店頭QRコード', kind: 'QR' }],
    scenarios: [{ id: 'scenario-welcome', name: '新規登録7日間フォロー' }],
    tags: [{ id: 'tag-new', name: '新規友だち' }],
    folders: [{ id: 'f-1', name: '店頭' }],
  },
}

function base(url: URL) {
  if (url.pathname === '/api/staff/me') return response({ success: true, data: { role: 'admin' } })
  if (url.pathname === '/api/friend-add-rules') return response({ success: true, data: listData })
  if (url.pathname === '/api/friend-add-rules/conflicts') return response({ success: true, data: { rules: [], conflicts: [] } })
  if (url.pathname === '/api/friend-add-rules/test-draft') return response({ success: true, data: {
    rule: {
      id: 'test-draft', name: '案内', folderName: null, priority: 1, friendKind: 'first_time',
      isFallback: false, status: 'draft', matchedLast7Days: null, lastTestStatus: null, version: 1,
      definition: { routeIds: [], scenarioId: null, messageType: 'text', messageText: 'こんにちは',
        timing: 'immediate', actions: [], friendCondition: '', activeFrom: '2026-10-01T00:00', activeUntil: '2026-11-30T23:59' },
    },
    options: listData.options,
  } })
  return response({ success: true, data: {} })
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 5000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

beforeEach(() => {
  navigation.account = 'account-a'
  navigation.query = 'view=new&step=basic'
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const values = new Map<string, string>()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return base(url)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('v8 の作る①は板 wDzkc・手順の輪・設定内容・下の帯が出る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddSettingsPage />))
  await settle()
  await eventually(() => {
    expect(host.querySelector('[data-design-node="wDzkc"]')).toBeTruthy()
  })
  expect(host.textContent).toContain('初回案内を作る')
  expect(host.textContent).toContain('設定内容')
  expect(getPageAction({ name: '下書きを保存' })).toBeTruthy()
  expect(host.textContent).toContain('次へ：流入リンク')
  expect(host.textContent).toContain('だれに送るか')
})


test('名前が空なら保存せず、理由を1回だけ出し、赤い名前欄へ移る', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddSettingsPage />))
  await eventually(() => expect(host.querySelector('#fa-name')).toBeTruthy())
  const save = ([...host.querySelectorAll('button')].find((button) => button.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
  await act(async () => save.click())
  const name = host.querySelector<HTMLInputElement>('#fa-name')!
  await eventually(() => expect(document.activeElement).toBe(name))
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(name.getAttribute('aria-describedby')?.split(' ').map(id=>document.getElementById(id)).find(node=>node?.getAttribute('role')==='alert')?.textContent).toBe('設定名を入力してください。')
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  await act(async () => fireEvent.change(name, { target: { value: '初回案内' } }))
  expect(name.getAttribute('aria-invalid')).toBeNull()
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test('流入リンクが未選択なら次へ進まず、選択欄と理由をつなぎ、最初の選択欄へ移る', async () => {
  navigation.query = 'view=edit&id=test-draft&step=routes'
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddSettingsPage />))
  await eventually(() => expect(host.querySelector('[data-friend-add-routes] input[type="checkbox"]')).toBeTruthy())
  const search = host.querySelector<HTMLInputElement>('input[aria-label="流入リンクの名前で探す"]')!
  const next = ([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('次へ：初回案内')) ?? querySupplementaryPageAction('次へ：初回案内'))!
  await act(async () => next.click())
  const checkbox = host.querySelector<HTMLInputElement>('[data-friend-add-routes] input[type="checkbox"]')!
  await eventually(() => expect(document.activeElement).toBe(checkbox))
  expect(checkbox.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(checkbox.getAttribute('aria-describedby')!)?.textContent).toBe('対象にする流入リンクを1つ以上選んでください。')
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(search.getAttribute('aria-invalid')).toBeNull()
  await act(async () => checkbox.click())
  expect(checkbox.getAttribute('aria-invalid')).toBeNull()
})

test('シナリオが未選択なら選べる赤い欄へ移り、選ぶと誤りを消す', async () => {
  navigation.query = 'view=edit&id=test-draft&step=message'
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddSettingsPage />))
  await eventually(() => expect(host.querySelector('[aria-label="最初に送るメッセージ"]')).toBeTruthy())
  const next = ([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('次へ：あわせて行うこと')) ?? querySupplementaryPageAction('次へ：あわせて行うこと'))!
  await act(async () => next.click())
  const field = () => host.querySelector<HTMLElement>('#fa-scenario')!
  const open = () => host.querySelector<HTMLButtonElement>('button[aria-label="実際に配信するシナリオ：選択する"]')!
  await eventually(() => expect(document.activeElement).toBe(open()))
  expect(field().getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  await act(async () => open().click())
  await act(async () => document.querySelector<HTMLInputElement>('input[type="radio"][aria-label="新規登録7日間フォロー"]')!.click())
  const confirm = ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '選択する') ?? querySupplementaryPageAction('選択する'))!
  await act(async () => confirm.click())
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test('未入力のまま次へを押しても、名前欄へ移り、保存・画面移動はしない', async () => {
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddSettingsPage />))
  await eventually(() => expect(host.querySelector('#fa-name')).toBeTruthy())
  const next = ([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('次へ：流入リンク')) ?? querySupplementaryPageAction('次へ：流入リンク'))!
  await act(async () => next.click())
  await eventually(() => expect(document.activeElement?.id).toBe('fa-name'))
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  expect(host.querySelector('[data-friend-add-routes]')).toBeNull()
})


test('狭い画面の条件編集は小窓で開き、変更した期間を閉じたあとも保存する', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query === '(max-width: 1280px)', media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => true,
  }))
  navigation.query = 'view=edit&id=test-draft&step=routes'
  document.documentElement.dataset.theme = 'v8'
  await act(async () => root.render(<FriendAddSettingsPage />))
  await eventually(() => expect(host.querySelector('[data-friend-add-routes]')).toBeTruthy())
  expect(host.querySelector('#fa-from')).toBeNull()
  const open = ([...host.querySelectorAll('button')].find((button) => button.textContent?.replace(/\s/g, '') === '対象をしぼる任意') ?? querySupplementaryPageAction('対象をしぼる任意'))!
  await act(async () => open.click())
  await eventually(() => expect(document.querySelector('[role="dialog"] #fa-from')).toBeTruthy())
  const dialog = document.querySelector('[role="dialog"]')!
  const clear = dialog.querySelector<HTMLButtonElement>('[aria-label="日時を消す"]')!
  await act(async () => clear.click())
  expect(dialog.querySelector('#fa-from')?.textContent).toBe('日時を選ぶ')
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click())
  await eventually(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  const save = ([...host.querySelectorAll('button')].find((button) => button.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
  await act(async () => save.click())
  const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT')!
  const payload = JSON.parse(String(request[1]?.body))
  expect(payload.definition.activeFrom).toBeNull()
  expect(payload.definition.activeUntil).toBe('2026-11-30T23:59')
})

test('WEB155: 新規作成のアカウント切替で前の名前を引き継がない', async () => {
 document.documentElement.dataset.theme='v8'
 await act(async()=>root.render(<FriendAddSettingsPage/>));await settle()
 const name=host.querySelector<HTMLInputElement>('input[placeholder="例：店頭QRの初回案内"]') ?? host.querySelector<HTMLInputElement>('input')!
 fireEvent.change(name,{target:{value:'前のアカウントの名前'}})
 expect(name.value).toBe('前のアカウントの名前')
 navigation.account='account-b'
 await act(async()=>root.render(<FriendAddSettingsPage/>));await settle()
 expect([...host.querySelectorAll<HTMLInputElement>('input')].some(input=>input.value==='前のアカウントの名前')).toBe(false)
})

test('WEB157: 競合の比較はシナリオと条件の差も表示する',async()=>{
 navigation.query='view=edit&id=test-draft&step=basic'
 let reads=0
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
  if(url.pathname.startsWith('/api/friend-add-rules/test-draft')){
   if(init?.method && init.method!=='GET') return response({success:false,error:'先に保存されました'},409)
   const original=await base(url).json();reads++
   if(reads>1){original.data.rule.definition.scenarioId='changed-scenario';original.data.rule.definition.friendCondition='条件が変わった'}
   return response(original)
  }
  return base(url)
 }))
 await act(async()=>root.render(<FriendAddSettingsPage/>));await settle()
 const save=([...host.querySelectorAll('button')].find(button=>button.textContent?.includes('下書きを保存')) ?? querySupplementaryPageAction('下書きを保存'))!
 await act(async()=>save.click());await settle()
 const compare=([...host.querySelectorAll('button')].find(button=>button.textContent?.includes('違いを比べる')) ?? querySupplementaryPageAction('違いを比べる'))!
 expect(compare).toBeTruthy()
 await act(async()=>compare.click());await settle()
 expect(document.body.textContent).toContain('友だちの条件')
 expect(document.body.textContent).toContain('changed-scenario')
});

test('初回案内の複製は変更と作りかけのフォルダを両方確認する', async () => {
  navigation.query = 'view=edit&id=test-draft&step=basic'
  await act(async () => { root.render(<FriendAddSettingsPage />) })
  await eventually(() => expect(host.querySelector('#fa-name')).toBeTruthy())
  await act(async () => { fireEvent.change(host.querySelector('#fa-name')!, { target: { value: '変更中の案内' } }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' })) })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成途中' } }); fireEvent.pointerDown(document.body) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '初回案内の操作' })) })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '複製する' })) })
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' }).textContent).toContain('作りかけのフォルダ')
})
