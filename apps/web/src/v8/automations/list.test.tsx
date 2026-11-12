import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 オートメーション（src/v8/automations）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * V8 のテーマで表示し、ルール一覧・閲覧のみ・動いた記録・共通アクションを確かめる。
 * 閲覧のみでは、作る・編集・フォルダを追加などの押せないボタンを置かない（隠す）。
 */
import { act } from 'react'
import { within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/lib/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/automations',
  useSearchParams: () => new URLSearchParams(''),
}))

const account = vi.hoisted(() => ({ id: 'account-a' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: account.id, name: '本店' }], loading: false }),
}))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }] })) }))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

// 1440 の板で見る（1152 の板  は狭い幅のとき）。
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import AutomationListV8 from './list'
import AutomationsPage from '@/app/automations/page'
import AutomationRunsV8 from './runs'
import CommonActionsV8 from './common-actions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const automation = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: null, eventType: 'message_received', triggerConfig: {}, conditions: {},
  actions: [{ type: 'notify_staff', params: {} }, { type: 'add_tag', params: {} }],
  isActive: true, priority: 1, lineAccountId: 'account-a', status: 'active', versionId: `${id}-v`, version: 1, confirmationRevision: 3,
  executionCount30d: 312, failureCount30d: 0, lastRunAt: null,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', ...extra,
})

const automations = [
  automation('au-1', '問い合わせを担当へ知らせる'),
  automation('au-6', '旧キャンペーンの自動返信', {
    isActive: false, status: 'stopped', triggerConfig: { keyword: 'キャンペーン' }, executionCount30d: 0, updatedAt: '2026-09-01T00:00:00.000Z',
  }),
]

const commonActions = [
  { id: 'ca-2', name: '購入のお礼', description: '買ってくれた人へのお礼', status: 'published', draftVersion: null, publishedVersion: 3, actionCount: 3, bindingCount: 3, oldVersionBindingCount: 0, executionCountThisMonth: 52, failureCountThisMonth: 0, lastRunAt: null, updatedAt: '2026-09-30T00:00:00.000Z' },
]

