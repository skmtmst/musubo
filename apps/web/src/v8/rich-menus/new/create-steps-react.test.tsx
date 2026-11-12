// @vitest-environment happy-dom
/*
 * ★V8 リッチメニューを作る：手順・面の欄・候補の読み込み失敗・公開の段の動き。
 * - `?step=` で開く手順を選べ、手順の現在地と板の印がその手順になる
 * - 面を選ぶと、その面だけの動きの欄が開き、面の名前が出る
 * - 候補の読み込みに失敗したら理由を出し、同じ条件で読み直せる
 * - 出す相手・いつ公開するかは共通の選ぶ札で選ぶ。終わりを決めるまでは終わりの欄を触れない
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const hqDraftMemory = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/hq-rich-menu-draft-store', () => ({
  readHqRichMenuDraft: async (key: string) => hqDraftMemory.get(key),
  writeHqRichMenuDraft: async (key: string, value: unknown) => { hqDraftMemory.set(key, value) },
  clearHqRichMenuDraft: async (key: string) => { hqDraftMemory.delete(key) },
}))
const accountState = vi.hoisted(() => ({ id: 'acc-1' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountState.id, selectedAccount: { ...ACCOUNT, id: accountState.id }, loading: false }),
}))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/rich-menus/new',
}))

const ACCOUNT = { id: 'acc-1', name: '店舗A' }

import RichMenuCreateV8 from './create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import type { HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import { describeMenuSummary } from './create-draft'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { getPageAction } from '@/test-utils/page-action'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const area = (id: string, label: string, x: number) => ({
  id, boundsX: x, boundsY: 0, boundsWidth: 833, boundsHeight: 843, actionType: 'uri' as const,
  actionData: { uri: 'https://nen.example/' }, intent: 'url' as const, label, tagIds: [], scoreChange: null,
  templateId: null, formId: null, trackedLinkId: null,
})
const GROUP = {
  id: 'rmg-x', accountId: 'acc-1', name: '通常メニュー', chatBarText: 'メニュー', size: 'large',
  isDefaultForAll: true, status: 'draft', targetingPriority: 1, targetingEnabled: false, targetingCondition: null,
  folderId: null, displayOrder: 1, version: 1, publishingGeneration:0, defaultPageId: 'p-top',
  pages: [
    { id: 'p-top', orderIndex: 0, name: 'トップ', aliasId: 'a-top', lineRichmenuId: null, imageR2Key: null, imageContentType: null,
      areas: [area('a-1', '予約する', 0), area('a-2', '会員証', 833)] },
  ],
}

let host: HTMLDivElement
let root: Root
const calls: string[] = []
const writes: Array<{ method: string; body: Record<string, unknown> }> = []
/** 道の頭がこれに当たる候補の口は、この回数だけ 500 で断る。 */
let failing: Record<string, number> = {}
/** 下書きの取得で返す中身。形の違う返事を試すときに入れ替える。 */
let groupBody: unknown = GROUP

function stubFetch() {
  calls.length = 0
  writes.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const parsed = new URL(String(url), 'http://localhost')
    calls.push(parsed.pathname + parsed.search)
    const prefix = Object.keys(failing).find((key) => parsed.pathname === key && failing[key] > 0)
    if (prefix) {
      failing[prefix] -= 1
      return { ok: false, status: 500, json: async () => ({ success: false, error: 'internal' }) }
    }
    if (parsed.pathname === '/api/staff/me') return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) }
    if ((parsed.pathname === '/api/rich-menu-groups' && init?.method === 'POST') || (parsed.pathname === '/api/rich-menu-groups/rmg-x' && init?.method === 'PATCH')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      writes.push({ method: init.method, body })
      groupBody = { ...GROUP, ...(groupBody as typeof GROUP), ...body, id: GROUP.id, pages: GROUP.pages }
      return { ok: true, status: 200, json: async () => ({ success: true, data: groupBody }) }
    }
    if (parsed.pathname === '/api/rich-menu-groups/rmg-x' && init?.method === 'DELETE') { writes.push({method:'DELETE',body:{expectedVersion:parsed.searchParams.get('expectedVersion')}}); return {ok:true,status:200,json:async()=>({success:true,data:null})} }
    if (parsed.pathname === '/api/rich-menu-groups/rmg-x') return { ok: true, status: 200, json: async () => ({ success: true, data: groupBody }) }
    if (parsed.pathname === '/api/rich-menu-groups') return { ok: true, status: 200, json: async () => ({ success: true, data: { items: [], total: 0, page: 1, limit: 200 } }) }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
}

