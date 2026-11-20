// @vitest-environment happy-dom
/*
 * 新しい一覧（src/v8/forms/list.tsx）を描いて見る。2026-10-06 に、もう描かれない
 * `./list-v8` から向け直した（入口 page.tsx はこの画面だけを出す）。
 *
 * 2026-10-03 点検：管理者確認（担当未割り当て）を開くと
 * `e is not iterable` で落ちていた。再発防止。
 *
 * 未割り当て口は配列で返す契約だが、配列でない応答が来ても
 * 一覧を空にして描く（`[...forms]` で落とさない）。
 */
import { fireEvent } from '@testing-library/react';
import React,{ act } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';

import FormSubmissionsListV8 from '@/v8/forms/list';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FORM_PAGE = {
  items: [
    {
      id: 'form-1', lineAccountId: 'visual-qa-account', name: '来店アンケート',
      description: '説明', folderId: null, fields: [], layout: { blocks: [] },
      onSubmitTagId: null, onSubmitScenarioId: null, onSubmitMessageType: null,
      onSubmitMessageContent: null, onSubmitWebhookUrl: null, onSubmitWebhookHeaders: null,
      onSubmitWebhookFailMessage: null, saveToMetadata: true, isActive: true,
      status: 'active', archivedAt: null, revision: 1, submitCount: 10,
      monthlySubmitCount: 5, monthlyOpenCount: 8, monthlyCompletionRate: 60,
      createdAt: '2026-08-21T03:00:00.000Z', updatedAt: '2026-08-21T03:00:00.000Z',
      lastSubmittedAt: '2026-08-21T03:00:00.000Z', usedByAccounts: [],
      accountScopeReviewRequired: false, destinationCount: 5,
      destinationSummary: { friendFieldCount: 3, tagCount: 2 },
    },
  ],
  total: 18, page: 1, limit: 20,
}

/* 試験ごとに差し替える未割り当て口の応答 */
let unassignedData: unknown = []
let rows = FORM_PAGE.items
const currentRole = vi.hoisted(() => ({ value: 'owner' }))
const formsDeleteImpact = vi.hoisted(() => vi.fn())
const formsUpdate = vi.hoisted(() => vi.fn())
const formsDuplicate = vi.hoisted(() => vi.fn())
const foldersCreate = vi.hoisted(() => vi.fn())
/* 読み込み中試験：ここに入れた先頭の口は返さず止める */
let pendingPrefixes: string[] = []
/* 並べ替え試験：箱の一覧と入れ替え口の記録 */
let folderFixtures: unknown[] | null = null
const swapOrderCalls: string[] = []
let folderListCalls = 0
let swapResult: () => Promise<{ success: boolean; data?: { swapped: string[] } }> = async () => ({ success: true, data: { swapped: ['a', 'b'] } })
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchApi: async (path: string) => {
      if (pendingPrefixes.some((prefix) => path.startsWith(prefix))) return new Promise(() => {})
      if (path.includes('/swap-order')) {
        swapOrderCalls.push(path)
        return swapResult()
      }
      if (path.startsWith('/api/folders')) {
        if (folderFixtures) return { success: true, data: folderFixtures }
        throw new Error(`unexpected GET ${path}`)
      }
      if (path.startsWith('/api/forms/unassigned')) return { success: true, data: unassignedData }
      if (path.startsWith('/api/forms?')) return { success: true, data: new URLSearchParams(path.split('?')[1]).has('q') && formsDuplicate.mock.calls.length ? { ...FORM_PAGE, items: [...FORM_PAGE.items, { ...FORM_PAGE.items[0], id: 'form-copy', name: '来店アンケートのコピー', isActive: false, status: 'draft' }] } : { ...FORM_PAGE, items: rows } }
      throw new Error(`unexpected GET ${path}`)
    },
    api: {
      ...actual.api,
      folders: {
        ...actual.api.folders,
        list: async () => { folderListCalls++; return { success: true, data: folderFixtures ?? [] } },
        create: foldersCreate,
        swapOrder: async (...args: unknown[]) => { swapOrderCalls.push(String(args[0])); return swapResult() },
      },
      forms: { ...actual.api.forms, deleteImpact: formsDeleteImpact, update: formsUpdate, duplicate: formsDuplicate },
      listStats: { get: async () => ({ success: true, data: null }) },
    },
  }
})
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'visual-qa-account', loading: false }),
}))
vi.mock('next/navigation', async importOriginal => ({
  ...await importOriginal<typeof import('next/navigation')>(),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/form-submissions',
}))
/*
 * 新しい一覧は役割をサーバ（/api/staff/me）で確かめ、答えが来るまでは手元の値（lh_staff_role）。
 * 試験は手元の値で決める（サーバへは出ない）。
 */
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => currentRole.value }
})
vi.mock('next/link', () => ({ default: ({ children, prefetch, ...props }: React.ComponentProps<'a'> & { prefetch?: boolean | null }) => { void prefetch; return <a {...props}>{children}</a> } }))

