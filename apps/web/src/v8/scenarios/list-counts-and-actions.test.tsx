// @vitest-environment happy-dom
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
/*
 * V8 シナリオ一覧の件数と操作の動きの試験。
 * - 読了率の母数は「いま途中＋読み終えた人」。登録0でも数は読めているので「登録した 0 人」（棒・割合なし）
 * - 「すべて」と数の帯のシナリオ数は、絞り込み無しの全体件数（共通のシナリオを含む）
 * - フォルダ・数の帯は一覧と同じアカウントで数え、「未分類」はサーバーの数を出す
 * - 共通のシナリオがフォルダの内訳に入らないことを、差がある時だけ説明する
 * - アカウントを替えたら絞り込みを外し、前のアカウントの遅い応答を採らない
 * - 狭い板の「フォルダ」の選ぶ欄でも、左の列と同じ絞り込みになる
 * - まとめて操作・フォルダ移動の失敗は日本語の知らせにし、表示を元に戻す
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const scenario = (id: string, name: string, folderId: string | null, isActive = true) => ({
  id,
  contentRevision: 7,
  name,
  description: null,
  triggerType: 'friend_add',
  triggerTagId: null,
  isActive,
  deliveryMode: 'elapsed',
  allowConcurrent: true,
  displayOrder: 0,
  folderId,
  lineAccountId: 'account-a',
  subscriberCount: 10,
  completedCount: 2,
  stepCount: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
})

const state = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'admin' | 'staff' | 'viewer' | null,
  account: 'account-a' as string | null,
  /** 絞り込み無しの全体件数（全アカウント共通のシナリオを含む）。 */
  overall: 7,
  stats: { scenarios: { total: 5, active: 4, subscribers: 30, completed: 10, sentThisWeek: 12 } } as Record<string, unknown>,
}))
const push = vi.hoisted(() => vi.fn())
const listPage = vi.hoisted(() => vi.fn())
const folderList = vi.hoisted(() => vi.fn())
const folderUpdate = vi.hoisted(() => vi.fn())
const statsGet = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const bulkStop = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())
const reorder = vi.hoisted(() => vi.fn())
const undo = vi.hoisted(() => ({ hold: false, queue: [] as Array<{ commit: () => unknown }> }))
const duplicate = vi.hoisted(() => vi.fn())

vi.mock('@/components/scenarios/duplicate-scenario', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/scenarios/duplicate-scenario')>(),
  duplicateScenario: duplicate,
}))

/* 取り消しの5秒を待たずに送る。失敗したら画面を戻し、画面が渡した文で知らせる（本物と同じ順）。 */
vi.mock('@/lib/undoable', async (importOriginal: () => Promise<typeof import('@/lib/undoable')>) => {
  const actual = await importOriginal()
  const { notifyToast } = await import('@/components/shared/toast')
  const { scheduledConfirmation } = await import('@/test-utils/confirmed-undo-test-handle')
  return {
    ...actual,
    runUndoable: (options: Parameters<typeof actual.runUndoable>[0] & { confirmation?: boolean }) => {
      if (options.confirmation) {
        const scheduled = scheduledConfirmation(options)
        if (undo.hold) undo.queue.push({ ...options, get failureMessage() { return options.failureMessage }, commit: scheduled.execute })
        else void Promise.resolve().then(() => scheduled.execute()).catch(() => {})
        return scheduled.handle
      }
      if (undo.hold) { undo.queue.push(options); return }
      void Promise.resolve()
        .then(() => options.commit())
        .then((res) => {
          if (res && res.success === false) throw new Error(res.error ?? '')
          options.onCommitted?.()
        })
        .catch(() => {
          ;(options.onCommitError ?? options.undo)()
          notifyToast(options.failureMessage ?? 'できませんでした。もう一度お試しください。', { tone: 'error' })
        })
    },
  }
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: state.account, loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: state.account, loading: false }),
}))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => state.role, useStaffIdentity: () => ({ id: 'staff-one' }) }
})

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      scenarios: { ...api.scenarios, confirmation: vi.fn(async () => ({ success: true, data: { contentRevision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 0, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] } })), listPage, update, bulkStop, create, delete: remove, moveReferrers: vi.fn(async () => ({ success: true, data: { items: [] } })), reorder },
      folders: { ...api.folders, list: folderList, update: folderUpdate },
      listStats: { get: statsGet },
    },
  }
})

import ScenariosListV8 from './list'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const rows = [
  scenario('s-filed', '新規登録7日間フォロー', 'sf-onboarding'),
  scenario('s-unfiled', '会員更新リマインド', null, false),
]

function folderRow(label: string) {
  const row = document.querySelector(`button[data-part="folder-row"][title="${label}"]`)
  expect(row, `フォルダの行「${label}」`).not.toBeNull()
  return row as HTMLElement
}

function kpi(title: string) {
  const card = [...document.querySelectorAll('[data-kpi-presentation]')]
    .find((item) => item.textContent?.startsWith(title))
  expect(card, `数の帯「${title}」`).toBeTruthy()
  return card as HTMLElement
}

async function mount() {
  const view = render(<><ScenariosListV8 /><ToastHost /></>)
  await view.findByText('新規登録7日間フォロー')
  return view
}

beforeEach(() => {
  forgetStaffIdentity(); forgetSessionSnapshot()
  rememberStaffIdentity({ id: 'scenario-owner', role: 'owner', permissionKeys: [] } as unknown as StaffMember)
  // 絞り込みは URL に残るので、前の試験の絞り込みを持ち越さない。
  window.history.replaceState(null, '', '/scenarios')
  undo.hold = false; undo.queue = []
  reorder.mockResolvedValue({ success: true })
  remove.mockResolvedValue({ success: true })
  state.account = 'account-a'
  state.role = 'owner'
  state.overall = 7
  state.stats = { scenarios: { total: 5, active: 4, subscribers: 30, completed: 10, sentThisWeek: 12 } }
  listPage.mockImplementation(async (input: { limit?: number; folderId?: string }) => ({
    success: true,
    data: input.limit === 1
      ? { items: [], total: state.overall, limit: 1, sort: [] }
      : { items: input.folderId ? rows.filter((r) => r.folderId === input.folderId) : rows, total: input.folderId ? 1 : rows.length, limit: input.limit ?? 20, sort: [] },
  }))
  folderList.mockImplementation(async (_kind: string, accountId?: string) => ({
    success: true,
    data: [{ id: accountId === 'account-b' ? 'sf-b' : 'sf-onboarding', kind: 'scenario', name: accountId === 'account-b' ? 'B店の箱' : '初回案内', parentId: null, displayOrder: 0, itemCount: 3, color: '#2f6fde' }],
    unfiledCount: 2,
  }))
  statsGet.mockImplementation(async () => ({ success: true, data: state.stats }))
  update.mockResolvedValue({ success: true, data: {} })
  bulkStop.mockReset().mockResolvedValue({ success: true, data: { stopped: 1 } })
  folderUpdate.mockResolvedValue({ success: true, data: {} })
  duplicate.mockResolvedValue('duplicate-result')
})

