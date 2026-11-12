import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
/*
 * V8 友だち追加時の配信の一覧（src/v8）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 管理者には作る・行の操作が出る・閲覧のみには変える操作を置かない（帯は出す）・
 * 受け皿の「…」は止める（案内の窓）だけで削除を出さない・送るものの2行目は1行にまとめる。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const accountState = vi.hoisted(() => ({ id: 'account-a' }))
const navigation = vi.hoisted(() => ({ query: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/friend-add-settings',
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountState.id, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

const roleState = vi.hoisted(() => ({ role: 'owner' as string }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => roleState.role }
})

import FriendAddListV8, { actionLine } from './list'
import type { FriendAddRule } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function rule(overrides: Partial<FriendAddRule> = {}): FriendAddRule {
  return {
    id: 'rule-shop', accountId: 'account-a', friendKind: 'first_time', name: '店頭QRの初回案内', folderName: '店頭',
    priority: 1, isFallback: false, status: 'published', versionId: 'v1', versionNumber: 1, versionStatus: 'published',
    lastTestStatus: null, lastTestedAt: null, lastTestedByStaffId: null, lastTestedByStaffName: null, publishedAt: null,
    matchedLast7Days: 41, version: 1, routeNames: ['店頭QRコード'], scenarioName: '7日間フォロー',
    definition: {
      routeIds: ['route-shop'], scenarioId: 'scenario-1', messageType: 'text', messageText: 'ようこそ', timing: 'immediate',
      actions: [
        { type: 'start_scenario', label: 'シナリオ「7日間フォロー」を開始する', targetId: 'scenario-1' },
        { type: 'add_tag', label: 'タグ「新規」を付ける', targetId: 'tag-1' },
      ],
      friendCondition: '', activeFrom: null, activeUntil: null,
    },
    ...overrides,
  }
}

const items = [
  rule(),
  rule({ id: 'rule-fallback', name: '経路が分からなかった人', isFallback: true, priority: 999, folderName: null, routeNames: [] }),
]

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  accountState.id = 'account-a'
  navigation.query = ''
  window.history.replaceState(null, '', '/friend-add-settings')
  window.dispatchEvent(new PopStateEvent('popstate'))
  roleState.role = verifiedStaffRole('owner')
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { role: roleState.role } })
    if (url.pathname === '/api/friend-add-rules') {
      return json({
        success: true,
        data: {
          items, total: items.length, nextCursor: null,
          folderCounts: [{ name: '店頭', count: 1 }, { name: null, count: 1 }],
          summary: { rules: 1, active: 1, recentAdds: 10, captured: 8, unknownRoute: 2, delivered: 9, failed: 1 },
          options: { routes: [], scenarios: [], tags: [], folders: [{ id: 'f1', name: '店頭', color: '#16a34a' }] },
        },
      })
    }
    return json({ success: true, data: null })
  })
})

it('編集から複製した下書きは、元の位置が別ページでも先頭に読み込み強調する', async () => {
  navigation.query = 'status=draft&highlight=copy'
  window.history.replaceState(null, '', `/friend-add-settings?${navigation.query}`)
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/friend-add-rules') return json({ success: true, data: {
      items: url.searchParams.get('highlight') === 'copy' ? [rule({ id: 'copy', status: 'draft', name: '複製した案内' })] : [],
      total: 21, nextCursor: null, folderCounts: [],
      summary: { rules: 21, active: 0, recentAdds: 0, captured: 0, unknownRoute: 0, delivered: 0, failed: 0 },
      options: { routes: [], scenarios: [], tags: [], folders: [] },
    } })
    return json({ success: true, data: null })
  })
  vi.stubGlobal('fetch', fetch)
  await render()
  await waitFor(() => expect(host.querySelector('[data-row-id="copy"]')?.getAttribute('aria-selected')).toBe('true'))
  expect(fetch.mock.calls.some(([input]) => new URL(String(input)).searchParams.get('highlight') === 'copy')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /下書き/ }))
  await waitFor(() => expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('highlight')).toBe(false))
  await waitFor(() => expect(new URLSearchParams(window.location.search).has('highlight')).toBe(false))
});

afterEach(() => {
  verifiedStaffRole(null)
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => { root.render(<FriendAddListV8 />) })
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

const buttons = () => Array.from(host.querySelectorAll('button, a')).map((el) => el.textContent?.trim() ?? '')
const openMenu = async (name: string) => {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="設定「${name}」の操作"]`)
  expect(button).not.toBeNull()
  await act(async () => { button!.click() })
  return Array.from(document.querySelectorAll('[role="menuitem"]')).filter(el => !el.closest('[aria-hidden="true"], [inert]')).map((el) => el.textContent?.trim() ?? '')
}

describe('友だち追加時の配信の一覧（V8）', () => {
  it('一覧が遅いときは、読み上げの文を残したまま0.3秒後に行の形の骨組みを出す', async () => {
    let complete!: (value: Response) => void
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/friend-add-rules') return new Promise<Response>((resolve) => { complete = resolve })
      return json({ success: true, data: null })
    })
    await act(async () => { root.render(<FriendAddListV8 />) })
    const status = () => Array.from(host.querySelectorAll('[role="status"][aria-busy="true"]'))
      .find((el) => el.querySelector('.sr-only')?.textContent === '友だち追加時の配信を読み込んでいます')
    expect(status()).toBeTruthy()
    expect(status()?.querySelector('[data-skeleton-reserve] [data-skeleton]')).not.toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 330)) })
    expect(status()?.querySelector('[data-skeleton-reserve]')).toBeNull()
    expect(status()?.querySelector('[data-skeleton]')).not.toBeNull()
    await act(async () => complete(json({ success: true, data: {
      items, total: items.length, nextCursor: null, folderCounts: [],
      summary: { rules: 1, active: 1, recentAdds: 0, captured: 0, unknownRoute: 0, delivered: 0, failed: 0 },
      options: { routes: [], scenarios: [], tags: [], folders: [] },
    } })))
    await waitFor(() => expect(host.textContent).toContain('店頭QRの初回案内'))
    expect(status()).toBeUndefined()
  })

  it('送るものの2行目はシナリオ・タグを1行にまとめる（シナリオの重ねは出さない）', () => {
    expect(actionLine(rule())).toBe('＋シナリオ「7日間フォロー」 ＋タグ「新規」')
  })

  it('管理者には作るボタンと行の変える操作が出る。受け皿の「…」に削除は出ない', async () => {
    await render()
    expect(buttons().some((text) => text.includes('初回案内を作る'))).toBe(true)
    expect(buttons().some((text) => text.includes('フォルダを追加'))).toBe(true)
    const regular = await openMenu('店頭QRの初回案内')
    expect(regular).toEqual(expect.arrayContaining(['編集する', '実行結果を見る', '止める', '保管する']))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    const sink = await openMenu('経路が分からなかった人')
    expect(sink).toContain('止められない理由を見る')
    expect(sink).not.toContain('止める')
    expect(sink).not.toContain('保管する')
  })

  it('配信を止める前に実際のアカウントと環境を確認する', async () => {
    await render(); await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name: '止める' }).click() })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('LINEアカウント'); expect(dialog.textContent).toContain('本店'); expect(dialog.textContent).toContain('環境')
  })

  it('アカウントを切り替えて戻した後、古い停止を実行しない', async () => {
    const existingFetch = globalThis.fetch
    const requests = vi.fn((...args: Parameters<typeof fetch>) => existingFetch(...args))
    vi.stubGlobal('fetch', requests)
    await render(); await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name: '止める' }).click() })
    const button = within(screen.getByRole('dialog')).getByRole('button', { name: '止める' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    await act(async () => { accountState.id = 'account-b'; root.render(<FriendAddListV8 />) })
    await act(async () => { accountState.id = 'account-a'; root.render(<FriendAddListV8 />) })
    await act(async () => { await handler({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:button, target:button }) })
    expect(requests.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('保管前に実際のアカウントと環境を確認する', async () => {
    await render(); await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name: '保管する' }).click() })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('LINEアカウント'); expect(dialog.textContent).toContain('本店'); expect(dialog.textContent).toContain('環境')
  })

  it('アカウントを切り替えて戻しても古い保管を実行しない', async () => {
    const existingFetch = globalThis.fetch
    const requests = vi.fn((...args: Parameters<typeof fetch>) => existingFetch(...args))
    vi.stubGlobal('fetch', requests)
    await render(); await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name: '保管する' }).click() })
    const dialog = screen.getByRole('alertdialog')
    const button = within(dialog).getByRole('button', { name: '保管する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    await act(async () => { accountState.id = 'account-b'; root.render(<FriendAddListV8 />) })
    await act(async () => { accountState.id = 'account-a'; root.render(<FriendAddListV8 />) })
    await act(async () => { await handler({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:button, target:button }) })
    expect(requests.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('保管の確認を閉じると古い確定は送れず、新しい確定は版と状態を送る', async () => {
    const existingFetch = globalThis.fetch
    const requests = vi.fn((...args: Parameters<typeof fetch>) => existingFetch(...args))
    vi.stubGlobal('fetch', requests)
    await render(); await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name: '保管する' }).click() })
    const dialog = screen.getByRole('alertdialog')
    const button = within(dialog).getByRole('button', { name: '保管する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    await act(async () => { within(dialog).getByRole('button', { name: 'キャンセル' }).click() })
    await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name: '保管する' }).click() })
    await act(async () => { await handler({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:button, target:button }) })
    expect(requests.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    await act(async () => { within(screen.getByRole('alertdialog')).getByRole('button', { name: '保管する' }).click() })
    const request = requests.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(request).toBeTruthy()
    const url = new URL(String(request![0]))
    expect(url.searchParams.get('account_id')).toBe('account-a')
    expect(url.searchParams.get('expected_version')).toBe('1')
    expect(url.searchParams.get('expected_status')).toBe('published')
  })

  it('版が変わった保管は409を示し、読み直すまで再実行しない', async () => {
    const original = globalThis.fetch
    const requests = vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
      ? Promise.resolve(new Response(JSON.stringify({ success:false, code:'VERSION_CONFLICT', error:'設定が変更されました' }), { status:409, headers:{ 'Content-Type':'application/json' } }))
      : original(input, init))
    vi.stubGlobal('fetch', requests)
    await render(); await openMenu('店頭QRの初回案内')
    await act(async () => { screen.getByRole('menuitem', { name:'保管する' }).click() })
    const dialog = screen.getByRole('alertdialog')
    await act(async () => { within(dialog).getByRole('button', { name:'保管する' }).click() })
    expect(within(dialog).getByText('ほかの人が設定を変えました。読み直してから、もう一度選んでください。')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name:'保管する' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { within(dialog).getByRole('button', { name:'読み直す' }).click() })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(requests.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
  })

  it('81: 止められない案内の窓は［キャンセル］［受け皿の中身を編集する］の順', async () => {
    await render()
    await openMenu('経路が分からなかった人')
    const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((el) => el.textContent?.includes('止められない理由を見る')) as HTMLElement
    await act(async () => { item.click() })
    const dialog = await screen.findByRole('dialog')
    const pair = dialog.querySelector('[data-dialog-action-pair]') as HTMLElement
    const labels = Array.from(pair.querySelectorAll('button')).map((button) => (button.textContent ?? '').replace(/\s+/g, ''))
    expect(labels).toEqual(['キャンセル', '受け皿の中身を編集する'])
  })

  it('行の名前の前に、左のフォルダの列と同じフォルダの丸が付く（未分類は灰色の丸）。閲覧のみでも出す', async () => {
    roleState.role = verifiedStaffRole('viewer')
    await render()
    const filed = host.querySelector('[data-row-id="rule-shop"]')?.querySelectorAll('[data-folder-dot]') ?? []
    expect(filed).toHaveLength(1)
    expect(filed[0].getAttribute('data-folder-dot')).toBe('filed')
    expect(filed[0].getAttribute('aria-label')).toBe('フォルダ：店頭')
    const unfiled = host.querySelector('[data-row-id="rule-fallback"]')?.querySelectorAll('[data-folder-dot]') ?? []
    expect(unfiled).toHaveLength(1)
    expect(unfiled[0].getAttribute('data-folder-dot')).toBe('unfiled')
  })

  it('閲覧のみには変える操作を置かない（押せない形でも出さない）。閲覧のみの帯は出す', async () => {
    roleState.role = verifiedStaffRole('viewer')
    await render()
    expect(host.textContent).toContain('閲覧のみで見ています')
    expect(buttons().some((text) => text.includes('初回案内を作る'))).toBe(false)
    expect(buttons().some((text) => text.includes('フォルダを追加'))).toBe(false)
    expect(host.querySelector('[data-reorder-handle]')).toBeNull()
    expect(host.querySelector('[data-row-id="rule-shop"] [data-reorder-disabled]')).not.toBeNull()
    const menu = await openMenu('店頭QRの初回案内')
    expect(menu).toEqual(['実行結果を見る'])
  })
})

it('保存されたフォルダの色を設定名の前と左の列に表示する', async () => {
  await act(async () => { root.render(<FriendAddListV8 />) })
  const dot = host.querySelector('[data-folder-dot="filed"]') as HTMLElement
  expect(dot.style.backgroundColor).toBe('#16a34a')
  expect(host.innerHTML).toContain('#16a34a')
})

it('WEB160: 主シナリオと別の開始処理を両方要約する',()=>{
 const target=rule({definition:{...rule().definition, actions:[...rule().definition.actions,{type:'start_scenario',label:'別シナリオを開始する',targetId:'scenario-other'}]}})
 expect(actionLine(target)).toContain('別シナリオ')
});

it('WEB158: 表にはページ内の番号でなく保存済み優先順位を出す',async()=>{
 items[0].priority=21
 try { await render()
 const row=[...host.querySelectorAll('tbody tr')].find(row=>row.textContent?.includes('店頭QRの初回案内'))!
 expect(row.querySelector('td')?.textContent).toContain('21')
 } finally {items[0].priority=1}
});


it.each(['first_time', 'returning'])('共通だけの%sは設定1・有効0と母数を分けて説明する', async kind => {
  navigation.query = `kind=${kind}`
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/friend-add-rules') return json({ success: true, data: {
      items: [rule({ isFallback: true, friendKind: kind as 'first_time' | 'returning' })], total: 1, nextCursor: null, folderCounts: [],
      summary: { rules: 1, active: 0, recentAdds: 0, captured: 0, unknownRoute: 0, delivered: 0, failed: 0 },
      options: { routes: [], scenarios: [], tags: [], folders: [] },
    } })
    return json({ success: true, data: null })
  })
  await render()
  const card = [...host.querySelectorAll('[data-kpi-presentation]')].find(el => el.textContent?.startsWith('初回案内'))!
  expect(card.textContent).toMatch(/1\s*件/)
  expect(card.textContent).toMatch(/有効\s*0\s*件（共通は別）/)
  fireEvent.click(screen.getByRole('button', { name: '初回案内の説明', exact: true }))
  expect(screen.getByText(/設定数には共通の案内を含みます/)).toBeTruthy()
})

it('設定の集計が失敗したときは有効0とせず、失敗の理由を残す', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => new URL(String(input)).pathname === '/api/friend-add-rules'
    ? new Response(JSON.stringify({ success: false, error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    : json({ success: true, data: null }))
  await render()
  expect(host.textContent).toContain('読み込めませんでした')
  expect(host.textContent).not.toContain('有効 0')
})
it('友だち追加時のフォルダ名を編集中は移動前に確認する', async () => {
  await render()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' })) })
  const dialog = screen.getByRole('dialog')
  await act(async () => { fireEvent.change(within(dialog).getByLabelText('フォルダ名'), { target: { value: '店頭' } }) })
  const link = document.createElement('a')
  link.href = '/events'
  link.textContent = 'イベントへ'
  document.body.append(link)
  await act(async () => { fireEvent.click(link) })
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})