async function settle() {
  for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function open(search: string, props: React.ComponentProps<typeof RichMenuCreateV8> = {}) {
  window.history.replaceState(null, '', `/rich-menus/new${search}`)
  await act(async () => { root.render(<RichMenuCreateV8 {...props} />) })
  await settle()
}

function board(): string | null {
  return host.querySelector('[data-design-node]')?.getAttribute('data-design-node') ?? null
}

function currentStep(): string {
  const nav = host.querySelector('nav[aria-label="リッチメニューを作る手順"]')
  return nav?.querySelector('[aria-current="step"]')?.textContent ?? ''
}

beforeEach(() => {
  accountState.id = 'acc-1'
  failing = {}
  hqDraftMemory.clear()
  groupBody = GROUP
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

describe('リッチメニューを作る：手順', () => {
  it.each([
    ['shape', 'JeINq', '形と画像'],
    ['buttons', 'Z0uO6', 'ボタンの動き'],
    ['audience', 'OxEMM', '誰に出すか'],
    ['publish', 'F4gELj', '公開'],
  ])('?step=%s で開くと、その手順が現在地になり、手順ごとの板の印が付く', async (step, boardId, label) => {
    await open(`?id=rmg-x&step=${step}`)
    expect(board()).toBe(boardId)
    expect(currentStep()).toContain(label)
  })

  it('知らない ?step= は最初の手順（形と画像）で開く', async () => {
    await open('?id=rmg-x&step=unknown')
    expect(board()).toBe('JeINq')
    expect(currentStep()).toContain('形と画像')
  })
})

describe('リッチメニューを作る：①形と画像', () => {
  it('空欄で次へ進むと、直す2項目をまとめと欄に示し、入力で消える', async () => {
    await open('')
    await act(async () => { fireEvent.change(document.getElementById('rm-chatbar')!, { target: { value: '' } }) })
    await act(async () => { fireEvent.click(getPageAction({ name: '次へ：ボタンの動き', exact: true })) })
    const summary = host.querySelector('[data-design-part="validation-summary"]') as HTMLElement
    expect(summary?.textContent).toContain('2か所直してください')
    expect(summary?.textContent).toContain('メニュー名')
    expect(summary?.textContent).toContain('トーク画面の下の文言')
    expect(screen.getByText('名前を入力してください。')).toBeTruthy()
    expect(screen.getByText('トーク画面の下の文言を入力してください。')).toBeTruthy()
    await act(async () => { fireEvent.change(document.getElementById('rm-name')!, { target: { value: '架空のメニュー' } }); fireEvent.change(document.getElementById('rm-chatbar')!, { target: { value: 'メニュー' } }) })
    expect(host.querySelector('[data-design-part="validation-summary"]')).toBeNull()
  })
  it('面の分け方は共通の選ぶ部品（radiogroup）で、右に共通の要約と LINE の見え方を出す', async () => {
    await open('')
    expect(board()).toBe('JeINq')
    const picker = host.querySelector('[role="radiogroup"]')
    expect(picker).not.toBeNull()
    expect(within(picker as HTMLElement).getByRole('radio', { name: '1面（面 A）' })).toBeTruthy()
    expect(host.querySelectorAll('[data-part="create-summary"]').length).toBeGreaterThan(0)
    expect(host.querySelector('section[aria-label="LINEでの見え方"]')).not.toBeNull()
  })

  it('「画像の作り方」を押すと、大きさと押しやすい余白の案内の窓が開く', async () => {
    await open('')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '画像の作り方（大きさ・押しやすい余白）' })) })
    expect(screen.getByRole('dialog', { name: '画像の作り方' })).toBeTruthy()
  })
})