const run = {
  id: 'run-2', automationId: 'au-1', occurredAt: '2026-09-30T02:05:00.000Z', subject: 'Masato S.', accountLabel: '然 本店',
  triggerLabel: 'メッセージが届いたとき', status: 'permanent_failed', detail: 'ブロック中で送れず', durationMs: 300,
  automationName: '購入のお礼とフォロー', canRetry: false, versionNumber: 2, isTest: false, canCancel: false, friendId: 'friend-1',
  successfulActions: ['購入のお礼'], failureReason: 'ブロック中で送れず',
}

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-a'
  window.history.replaceState({}, '', '/automations')
  window.dispatchEvent(new PopStateEvent('popstate'))
  role.value = verifiedStaffRole('owner')
  push.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/automations') {
      return json({ success: true, data: automations, summary: { active: 1, stopped: 1, executionCount30d: 312, failureCount30d: 0 } })
    }
    if (url.pathname === '/api/automation-runs') {
      return json({ success: true, data: { summary: { total: 9666, executed: 2988, skipped: 1240, failed: 6, mostRunName: null, mostRunCount: null }, items: [run], pagination: { total: 1, limit: 20, offset: 0 } } })
    }
    if (url.pathname === '/api/automation-templates') return json({ success: true, data: [{ key: 'a' }, { key: 'b' }] })
    if (url.pathname === '/api/common-actions') {
      return json({ success: true, data: commonActions, pagination: { total: 1, limit: 20, offset: 0 }, summary: { total: 1, published: 1, draft: 0, oldVersion: 0, unused: 0, archived: 0, actions: 3, bindings: 3, outdated: 0, outdatedItems: 0, executions: 52, failures: 0 } })
    }
    if (url.pathname === '/api/folders') return json({ success: true, data: [] })
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function render(node: React.ReactElement) {
  await act(async () => { root.render(node) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** 読み込みが終わるまで待つ（動いた記録は 400ms 待ってから読む）。 */
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  }
  throw new Error(`待ちきれませんでした：${label}`)
}

const buttons = () => [...host.querySelectorAll('button, a')] as HTMLElement[]
const named = (text: string) => buttons().filter((element) => (element.textContent ?? '').trim() === text)

describe('V8 オートメーションのルール一覧（LWQXd）', () => {
  it('条件に外れた回数と30日間動かなかったルール数を区別する', async () => {
    vi.spyOn(api.automations, 'list').mockResolvedValueOnce({ success: true, data: [automation('idle', '待機中', { executionCount30d: 0 })], summary: { active: 1, stopped: 0, executionCount30d: 0, failureCount30d: 0 } })
    await render(<AutomationListV8 />)
    await waitFor(() => Boolean(host.textContent?.includes('待機中')), 'ルールの行')
    expect(host.textContent).toContain('稼働中で直近30日動いていないルール 1')
    expect(host.textContent).not.toContain('だれにも当たらないルール')
  })

  it('旧一覧の削減時間は現在の説明へ残し、未取得を0時間にしない', async () => {
    vi.spyOn(api.automations, 'list').mockResolvedValueOnce({ success: true, data: automations, summary: null })
    await render(<AutomationsPage />)
    await waitFor(() => Boolean(host.querySelector('[aria-label="ルール「問い合わせを担当へ知らせる」の操作"]')), 'ルールの行')
    expect(host.querySelector('[data-page-template="list"] [data-template-region="content"]')?.textContent).toContain('問い合わせを担当へ知らせる')
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="この画面の説明"]')!.click() })
    expect(host.textContent).toContain('削減時間はまだ数えられていません')
    expect(host.textContent).not.toContain('およそ0時間')
    account.id = 'account-b'
    await render(<AutomationsPage />)
    expect(host.textContent).toContain('およそ3時間の削減')
    expect(host.textContent).toContain('1回30秒として計算しています')
  })

  async function chooseRowAction(label: string) {
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="ルール「問い合わせを担当へ知らせる」の操作"]')!.click() })
    const item = ([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === label) ?? querySupplementaryPageAction(label))!
    await act(async () => { item.click() })
  }

  it('保管の確認で記録と設定が残り、一覧から戻せると説明する', async () => {
    await render(<AutomationListV8 />)
    await chooseRowAction('保管する')
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('通常の一覧から外します。動いた記録と設定は残り、「保管したもの」の絞り込みから戻せます。')
    expect(dialog.textContent).toContain('LINEアカウント')
    await waitFor(() => dialog.textContent?.includes('本店') ?? false, '操作対象のアカウント')
    expect(dialog.textContent).toContain('検証環境')
    await act(async () => { within(dialog as HTMLElement).getByRole('button', { name: 'キャンセル' }).click() })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('編集を連打しても下書きは1つだけ作り、店が変わると前の返事で移動しない', async () => {
    let resolve!: (value: { success: true; data: { id: string } }) => void
    const edit = vi.spyOn(api.automations, 'createDraftFromAutomation').mockImplementation(() => new Promise((done) => { resolve = done }))
    await render(<AutomationListV8 />)
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="ルール「問い合わせを担当へ知らせる」の操作"]')!.click() })
    const item = ([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === '編集する') ?? querySupplementaryPageAction('編集する'))!
    await act(async () => { item.click(); item.click() })
    expect(edit).toHaveBeenCalledTimes(1)
    account.id = 'account-b'
    await render(<AutomationListV8 />)
    await act(async () => { resolve({ success: true, data: { id: 'old-draft' } }) })
    expect(push).not.toHaveBeenCalled()
  })

  it.each([
    [403, 'このルールを編集する権限がありません'],
    [404, 'ルールが見つかりませんでした'],
    [409, 'ほかの人の変更と重なりました'],
    [500, 'サーバー側で編集用の下書きを作れませんでした'],
  ])('編集の%sでは理由を示し、古い一覧の可能性がある場合だけ読み直す', async (status, message) => {
    vi.spyOn(api.automations, 'createDraftFromAutomation').mockRejectedValue(new ApiError(Number(status)))
    const list = vi.spyOn(api.automations, 'list')
    await render(<AutomationListV8 />)
    const before = list.mock.calls.length
    await chooseRowAction('編集する')
    expect(host.textContent).toContain(message)
    expect(list.mock.calls.length).toBe(before + ([404, 409].includes(Number(status)) ? 1 : 0))
    expect(push).not.toHaveBeenCalled()
  })

  it('状態の変更が失敗しても読み直し、再試行できる', async () => {
    const status = vi.spyOn(api.automations, 'setStatus').mockRejectedValueOnce(new ApiError(500)).mockResolvedValue({ success: true })
    const list = vi.spyOn(api.automations, 'list')
    await render(<AutomationListV8 />)
    const before = list.mock.calls.length
    await chooseRowAction('止める')
    const confirm = () => ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent?.trim() === '止める') ?? querySupplementaryPageAction('止める'))!
    await act(async () => { confirm().click(); confirm().click() })
    expect(status).toHaveBeenCalledTimes(1)
    expect(list.mock.calls.length).toBe(before + 1)
    expect(document.body.textContent).toContain('稼働を切り替えられませんでした')
    await act(async () => { confirm().click() })
    expect(status).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenLastCalledWith('au-1', 'stopped', 3)
  })

  it('変更中に店を切り替えると窓を閉じ、新しい店の確認を前の処理のロックで止めない', async () => {
    let resolve!: (value: { success: true }) => void
    const status = vi.spyOn(api.automations, 'setStatus').mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValue({ success: true })
    const list = vi.spyOn(api.automations, 'list')
    await render(<AutomationListV8 />)
    await chooseRowAction('止める')
    const confirm = () => ([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent?.trim() === '止める') ?? querySupplementaryPageAction('止める'))!
    await act(async () => { confirm().click() })
    expect(status).toHaveBeenCalledTimes(1)
    account.id = 'account-b'
    await render(<AutomationListV8 />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await chooseRowAction('止める')
    await act(async () => { confirm().click() })
    expect(status).toHaveBeenCalledTimes(2)
    const afterNew = list.mock.calls.length
    await act(async () => { resolve({ success: true }) })
    expect(list.mock.calls.length).toBe(afterNew)
  })

  it('V8 のテーマで、タブ・数の帯・行・編集は「…」の中へ入れる', async () => {
    await render(<AutomationListV8 />)
    await waitFor(() => host.textContent?.includes('問い合わせを担当へ知らせる') ?? false, 'ルールの行')
    expect(document.documentElement.dataset.theme).toBe('v8')
    expect(host.querySelector('[data-design-node="LWQXd"]')).not.toBeNull()
    expect(host.textContent).toContain('ルール 2')
    expect(host.textContent).toContain('動いている 1・止めている 1')
    // きっかけは言葉まで（「〇〇」と送られた）。止めているルールは最後に変えた日。
    expect(host.textContent).toContain('「キャンペーン」と送られた')
    expect(host.textContent).toContain('止めています')
    expect(named('編集する')).toHaveLength(0)
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="ルール「問い合わせを担当へ知らせる」の操作"]')!.click() })
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('編集する')
    expect(host.querySelector('[aria-label="ルール「問い合わせを担当へ知らせる」の操作"]')).not.toBeNull()
    expect(named('ルールを作る').length).toBeGreaterThan(0)
  })

  it('閲覧のみでは、帯を出し、フォルダ追加を理由付きで残して拒否する', async () => {
    role.value = verifiedStaffRole('staff')
    await render(<AutomationListV8 />)
    await waitFor(() => host.textContent?.includes('問い合わせを担当へ知らせる') ?? false, 'ルールの行')
    expect(host.querySelector('[data-design-node="nH9L8"]')).not.toBeNull()
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
    expect(named('編集する')).toHaveLength(0)
    expect(named('ルールを作る')).toHaveLength(0)
    for (const folderAdd of named('フォルダを追加')) await expectPermissionLocked(folderAdd)
    expect(named('フォルダを追加').length).toBeGreaterThan(0)
    expect(named('見本から作る')).toHaveLength(0)
    const disabled = buttons().filter((element) => !element.closest('[data-pagination]') && element.matches(':disabled, [aria-disabled="true"]'))
    expect(disabled.length).toBeGreaterThan(0)
    for (const element of disabled) await expectPermissionLocked(element)
    expect(host.querySelector('[aria-label="ルール一覧のページ送り"]')).toBeNull()
    expect(host.querySelector('[data-pagination]')?.textContent).toContain('2件中 1〜2件')
    // 「…」は動いた記録を見るだけ。
    const menu = host.querySelector('[aria-label="ルール「問い合わせを担当へ知らせる」の操作"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent?.trim())
    expect(items).toEqual(['動いた記録を見る'])
  })
})

