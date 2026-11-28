
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import FormsListV8 from './list'
import { formQuestionCount, type Form } from './model'
import { fieldsToLayout } from '@line-crm/shared'

;
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 回答フォーム一覧（src/v8/forms）の動きの試験。BEHAVIOR.md の「今までと変えたところ」を守る。
 * 未分類の件数・閲覧のみの帯と押せない「フォルダを追加」・行の「…」の読み上げ名・1152 で保存先を出さない・表示件数 10/20/50。
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
});

const fetchApi = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const unarchive = vi.hoisted(() => vi.fn())
const deleteImpact = vi.hoisted(() => vi.fn())
const listStats = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const narrow = vi.hoisted(() => ({ value: false }))
const account = vi.hoisted(() => ({ id: 'account-a' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    fetchApi,
    api: { ...api, forms: { ...api.forms, unarchive, deleteImpact }, folders: { ...api.folders, list: listFolders }, listStats: { get: listStats } },
  }
});

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { id: account.id, liffId: 'liff-a' }, loading: false }),
}));

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}));

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
});

vi.mock('@/lib/use-narrow-viewport', () => ({
  useNarrowViewport: () => narrow.value,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const baseForm = {
  description: '来店後に感想を聞く',
  fields: [],
  layout: { version: 2, header: [], sections: [], options: {} },
  onSubmitTagId: null,
  isActive: true,
  status: 'active',
  revision: 1,
  submitCount: 12,
  monthlySubmitCount: 3,
  monthlyCompletionRate: 50,
  createdAt: '2026-08-01',
  updatedAt: '2026-08-02',
  lastSubmittedAt: null,
  usedByAccounts: [],
  destinationSummary: { friendFieldCount: 3, tagCount: 0 },
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mount() {
  await act(async () => { root.render(<FormsListV8 />) })
  await flush()
}

beforeEach(() => {
  account.id = 'account-a'
  window.history.replaceState(null, '', '/form-submissions')
  forgetStaffIdentity()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  role.value = verifiedStaffRole('owner')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  window.localStorage.setItem('lh_staff_role', 'owner')
  narrow.value = false
  deleteImpact.mockReset()
  unarchive.mockReset()
  unarchive.mockResolvedValue({ success: true, data: { status: 'active', revision: 2, isActive: false } })
  fetchApi.mockReset()
  fetchApi.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/forms?')) {
      return { success: true, data: { items: [{ ...baseForm, id: 'f-1', name: '来店アンケート', folderId: null }], total: 1, all_total: 1, page: 1, limit: 20 } }
    }
    return { success: true, data: {} }
  })
  listFolders.mockReset()
  listFolders.mockResolvedValue({ success: true, data: [{ id: 'fol-1', kind: 'form', name: '来店・予約', itemCount: 6, displayOrder: 0, color: null }], unfiledCount: 3 })
  listStats.mockReset()
  listStats.mockResolvedValue({ success: true, data: { forms: { published: 5, draft: 2, monthlySubmits: 712, prevMonthSubmits: 640, monthlyCompletionRate: 74, pendingPostActions: 2 } } })
});

afterEach(() => {
  act(() => root.unmount())
  host.remove()
});

describe('V8 回答フォーム一覧', () => {
  it('詳細のフォーム名を編集中に画面を移ると入力を保って確認する', async () => {
    window.history.replaceState(null, '', '/form-submissions?form=f-1')
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: 'フォーム名を変更する' }))
    const input = screen.getByRole('textbox', { name: 'フォーム名' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '編集中のフォーム' } }); fireEvent.blur(input)
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'フォーム名' }) as HTMLInputElement).value).toBe('編集中のフォーム')
    link.remove()
  })
  it.each([false,true])('未完を名前と分けて状態の列に残し、詳細の入口を保つ（狭い=%s）', async (small) => {
    narrow.value = small
    fetchApi.mockImplementation(async (path: string) => path.startsWith('/api/forms?') ? {
      success: true, data: { items: [{ ...baseForm, id: 'f-1', name: '来店アンケート', folderId: null, pendingPostActionCount: 2 }], total: 1, all_total: 1, page: 1, limit: 20 },
    } : { success: true, data: {} })
    await mount()
    const row = host.querySelector('tr[data-row-id="f-1"]')!
    expect(row.querySelector('[data-list-name-cell]')?.textContent).not.toContain('未完')
    expect(row.querySelector('[data-list-status-cell]')?.textContent).toContain('後処理の未完 2')
    expect(row.querySelector('[data-list-name-cell] a')?.getAttribute('href')).toContain('/form-submissions/edit?id=f-1')
  })
  it('未分類の行にフォルダの口の unfiledCount を出す', async () => {
    await mount()
    const unfiled = screen.getByRole('button', { name: /未分類/ })
    expect(unfiled.textContent).toContain('3')
  })

  it('行の名前の前に、左のフォルダの列と同じ色の丸が付く（未分類は灰色の丸）', async () => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/forms?')) {
        return {
          success: true,
          data: {
            items: [
              { ...baseForm, id: 'f-1', name: '来店アンケート', folderId: 'fol-1' },
              { ...baseForm, id: 'f-2', name: 'イベント申込', folderId: null },
            ],
            total: 2, all_total: 2, page: 1, limit: 20,
          },
        }
      }
      return { success: true, data: {} }
    })
    listFolders.mockResolvedValue({ success: true, data: [{ id: 'fol-1', kind: 'form', name: '来店・予約', itemCount: 6, displayOrder: 0, color: '#2f6fde' }], unfiledCount: 3 })
    await mount()
    const filed = host.querySelector('tr[data-row-id="f-1"]')?.querySelectorAll('[data-folder-dot]') ?? []
    expect(filed).toHaveLength(1)
    expect(filed[0].getAttribute('data-folder-dot')).toBe('filed')
    expect(filed[0].getAttribute('aria-label')).toBe('フォルダ：来店・予約')
    const unfiled = host.querySelector('tr[data-row-id="f-2"]')?.querySelectorAll('[data-folder-dot]') ?? []
    expect(unfiled).toHaveLength(1)
    expect(unfiled[0].getAttribute('data-folder-dot')).toBe('unfiled')
  })

  it('行の「…」は「「〇〇」のその他の操作」で押せて、項目が開く', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '「来店アンケート」のその他の操作' }))
    await flush()
    expect(screen.getByRole('menuitem', { name: '受付を止める' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '削除' })).toBeTruthy()
  })

  it('変えられない人には閲覧のみの帯が出て、「フォルダを追加」は出さない（押せない飾りを置かない）', async () => {
    role.value = verifiedStaffRole('staff')
    await mount()
    expect(screen.getByText('閲覧のみで見ています。変える操作はオーナーか管理者に頼んでください。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /フォルダを追加/ })).toBeNull()
    const create = screen.getAllByRole('button', { name: /フォームを作る/ })
    expect(create.every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
    fireEvent.click(create[0])
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '「来店アンケート」のその他の操作' }))
    await flush()
    expect(screen.getByRole('menuitem', { name: '集まった回答' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '編集する' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '削除' })).toBeNull()
    fireEvent.click(host.querySelector('[data-row-id="f-1"]')!)
    await flush()
    expect(screen.getByRole('button', { name: 'フォーム名を変更する' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: '編集する' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button', { name: '複製' })).toBeNull()
  })

  it('フォームの編集権限がある staff は変更でき、フォルダの管理だけは出さない', async () => {
    role.value = verifiedStaffRole('staff')
    window.localStorage.setItem('lh_staff_role', 'staff')
    rememberStaffIdentity({ role: 'staff', permissionKeys: ['/form-submissions'] } as StaffMember)
    await mount()
    expect(screen.getAllByRole('button', { name: /フォームを作る/ }).length).toBeGreaterThan(0)
    expect(screen.queryByText('閲覧のみで見ています。変える操作はオーナーか管理者に頼んでください。')).toBeNull()
    expect(screen.queryByRole('button', { name: /フォルダを追加/ })).toBeNull()
  })

  it('管理できる人には帯を出さず、「フォルダを追加」を押せる', async () => {
    await mount()
    expect(screen.queryByText('閲覧のみで見ています。変える操作はオーナーか管理者に頼んでください。')).toBeNull()
    const add = screen.getByRole('button', { name: /フォルダを追加/ }) as HTMLButtonElement
    expect(add.disabled).toBe(false)
  })

  it('1152 の板では保存先の列を出さない', async () => {
    narrow.value = true
    await mount()
    expect(screen.queryByRole('columnheader', { name: '保存先' })).toBeNull()
    expect(screen.queryByText('友だち情報 3')).toBeNull()
  })

  it('広い板では保存先の列を出す', async () => {
    await mount()
    expect(screen.getByRole('columnheader', { name: '保存先' })).toBeTruthy()
    expect(screen.getByText('友だち情報 3')).toBeTruthy()
  })

  it('1ページは件数の範囲だけを出す', async () => {
    await mount()
    expect(screen.getByText('1件中 1〜1件')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: '回答フォームのページ送り' })).toBeNull()
    expect(screen.queryByRole('button', { name: '1ページ目へ' })).toBeNull()
  })

  it('一覧の口へ件数 20・最新の回答順で頼む', async () => {
    await mount()
    const listCall = fetchApi.mock.calls.map(([path]) => String(path)).find((path) => path.startsWith('/api/forms?'))
    expect(listCall).toContain('limit=20')
    expect(listCall).toContain('sort=latest-answer')
    expect(listCall).toContain('with_list_summary=1')
  })

  it('件数が1ページを超えるときは共通の ListRange で「N件中 X〜Y件」と出す', async () => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/forms?')) {
        return {
          success: true,
          data: {
            items: [
              { ...baseForm, id: 'f-1', name: '来店アンケート', folderId: null },
              { ...baseForm, id: 'f-2', name: '予約後アンケート', folderId: null },
            ],
            total: 45, all_total: 45, page: 1, limit: 20,
          },
        }
      }
      return { success: true, data: {} }
    })
    await mount()
    expect(host.textContent).toContain('45件中 1〜2件')
  })
});

