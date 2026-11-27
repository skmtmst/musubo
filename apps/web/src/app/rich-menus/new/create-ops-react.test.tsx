import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 リッチメニューを作る：作成の口へ送る中身・登録メディア・未保存の確認・板の印・競合の帯・スタッフの集計。
 * - 作るときは既定ページ・全員の既定・出し分け・順番・フォルダを作成の口1回で送り、フォルダを付け直す2口目を送らない
 * - 登録メディアは今のアカウントで選び、取り消しでは入力を捨てず、選んだ画像は作成の口へ渡す
 * - 選んだ画像だけでも未保存の入力として離れる前に確かめる
 * - 手順ごとに板の印を付ける
 * - 下書きの保存が競合したら帯を出し、最新を読み込んで続けられる
 * - スタッフは集計だけを読み、出す相手を変えられない
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const state = vi.hoisted(() => ({ role: 'owner', push: vi.fn(), pickerAccount: [] as Array<string | null> }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '店舗A' }, loading: false }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/rich-menus/new',
}))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({
  ...await importOriginal(), useStaffRole: () => state.role,
}))
/* フォルダの選ぶ欄は部品自身の試験が持つ。ここでは選んだ後の送り先を見る。 */
vi.mock('@/components/shared/folder-select', async (importOriginal: () => Promise<typeof import('@/components/shared/folder-select')>) => ({
  ...await importOriginal(),
  default: ({ value, onChange, folders }: { value: string; onChange: (value: string) => void; folders: Array<{ value: string; label: string }> }) => React.createElement(
    'select',
    { 'aria-label': 'フォルダ', value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    [React.createElement('option', { key: '', value: '' }, '未分類'), ...folders.map((folder) => React.createElement('option', { key: folder.value, value: folder.value }, folder.label))],
  ),
}))
/* 登録メディアの窓は部品自身の試験が持つ。ここでは開く相手と、選んだ・閉じたの受け取り方を見る。 */
vi.mock('@/v8/contents/public/media-picker-dialog/index', () => ({
  MediaPickerDialog: ({ open, accountId, onClose, onSelect }: { open: boolean; accountId: string | null; onClose: () => void; onSelect: (item: unknown) => void }) => {
    if (!open) return null
    state.pickerAccount.push(accountId)
    return React.createElement('div', { role: 'dialog', 'aria-label': '登録メディア' },
      React.createElement('button', { type: 'button', onClick: onClose }, '選ばずに閉じる'),
      React.createElement('button', { type: 'button', onClick: () => onSelect({ id: 'media-a', filename: '案内.png', mimeType: 'image/png', accountId: 'acc-1' }) }, '案内.png を選ぶ'),
    )
  },
}))

/* 条件の組み立ては部品自身の試験が持つ。ここでは集計だけの人に止められているかを見る。 */
vi.mock('@/components/shared/condition-builder', () => ({
  default: ({ label }: { label: string }) => React.createElement('input', { 'aria-label': label, defaultValue: '保存済みの条件' }),
}))

import RichMenuCreateV8 from '../../../v8/rich-menus/new/create'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const area = (id: string, x: number) => ({
  id, boundsX: x, boundsY: 0, boundsWidth: 1250, boundsHeight: 843, actionType: 'uri',
  actionData: { uri: 'https://nen.example/booking' }, intent: 'url', label: '予約する', tagIds: [], scoreChange: null,
  templateId: null, formId: null, trackedLinkId: null,
})
const GROUP = {
  id: 'rmg-x', accountId: 'acc-1', name: '通常メニュー', chatBarText: 'メニュー', size: 'large',
  isDefaultForAll: true, status: 'draft', targetingPriority: 1, targetingEnabled: false, targetingCondition: null,
  folderId: null, displayOrder: 1, version: 1, defaultPageId: 'p-top',
  pages: [{ id: 'p-top', orderIndex: 0, name: 'トップ', aliasId: 'a-top', lineRichmenuId: null, imageR2Key: null, imageContentType: null, areas: [area('a-1', 0), area('a-2', 1250)] }],
}

type Request = { path: string; method: string; body: unknown }
let requests: Request[] = []
let patchStatus = 200
let current: Record<string, unknown> = GROUP
let host: HTMLDivElement
let root: Root

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ path, method, body })
    if (path === '/api/staff/me') return json({ success: true, data: { id: 'me', role: state.role } })
    if (path === '/api/folders') return json({ success: true, data: [{ id: 'f-1', kind: 'rich_menu', name: '会員向け', parentId: null, displayOrder: 1, color: '#2f6fde' }] })
    if (path === '/api/rich-menu-groups' && method === 'POST') {
      return json({ success: true, data: { id: 'rmg-x', pages: [{ id: 'p-top' }] } })
    }
    if (path === '/api/rich-menu-groups/rmg-x') {
      if (method === 'PATCH' && patchStatus !== 200) {
        return json({ success: false, error: 'version_conflict', data: { latest: { ...GROUP, version: 2, name: 'ほかの人が変えた名前' } } }, patchStatus)
      }
      return json({ success: true, data: current })
    }
    if (path === '/api/rich-menu-groups/rmg-x/audience-summary') {
      return json({ success: true, data: {
        total: { value: 10, state: 'available', reason: null }, targeted: { value: 8, state: 'available', reason: null },
        excluded: { value: 0, state: 'available', reason: null }, effective: { value: 8, state: 'available', reason: null },
      } })
    }
    if (path === '/api/rich-menu-groups') return json({ success: true, data: { items: [], total: 0, page: 1, limit: 200 } })
    return json({ success: true, data: [] })
  }))
}