let host: HTMLDivElement
let root: Root
const errors: unknown[] = []
let spy: ReturnType<typeof vi.spyOn> | null = null
/*
 * 待ちは偽の時計で進める（本物の時間を待たない。重いときに落ちないように）。
 * 1回 25ms ずつ進めるのは前と同じ（検索の 300ms 待ち・骨組みの 0.3 秒もこの中で過ぎる）。
 */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(25) })
}
beforeEach(() => {
  window.history.replaceState(null, '', '/form-submissions')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  unassignedData = []
  rows = FORM_PAGE.items
  currentRole.value = 'owner'
  formsDeleteImpact.mockReset()
  formsUpdate.mockReset()
  formsDuplicate.mockReset()
  formsDuplicate.mockResolvedValue({ success: true, data: { id: 'form-copy', isActive: false } })
  foldersCreate.mockReset()
  formsDeleteImpact.mockResolvedValue({ success: true, data: { contentRevision: 7 } })
  formsUpdate.mockResolvedValue({ success: true, data: {} })
  foldersCreate.mockResolvedValue({ success: true, data: { id: 'f1', name: '箱' } })
  pendingPrefixes = []
  folderFixtures = null
  swapOrderCalls.length = 0
  folderListCalls = 0
  swapResult = async () => ({ success: true, data: { swapped: ['a', 'b'] } })
  try {
    if (window.localStorage == null) {
      const store = new Map<string, string>()
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => { store.set(key, value) },
          removeItem: (key: string) => { store.delete(key) },
          clear: () => store.clear(),
        },
        configurable: true,
      })
    } else {
      window.localStorage.clear()
    }
  } catch {
    /* 置き場が無いときはそのまま */
  }
  window.localStorage.setItem('lh_staff_role', 'owner')
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); delete document.documentElement.dataset.theme
  vi.useRealTimers()
  spy?.mockRestore(); errors.length = 0
})

describe('管理者確認の切り替え', () => {
  it('配列でない応答でも落ちずに空の一覧を出す', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    expect(host.textContent).toContain('来店アンケート')
    /* 偽 API の修正前は既定のページ形が返り、ここで落ちていた */
    unassignedData = { items: [], total: 0, page: 1, limit: 20 }
    const toggle = [...host.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('管理者確認'))
    expect(toggle).toBeTruthy()
    await act(async () => { fireEvent.click(toggle!) })
    await flush()
    expect(errors.map(String).join('\n')).toBe('')
    expect(host.textContent).toContain('通常の一覧に戻る')
  })

  it('GrnO4 回答の2行目は見本どおり詰めて書く（1152幅のはみ出し防止）', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    // 見本「今月 186・完了 75%」。全角の空きを入れると1152幅で器からはみ出す。
    expect(host.textContent).toContain('今月 5・完了 60%')
    expect(host.textContent).not.toContain(' ・完了')
  })

  it('配列の応答では未割り当ての行を出す', async () => {
    unassignedData = FORM_PAGE.items
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    const toggle = [...host.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('管理者確認'))
    await act(async () => { fireEvent.click(toggle!) })
    await flush()
    expect(errors.map(String).join('\n')).toBe('')
    expect(host.textContent).toContain('来店アンケート')
  })
})

/* V8「サクサク感」C①・D・E：行→詳細パネル・右クリック・つながる移り変わり。
 * 共通パネルは最上層へ描画されるため、パネル内の操作は文書全体から探す。 */