describe('リッチメニューを直す：下書きの読み込み', () => {
  it.each([
    ['ページの無い返事', { id: 'rmg-x', name: '通常メニュー' }],
    ['ページが配列でない返事', { ...GROUP, pages: null }],
    ['名前の無い返事', { ...GROUP, name: undefined }],
  ])('%sは形を確かめて受け取らず、見つからない扱いにする', async (_label, body) => {
    groupBody = body
    window.history.replaceState(null, '', '/rich-menus/edit?id=rmg-x&step=buttons')
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="rmg-x" />) })
    await settle()
    expect(host.textContent).toContain('このリッチメニューは見つかりません')
    expect(host.textContent).not.toContain('面 A')
  })
})

describe('リッチメニューを作る：面の動きの欄', () => {
  it('公開確認には保存したメニューのアカウントと環境を出す', async () => {
    await open('?id=rmg-x&step=publish')
    await act(async () => { fireEvent.click(getPageAction({ name: '公開する', exact: true })) })
    await settle()
    const dialog = screen.getByRole('dialog', { name: '公開の確認' })
    expect(dialog.textContent).toContain('LINEアカウント'); expect(dialog.textContent).toContain('環境')
    expect(calls.filter(path => /\/publish(?:\?|$)/.test(path))).toEqual([])
  })

  it('確認した画像と保存直後の版を公開APIへ渡す',async()=>{
    groupBody={...GROUP,pages:[{...GROUP.pages[0],imageR2Key:'confirmed-image',imageContentType:'image/png'}]}
    await open('?id=rmg-x&step=publish')
    await act(async()=>{fireEvent.click(getPageAction({name:'公開する',exact:true}))})
    const dialog=await screen.findByRole('dialog',{name:'公開の確認'})
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'公開する',exact:true}))})
    await settle()
    const publish=vi.mocked(fetch).mock.calls.find(([url])=>String(url).includes('/api/rich-menu-groups/rmg-x/publish'))
    expect(publish).toBeTruthy()
    expect(JSON.parse(String(publish![1]?.body))).toEqual({expectedVersion:2,expectedPublishGeneration:0,expectedImages:[{orderIndex:0,imageR2Key:'confirmed-image',imageContentType:'image/png'}]})
  })

  it('表示先を決めない公開確認では、友だちの画面に出ないと示す', async () => {
    groupBody = { ...GROUP, isDefaultForAll: false, targetingEnabled: false }
    await open('?id=rmg-x&step=publish')
    await act(async () => { fireEvent.click(getPageAction({ name: '公開する', exact: true })) })
    const dialog = await screen.findByRole('dialog', { name: '公開の確認' })
    expect(dialog.textContent).toContain('この操作だけでは、友だちのトーク画面には出ません')
    expect(calls.filter(path => /\/publish(?:\?|$)/.test(path))).toEqual([])
  })

  it('確認中にアカウントを切り替えて戻した後、古い公開を送らない', async () => {
    await open('?id=rmg-x&step=publish')
    await act(async () => { fireEvent.click(getPageAction({ name: '公開する', exact: true })) }); await settle()
    const button = within(screen.getByRole('dialog', { name: '公開の確認' })).getByRole('button', { name: '公開する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    await act(async () => { accountState.id = 'acc-2'; root.render(<RichMenuCreateV8 editGroupId="rmg-x" />) })
    await act(async () => { accountState.id = 'acc-1'; root.render(<RichMenuCreateV8 editGroupId="rmg-x" />) })
    await act(async () => { await handler({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:button, target:button }) })
    expect(calls.filter(path => /\/publish(?:\?|$)/.test(path))).toEqual([])
  })

  it('確認窓を再び開いても、閉じた窓からは公開しない',async()=>{
    await open('?id=rmg-x&step=publish')
    await act(async()=>{fireEvent.click(getPageAction({name:'公開する',exact:true}))});await settle()
    const dialog=screen.getByRole('dialog',{name:'公開の確認'}),button=within(dialog).getByRole('button',{name:'公開する'})
    const key=Object.keys(button).find(item=>item.startsWith('__reactProps$'))!
    const handler=(button as unknown as Record<string,{onClick:(event:unknown)=>unknown}>)[key].onClick
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'キャンセル'}))})
    await act(async()=>{fireEvent.click(getPageAction({name:'公開する',exact:true}))});await settle()
    await act(async()=>{await handler({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button})})
    expect(calls.filter(path=>/\/publish(?:\?|$)/.test(path))).toEqual([])
  })

  it.each([1, 2])('公開前に%d枚目の名前の空いた面を開いて欄の下に理由を出し、入力すると消す', async (pageNumber) => {
    const first = { ...GROUP.pages[0], areas: GROUP.pages[0].areas.map(area => ({ ...area })) }
    const pages = pageNumber === 1 ? [first] : [first, { ...first, id: 'p-next', orderIndex: 1, name: '次のページ', aliasId: 'a-next', areas: [area('next-area', '', 0)] }]
    if (pageNumber === 1) pages[0].areas[0].label = ''
    groupBody = { ...GROUP, pages }
    await open('?id=rmg-x&step=publish')
    await act(async () => { fireEvent.click(getPageAction({ name: '公開する', exact: true })) })
    await settle()
    expect(screen.queryByText('ボタン名（読み上げラベル）を入力してください')).not.toBeNull()
    expect(currentStep()).toContain('ボタンの動き')
    if (pageNumber === 2) expect(screen.getByRole('button', { name: 'タブ2「次のページ」' }).getAttribute('aria-pressed')).toBe('true')
    const name = screen.getByRole('textbox', { name: /ボタン名/ }) as HTMLInputElement
    expect(name.value).toBe('')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(calls.filter(path => /\/publish(?:\?|$)/.test(path))).toEqual([])
    await act(async () => { fireEvent.change(name, { target: { value: '予約する' } }) })
    expect(screen.queryByText('ボタン名（読み上げラベル）を入力してください')).toBeNull()
    await act(async () => { fireEvent.click(within(screen.getByRole('navigation', { name: 'リッチメニューを作る手順' })).getByRole('button', { name: /公開/ })) })
    await settle()
    await act(async () => { fireEvent.click(getPageAction({ name: '公開する', exact: true })) })
    await settle()
    expect(screen.queryByRole('alertdialog', { name: '公開の確認' }) ?? screen.queryByRole('dialog', { name: '公開の確認' })).not.toBeNull()
    expect(calls.filter(path => /\/publish(?:\?|$)/.test(path))).toEqual([])
  })

  it.each(['not-a-url', ''])('不正なURLまたは未設定の面があると次の手順へ進まない: %s', async (uri) => {
    groupBody = { ...GROUP, pages: [{ ...GROUP.pages[0], areas: [area('a-1', '予約する', 0), { ...area('a-2', '会員証', 833), actionData: { uri } }] }] }
    await open('?id=rmg-x&step=buttons')
    await act(async () => { fireEvent.click(getPageAction({ name: '次へ：誰に出すか', exact: true })) })
    await settle()
    expect(currentStep()).toContain('ボタンの動き')
    expect(screen.getByText(/面.*設定/)).toBeTruthy()
  })

  it('面が一つもないタブが残っていると次の手順へ進まない', async () => {
    groupBody = { ...GROUP, pages: [...GROUP.pages, { ...GROUP.pages[0], id: 'empty-page', name: '次のページ', areas: [] }] }
    await open('?id=rmg-x&step=buttons')
    await act(async () => { fireEvent.click(getPageAction({ name: '次へ：誰に出すか', exact: true })) })
    await settle()
    expect(currentStep()).toContain('ボタンの動き')
    expect(screen.getByText(/面.*設定/)).toBeTruthy()
  })

  it('テキストが入った面には未設定ではなくテキストを送ると表示する', async () => {
    groupBody = { ...GROUP, pages: [{ ...GROUP.pages[0], areas: [{ ...area('a-1', '予約する', 0), intent: 'text', actionType: 'message', actionData: { text: '架空メッセージ' } }] }] }
    await open('?id=rmg-x&step=buttons')
    expect(screen.getAllByText('テキストを送る').length).toBeGreaterThan(0)
  })

  it('選んだ面だけの動きの欄を開き、面の名前を出す。別の面を選ぶと欄が入れ替わる', async () => {
    await open('?id=rmg-x&step=buttons')
    expect(screen.getByText('面 A「予約する」の動き')).toBeTruthy()
    expect(screen.queryByText('面 B「会員証」の動き')).toBeNull()
    await act(async () => { fireEvent.click([...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('B会員証'))!) })
    expect(screen.getByText('面 B「会員証」の動き')).toBeTruthy()
    expect(screen.queryByText('面 A「予約する」の動き')).toBeNull()
  })
})