describe('V8 オートメーションの動いた記録（g98F9）', () => {
  it('結果の札と理由・したことの数・かかった時間を出す', async () => {
    await render(<AutomationRunsV8 />)
    await waitFor(() => host.textContent?.includes('Masato S.') ?? false, '記録の行')
    expect(host.querySelector('[data-design-node="g98F9"]')).not.toBeNull()
    expect(host.textContent).toContain('失敗ブロック中で送れず')
    expect(host.textContent).toContain('1 つ')
    expect(host.textContent).toContain('0.3 秒')
    expect(within(host).getByRole('tab', { name: /^動いた\s*2,?988$/ })).toBeTruthy()
    expect(host.textContent).toContain('1件中 1〜1件')
  })
})

describe('V8 オートメーションの共通アクション（LnGNw）', () => {
  it('行の「中身を見る」は版と使われている場所へ。閲覧のみのフォルダ追加は拒否する', async () => {
    await render(<CommonActionsV8 />)
    await waitFor(() => host.textContent?.includes('購入のお礼') ?? false, '共通アクションの行')
    const open = named('中身を見る')[0] as HTMLAnchorElement
    expect(open.getAttribute('href')).toBe('/common-actions/versions?id=ca-2')
    expect(named('共通アクションを作る').length).toBeGreaterThan(0)

    act(() => root.unmount())
    root = createRoot(host)
    role.value = verifiedStaffRole('staff')
    await render(<CommonActionsV8 />)
    await waitFor(() => host.textContent?.includes('購入のお礼') ?? false, '共通アクションの行（閲覧のみ）')
    expect(named('共通アクションを作る')).toHaveLength(0)
    for (const folderAdd of named('フォルダを追加')) await expectPermissionLocked(folderAdd)
    expect(named('フォルダを追加').length).toBeGreaterThan(0)
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
  })

  it('状態の札は「保管したもの」と書き、何を見る札か分かるようにする（87）', async () => {
    await render(<CommonActionsV8 />)
    await waitFor(() => host.textContent?.includes('購入のお礼') ?? false, '共通アクションの行')
    const chip = buttons().find((element) => (element.textContent ?? '').startsWith('保管したもの'))
    expect(chip).toBeTruthy()
    expect(named('保管')).toHaveLength(0)
  })
})

 it.each([['ルール',AutomationListV8],['共通アクション',CommonActionsV8]])('%sのフォルダ取得失敗と空を分け、読込だけやり直す', async (_label,Component) => {
   const fetchFixture=globalThis.fetch
   let folderReads=0
   vi.stubGlobal('fetch', async (input: RequestInfo|URL,init?:RequestInit) => {
     if(new URL(String(input)).pathname==='/api/folders') {
       folderReads++
       if(folderReads===1) return new Response(JSON.stringify({success:false,error:'fixture failure'}),{status:500,headers:{'Content-Type':'application/json'}})
       return json({success:true,data:[{id:'folder1',name:'再取得した分類',kind:'automation',color:'#777777',sortOrder:0,parentId:null}]})
     }
     return fetchFixture(input,init)
   })
   await render(<Component />)
   await waitFor(()=>Boolean(host.textContent?.includes('フォルダを読み込めませんでした')),'フォルダ失敗表示')
   const error=host.querySelector('[data-list-state="error"]')!
   expect(error).not.toBeNull()
   await act(async()=>{(error.querySelector('button') as HTMLButtonElement).click()})
   await waitFor(()=>Boolean(host.textContent?.includes('再取得した分類')),'フォルダ復帰')
   expect(folderReads).toBe(2)
 })