afterEach(() => {
  forgetStaffIdentity(); forgetSessionSnapshot()
  cleanup()
  clearToastsForTest()
  vi.clearAllMocks()
})

describe('読了率の母数', () => {
  test.each(['owner', 'viewer'] as const)('一覧の説明は%sの操作に合う', async role => {
    state.role = role
    rememberStaffIdentity({ id: 'scenario-person', role, permissionKeys: [] } as unknown as StaffMember)
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    expect(screen.getByText(/きっかけ（友だち追加/)).toBeTruthy()
    expect(Boolean(screen.queryByText(/まとめて止める・再開・フォルダへ移す/))).toBe(role === 'owner')
    if (role === 'viewer') expect(screen.getByText(/配信結果を確認できます/)).toBeTruthy()
  })
  test('いま途中と読み終えた人の合計を母数にし、購読中は重複を含むと書く', async () => {
    await mount()
    await waitFor(() => expect(kpi('最後まで配信した人').textContent).toContain('全7件の合計'))
    fireEvent.click(screen.getByRole('button', { name: '最後まで配信した人の説明', exact: true }))
    expect(screen.getByText('登録した 40 人の 25%')).toBeTruthy()
    expect(kpi('配信中').textContent?.replace(/\n/g, '')).toContain('いま途中にいる人（重複を含む）')
    expect(screen.getAllByTitle('配信中 10 人・最後まで配信 2 人')).toHaveLength(2)
  })

  test('登録した人が0でも数は読めているので薄い灰の「登録した 0 人」と出す（割合は決まらないので出さない）', async () => {
    state.stats = { scenarios: { total: 0, active: 0, subscribers: 0, completed: 0, sentThisWeek: 0 } }
    await mount()
    await waitFor(() => expect(kpi('最後まで配信した人').textContent).toContain('全7件の合計'))
    fireEvent.click(screen.getByRole('button', { name: '最後まで配信した人の説明', exact: true }))
    expect(screen.getAllByText('登録した 0 人').length).toBeGreaterThan(0)
    expect(kpi('最後まで配信した人').textContent).not.toContain('%')
  })

  test('登録0の行は棒と割合を出さず「登録した 0 人」だけ出す', async () => {
    listPage.mockImplementation(async () => ({
      success: true,
      data: { items: [{ ...scenario('s-zero', '誰もいない', null), subscriberCount: 0, completedCount: 0 }], total: 1, limit: 20, sort: [] },
    }))
    const view = render(<><ScenariosListV8 /><ToastHost /></>)
    await view.findByText('誰もいない')
    const row = screen.getByText('誰もいない').closest('tr') as HTMLElement
    expect(row.textContent).toContain('配信中 0 人・最後まで配信 0 人')
    expect(row.textContent).toContain('登録した 0 人')
    expect(row.textContent).not.toContain('%')
    expect(within(row).queryByRole('progressbar')).toBeNull()
  })
})

describe('件数の定義', () => {
  test('「すべて」と数の帯は全体件数。フォルダ・数の帯は同じアカウントで数え、未分類はサーバーの数', async () => {
    await mount()
    await waitFor(() => expect(folderRow('すべて').textContent).toBe('すべて7'))
    expect(listPage).toHaveBeenCalledWith({ accountId: 'account-a', page: 1, limit: 1 })
    expect(folderList).toHaveBeenCalledWith('scenario', 'account-a')
    expect(statsGet).toHaveBeenCalledWith('account-a')
    expect(folderRow('未分類').textContent).toBe('未分類2')
    // 数の帯は list-stats の total（共通を含まない 5）ではなく、全体件数 7。
    await waitFor(() => expect(kpi('シナリオ').textContent).toContain('7'))
    expect(kpi('最後まで配信した人').textContent).toContain('全7件の合計')
    expect(kpi('シナリオ').textContent).not.toContain('5件')
  })

  test('絞り込んでも「すべて」は全体件数のまま', async () => {
    await mount()
    fireEvent.click(folderRow('初回案内'))
    await waitFor(() => expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'sf-onboarding' }), expect.anything()))
    await waitFor(() => expect(screen.queryByText('会員更新リマインド')).toBeNull())
    expect(folderRow('すべて').textContent).toBe('すべて7')
  })

  test('全体と内訳の差（共通のシナリオ）がある時だけ、内訳に入らないと説明する', async () => {
    await mount()
    // 全体7 − フォルダ3 − 未分類2 = 共通2
    expect(await screen.findByText(/全アカウントに共通で適用されるシナリオが2 件あります/)).toBeTruthy()
    expect(screen.getByText(/フォルダ別の件数と「未分類」には含まれません/)).toBeTruthy()
    cleanup()
    state.overall = 5
    await mount()
    await waitFor(() => expect(folderRow('すべて').textContent).toBe('すべて5'))
    expect(screen.queryByText(/全アカウントに共通で適用されるシナリオが/)).toBeNull()
  })

  test('アカウントを替えたら絞り込みと前のアカウントのフォルダを外し、新しいアカウントで数え直す', async () => {
    const view = await mount()
    fireEvent.click(folderRow('初回案内'))
    await waitFor(() => expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'sf-onboarding' }), expect.anything()))

    state.account = 'account-b'
    view.rerender(<><ScenariosListV8 /><ToastHost /></>)
    await waitFor(() => expect(folderList).toHaveBeenCalledWith('scenario', 'account-b'))
    await waitFor(() => expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-b', folderId: undefined }), expect.anything()))
    expect(listPage).toHaveBeenCalledWith({ accountId: 'account-b', page: 1, limit: 1 })
    await waitFor(() => expect(statsGet).toHaveBeenCalledWith('account-b'))
    await waitFor(() => expect(document.querySelector('button[data-part="folder-row"][title="B店の箱"]')).not.toBeNull())
    expect(document.querySelector('button[data-part="folder-row"][title="初回案内"]')).toBeNull()
    expect(folderRow('すべて').getAttribute('aria-current')).toBe('true')
  })
})