async function settle() {
  for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function open(search: string) {
  window.history.replaceState(null, '', `/rich-menus/new${search}`)
  await act(async () => { root.render(<RichMenuCreateV8 />) })
  await settle()
}

/* 外側の fieldset が disabled なら中の欄は押せない（ブラウザの決まり）。 */
const lockedByFieldset = (node: Element) => {
  for (let el = node.parentElement; el; el = el.parentElement) if (el instanceof HTMLFieldSetElement && el.disabled) return true
  return false
}
const board = () => host.querySelector('[data-page-template]')?.getAttribute('data-design-node')
const created = () => requests.filter((r) => r.path === '/api/rich-menu-groups' && r.method === 'POST')

beforeEach(() => {
  state.role = 'owner'
  state.push.mockReset()
  state.pickerAccount = []
  requests = []
  patchStatus = 200
  current = GROUP
  stubFetch()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('作成の口へ送る中身', () => {
  it('既定ページ・全員の既定・出し分け・順番・フォルダを1回で送り、フォルダを付け直す2口目を送らない', async () => {
    await open('')
    await act(async () => { fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '会員メニュー' } }) })
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'フォルダ' }), { target: { value: 'f-1' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き' })) })
    await settle()
    expect(created()).toHaveLength(1)
    expect(created()[0].body).toMatchObject({
      accountId: 'acc-1', name: '会員メニュー', folderId: 'f-1',
      defaultPageIndex: 0, isDefaultForAll: false, targetingEnabled: false, targetingCondition: null, targetingPriority: 0,
    })
    const refile = requests.filter((r) => r.method === 'PATCH' && r.body && Object.keys(r.body as object).join() === 'folderId')
    expect(refile).toHaveLength(0)
  })
})

describe('登録メディア', () => {
  it('今のアカウントで選ぶ窓を開き、閉じても入力を残し、選んだ画像を作成の口へ渡す', async () => {
    await open('')
    await act(async () => { fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '画像つき' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' })) })
    expect(state.pickerAccount.at(-1)).toBe('acc-1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '選ばずに閉じる' })) })
    expect(screen.queryByRole('dialog', { name: '登録メディア' })).toBeNull()
    expect((screen.getByLabelText('メニュー名（友だちには見えません）') as HTMLInputElement).value).toBe('画像つき')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '案内.png を選ぶ' })) })
    expect(screen.queryByRole('dialog', { name: '登録メディア' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き' })) })
    await settle()
    expect(created()).toHaveLength(1)
    expect((created()[0].body as { imageMediaId?: string }).imageMediaId).toBe('media-a')
    // 最初のページの登録メディアは作る口で渡したので、同じ画像を上げ直さない。
    expect(requests.filter((r) => r.path.endsWith('/image') && r.method === 'POST')).toHaveLength(0)
  })

  it('選んだ画像だけでも未保存の入力として、一覧へ離れる前に確かめる', async () => {
    await open('')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登録メディアから選択する' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '案内.png を選ぶ' })) })
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'キャンセル' })) })
    await settle()
    expect(screen.getByText('保存していない変更があります')).toBeTruthy()
    expect(state.push).not.toHaveBeenCalled()
  })
})