describe('行の詳細パネルと右クリック', () => {
  const detailButton = () => {
    const found = host.querySelector<HTMLElement>('[data-row-id="form-1"]')
    expect(found, '名前以外も押せる行がある').toBeTruthy()
    return found!
  }

  it('行を押すと右の詳細パネルが開く', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    await act(async () => { fireEvent.click(detailButton()) })
    await flush()
    const panel = document.querySelector('[data-design-part="detail-panel"]')
    expect(panel, '詳細パネルが開く').toBeTruthy()
    expect(panel?.textContent).toContain('来店アンケート')
    expect(panel?.textContent).toContain('友だち情報')
    expect(errors.map(String).join('\n')).toBe('')
  })

  it('行を右クリックすると「…」と同じ操作が出る', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    await act(async () => {
      fireEvent.contextMenu(detailButton(), { clientX: 60, clientY: 120 })
    })
    await flush()
    const menu = document.body.querySelector('[data-context-menu]')
    expect(menu, '右クリックメニューが出る').toBeTruthy()
    expect(menu?.textContent).toContain('集まった回答')
    expect(menu?.textContent).toContain('フォルダへ移す')
    const contextLabels = [...menu!.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)
    await act(async () => { fireEvent.keyDown(menu!, { key: 'Escape' }) })
    await flush()
    const rowMenu = host.querySelector('button[aria-label="「来店アンケート」のその他の操作"]')
    expect(rowMenu).toBeTruthy()
    await act(async () => { fireEvent.click(rowMenu!) })
    await flush()
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(contextLabels)
    expect(errors.map(String).join('\n')).toBe('')
  })

  it('別の行を右クリックしても前の行を複製しない', async () => {
    rows = [...FORM_PAGE.items, { ...FORM_PAGE.items[0], id: 'form-2', name: '二つ目のフォーム' }]
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    await act(async () => { fireEvent.contextMenu(detailButton(), { clientX: 60, clientY: 120 }) })
    await flush()
    await act(async () => { fireEvent.keyDown(document.querySelector('[data-context-menu]')!, { key: 'Escape' }) })
    await flush()
    await act(async () => { fireEvent.contextMenu(host.querySelector('[data-row-id="form-2"]')!, { clientX: 60, clientY: 180 }) })
    await flush()
    const duplicate = [...document.querySelectorAll('[data-context-menu] [role="menuitem"]')].find(item => item.textContent === '複製する')
    expect(duplicate).toBeTruthy()
    await act(async () => { fireEvent.click(duplicate!) })
    await flush()
    expect(formsDuplicate).toHaveBeenCalledTimes(1)
    expect(formsDuplicate).toHaveBeenCalledWith('form-2', 'visual-qa-account', '二つ目のフォームのコピー')
  })

  it('閲覧のみの右クリックには変更する操作を出さない', async () => {
    currentRole.value = 'viewer'
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    await act(async () => { fireEvent.contextMenu(detailButton(), { clientX: 60, clientY: 120 }) })
    await flush()
    const menu = document.querySelector('[data-context-menu]')
    expect(menu).toBeTruthy()
    expect(menu?.textContent).not.toMatch(/複製する|フォルダへ移す|削除する|公開する/)
    expect(formsDuplicate).not.toHaveBeenCalled()
    expect(formsUpdate).not.toHaveBeenCalled()
  })

  it('詳細パネルの名前をその場で変えると版付きで更新口へ届く', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    await act(async () => { fireEvent.click(detailButton()) })
    await flush()
    const panel = document.querySelector('[data-design-part="detail-panel"]')
    const edit = [...panel!.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'フォーム名を変更する')
    expect(edit, '名前の変更ボタンがある').toBeTruthy()
    await act(async () => { fireEvent.click(edit!) })
    await flush()
    const input = document.querySelector('[data-design-part="detail-panel"] input[aria-label="フォーム名"]') as HTMLInputElement | null
    expect(input, '入力欄が出る').toBeTruthy()
    await act(async () => {
      fireEvent.change(input!, { target: { value: '改名アンケート' } })
    })
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Enter' })
    })
    await flush()
    expect(formsUpdate, '版付きで更新口へ届く').toHaveBeenCalledWith(
      'form-1', 'visual-qa-account', { name: '改名アンケート', expectedContentRevision: 7 },
    )
    expect(host.textContent).toContain('改名アンケート')
    expect(errors.map(String).join('\n')).toBe('')
  })
})