describe('リッチメニューを作る：候補の読み込み', () => {
  it('候補の読み込みに失敗したら何が読めなかったかを出し、もう一度読み込むで同じアカウントの候補を読み直す', async () => {
    failing = { '/api/tags': 1, '/api/forms': 1 }
    await open('?id=rmg-x&step=buttons')
    const alert = screen.getByText(/候補の読み込みに失敗しました（タグ・フォーム）/)
    expect(alert).toBeTruthy()
    const before = calls.filter((path) => path.startsWith('/api/tags')).length
    const retry = within(alert.closest('[data-design-part="notice"]') as HTMLElement).getByRole('button', { name: 'もう一度読み込む' })
    await act(async () => { fireEvent.click(retry) })
    await settle()
    const tagCalls = calls.filter((path) => path.startsWith('/api/tags'))
    expect(tagCalls.length).toBe(before + 1)
    expect(tagCalls.at(-1)).toContain('acc-1')
    expect(calls.filter((path) => path.startsWith('/api/forms/') || path.startsWith('/api/forms?') || path === '/api/forms').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/候補の読み込みに失敗しました/)).toBeNull()
  })
})

describe('リッチメニューを作る：選ぶ札と終わりの欄', () => {
  it('未設定の面から、画面に表示された手順名で設定画面に戻れる', async () => {
    groupBody = { ...GROUP, pages: [{ ...GROUP.pages[0], areas: [{ ...GROUP.pages[0].areas[0], actionData: { uri: '' } }] }] }
    await open('?id=rmg-x&step=publish')
    expect(screen.getByText('押しても何も起きません。「ボタンの動き」で設定します')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ボタンの動きを設定する' })) })
    expect(currentStep()).toContain('ボタンの動き')
  })

  it('出す相手は共通の選ぶ札（fieldset と legend）で選ぶ', async () => {
    await open('?id=rmg-x&step=audience')
    const group = screen.getByRole('group', { name: '出す相手' })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.length).toBeGreaterThanOrEqual(2)
    expect(new Set(radios.map((radio) => radio.name))).toEqual(new Set(['audience']))
  })

  it('いつ公開するかは共通の選ぶ札で選び、終わりを決めるをオンにするまで終わりの欄は触れない', async () => {
    await open('?id=rmg-x&step=publish')
    const timing = screen.getByRole('group', { name: 'いつ公開するか' })
    expect(new Set((within(timing).getAllByRole('radio') as HTMLInputElement[]).map((radio) => radio.name))).toEqual(new Set(['timing']))
    const ends = () => screen.getByLabelText('終わる日時') as HTMLInputElement
    expect(ends().disabled).toBe(true)
    expect(screen.getByText('終わる日時を選ぶと、')).toBeTruthy()
    expect(screen.getByText('「終わりを決める」をオンにすると設定できます').id).toBe(ends().getAttribute('aria-describedby'))
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: '終わりを決める' })) })
    expect(ends().disabled).toBe(false)
    expect(screen.queryByText('「終わりを決める」をオンにすると設定できます')).toBeNull()
  })
})