describe('前のアカウントの遅い応答', () => {
  test('切り替えの前に出したフォルダの読み込みが後から返っても、今のアカウントの列を上書きしない', async () => {
    let lateA!: (value: unknown) => void
    folderList.mockImplementationOnce(() => new Promise((resolve) => { lateA = resolve }))
    const view = render(<><ScenariosListV8 /><ToastHost /></>)
    await view.findByText('新規登録7日間フォロー')
    state.account = 'account-b'
    view.rerender(<><ScenariosListV8 /><ToastHost /></>)
    await waitFor(() => expect(document.querySelector('button[data-part="folder-row"][title="B店の箱"]')).not.toBeNull())
    await act(async () => {
      lateA({ success: true, data: [{ id: 'sf-a', kind: 'scenario', name: 'A店の古い箱', parentId: null, displayOrder: 0, itemCount: 9 }], unfiledCount: 99 })
    })
    expect(document.querySelector('button[data-part="folder-row"][title="A店の古い箱"]')).toBeNull()
    expect(folderRow('未分類').textContent).toBe('未分類2')
  })
})

describe('狭い板のフォルダの選ぶ欄', () => {
  test('「フォルダ：すべて」から選ぶと、左の列と同じ絞り込みになる', async () => {
    await mount()
    const select = screen.getByRole('button', { name: 'フォルダ' })
    expect(select.textContent).toContain('フォルダ：すべて')
    fireEvent.click(select)
    fireEvent.click(within(await screen.findByRole('option', { name: '初回案内' })).getByRole('button'))
    await waitFor(() => expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'sf-onboarding' }), expect.anything()))
    expect(folderRow('初回案内').getAttribute('aria-current')).toBe('true')
  })
})

describe('作るボタン', () => {
  test('方式選びへ送るだけで行を作らず、作成中の状態にもしない', async () => {
    await mount()
    const button = screen.getAllByRole('button', { name: 'シナリオを作る' })[0] as HTMLButtonElement
    fireEvent.click(button)
    // 行き先は方式選び（戻り先だけ添える）。id を付けない＝まだ行が無いと方式選びが分かる。
    expect(push).toHaveBeenCalledTimes(1)
    const target = new URL(push.mock.calls[0][0] as string, 'http://admin.test')
    expect(target.pathname).toBe('/scenarios/mode')
    expect(target.searchParams.get('id')).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(button.disabled).toBe(false)
    expect(screen.queryByText('作成中…')).toBeNull()
  })
})