describe('切り替えの面', () => {
  it('店の新しいメニューでも切り替えを選べ、行き先の無い切り替えは保存せずに理由を出す', async () => {
    current = { ...GROUP, pages: [...GROUP.pages, { id: 'p-tab', orderIndex: 1, name: 'タブB', aliasId: 'a-tab', lineRichmenuId: null, imageR2Key: null, imageContentType: null, areas: [area('b-1', 0)] }] }
    await open('?id=rmg-x&step=buttons')
    // 開き直すと最初の面が選ばれている。
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'メニューを切り替える', exact: false })) })
    const patches = requests.filter((r) => r.method === 'PATCH').length
    await act(async () => { fireEvent.click(getPageAction({ name: '下書きを保存' })) })
    await settle()
    expect(screen.getByText('「メニューを切り替える」面の行き先ページが決まっていません。切り替え先を選んでください。')).toBeTruthy()
    expect(requests.filter((r) => r.method === 'PATCH').length).toBe(patches)
  })
})

describe('手順ごとの板の印', () => {
  it.each([
    ['shape', 'JeINq'],
    ['buttons', 'Z0uO6'],
    ['audience', 'OxEMM'],
    ['publish', 'F4gELj'],
  ])('?step=%s で開くと %s の印を付ける', async (step, node) => {
    await open(`?id=rmg-x&step=${step}`)
    await waitFor(() => expect(board()).toBe(node))
  })
})

describe('編集の競合', () => {
  it('下書きの保存が競合したら帯を出し、最新を読み込んで続けられる', async () => {
    await open('?id=rmg-x&step=shape')
    await act(async () => { fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '自分の直し' } }) })
    patchStatus = 409
    await act(async () => { fireEvent.click(getPageAction({ name: '下書きを保存' })) })
    await settle()
    const band = host.querySelector('[data-design-node="r8dGXT"]')
    expect(band).not.toBeNull()
    expect(band?.textContent).toContain('ほかの人がこのメニューを更新しました')
    // 帯が出ても自分の入力は書き換えない。
    expect((screen.getByLabelText('メニュー名（友だちには見えません）') as HTMLInputElement).value).toBe('自分の直し')
    patchStatus = 200
    const reads = requests.filter((r) => r.path === '/api/rich-menu-groups/rmg-x' && r.method === 'GET').length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '最新を読み込んで続ける' })) })
    await settle()
    expect(host.querySelector('[data-design-node="r8dGXT"]')).toBeNull()
    expect(requests.filter((r) => r.path === '/api/rich-menu-groups/rmg-x' && r.method === 'GET').length).toBeGreaterThanOrEqual(reads)
  })
})

describe('スタッフの出す相手', () => {
  const TARGETED = { ...GROUP, targetingEnabled: true, targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'private_memo', value: '保存済み' }] }) }

  it('スタッフは集計だけを読み、出す相手の条件を変えられない', async () => {
    state.role = 'staff'
    current = TARGETED
    await open('?id=rmg-x&step=audience')
    await waitFor(() => expect(requests.some((r) => r.path === '/api/rich-menu-groups/rmg-x/audience-summary')).toBe(true), { timeout: 3000 })
    expect(requests.some((r) => r.path.endsWith('/preview-targets'))).toBe(false)
    expect(lockedByFieldset(screen.getByLabelText('このメニューを出す相手'))).toBe(true)
  })

  it('オーナーは条件を変えられ、保存前の条件で人数を読み直す', async () => {
    current = TARGETED
    await open('?id=rmg-x&step=audience')
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/preview-targets'))).toBe(true), { timeout: 3000 })
    expect(requests.some((r) => r.path.endsWith('/audience-summary'))).toBe(false)
    expect(lockedByFieldset(screen.getByLabelText('このメニューを出す相手'))).toBe(false)
  })
})