function makeHqHost(initial?: HqRichMenuSeed): RichMenuCreateHost {
  return {
    backHref: '/hq/rich-menus', onCancel: vi.fn(), canOperate: true, folders: [],
    references: { tags: [], templates: [], forms: [] }, initial,
    uploadImage: vi.fn(async () => ({ r2Key: 'test-image' })), imageUrl: () => '',
    distribute: null, selectedCount: 0, selectedIds: [], friendTotal: null, busy: false, onSave: vi.fn(),
  }
}

describe('リッチメニューの出す相手は明示的に決める', () => {
  it('店舗の新規作成は決めないから始め、全員を選んでいない', async () => {
    await open('?step=audience')
    expect((screen.getByRole('radio', { name: /^決めない/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /^すべての友だち/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('統括の新規作成も各アカウントで決める状態から始める', async () => {
    await open('?step=audience', { host: makeHqHost() })
    expect((screen.getByRole('radio', { name: /^決めない/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /^全員/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('手順を進めるまでは入力だけで下書きを作らない', async () => {
    await open('')
    fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '作りかけ' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
    expect(writes).toHaveLength(0)
  })

  it('手順を進めて保存した下書きは、キャンセル時に残すか消すか確かめる', async () => {
    await open('')
    fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '作りかけ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き', exact: true })) })
    await settle()
    const leave = vi.fn()
    await act(async () => { requestUnsavedAction(leave) })
    expect(leave).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '下書きを残して移る' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下書きを消して移る' })).toBeTruthy()
  })

  it.each(['keep','delete'] as const)('保存済み下書きの%sを選んで移る', async (choice) => {
    await open('')
    fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '作りかけ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き', exact: true })) })
    await settle()
    const leave = vi.fn()
    await act(async () => { requestUnsavedAction(leave) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: choice === 'keep' ? '下書きを残して移る' : '下書きを消して移る' })) })
    await settle()
    expect(leave).toHaveBeenCalledOnce()
    const deletion = writes.find(write => write.method === 'DELETE')
    if (choice === 'keep') expect(deletion).toBeUndefined()
    else expect(deletion?.body).toEqual({expectedVersion:'1'})
  })

  it('保存した下書きの削除に失敗したら、理由を出して画面に残る', async () => {
    await open('')
    fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '作りかけ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き', exact: true })) })
    await settle()
    failing['/api/rich-menu-groups/rmg-x'] = 1
    const leave = vi.fn()
    await act(async () => { requestUnsavedAction(leave) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを消して移る' })) })
    await settle()
    expect(leave).not.toHaveBeenCalled()
    expect(screen.getByText(/下書きの削除結果を確認できません/)).toBeTruthy()
  })

  it('削除結果が不明なら一覧で確認する操作を案内する', async () => {
    await open('')
    fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '作りかけ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き', exact: true })) })
    await settle()
    failing['/api/rich-menu-groups/rmg-x'] = 1
    await act(async () => { requestUnsavedAction(vi.fn()) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを消して移る' })) })
    await settle()
    expect(screen.getByText(/削除結果を確認できません/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下書きを残して移る' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '一覧で確認する' })) })
    expect(push).toHaveBeenCalledWith('/rich-menus')
  })

  it('初めの下書き保存と手順の保存でも全員の既定にしない', async () => {
    await open('')
    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '作りかけのメニュー' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：ボタンの動き', exact: true })) })
    await settle()
    expect(writes).toHaveLength(1)
    expect(writes[0].body).toMatchObject({ accountId: 'acc-1', isDefaultForAll: false, targetingEnabled: false, targetingCondition: null })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：誰に出すか', exact: true })) })
    await settle()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ method: 'PATCH', body: { isDefaultForAll: false, targetingEnabled: false } })
    expect((screen.getByRole('radio', { name: /^決めない/ }) as HTMLInputElement).checked).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：公開', exact: true })) })
    await settle()
    expect(host.textContent).toContain('LINEへの登録だけでは、友だちの画面は変わりません。出す相手は一覧の「表示先」で決めてください。')
    expect(within(screen.getByRole('list', { name: '設定済みの内容' })).getByText('決めない', { exact: true })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '誰に出すかに戻る', exact: true })) })
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /^すべての友だち/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次へ：公開', exact: true })) })
    await settle()
    expect(writes.at(-1)?.body.isDefaultForAll).toBe(true)
  })

  it.each([
    ['全員', { isDefaultForAll: true, targetingEnabled: false }, /^すべての友だち/],
    ['条件付き', { isDefaultForAll: false, targetingEnabled: true, targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] }) }, /^条件に当てはまる友だちだけ/],
    ['決めない', { isDefaultForAll: false, targetingEnabled: false }, /^決めない/],
  ] as const)('保存済みの%sは、読み直してもその選択を保つ', async (_name, saved, label) => {
    groupBody = { ...GROUP, ...saved }
    await open('?id=rmg-x&step=audience')
    expect((screen.getByRole('radio', { name: label }) as HTMLInputElement).checked).toBe(true)
  })

  it.each(['all', 'store', 'tag'] as const)('統括の保存済み%sも選び直させず保持する', async displayAudience => {
    const initial: HqRichMenuSeed = {
      name: GROUP.name, chatBarText: GROUP.chatBarText, folderId: null, size: 'large',
      displayAudience, displayTagName: displayAudience === 'tag' ? '会員' : '', defaultOpen: true,
      displayOrder: 1, defaultPageId: GROUP.defaultPageId, pages: GROUP.pages,
    }
    await open('?step=audience', { host: makeHqHost(initial) })
    const label = displayAudience === 'all' ? /^全員/ : displayAudience === 'tag' ? /^タグが付いた人/ : /^決めない/
    expect((screen.getByRole('radio', { name: label }) as HTMLInputElement).checked).toBe(true)
  })
})