/*
 * 2026-10-06 点検：表全体を1つの右クリックで包み、押した行を state に入れてから項目を作っていたので、
 * 1回目の右クリックでは空で開かず、2回目は前に押した行の項目が出ていた。
 */
describe('V8 回答フォーム一覧の右クリック', () => {
  beforeEach(() => {
    fetchApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/forms?')) {
        return {
          success: true,
          data: {
            items: [
              { ...baseForm, id: 'f-1', name: '来店アンケート', folderId: null },
              { ...baseForm, id: 'f-2', name: '受付を終えたアンケート', folderId: null, isActive: false },
            ],
            total: 2, all_total: 2, page: 1, limit: 20,
          },
        }
      }
      return { success: true, data: {} }
    })
  })

  const rowCell = (id: string) => {
    const row = host.querySelector(`tr[data-row-id="${id}"]`)
    expect(row, `${id} の行がある`).toBeTruthy()
    return row!.querySelector('td')!
  }
  const openMenu = () => document.body.querySelector('[data-context-menu] [role="menu"]')

  it('1回目の右クリックで、押した行の項目のメニューが開く', async () => {
    await mount()
    await act(async () => { fireEvent.contextMenu(rowCell('f-2'), { clientX: 80, clientY: 140 }) })
    await flush()
    const menu = openMenu()
    expect(menu, '1回目で開く').toBeTruthy()
    expect(menu!.getAttribute('aria-label')).toBe('「受付を終えたアンケート」の操作')
    // 止まっているフォームには「受付を止める」が無い（押した行の中身で作っている）。
    expect(menu!.textContent).toContain('フォルダへ移す')
    expect(menu!.textContent).not.toContain('受付を止める')
  })

  it('続けて別の行を右クリックすると、前の行ではなくその行の項目が出る', async () => {
    await mount()
    await act(async () => { fireEvent.contextMenu(rowCell('f-2'), { clientX: 80, clientY: 140 }) })
    await flush()
    await act(async () => { fireEvent.keyDown(openMenu()!, { key: 'Escape' }) })
    await flush()
    expect(openMenu()).toBeNull()
    await act(async () => { fireEvent.contextMenu(rowCell('f-1'), { clientX: 80, clientY: 100 }) })
    await flush()
    const menu = openMenu()
    expect(menu, '2回目も開く').toBeTruthy()
    expect(menu!.getAttribute('aria-label')).toBe('「来店アンケート」の操作')
    expect(menu!.textContent).toContain('受付を止める')
  })
});