describe('操作の失敗', () => {
  function selectRow(name: string) {
    const row = screen.getByText(name).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('checkbox'))
  }

  test('まとめて再開に失敗したら日本語で知らせ、行の状態を元に戻す', async () => {
    update.mockResolvedValue({ success: false, error: 'Internal Server Error' })
    await mount()
    selectRow('会員更新リマインド')
    fireEvent.click(await screen.findByRole('button', { name: '再開' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('s-unfiled', { isActive: true }))
    expect(await screen.findByText(/全 1 件中 0 件の保存を確認しました。1 件目で止めました。未送信は 0 件です。理由：/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('Internal Server Error')
  })

  test('まとめて停止に失敗したら日本語で知らせる', async () => {
    bulkStop.mockRejectedValue(new Error('offline'))
    await mount()
    selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: '止める' }))
    const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する' }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }))
    await waitFor(() => expect(bulkStop).toHaveBeenCalledWith([{ id: 's-filed', revision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }]))
    expect(await screen.findByText('停止に失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('offline')
  })

  test('全アカウント共通のシナリオの停止では全アカウントに効くことを示す', async () => {
    listPage.mockResolvedValue({ success: true, data: { items: [{ ...rows[0], lineAccountId: null }], total: 1, limit: 20, sort: [] } })
    await mount()
    selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: '止める' }))
    const dialog = within(await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' }))
    expect(dialog.getByText('すべてのLINEアカウント')).toBeTruthy()
    expect(dialog.queryByText('本店', { exact: true })).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  test('フォルダ移動に失敗したら日本語で知らせ、行を元のフォルダへ戻す', async () => {
    update.mockResolvedValue({ success: false, error: 'Internal Server Error' })
    await mount()
    selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダへ移す' }))
    const dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(await within(dialog).findByText('本店')).toBeTruthy()
    expect(within(dialog).getByText('検証環境')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '移動する' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('s-filed', { folderId: null }))
    expect(await screen.findByText(/全 1 件中 0 件の保存を確認しました。1 件目で止めました。未送信は 0 件です。理由：/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('Internal Server Error')
    const row = screen.getByText('新規登録7日間フォロー').closest('tr') as HTMLElement
    await waitFor(() => expect(row.querySelector('[data-folder-dot]')?.getAttribute('aria-label')).toBe('フォルダ：初回案内'))
  })

  test('共通と個別のシナリオを一緒に移すとき全アカウントへの影響を示す', async () => {
    listPage.mockResolvedValue({ success: true, data: { items: [{ ...rows[0], lineAccountId: null }, rows[1]], total: 2, limit: 20, sort: [] } })
    await mount()
    selectRow('新規登録7日間フォロー')
    selectRow('会員更新リマインド')
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダへ移す' }))
    const dialog = within(await screen.findByRole('dialog', { name: '2 件のシナリオのフォルダを移動' }))
    expect(dialog.getByText('すべてのLINEアカウント')).toBeTruthy()
    expect(dialog.getByText('検証環境')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })
})


describe('右詳細の情報と操作', () => {
  async function panel() {
    window.history.replaceState(null, '', '/scenarios?scenario=s-filed')
    render(<><ScenariosListV8 /><ToastHost /></>)
    return screen.findByRole('dialog', { name: '新規登録7日間フォロー', exact: true })
  }

  test('名前の編集中に詳細を閉じると破棄の確認が出る', async () => {
    const detail = await panel()
    fireEvent.click(within(detail).getByRole('button', { name: 'シナリオ名を変更する' }))
    const input = within(detail).getByRole('textbox', { name: 'シナリオ名', exact: true })
    fireEvent.change(input, { target: { value: '未保存の名前' } })
    fireEvent.blur(input)
    fireEvent.click(within(detail).getByRole('button', { name: '閉じる' }))
    expect(await screen.findByText('保存していない変更があります')).toBeTruthy()
  })

  test('人数は配信の状態として示し、複製と削除はメニューへ置く', async () => {
    const detail = await panel()
    const scoped = within(detail)
    expect(scoped.getByRole('region', { name: '配信状況' }).textContent).toContain('配信中 10 人・最後まで配信 2 人')
    expect(detail.textContent).not.toContain('既読人数ではありません。')
    fireEvent.click(scoped.getByRole('button', { name: '配信状況の説明', exact: true }))
    expect((await scoped.findByRole('note')).textContent).toContain('既読人数ではありません。')
    fireEvent.click(scoped.getByRole('button', { name: '配信状況の説明', exact: true }))
    expect(scoped.getByRole('heading', { name: '名前を変更' })).toBeTruthy()
    expect(scoped.getByRole('button', { name: 'シナリオ名を変更する' })).toBeTruthy()
    fireEvent.click(scoped.getByRole('button', { name: '「新規登録7日間フォロー」のその他操作' }))
    expect(screen.getByRole('menuitem', { name: '複製する', exact: true })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '複製する', exact: true }), { key: 'Escape' })
    expect(scoped.getByRole('button', { name: '開く', exact: true })).toBeTruthy()
    fireEvent.click(scoped.getByRole('button', { name: '配信結果', exact: true }))
    expect(push).toHaveBeenCalledTimes(1)
    const target = new URL(push.mock.calls[0][0] as string, 'http://admin.test')
    expect(target.pathname).toBe('/scenarios/results')
    expect(target.searchParams.get('id')).toBe('s-filed')
    expect(target.searchParams.get('returnTo')).toBe('/scenarios?scenario=s-filed')
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  test('未取得の人数や方式を0人や前の配信からの間隔へ推測しない', async () => {
    listPage.mockResolvedValue({ success: true, data: { items: [{ ...rows[0], deliveryMode: undefined, stepCount: undefined, subscriberCount: undefined, completedCount: undefined }], total: 1, limit: 20, sort: [] } })
    const detail = await panel()
    expect(detail.textContent).toContain('配信方法は未確認・通数は未確認')
    const facts = within(detail).getByRole('region', { name: '配信状況' })
    expect(facts.textContent).toContain('配信中 —・最後まで配信 —')
    expect(facts.textContent).not.toContain('— 人')
    expect(facts.textContent).not.toContain('0 人')
  })

  test('メニューからの削除は同じ確認窓を経て、取消では削除しない', async () => {
    const detail = await panel()
    fireEvent.click(within(detail).getByRole('button', { name: '「新規登録7日間フォロー」のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除する', exact: true }))
    const confirmation = await screen.findByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？', exact: true })
    expect(within(confirmation).getByText('LINEアカウント')).toBeTruthy()
    expect(await within(confirmation).findByText('本店')).toBeTruthy()
    expect(within(confirmation).getByText('検証環境')).toBeTruthy()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル', exact: true }))
    expect(remove).not.toHaveBeenCalled()
  })

  test('全アカウント共通のシナリオは選択中の1件と区別して削除前に示す', async () => {
    listPage.mockResolvedValue({ success: true, data: { items: [{ ...rows[0], lineAccountId: null }], total: 1, limit: 20, sort: [] } })
    const detail = await panel()
    fireEvent.click(within(detail).getByRole('button', { name: '「新規登録7日間フォロー」のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除する', exact: true }))
    const dialog = within(await screen.findByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？' }))
    expect(dialog.getByText('すべてのLINEアカウント')).toBeTruthy()
    expect(dialog.queryByText('本店', { exact: true })).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  test('名前の編集失敗でも入力を残し、同じ値で再試行する', async () => {
    update.mockResolvedValueOnce({ success: false, error: 'offline' }).mockResolvedValueOnce({ success: true, data: {} })
    const detail = await panel()
    fireEvent.click(within(detail).getByRole('button', { name: 'シナリオ名を変更する' }))
    const input = within(detail).getByRole('textbox', { name: 'シナリオ名', exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '変更した名前' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await within(detail).findByRole('alert')).toBeTruthy()
    expect(input.value).toBe('変更した名前')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenNthCalledWith(1, 's-filed', { name: '変更した名前' })
    expect(update).toHaveBeenNthCalledWith(2, 's-filed', { name: '変更した名前' })
  })

  test.each(['viewer', null] as const)('役割%sでは既存の編集操作を起動しない', async (role) => {
    state.role = role
    forgetStaffIdentity()
    if (role) rememberStaffIdentity({ id: 'scenario-viewer', role, permissionKeys: [] } as unknown as StaffMember)
    const detail = await panel()
    expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(role === null ? 0 : 1)
    const edit = within(detail).getByRole('button', { name: 'シナリオ名を変更する' })
    if (role === null) { expect(edit.hasAttribute('disabled')).toBe(true); expect(edit.hasAttribute('data-permission-locked')).toBe(false) }
    else await expectPermissionLocked(edit)
    const more = within(detail).getByRole('button', { name: /その他操作/ })
    fireEvent.click(more)
    const duplicateItem = screen.getByRole('menuitem', { name: '複製する', exact: true })
    if (role === null) { expect(duplicateItem.hasAttribute('disabled')).toBe(true); expect(duplicateItem.hasAttribute('data-permission-locked')).toBe(false) }
    else expect(duplicateItem.getAttribute('aria-disabled')).toBe('true')
    expect(within(detail).getByRole('button', { name: '開く', exact: true })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(duplicate).not.toHaveBeenCalled()
  })
})


describe('保持した書込操作の実行直前の判定', () => {
  function selectRow(name: string) { const row = screen.getByText(name).closest('tr')!; fireEvent.click(within(row).getByRole('checkbox')) }
  const person = (role: 'owner' | 'admin' | 'staff' | 'viewer', extra: object = {}) => { state.role = role; return { id: 'scenario-person', role, permissionKeys: [], ...extra } as unknown as StaffMember }
  const proxyRead = () => rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: { mode: 'read' } as never })
  function heldClick(button: HTMLElement) {
    const key = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    expect(handler).toBeTypeOf('function')
    return () => handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button })
  }
  const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
  async function deleteConfirmation() {
    fireEvent.click(screen.getByRole('button', { name: 'シナリオ「新規登録7日間フォロー」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除する', exact: true }))
    return screen.findByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？', exact: true })
  }
  test('停止確認の後にアカウントが変わったら、保持した旧確定から送らない', async () => {
    const view = await mount()
    selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: '止める' }))
    const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    const stale = heldClick(within(dialog).getByRole('button', { name: '停止する' }))
    state.account = 'account-b'
    view.rerender(<><ScenariosListV8 /><ToastHost /></>)
    await act(async () => { await stale() })
    expect(update).not.toHaveBeenCalled()
    expect(bulkStop).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '選んだシナリオを停止しますか？' })).toBeNull()
  })
  test('停止確認を閉じて開き直すと古い確定では送らない', async () => {
    await mount()
    selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: '止める' }))
    let dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    const stale = heldClick(within(dialog).getByRole('button', { name: '停止する' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: '止める' }))
    dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    await act(async () => { await stale() })
    expect(update).not.toHaveBeenCalled()
    expect(bulkStop).not.toHaveBeenCalled()
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する' }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }))
    await waitFor(() => expect(bulkStop).toHaveBeenCalledTimes(1))
  })
  test('停止の確認窓を開いた時の版を固定する', async () => {
    const row = { ...rows[0] }
    listPage.mockImplementation(async input => ({ success: true, data: { items: input.limit === 1 ? [] : [row], total: 1, limit: input.limit, sort: [] } }))
    await mount(); selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: '止める' }))
    const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    row.contentRevision = 8
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する' }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }))
    await waitFor(() => expect(bulkStop).toHaveBeenCalledWith([{ id: 's-filed', revision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }]))
  })
  test.each(['viewer', 'unknown', 'read-proxy'] as const)('%sへ変わると、保持した削除確定もAPI0で窓と読取を残す', async change => {
    await mount()
    const dialog = await deleteConfirmation()
    const saved = heldClick(within(dialog).getByRole('button', { name: '削除する', exact: true }))
    act(() => { if (change === 'viewer') rememberStaffIdentity(person('viewer')); else if (change === 'unknown') { state.role = null; forgetStaffIdentity() } else proxyRead() })
    await act(async () => { await saved() })
    expect(remove).not.toHaveBeenCalled()
    const confirm = within(screen.getByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？', exact: true })).getByRole('button', { name: '削除する', exact: true })
    if (change === 'unknown') { expect(confirm.hasAttribute('disabled')).toBe(true); expect(confirm.hasAttribute('data-permission-locked')).toBe(false) } else await expectPermissionLocked(confirm)
    expect(screen.getByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？', exact: true })).toBeTruthy()
    expect(await screen.findByText('本人・権限・LINEアカウントを確認できないため、変更を中止しました。')).toBeTruthy()
    expect(listPage).toHaveBeenCalled(); expect(folderList).toHaveBeenCalled(); expect(statsGet).toHaveBeenCalled()
  })
  test('編集キーstaffも配信の開始停止は拒む。管理者の明示操作は保存する', async () => {
    rememberStaffIdentity(person('staff', { permissionKeys: ['/scenarios', 'scenario.definition.edit', 'scenario.definition.publish'] }))
    await mount(); selectRow('新規登録7日間フォロー')
    const stop = await screen.findByRole('button', { name: '止める', exact: true })
    await expectPermissionLocked(stop)
    fireEvent.click(stop)
    expect(screen.queryByRole('dialog', { name: '選んだシナリオを停止しますか？' })).toBeNull()
    expect(update).not.toHaveBeenCalled()
    expect(bulkStop).not.toHaveBeenCalled()
    expect(screen.getByRole('tooltip').textContent).toContain('オーナーか管理者だけ')
    act(() => rememberStaffIdentity(person('admin')))
    fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する', exact: true }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(within(dialog).getByRole('button', { name: '停止する', exact: true }))
    await waitFor(() => expect(bulkStop).toHaveBeenCalledTimes(1))
    expect(bulkStop).toHaveBeenCalledWith([{ id: 's-filed', revision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }])
  })
  test('取り消し待ちの並べ替えは本人切替後にGETも書込も始めない', async () => {
    undo.hold = true; await mount()
    fireEvent.keyDown(document.querySelector('button[data-reorder-handle]')!, { key: 'ArrowDown' })
    expect(undo.queue).toHaveLength(1)
    const reads = listPage.mock.calls.length
    act(() => rememberStaffIdentity(person('viewer')))
    await expect(undo.queue[0].commit()).rejects.toThrow('本人・権限')
    expect(listPage).toHaveBeenCalledTimes(reads); expect(reorder).not.toHaveBeenCalled()
    expect(await screen.findByText('本人・権限・LINEアカウントを確認できないため、変更を中止しました。')).toBeTruthy()
  })
  test('並べ替えの全件GET中にread代理へ変わると順位を保存しない', async () => {
    undo.hold = true; await mount()
    const response = pending<{ success: boolean; data: { items: typeof rows; total: number; limit: number; sort: never[] } }>()
    listPage.mockImplementation(input => input.limit === 100 ? response.promise : Promise.resolve({ success: true, data: { items: rows, total: rows.length, limit: input.limit, sort: [] } }))
    fireEvent.keyDown(document.querySelector('button[data-reorder-handle]')!, { key: 'ArrowDown' })
    expect(undo.queue).toHaveLength(1)
    const commit = Promise.resolve(undo.queue[0].commit())
    await waitFor(() => expect(listPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }), expect.anything()))
    act(proxyRead)
    response.resolve({ success: true, data: { items: rows, total: rows.length, limit: 100, sort: [] } })
    await expect(commit).rejects.toThrow('本人・権限')
    expect(reorder).not.toHaveBeenCalled()
  })
  test('一括停止の応答中に権限が変わっても追加の書込を始めない', async () => {
    const activeRows = rows.map(row => ({ ...row, isActive: true }))
    listPage.mockResolvedValue({ success: true, data: { items: activeRows, total: 2, limit: 20, sort: [] } })
    const first = pending<{ success: boolean; data: object }>()
    bulkStop.mockReturnValueOnce(first.promise)
    await mount(); selectRow('新規登録7日間フォロー'); selectRow('会員更新リマインド')
    fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する', exact: true }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(within(dialog).getByRole('button', { name: '停止する', exact: true }))
    await waitFor(() => expect(bulkStop).toHaveBeenCalledTimes(1))
    act(() => rememberStaffIdentity(person('viewer')))
    await act(async () => first.resolve({ success: true, data: {} }))
    expect(bulkStop).toHaveBeenCalledWith([{ id: 's-filed', revision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }, { id: 's-unfiled', revision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }])
    expect(bulkStop).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
  })
  test('フォルダ移動の取り消し待ちはread代理への切替で送らず、窓の確定を持ち越さない', async () => {
    undo.hold = true; await mount(); selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダへ移す', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    fireEvent.click(within(dialog).getByRole('button', { name: '移動する', exact: true }))
    expect(undo.queue).toHaveLength(1)
    act(proxyRead)
    await expect(undo.queue[0].commit()).rejects.toThrow('本人・権限')
    expect(update).not.toHaveBeenCalled()
    expect((undo.queue[0] as { failureMessage?: string }).failureMessage).toBe('1 件中 0 件を保存しました。残りは本人・権限・LINEアカウントが変わったため送っていません。')
  })
  test('AからBへ移りAへ戻っても、古い並べ替えは復活せず新しい明示操作だけ通る', async () => {
    undo.hold = true; const view = await mount()
    fireEvent.keyDown(document.querySelector('button[data-reorder-handle]')!, { key: 'ArrowDown' })
    expect(undo.queue).toHaveLength(1)
    state.account = 'account-b'; view.rerender(<><ScenariosListV8 /><ToastHost /></>)
    await waitFor(() => expect(folderList).toHaveBeenCalledWith('scenario', 'account-b'))
    state.account = 'account-a'; view.rerender(<><ScenariosListV8 /><ToastHost /></>)
    await waitFor(() => expect(document.querySelector('button[data-reorder-handle]')).toBeTruthy())
    await undo.queue[0].commit()
    expect(reorder).not.toHaveBeenCalled()
    fireEvent.keyDown(document.querySelector('button[data-reorder-handle]')!, { key: 'ArrowDown' })
    expect(undo.queue).toHaveLength(2)
    await undo.queue[1].commit()
    expect(reorder).toHaveBeenCalledTimes(1)
  })
  test('複製の共通手順へ最新判定を渡し、切替後にコピーを勝手に再開しない', async () => {
    const response = pending<string>(); duplicate.mockReturnValueOnce(response.promise)
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'シナリオ「新規登録7日間フォロー」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '複製する', exact: true }))
    await waitFor(() => expect(duplicate).toHaveBeenCalledTimes(1))
    const allowed = duplicate.mock.calls[0][2] as () => boolean
    expect(allowed).toBeTypeOf('function'); expect(allowed()).toBe(true)
    act(proxyRead); expect(allowed()).toBe(false)
    act(() => forgetSessionSnapshot()); expect(allowed()).toBe(false)
    await act(async () => response.resolve('saved-copy'))
    expect(await screen.findByText('本人・権限が変わったため処理を止めました。作成済みのコピーを一覧で確認してください。')).toBeTruthy()
    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('複製しました')).toBeNull()
  })
  test('名前の編集中にread代理へ替わると保持したEnterでも更新0、GETは残る', async () => {
    window.history.replaceState(null, '', '/scenarios?scenario=s-filed')
    render(<><ScenariosListV8 /><ToastHost /></>)
    const panel = await screen.findByRole('dialog', { name: '新規登録7日間フォロー', exact: true })
    fireEvent.click(within(panel).getByRole('button', { name: 'シナリオ名を変更する' }))
    const field = within(panel).getByRole('textbox', { name: 'シナリオ名', exact: true })
    fireEvent.change(field, { target: { value: '書きかけ' } })
    const key = Object.keys(field).find(key => key.startsWith('__reactProps$'))!
    const enter = (field as unknown as Record<string, { onKeyDown: (event: unknown) => unknown }>)[key].onKeyDown
    expect(enter).toBeTypeOf('function')
    act(proxyRead)
    await act(async () => enter({ key: 'Enter', defaultPrevented: false, preventDefault() {}, nativeEvent: { isComposing: false }, keyCode: 13 }))
    expect(update).not.toHaveBeenCalled(); expect(listPage).toHaveBeenCalled()
    expect(field.isConnected).toBe(true)
    expect((field as HTMLInputElement).value).toBe('書きかけ')
    expect((field as HTMLInputElement).readOnly).toBe(true)
    await expectPermissionLocked(field)
  })

  test('本人未知へ替わると保持した作成入口からも遷移しない', async () => {
    await mount()
    const start = heldClick(screen.getAllByRole('button', { name: 'シナリオを作る', exact: true })[0])
    act(() => { state.role = null; forgetStaffIdentity() })
    await act(async () => { await start() })
    expect(push).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(await screen.findByText('本人・権限・LINEアカウントを確認できないため、変更を中止しました。')).toBeTruthy()
  })
  test('削除窓を閉じて開き直しても、古い確定では保存せず、新しい確定だけ通る', async () => {
    await mount(); let dialog = await deleteConfirmation()
    const saved = heldClick(within(dialog).getByRole('button', { name: '削除する', exact: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル', exact: true }))
    dialog = await deleteConfirmation()
    await act(async () => { await saved() })
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？', exact: true })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する', exact: true }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(remove).toHaveBeenCalledWith('s-filed', { contentRevision: 7, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 0, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] })
  })
  test('複製の待機中に画面を離れたら保持した許可も失効する', async () => {
    const response = pending<string>(); duplicate.mockReturnValueOnce(response.promise)
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'シナリオ「新規登録7日間フォロー」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '複製する', exact: true }))
    await waitFor(() => expect(duplicate).toHaveBeenCalledTimes(1))
    const allowed = duplicate.mock.calls[0][2] as () => boolean
    expect(allowed()).toBe(true); view.unmount(); expect(allowed()).toBe(false)
    await act(async () => response.resolve('saved-copy'))
    expect(screen.queryByText('複製しました')).toBeNull()
  })

  test('移動の送信直前にread代理へ替わると実際の失敗通知へ理由を渡す', async () => {
    await mount(); selectRow('新規登録7日間フォロー')
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダへ移す', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    act(() => { fireEvent.click(within(dialog).getByRole('button', { name: '移動する', exact: true })); proxyRead() })
    expect(await screen.findByText('1 件中 0 件を保存しました。残りは本人・権限・LINEアカウントが変わったため送っていません。')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })
  test('一括停止の失敗は一括送信1回だけで、個別更新を始めない', async () => {
    const values = [...rows.map(row => ({ ...row, isActive: true })), scenario('s-third', '三つ目', null, true)]
    listPage.mockImplementation(async input => ({ success: true, data: { items: input.limit === 1 ? [] : values, total: 3, limit: input.limit, sort: [] } }))
    bulkStop.mockRejectedValueOnce(new Error('offline'))
    await mount(); selectRow('新規登録7日間フォロー'); selectRow('会員更新リマインド'); selectRow('三つ目')
    fireEvent.click(screen.getByRole('button', { name: '止める', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '停止する', exact: true }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(within(dialog).getByRole('button', { name: '停止する', exact: true }))
    await waitFor(() => expect(bulkStop).toHaveBeenCalledTimes(1))
    expect(update).not.toHaveBeenCalled()
    expect(values.every(row => row.isActive)).toBe(true)
    expect(document.body.textContent).not.toContain('offline')
  })
  test('一括移動の2件目で失敗すると、1件保存確認・1件未送信を知らせて残りを送らない', async () => {
    const values = [...rows.map(row => ({ ...row, isActive: true })), scenario('s-third', '三つ目', null, true)]
    listPage.mockImplementation(async input => ({ success: true, data: { items: input.limit === 1 ? [] : values, total: 3, limit: input.limit, sort: [] } }))
    update.mockImplementation(async (id, patch) => { if (id === 's-filed') { Object.assign(values[0], patch); return { success: true, data: values[0] } } throw new Error('offline') })
    await mount(); selectRow('新規登録7日間フォロー'); selectRow('会員更新リマインド'); selectRow('三つ目')
    fireEvent.click(screen.getByRole('button', { name: 'フォルダへ移す', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '3 件のシナリオのフォルダを移動' })
    fireEvent.click(within(dialog).getByRole('button', { name: '移動する', exact: true }))
    expect(await screen.findByText(/全 3 件中 1 件の保存を確認しました。2 件目で止めました。未送信は 1 件です。理由：/)).toBeTruthy()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls.map(([id]) => id)).toEqual(['s-filed', 's-unfiled'])
    expect(document.body.textContent).not.toContain('offline')
    expect(values[0].folderId).toBe(null)
  })
  test('削除の成功直後に閲覧へ替わっても成功を伝えて確認窓を閉じ、追加の書込は0', async () => {
    const response = pending<{ success: boolean }>(); remove.mockReturnValueOnce(response.promise)
    await mount(); const dialog = await deleteConfirmation()
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する', exact: true }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    act(() => rememberStaffIdentity(person('viewer')))
    await act(async () => response.resolve({ success: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '「新規登録7日間フォロー」を削除しますか？', exact: true })).toBeNull())
    expect(await screen.findByText('削除しました。変更後の権限で一覧を確認してください。')).toBeTruthy()
    expect(remove).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled()
  })
  test('閲覧へ切替後も検索のGETを新たに送り、変更のAPIを送らない', async () => {
    await mount(); const reads = listPage.mock.calls.length
    act(() => rememberStaffIdentity(person('viewer')))
    fireEvent.change(screen.getByRole('searchbox', { name: 'シナリオ名で探す' }), { target: { value: '更新' } })
    await waitFor(() => expect(listPage.mock.calls.length).toBeGreaterThan(reads))
    expect(listPage.mock.calls.some(([input]) => input.query === '更新')).toBe(true)
    expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })

  test('移動窓を閉じて開き直すと古い確定は無効、新しい確定だけ1件送る', async () => {
    await mount(); selectRow('新規登録7日間フォロー')
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'フォルダへ移す', exact: true }))
    open(); let dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    const saved = heldClick(within(dialog).getByRole('button', { name: '移動する', exact: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル', exact: true }))
    open(); dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    await act(async () => { await saved() }); expect(update).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })).toBe(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: '移動する', exact: true }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  })
  test.each(['移動', '削除'] as const)('%s窓を開いたアカウントが替わると権限理由ではなく状態理由で確定を止める', async operation => {
    const view = await mount(); let dialog: HTMLElement
    if (operation === '移動') {
      selectRow('新規登録7日間フォロー'); fireEvent.click(screen.getByRole('button', { name: 'フォルダへ移す', exact: true }))
      dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    } else dialog = await deleteConfirmation()
    state.account = 'account-b'; view.rerender(<><ScenariosListV8 /><ToastHost /></>)
    await waitFor(() => expect(folderList).toHaveBeenCalledWith('scenario', 'account-b'))
    const confirm = within(dialog).getByRole('button', { name: operation === '移動' ? '移動する' : '削除する', exact: true })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    expect(confirm.hasAttribute('data-permission-locked')).toBe(false)
    expect(dialog.textContent).toContain('閉じて選び直してください。')
    fireEvent.click(confirm); expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  })
  test('開いたフォルダの編集窓はread代理への切替でも残り、名前を保ち保存0で理由を出す', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'フォルダ「初回案内」の操作', exact: true }))
    fireEvent.click(screen.getByRole('menuitem', { name: '名前を変える', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: 'フォルダを編集する', exact: true })
    const name = within(dialog).getByRole('textbox', { name: 'フォルダ名', exact: true }) as HTMLInputElement
    fireEvent.change(name, { target: { value: '書きかけの箱' } })
    act(proxyRead)
    expect(screen.getByRole('dialog', { name: 'フォルダを編集する', exact: true })).toBe(dialog)
    expect(name.value).toBe('書きかけの箱')
    await expectPermissionLocked(within(dialog).getByRole('button', { name: '保存する', exact: true }))
    expect(folderUpdate).not.toHaveBeenCalled()
  })
  test('閲覧の選択欄とつまみと右クリックの変更項目も残し、結果だけ開ける', async () => {
    rememberStaffIdentity(person('viewer')); await mount()
    for (const label of ['このページのシナリオをすべて選択', '新規登録7日間フォローを選択']) await expectPermissionLocked(screen.getByRole('checkbox', { name: label, exact: true }))
    const grip = screen.getByRole('button', { name: '新規登録7日間フォローを並び替え。上下キーで移動', exact: true })
    await expectPermissionLocked(grip)
    expect(grip.closest('[draggable]')?.getAttribute('draggable')).toBe('false')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'シナリオ「新規登録7日間フォロー」の操作', exact: true }), { clientX: 300, clientY: 300 })
    await expectPermissionLocked(await screen.findByRole('menuitem', { name: '複製する', exact: true }))
    await expectPermissionLocked(screen.getByRole('menuitem', { name: '削除する', exact: true }))
    const result = screen.getByRole('menuitem', { name: '配信結果を見る', exact: true })
    expect(result.getAttribute('aria-disabled')).not.toBe('true'); fireEvent.click(result)
    expect(push).toHaveBeenCalledTimes(1)
    expect(new URL(push.mock.calls[0][0], 'http://admin.test').pathname).toBe('/scenarios/results')
    expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(duplicate).not.toHaveBeenCalled()
  })
  test('編集中の本人未知は理由なしreadOnlyで入力を残し、Escapeで取り消せる', async () => {
    window.history.replaceState(null, '', '/scenarios?scenario=s-filed')
    render(<><ScenariosListV8 /><ToastHost /></>)
    const panel = await screen.findByRole('dialog', { name: '新規登録7日間フォロー', exact: true })
    fireEvent.click(within(panel).getByRole('button', { name: 'シナリオ名を変更する' }))
    const input = within(panel).getByRole('textbox', { name: 'シナリオ名', exact: true }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '未確定でも保持' } })
    act(() => { state.role = null; forgetStaffIdentity() })
    expect(input.isConnected).toBe(true); expect(input.readOnly).toBe(true); expect(input.disabled).toBe(false)
    expect(input.value).toBe('未確定でも保持'); expect(input.hasAttribute('data-permission-locked')).toBe(false)
    expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(0)
    fireEvent.keyDown(input, { key: 'Enter' }); expect(update).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(within(panel).queryByRole('textbox', { name: 'シナリオ名', exact: true })).toBeNull()
    expect(within(panel).getByRole('button', { name: 'シナリオ名を変更する' }).hasAttribute('disabled')).toBe(true)
  })
  test.each(['viewer', 'unknown', 'read-proxy'] as const)('%sへ替わっても移動窓の行き先を残し、欄と確定だけ止める', async change => {
    await mount(); selectRow('新規登録7日間フォロー')
    fireEvent.click(screen.getByRole('button', { name: 'フォルダへ移す', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })
    fireEvent.click(within(dialog).getByRole('button', { name: '移動先のフォルダ', exact: true }))
    fireEvent.click(within(screen.getByRole('option', { name: '初回案内' })).getByRole('button'))
    act(() => { if (change === 'viewer') rememberStaffIdentity(person('viewer')); else if (change === 'unknown') { state.role = null; forgetStaffIdentity() } else proxyRead() })
    expect(screen.getByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })).toBe(dialog)
    const field = within(dialog).getByRole('button', { name: '移動先のフォルダ', exact: true }), confirm = within(dialog).getByRole('button', { name: '移動する', exact: true })
    expect(field.textContent).toContain('初回案内')
    if (change === 'unknown') { for (const control of [field, confirm]) { expect(control.hasAttribute('disabled')).toBe(true); expect(control.hasAttribute('data-permission-locked')).toBe(false) } }
    else { await expectPermissionLocked(field); await expectPermissionLocked(confirm) }
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル', exact: true }))
    expect(screen.queryByRole('dialog', { name: '「新規登録7日間フォロー」のフォルダを移動' })).toBeNull()
  })
  test.each(['owner', 'viewer', null] as const)('空の一覧でも役割%sの作成入口を残し、変更0と普通無効を区別する', async role => {
    if (role) rememberStaffIdentity(person(role)); else { state.role = null; forgetStaffIdentity() }
    listPage.mockResolvedValue({ success: true, data: { items: [], total: 0, limit: 20, sort: [] } })
    render(<><ScenariosListV8 /><ToastHost /></>); await screen.findByText('まだシナリオがありません')
    const createButton = screen.getByRole('button', { name: '最初のシナリオを作る', exact: true })
    const topCreate = screen.getAllByRole('button', { name: 'シナリオを作る', exact: true })
    if (role === null) for (const button of topCreate) { expect(button.hasAttribute('disabled')).toBe(true); expect(button.hasAttribute('data-permission-locked')).toBe(false) }
    else if (role === 'viewer') await expectPermissionLocked(topCreate[0])
    for (const child of document.querySelector('[data-template-region=stats]')!.children) expect(child.childElementCount > 0 || Boolean(child.textContent?.trim())).toBe(true)
    if (role === 'viewer') await expectPermissionLocked(createButton)
    else if (role === null) { expect(createButton.hasAttribute('disabled')).toBe(true); expect(createButton.hasAttribute('data-permission-locked')).toBe(false) }
    else { expect(createButton.hasAttribute('disabled')).toBe(false); fireEvent.click(createButton); expect(new URL(push.mock.calls[0][0], 'http://admin.test').pathname).toBe('/scenarios/mode') }
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
  })
})

vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '二号店' }] }) }))

test('一括停止の窓は操作先を示し、アカウント切替で閉じて古いシナリオを送らない', async () => {
  const view = await mount()
  fireEvent.click(within(screen.getByText('新規登録7日間フォロー').closest('tr')!).getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '選んだシナリオを停止しますか？' })
  await within(within(dialog).getByRole('region', { name: '操作の対象' })).findByText('本店')
  expect(update).not.toHaveBeenCalled()
  state.account = 'account-b'
  view.rerender(<><ScenariosListV8 /><ToastHost /></>)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(update).not.toHaveBeenCalled()
})