it('統括は初めの保存・決めないを押した保存・開き直しで同じ表示先になり、未保存を作らない', async () => {
  const hq = makeHqHost()
  await open('', { host: hq })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: /^メニュー名/ }), { target: { value: '各店舗で決めるメニュー' } }) })
  const leave = vi.fn()
  await act(async () => { requestUnsavedAction(leave) })
  expect(leave).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '編集を続ける', exact: true })) })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull())
  await act(async () => { fireEvent.click(getPageAction({ name: '下書きを保存', exact: true })) })
  await settle()
  const saved = vi.mocked(hq.onSave).mock.calls[0][0]
  expect(saved.displayAudience).toBe('store')
  await act(async () => { requestUnsavedAction(leave) })
  expect(leave).toHaveBeenCalledTimes(1)
  await act(async () => { root.unmount(); root = createRoot(host) })
  const resumed = makeHqHost(saved)
  await open('?step=audience', { host: resumed })
  expect((screen.getByRole('radio', { name: /^決めない/ }) as HTMLInputElement).checked).toBe(true)
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /^全員/ })) })
  expect((screen.getByRole('radio', { name: /^全員/ }) as HTMLInputElement).checked).toBe(true)
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /^決めない/ })) })
  await act(async () => { fireEvent.click(getPageAction({ name: '下書きを保存', exact: true })) })
  await settle()
  expect(vi.mocked(resumed.onSave).mock.calls[0][0]).toEqual(saved)
  await act(async () => { requestUnsavedAction(leave) })
  expect(leave).toHaveBeenCalledTimes(2)
})