it('アーカイブの絞り込みと復元は版番号を送り、受付を勝手に再開しない', async () => {
  fetchApi.mockImplementation(async (path: string) => ({ success: true, data: path.includes('filter=archived')
    ? { items: [{ ...baseForm, id: 'f-old', name: '過去のフォーム', status: 'archived', isActive: false, revision: 7 }], total: 1 }
    : { items: [], total: 0 } }));
  await mount();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'アーカイブ済み' })));
  await flush();
  expect(fetchApi.mock.calls.some(([path]) => path.includes('filter=archived'))).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '「過去のフォーム」のその他の操作' })));
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'アーカイブから戻す' })));
  await flush();
  expect(unarchive).toHaveBeenCalledWith('f-old', 'account-a', 7);
});


it('一覧フロー：余白・Enter・Spaceでフォームのパネル、名前は編集、回答件数は別操作', async () => {
  await mount()
  const row = host.querySelector<HTMLElement>('tr[data-row-id="f-1"]')!
  const name = row.querySelector<HTMLAnchorElement>('a[data-row-link]')!
  expect(new URL(name.href).pathname).toBe('/form-submissions/edit')
  expect(new URL(new URL(name.href).searchParams.get('returnTo')!, window.location.origin).searchParams.get('form')).toBe('f-1')
  const count = row.querySelector<HTMLAnchorElement>('a[href*="/responses"]')!
  expect(new URL(count.href).pathname).toBe('/form-submissions/responses')
  await act(async () => { fireEvent.click(row) })
  expect(new URLSearchParams(window.location.search).get('form')).toBe('f-1')
  expect(screen.getByRole('dialog', { name: '来店アンケート' })).toBeTruthy()
  await act(async () => { fireEvent.click(row) })
  expect(new URLSearchParams(window.location.search).has('form')).toBe(false)
  await act(async () => { fireEvent.keyDown(row, { key: ' ' }) })
  expect(new URLSearchParams(window.location.search).get('form')).toBe('f-1')
})