/* V8「サクサク感」：入力の窓は右のパネルへ（確認の窓は残す）。 */
describe('入力の右パネル移設', () => {
  it('フォルダへ移すは右のパネルで選べる', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    const menuButton = [...host.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('「来店アンケート」のその他の操作'))
    expect(menuButton, '行末の「…」がある').toBeTruthy()
    await act(async () => { fireEvent.click(menuButton!) })
    await flush()
    const moveItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('フォルダへ移す'))
    expect(moveItem, '移動の項目がある').toBeTruthy()
    await act(async () => { fireEvent.click(moveItem!) })
    await flush()
    const panel = document.querySelector('[data-design-part="detail-panel"]')
    expect(panel, '右のパネルが開く').toBeTruthy()
    expect(panel?.textContent).toContain('どのフォルダへ移しますか')
    expect(panel?.textContent).toContain('未分類')
    const moveButton = [...panel!.querySelectorAll('button')].find((b) => b.textContent === '移動する')
    expect(moveButton, '移動するボタンがある').toBeTruthy()
    expect(errors.map(String).join('\n')).toBe('')
  })

  it('複製は窓を開かず1回だけ作り、元の行の下に下書きを出す', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    const menuButton = [...host.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('「来店アンケート」のその他の操作'))
    await act(async () => { fireEvent.click(menuButton!) })
    await flush()
    const duplicateItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent === '複製する')
    expect(duplicateItem, '複製の項目がある').toBeTruthy()
    await act(async () => { fireEvent.click(duplicateItem!) })
    await flush()
    expect(formsDuplicate).toHaveBeenCalledTimes(1)
    expect(formsDuplicate).toHaveBeenCalledWith('form-1', 'visual-qa-account', '来店アンケートのコピー')
    expect(document.querySelector('[data-design-part="detail-panel"]')).toBeNull()
    expect([...host.querySelectorAll('[data-row-id]')].map(row => row.getAttribute('data-row-id'))).toEqual(['form-1', 'form-copy'])
    expect(host.querySelector('[data-row-id="form-copy"][data-highlighted]')).toBeTruthy()
    expect(host.querySelector('[data-row-id="form-copy"]')?.textContent).toContain('下書き')
    expect(errors.map(String).join('\n')).toBe('')
  })
})

describe('V8 サクサク感 A・B', () => {
  it('読み込み中は骨組みで場所を取り「読み込み中」の文字は出さない', async () => {
    pendingPrefixes = ['/api/forms?']
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(host.textContent).toContain('回答フォームの一覧を読み込んでいます')
    expect(host.textContent).not.toContain('読み込み中')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })
    expect(host.querySelectorAll('[data-skeleton]').length).toBeGreaterThanOrEqual(5)
  })

  it.each([true, false])('箱の並べ替えは即時反映して保存し、失敗時は戻す（成功: %s）', async (success) => {
    if (window.localStorage == null) return
    window.localStorage.setItem('lh_staff_role', 'admin')
    folderFixtures = [
      { id: 'f1', kind: 'form', name: '受付中', parentId: null, displayOrder: 1, color: null },
      { id: 'f2', kind: 'form', name: '準備中', parentId: null, displayOrder: 2, color: null },
    ]
    let finish!: (value: { success: boolean; data?: { swapped: string[] } }) => void
    swapResult = () => new Promise(resolve => { finish = resolve })
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    const aside = host.querySelector('aside[aria-label="フォルダ"]')
    expect(aside).not.toBeNull()
    const order = () => [...aside!.querySelectorAll('nav button')]
      .filter((b) => !b.getAttribute('aria-label'))
      .map((b) => b.textContent)
    expect(order()[1]).toContain('受付中')
    // 1つ目の箱の「…」から「並べ替える（下へ）」（V8 の言葉・nH0fZ）。
    const menuButton = aside!.querySelector('button[aria-label="フォルダ「受付中」の操作"]')
    expect(menuButton).not.toBeNull()
    await act(async () => { fireEvent.click(menuButton!) })
    await flush()
    const down = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent === '並べ替える（下へ）')
    expect(down).toBeTruthy()
    await act(async () => { fireEvent.click(down!) })
    await flush()
    // 保存中も押した並びを保ち、保存はすぐ1回送る。
    expect(order()[1]).toContain('準備中')
    expect(order()[2]).toContain('受付中')
    expect(swapOrderCalls.length).toBe(1)
    const readsBefore = folderListCalls
    await act(async () => { fireEvent.change(host.querySelector('input[placeholder="フォーム名・質問文"]')!, { target: { value: '来店' } }) })
    await flush()
    expect(folderListCalls).toBeGreaterThan(readsBefore)
    expect(order()[1]).toContain('準備中')
    expect(order()[2]).toContain('受付中')
    if (success) folderFixtures = [folderFixtures![1], folderFixtures![0]]
    await act(async () => { finish({ success, data: { swapped: ['f1', 'f2'] } }) })
    await flush()
    expect(order()[1]).toContain(success ? '準備中' : '受付中')
    expect(order()[2]).toContain(success ? '受付中' : '準備中')
    expect(swapOrderCalls.length).toBe(1)
  })
})

describe('回答の補足の行のはみ出し', () => {
  it('1行のまま全文を title にも持つ（狭い列で省略表示）', async () => {
    await act(async () => { root.render(<FormSubmissionsListV8 />) })
    await flush()
    const sub = [...host.querySelectorAll('tbody span')]
      .find((p) => (p.textContent ?? '').startsWith('今月'))
    expect(sub).toBeTruthy()
    expect(sub!.textContent).toBe('今月 5・完了 60%')
    expect(sub!.getAttribute('title')).toBe(sub!.textContent)
  })
})