it.each([
  ['all', false, 'すべての友だち'], ['targeted', false, '条件に当てはまる友だちだけ'], ['none', false, '決めない'],
  ['all', true, '全員'], ['tag', true, 'タグが付いた人'], ['targeted', true, '決めない'],
] as const)('比較する表示先%s（統括=%s）は選択の題と一致する', (audience, forHq, expected) => {
  expect(describeMenuSummary({ name: 'メニュー', chatBarText: 'メニュー', audience, forHq, pages: [] })).toContain(`出す相手：${expected}`)
})

it('統括の新規メニューは再読込しても名前を戻す', async () => {
  const hq = { ...makeHqHost(), draftKey: 'test-hq-reload' }
  await open('', { host: hq })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name:/^メニュー名/ }), { target:{ value:'再開するメニュー' } }) })
  await settle()
  await act(async () => { root.unmount(); root = createRoot(host) })
  await open('', { host:hq })
  expect((screen.getByRole('textbox', { name:/^メニュー名/ }) as HTMLInputElement).value).toBe('再開するメニュー')
})

it('統括の画像ファイルも再読込後に残す', async () => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test-image'), revokeObjectURL: vi.fn() }))
  const hq = { ...makeHqHost(), draftKey: 'test-hq-image' }
  await open('', { host:hq })
  const file = new File(['fixture'], '架空.png', { type:'image/png' })
  const input = host.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => { fireEvent.change(input, { target:{ files:[file] } }) })
  await settle()
  const saved = hqDraftMemory.get('test-hq-image') as {pendingImages:Array<{file:File}>}
  expect(saved.pendingImages[0]?.file.name).toBe('架空.png')
  await act(async () => { root.unmount(); root = createRoot(host) })
  await open('', { host:hq })
  expect(screen.getByText('架空.png')).toBeTruthy()
})