afterEach(() => { verifiedStaffRole(null) })
it('質問数は配置の入力欄を数え、見出し・説明を数えず、互換fieldsの欠落でも落とさない', () => {
  const fields = [{ name: 'answer', label: '回答', type: 'text' }, { name: 'title', label: '題', type: 'heading' }]
  const layout = fieldsToLayout(fields)
  expect(formQuestionCount({ fields: [], layout })).toBe(1)
  expect(formQuestionCount({ fields, layout: undefined } as unknown as Form)).toBe(1)
})


describe('フォームを片付ける時の案内', () => {
  const impact = {
    form: { id: 'f-1', name: '来店アンケート', isActive: false, status: 'active' },
    submissionCount: 0, openCount: 0, references: [], referenceCount: 0,
    answerUrl: 'https://liff.line.me/liff-a/?page=form&id=f-1',
    revision: 4, contentRevision: 3, checkedAt: '2026-10-31T12:00:00Z',
    canDelete: true, canArchive: true, recommendedAction: 'delete', blockers: [],
  }
  async function openCleanup() {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '「来店アンケート」のその他の操作' }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    await flush()
    return within(screen.getByRole('dialog', { name: '「来店アンケート」をどうしますか' }))
  }
  it('削除の対象を示し、切替前の確定を拒む', async () => {
    const { api } = await import('@/lib/api')
    const remove = vi.spyOn(api.forms, 'remove').mockResolvedValue({ success: true, data: {} } as never)
    deleteImpact.mockResolvedValue({ success: true, data: impact })
    const dialog = await openCleanup()
    expect(dialog.getByText('LINEアカウント')).toBeTruthy()
    const button = dialog.getByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const oldConfirm = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    account.id = 'account-b'; await mount()
    account.id = 'account-a'; await mount()
    await act(async () => oldConfirm())
    expect(remove).not.toHaveBeenCalled()
    remove.mockRestore()
  })

  it('受付停止の対象を示し、切替前の確定を拒む', async () => {
    const { api } = await import('@/lib/api')
    const update = vi.spyOn(api.forms, 'update').mockResolvedValue({ success: true, data: {} } as never)
    deleteImpact.mockResolvedValue({ success: true, data: impact })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '「来店アンケート」のその他の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '受付を止める' }))
    await flush()
    const dialog = within(screen.getByRole('alertdialog'))
    expect(dialog.getByText('LINEアカウント')).toBeTruthy()
    const button = dialog.getByRole('button', { name: '受付を止める' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const oldConfirm = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    account.id = 'account-b'; await mount()
    account.id = 'account-a'; await mount()
    await act(async () => oldConfirm())
    expect(update).not.toHaveBeenCalled()
    update.mockRestore()
  })

  it('閉じて再表示した後は前の削除確定を使えない', async () => {
    const { api } = await import('@/lib/api')
    const remove = vi.spyOn(api.forms, 'remove').mockResolvedValue({ success: true, data: {} } as never)
    deleteImpact.mockResolvedValue({ success: true, data: impact })
    let dialog = await openCleanup()
    const button = dialog.getByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const oldConfirm = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    fireEvent.click(dialog.getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: '「来店アンケート」のその他の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    await flush()
    dialog = within(screen.getByRole('dialog', { name: '「来店アンケート」をどうしますか' }))
    await act(async () => oldConfirm())
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: '削除する' }))
    await flush()
    expect(remove).toHaveBeenCalledTimes(1)
    remove.mockRestore()
  })

  it('受付停止の確認後に選んだアカウントへ送る', async () => {
    const { api } = await import('@/lib/api')
    const update = vi.spyOn(api.forms, 'update').mockResolvedValue({ success: true, data: {} } as never)
    deleteImpact.mockResolvedValue({ success: true, data: impact })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '「来店アンケート」のその他の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '受付を止める' }))
    await flush()
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '受付を止める' }))
    await flush()
    expect(update).toHaveBeenCalledWith('f-1', 'account-a', { isActive: false, expectedContentRevision: 3 })
    update.mockRestore()
  })

  it('削除できる未公開フォームは削除を勧め、開けなくなる公開URLを出さない', async () => {
    deleteImpact.mockResolvedValue({ success: true, data: impact })
    const dialog = await openCleanup()
    expect(dialog.getByText('削除する（おすすめ）')).toBeTruthy()
    expect(dialog.queryByText('アーカイブする（おすすめ）')).toBeNull()
    expect(dialog.queryByText(/開けなくなる公開URL/)).toBeNull()
    expect((dialog.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('公開した受付停止フォームはアーカイブを勧め、公開URLの影響を残す', async () => {
    deleteImpact.mockResolvedValue({ success: true, data: { ...impact, canDelete: false, recommendedAction: 'archive', blockers: ['published'] } })
    const dialog = await openCleanup()
    expect(dialog.getByText('アーカイブする（おすすめ）')).toBeTruthy()
    expect(dialog.queryByText('削除する（おすすめ）')).toBeNull()
    expect(dialog.getByText(/開けなくなる公開URL/)).toBeTruthy()
    expect((dialog.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('未公開でも利用先がある時は削除を許可せず、利用先の注意を保つ', async () => {
    deleteImpact.mockResolvedValue({ success: true, data: { ...impact, canDelete: false, recommendedAction: 'archive', blockers: ['in_use'], referenceCount: 1,
      references: [{ kind: 'rich_menu', name: 'お知らせ', href: '/rich-menus/edit?id=menu-a', state: 'available' }] } })
    const dialog = await openCleanup()
    expect(dialog.getByText('アーカイブする（おすすめ）')).toBeTruthy()
    expect(dialog.queryByText(/開けなくなる公開URL/)).toBeNull()
    expect(dialog.getByText(/このフォームを開きます/)).toBeTruthy()
    expect(dialog.queryByTitle(/開けなくなる公開URL/)).toBeNull()
    expect((dialog.getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('影響を確認できない時は削除もアーカイブも実行できない', async () => {
    deleteImpact.mockRejectedValue(new Error('offline'))
    const dialog = await openCleanup()
    expect(dialog.getByText(/影響を確認できませんでした/)).toBeTruthy()
    for (const name of ['削除する', 'アーカイブする']) expect((dialog.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('空一覧では権限の無い人のフォーム作成を止める', async () => {
    role.value = verifiedStaffRole('staff')
    fetchApi.mockImplementation(async (path: string) => path.startsWith('/api/forms?') ? { success: true, data: { items: [], total: 0, all_total: 0, page: 1, limit: 20 } } : { success: true, data: {} })
    await mount()
    const b = screen.getByRole('button', { name: /最初のフォームを作る/ }) as HTMLButtonElement
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(b)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

})