afterEach(() => { verifiedStaffRole(null) })

it('自動処理のフォルダ数も、すべてと同じルール一覧で数える',async()=>{
 vi.spyOn(api.automations,'list').mockResolvedValueOnce({success:true,data:[automation('a','分類あり',{folderId:'f1'}),automation('b','未分類'),automation('c','保管したルール',{status:'archived',folderId:'f1'})]} as never)
 vi.spyOn(api.folders,'list').mockResolvedValueOnce({success:true,data:[{id:'f1',name:'問合せ',itemCount:99}],unfiledCount:98} as never)
 await render(<AutomationListV8/>)
 await waitFor(()=>Boolean(host.textContent?.includes('分類あり')),'一覧')
 const rows=[...host.querySelectorAll('aside [data-part="folder-row"]')].map(el=>el.textContent?.replace(/\s/g,''))
 expect(rows).toEqual(expect.arrayContaining(['すべて2','問合せ1','未分類1']))
 await act(async()=>{within(host).getByRole('button',{name:'保管したもの',exact:true}).click()})
 const archivedRows=[...host.querySelectorAll('aside [data-part="folder-row"]')].map(el=>el.textContent?.replace(/\s/g,''))
 expect(archivedRows).toEqual(expect.arrayContaining(['すべて1','問合せ1','未分類0']))
 expect(host.textContent).toContain('保管したルール')
})

it('保管したルールを合計から除き、下書きは停止側に数える', async () => {
  vi.spyOn(api.automations, 'list').mockResolvedValueOnce({ success: true, data: [
    automation('active', '稼働中'),
    automation('draft', '下書き', { status: 'draft', isActive: false }),
    automation('archive', '保管済み', { status: 'archived', isActive: false }),
  ], summary: null })
  await render(<AutomationListV8 />)
  await waitFor(() => Boolean(host.textContent?.includes('下書き')), '一覧')
  const band = host.querySelector('[aria-label="ルールの数の帯"]')!
  expect(band.textContent?.replace(/\s/g, '')).toContain('ルール2件')
  expect(band.textContent?.replace(/\s/g, '')).toContain('動いている1・止めている1')
  expect(host.textContent).not.toContain('保管済み')
})

it('動いていない稼働ルールの件数に保管済みを含めない', async () => {
  vi.spyOn(api.automations, 'list').mockResolvedValueOnce({ success: true, data: [
    automation('active-idle', '稼働中', { executionCount30d: 0 }),
    automation('archived-idle', '保管済み', { status: 'archived', isActive: true, executionCount30d: 0 }),
  ], summary: null })
  await render(<AutomationListV8 />)
  await waitFor(() => Boolean(host.textContent?.includes('稼働中')), '一覧')
  expect(host.textContent).toContain('稼働中で直近30日動いていないルール 1')
})