it('所属が変わると別の一時下書きを読まない', async () => {
  const first = { ...makeHqHost(), draftKey:'tenant-a:owner' }
  await open('', { host:first })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name:/^メニュー名/ }), { target:{value:'Aの名前'} }) })
  await settle()
  await act(async () => { root.unmount(); root = createRoot(host) })
  await open('', { host:{ ...makeHqHost(), draftKey:'tenant-b:owner' } })
  expect((screen.getByRole('textbox', { name:/^メニュー名/ }) as HTMLInputElement).value).toBe('')
})

it('壊れた一時下書きを上書きせず、保存できない理由を表示する', async () => {
  hqDraftMemory.set('broken-draft', { version: 999, name:'元の値' })
  await open('', { host:{ ...makeHqHost(), draftKey:'broken-draft' } })
  expect(screen.getByText(/一時保存できません/)).toBeTruthy()
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name:/^メニュー名/ }), { target:{value:'入力した値'} }) })
  await settle()
  expect(hqDraftMemory.get('broken-draft')).toEqual({ version:999, name:'元の値' })
})

it('統括で配る先と一時アップロードの後片付け情報も復元する', async () => {
  const restoreSelectedIds = vi.fn(), restoreUploadedKeys = vi.fn()
  const hq = { ...makeHqHost(), draftKey:'hq-targets', selectedIds:['store-1'], uploadedKeys:['hq-templates/t/uploads/photo.png'], restoreSelectedIds, restoreUploadedKeys }
  await open('', { host:hq })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name:/^メニュー名/ }), { target:{value:'作りかけ'} }) })
  await settle()
  await act(async () => { root.unmount(); root = createRoot(host) })
  await open('', { host:hq })
  expect(restoreSelectedIds).toHaveBeenCalledWith(['store-1'])
  expect(restoreUploadedKeys).toHaveBeenCalledWith(['hq-templates/t/uploads/photo.png'])
})

it('統括のボタン設定中に再読込しても手順と編集中の内容を戻す', async () => {
  const hq = { ...makeHqHost(), draftKey:'hq-step' }
  await open('', { host:hq })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name:/^メニュー名/ }), { target:{value:'作りかけのメニュー'} }) })
  await act(async () => { fireEvent.click(getPageAction({name:'次へ：ボタンの動き',exact:true})) })
  await settle()
  expect(currentStep()).toContain('ボタンの動き')
  const previousText = host.textContent
  await act(async () => { root.unmount(); root = createRoot(host) })
  await open('', {host:hq})
  expect(currentStep()).toContain('ボタンの動き')
  expect(host.textContent).toContain('作りかけのメニュー')
  expect(host.textContent).toContain('面 A')
  expect(previousText).toContain('面 A')
})
