// @vitest-environment happy-dom
/*
 * 統括のアカウント（/hq・src/v8/hq/home.tsx）の配線を、描いて押して確かめる。
 * - 登録の口は一般の登録（/accounts/new）へ。閲覧のみには置かない
 * - 読み込みの失敗は共通の案内。403 は押しても直らないので「もう一度読み込む」を出さない
 * - 「全部を更新」は全アカウントの接続を確かめ直し、版を添えて送り、一覧を読み直す
 * - 「設定」→「LINE の登録内容を編集」で既存の編集の窓。保存のあとは一覧を読み直す
 * - 「入る」は選んだアカウントを覚え、店舗未選択から来たときは元の画面へ戻す
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { loadFailureNotice } from '@/components/shared/api-error-message'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  attention: vi.fn(), list: vi.fn(), fetchApi: vi.fn(), select: vi.fn(), refresh: vi.fn(), push: vi.fn(), folders: vi.fn(), accountEntry: vi.fn(),
  role: 'owner', editProps: null as null | Record<string, unknown>,
}))

vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { attention: mocks.attention } }))
vi.mock('@/components/hq/platform-notices', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], setSelectedAccountId: mocks.select, refreshAccounts: mocks.refresh }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => mocks.role }))
/* 設定の窓と編集の窓の中身は、それぞれの試験が見る。ここでは画面からの受け渡しだけを見る。 */
vi.mock('@/v8/hq/account-dialogs', async (original) => ({
  ...await original<typeof import('@/v8/hq/account-dialogs')>(),
  AccountSettingsDialogV8: ({ account, onEditRegistration, onSaved }: { account: { name: string }; onEditRegistration: () => void; onSaved: () => void }) => (
    <div role="dialog" aria-label={`${account.name}の設定`}>
      <button type="button" onClick={onEditRegistration}>LINE の登録内容を編集</button>
      <button type="button" onClick={onSaved}>保存する</button>
    </div>
  ),
  AccountArchiveDialogV8: () => null,
  AccountRestoreDialogV8: () => null,
}))
vi.mock('@/components/accounts/account-edit-modal', () => ({
  default: (props: Record<string, unknown> & { onSaved: () => void }) => {
    mocks.editProps = props
    return <div role="dialog" aria-label="アカウントの編集"><button type="button" onClick={props.onSaved}>編集を保存</button></div>
  },
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchApi: mocks.fetchApi,
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: mocks.list, accountEntry: mocks.accountEntry },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: mocks.folders },
      tenants: { ...actual.api.tenants, me: vi.fn(async () => ({ success: true, data: { name: '統括' } })) },
    },
  }
})

import HqHomeV8 from '@/v8/hq/home'

const account = (id: string, name: string, revision: number | null = 1) => ({
  id, revision, name, displayName: name, channelId: `ch-${id}`, basicId: `@${id}`, isActive: true, country: null, role: null,
  displayOrder: 0, archivedAt: null, tags: [], folderId: null,
  stats: { friendCount: 1, messagesThisMonth: 0, activeScenarios: 0, staffCount: 1 },
  connection: { status: 'warn', checkedAt: null, tokenExpired: false, issues: [] },
})

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/hq')
  mocks.attention.mockReset().mockResolvedValue({ success: true, data: { items: ['a1', 'a2'].map(accountId => ({ accountId, counts: { connections: 1, unhandledChats: 9 } })) } })
  mocks.role = 'owner'
  mocks.editProps = null
  mocks.list.mockResolvedValue({ success: true, data: [account('a1', '銀座店')] })
  mocks.folders.mockResolvedValue({ success: true, data: { folders: [], total: 0, unclassifiedCount: 0 } })
  mocks.refresh.mockResolvedValue(undefined)
  mocks.fetchApi.mockResolvedValue({ success: true, data: {} })
  mocks.accountEntry.mockReset().mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume: false } })
})
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/') })

const links = (name: string) => screen.queryAllByRole('link', { name }).map((link) => link.getAttribute('href'))

describe('統括のアカウント：登録の口', () => {
  it('オーナーには一般のアカウント登録へ進む口を置き、飲食の店舗作成へは送らない', async () => {
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    expect(links('アカウントを登録').length).toBeGreaterThan(0)
    expect(new Set(links('アカウントを登録'))).toEqual(new Set(['/accounts/new']))
    expect(document.querySelector('a[href*="restaurant-test/stores/new"]')).toBeNull()
  })

  it('閲覧のみには登録の口を置かない', async () => {
    mocks.role = 'viewer'
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    expect(links('アカウントを登録')).toEqual([])
  })

  it('0件のときは最初の登録へ案内する', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [] })
    render(<HqHomeV8 />)
    await screen.findByText('まだ LINE 公式アカウントがありません')
    expect(links('最初のアカウントを登録する')).toEqual(['/accounts/new'])
  })
})

describe('統括のアカウント：読み込みの失敗（M021）', () => {
  it('通信の失敗は共通の案内を出し、「もう一度読み込む」で読み直して一覧に戻る', async () => {
    const failure = new ApiError(503, 'API error: 503')
    mocks.list.mockRejectedValueOnce(failure)
    render(<HqHomeV8 />)
    const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
    expect(screen.getByText(loadFailureNotice(failure, '統括のアカウント情報', 'hq'))).toBeTruthy()
    expect(document.body.textContent).not.toContain('API error')
    expect(document.body.textContent).not.toContain('統括のアカウント情報を読み込めませんでした。')
    await act(async () => { fireEvent.click(retry) })
    await screen.findAllByText('銀座店')
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('403 は権限の案内にし、押しても直らないので「もう一度読み込む」を出さない', async () => {
    const failure = new ApiError(403, 'API error: 403')
    mocks.list.mockRejectedValueOnce(failure)
    render(<HqHomeV8 />)
    await screen.findByText(loadFailureNotice(failure, '統括のアカウント情報', 'hq'))
    expect(document.body.textContent).toContain('統括のアカウント情報を見る権限がありません')
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
  })
})

describe('統括のアカウント：接続の確かめ直し', () => {
  it('「全部を更新」で全アカウントへ版と重複よけの鍵を添えて送り、一覧と店の一覧を読み直す', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [account('a1', '銀座店', 3), account('a/2', '梅田店', 7)] })
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部を更新' })) })
    await screen.findByText('2 件のLINE IDと接続状態を更新しました。')
    expect(mocks.fetchApi).toHaveBeenCalledTimes(2)
    const [firstPath, firstInit] = mocks.fetchApi.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(firstPath).toBe('/api/line-accounts/a1/connection-checks')
    expect(firstInit.method).toBe('POST')
    expect(JSON.parse(String(firstInit.body))).toEqual({ expectedRevision: 3 })
    expect(firstInit.headers['Idempotency-Key']).toMatch(/^hq-check-a1-/)
    const [secondPath, secondInit] = mocks.fetchApi.mock.calls[1] as [string, RequestInit & { headers: Record<string, string> }]
    expect(secondPath).toBe('/api/line-accounts/a%2F2/connection-checks')
    expect(JSON.parse(String(secondInit.body))).toEqual({ expectedRevision: 7 })
    expect(secondInit.headers['Idempotency-Key']).not.toBe(firstInit.headers['Idempotency-Key'])
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('版の無いアカウントは送らずに「更新できなかった」に数える', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [account('a1', '銀座店', 3), account('a2', '梅田店', null)] })
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部を更新' })) })
    await screen.findByText('梅田店の接続情報を更新できませんでした。1 件を更新しました。')
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
  })

  it('確かめている間にもう一度押しても重ねて送らない', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.fetchApi.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    const button = screen.getAllByRole('button', { name: '更新する' })[0]
    await act(async () => { fireEvent.click(button) })
    await act(async () => { fireEvent.click(button) })
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ success: true, data: {} }) })
    await screen.findByText('1 件のLINE IDと接続状態を更新しました。')
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
  })
  it('全件更新は停止中・正常も対象にし、アーカイブには送らず失敗名を残す', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [
      account('a1', '銀座店'), account('a2', '梅田店'),
      { ...account('a3', '正常店'), connection: { status: 'ok', issues: [] } },
      { ...account('a4', '停止店'), isActive: false },
      { ...account('a5', '保管店'), archivedAt: '2026-10-01 00:00:00' },
    ] })
    mocks.fetchApi.mockResolvedValueOnce({ success: true, data: {} }).mockRejectedValueOnce(new ApiError(503, 'unavailable'))
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部を更新' })) })
    await screen.findByText('梅田店の接続情報を更新できませんでした。3 件を更新しました。')
    expect(mocks.fetchApi.mock.calls.map(([path]) => path)).toEqual(['a1', 'a2', 'a3', 'a4'].map(id => `/api/line-accounts/${id}/connection-checks`))
  })

  it('成功しない応答を成功件数にせず、その店の失敗を表示する', async () => {
    mocks.fetchApi.mockResolvedValueOnce({ success: false, error: 'REVISION_CONFLICT' })
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新する' })) })
    await screen.findByText('銀座店の接続情報を更新できませんでした。0 件を更新しました。')
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('再読込失敗は古い警告を残し、再読込だけで回復し更新を再送しない', async () => {
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    mocks.list.mockRejectedValueOnce(new ApiError(503, 'unavailable'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新する' })) })
    const message = await screen.findByText(/一覧を再読み込みできませんでした。もう一度読み込んでください。/)
    expect(message.closest('[data-design-part="notice"]')?.getAttribute('data-tone')).toBe('danger')
    expect(screen.getByRole('button', { name: '更新する' })).toBeTruthy()
    mocks.list.mockResolvedValue({ success: true, data: [{ ...account('a1', '銀座店'), connection: { status: 'ok', issues: [] } }] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })) })
    expect(screen.queryByText(/一覧を再読み込みできませんでした。/)).toBeNull()
    expect(screen.queryByRole('button', { name: '更新する' })).toBeNull()
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
    expect(mocks.list).toHaveBeenCalledTimes(3)
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
  })

  it('再読込が続けて失敗しても警告と再読込の口を失わない', async () => {
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    mocks.list.mockRejectedValue(new ApiError(503, 'unavailable'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新する' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })) })
    expect(screen.getByText(/一覧を再読み込みできませんでした。もう一度読み込んでください。/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
  })

})

describe('統括のアカウント：設定と編集', () => {
  it('「設定」→「LINE の登録内容を編集」で既存の編集の窓にそのアカウントを渡し、保存のあと一覧を読み直す', async () => {
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    fireEvent.click(screen.getByRole('button', { name: '銀座店 の設定' }))
    fireEvent.click(screen.getByRole('button', { name: 'LINE の登録内容を編集' }))
    expect(screen.getByRole('dialog', { name: 'アカウントの編集' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '銀座店の設定' })).toBeNull()
    expect(mocks.editProps).toMatchObject({ accountId: 'a1', initialName: '銀座店', initialChannelId: 'ch-a1' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '編集を保存' })) })
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('設定の窓で保存すると窓を閉じて一覧を読み直す', async () => {
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    fireEvent.click(screen.getByRole('button', { name: '銀座店 の設定' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    expect(screen.queryByRole('dialog', { name: '銀座店の設定' })).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('統括のアカウント：入る', () => {
  it('入ると選んだアカウントを覚え、識別子を住所に付けずに店のホームへ移る', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [account('a1', '銀座店'), account('a2', '梅田店')] })
    render(<HqHomeV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '梅田店 へ入る' }))
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith('a2'))
    expect(mocks.accountEntry).toHaveBeenCalledExactlyOnceWith('a2')
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.push.mock.calls[0][0]).toBe('/')
  })

  it('店舗未選択から来たときは元の画面へ戻し、外の住所や統括の画面へは戻さない', async () => {
    window.history.replaceState(null, '', '/hq?return=%2Ffriends%3Ftab%3Dall')
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    fireEvent.click(screen.getByRole('button', { name: '銀座店 へ入る' }))
    await waitFor(() => expect(mocks.push.mock.calls[0][0]).toBe('/friends?tab=all'))
    for (const back of ['https%3A%2F%2Fevil.example%2F', '%2Fhq%2Fmembers']) {
      cleanup()
      mocks.push.mockClear()
      window.history.replaceState(null, '', `/hq?return=${back}`)
      render(<HqHomeV8 />)
      await screen.findAllByText('銀座店')
      fireEvent.click(screen.getByRole('button', { name: '銀座店 へ入る' }))
      // 外の住所と、店を選ばなくても開ける統括の画面へは戻さず、店のホームへ移る。
      await waitFor(() => expect(mocks.push.mock.calls[0][0]).toBe('/'))
    }
  })

  it('引き継ぎ中は店舗を選択せず登録時と同じ進捗画面へ戻す', async () => {
    mocks.accountEntry.mockResolvedValue({ success: true, data: { destination: 'handover', canResume: true } })
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    fireEvent.click(screen.getByRole('button', { name: '銀座店 へ入る' }))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/accounts/new/handover?accountId=a1'))
    expect(mocks.accountEntry).toHaveBeenCalledExactlyOnceWith('a1')
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('登録状態を読めないときも店舗へ入れない', async () => {
    mocks.accountEntry.mockRejectedValue(new Error('network error'))
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    fireEvent.click(screen.getByRole('button', { name: '銀座店 へ入る' }))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/accounts/new/handover?accountId=a1'))
    expect(mocks.accountEntry).toHaveBeenCalledExactlyOnceWith('a1')
    expect(mocks.select).not.toHaveBeenCalled()
  })
})


describe('統括のアカウント：未知の件数と本当の0件を分ける', () => {
  const kpis = () => [...document.querySelectorAll('[data-kpi-presentation]:not([data-kpi-strip])')]
  const values = () => kpis().map(card => card.querySelector('[data-kpi-number]')?.textContent)
  const folderCounts = (name: string) => [...document.querySelectorAll('[data-folder-select]')]
    .filter(row => row.getAttribute('title') === name).map(row => row.textContent)

  it('最初の読込と失敗で0件を作らず、再取得で既知の件数へ戻す', async () => {
    let fail: (reason: unknown) => void = () => {}
    mocks.list.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    mocks.folders.mockResolvedValue({ success: true, data: { folders: [
      { id: 'known', name: '既知の分類', displayOrder: 0, itemCount: 0 },
      { id: 'pending', name: '未取得の分類', displayOrder: 1 },
    ] } })
    render(<HqHomeV8 />)
    await waitFor(() => expect(folderCounts('既知の分類').length).toBeGreaterThan(0))
    expect(kpis()).toHaveLength(4)
    expect(document.querySelectorAll('[data-kpi-skeleton]')).toHaveLength(4)
    expect(folderCounts('すべて')).toEqual(expect.arrayContaining(['すべて']))
    expect(folderCounts('未分類').every(text => text === '未分類')).toBe(true)
    expect(folderCounts('未取得の分類').every(text => text === '未取得の分類')).toBe(true)
    expect(folderCounts('既知の分類').every(text => text === '既知の分類')).toBe(true)
    await act(async () => { fail(new ApiError(503, 'account failed')) })
    const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
    expect(kpis()).toHaveLength(4)
    expect(values()).toEqual(['—', '—', '—', '—'])
    expect(document.querySelectorAll('[data-kpi-zero]')).toHaveLength(0)
    expect(folderCounts('すべて').every(text => text === 'すべて')).toBe(true)
    expect(folderCounts('未分類').every(text => text === '未分類')).toBe(true)
    mocks.list.mockResolvedValue({ success: true, data: [
      { ...account('a1', '銀座店'), folderId: 'pending' }, account('a2', '二号店'),
    ] })
    await act(async () => { fireEvent.click(retry) })
    await screen.findAllByText('銀座店')
    await waitFor(() => expect(values()).toEqual(['2', '2', '0', '2']))
    expect(folderCounts('すべて').every(text => text === 'すべて2')).toBe(true)
    expect(folderCounts('未分類').every(text => text === '未分類1')).toBe(true)
    expect(folderCounts('未取得の分類').every(text => text === '未取得の分類1')).toBe(true)
    expect(folderCounts('既知の分類').every(text => text === '既知の分類0')).toBe(true)
  })

  it('一覧の失敗では分類の件数も未知にし、再取得後は同じ一覧から数える', async () => {
    mocks.list.mockRejectedValue(new ApiError(503, 'account failed'))
    mocks.folders.mockResolvedValue({ success: true, data: { folders: [
      { id: 'known', name: '既知の分類', displayOrder: 0, itemCount: 2 },
    ], unclassifiedCount: 3 } })
    render(<HqHomeV8 />)
    const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
    await waitFor(() => expect(folderCounts('既知の分類').length).toBeGreaterThan(0))
    expect(folderCounts('未分類').every(text => text === '未分類')).toBe(true)
    expect(folderCounts('未分類').length).toBeGreaterThan(0)
    expect(folderCounts('既知の分類').every(text => text === '既知の分類')).toBe(true)
    expect(folderCounts('すべて').every(text => text === 'すべて')).toBe(true)
    expect(values()).toEqual(['—', '—', '—', '—'])
    mocks.list.mockResolvedValue({ success: true, data: [
      { ...account('a1', '銀座店'), folderId: 'known' }, account('a2', '二号店'),
    ] })
    await act(async () => { fireEvent.click(retry) })
    await screen.findAllByText('銀座店')
    expect(folderCounts('すべて').every(text => text === 'すべて2')).toBe(true)
    expect(folderCounts('未分類').every(text => text === '未分類1')).toBe(true)
    expect(folderCounts('既知の分類').every(text => text === '既知の分類1')).toBe(true)
  })

  it('成功した空の一覧は、本当の0件としてカードとフォルダに残す', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [] })
    mocks.folders.mockRejectedValue(new Error('folders unavailable'))
    render(<HqHomeV8 />)
    await screen.findByText('まだ LINE 公式アカウントがありません')
    expect(values()).toEqual(['0', '0', '0', '0'])
    expect(document.querySelectorAll('[data-kpi-zero]')).toHaveLength(4)
    expect(folderCounts('すべて').every(text => text === 'すべて0')).toBe(true)
    expect(folderCounts('未分類').every(text => text === '未分類0')).toBe(true)
  })

  it('未知の集計は0にせず、既知の接続問題は未確認と分けて残す', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [account('a1', '銀座店'), {
      ...account('a2', '二号店'), stats: { messagesThisMonth: 0 }, connection: { status: 'unknown' },
    }] })
    render(<HqHomeV8 />)
    await screen.findAllByText('銀座店')
    expect(kpis()).toHaveLength(4)
    await waitFor(() => expect(values()).toEqual(['2', '—', '0', '2']))
    expect(kpis()[3].textContent).toContain('要確認・未確認 1')
    // 未確認は右上の札にまとめ、2行目（note）を出さない＝ほかの箱と同じ高さ。
    expect(kpis()[3].querySelector('[role="note"]')?.textContent ?? '').toBe('')
    expect(document.querySelectorAll('[data-kpi-zero]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-kpi-detail] [role="note"]')).toHaveLength(4)
    const card = [...document.querySelectorAll('article')].find(node => node.textContent?.includes('二号店'))!
    expect([...card.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['—', '0 通'])
    fireEvent.click(screen.getByRole('button', { name: '表' }))
    const row = await screen.findByRole('row', { name: /二号店/ })
    expect([...row.querySelectorAll('td')].slice(-3, -1).map(node => node.textContent)).toEqual(['—', '0'])
  })
})


describe('統括の接続問題：分かっている数と未確認を分ける', () => {
  it.each([
    { statuses: ['warn', 'unknown'], value: '3', detail: '要確認・未確認 1', tab: 2, warning: true },
    { statuses: ['ok', 'unknown'], value: '—', detail: '未確認 1 件', tab: 1, warning: false },
    { statuses: ['warn', 'ok'], value: '3', detail: '', tab: 1, warning: true },
    { statuses: ['ok', 'ok'], value: '0', detail: '', tab: 0, warning: false },
  ])('$statuses の既知数は $value、要確認は $tab', async ({ statuses, value, detail, tab, warning }) => {
    mocks.attention.mockResolvedValue({ success: true, data: { items: statuses.map((status, index) => ({ accountId: `a${index}`, counts: { connections: status === 'warn' ? 3 : 0, unhandledChats: 8 } })) } })
    mocks.list.mockResolvedValue({ success: true, data: statuses.map((status, index) => ({
      ...account(`a${index}`, `確認対象${index}`), connection: { status, issues: [] },
    })) })
    render(<HqHomeV8 />)
    await screen.findAllByText('確認対象0')
    const card = [...document.querySelectorAll('[data-kpi-presentation]:not([data-kpi-strip])')][3]
    await waitFor(() => expect(card.querySelector('[data-kpi-number]')?.textContent).toBe(value))
    if (detail) expect(card.textContent).toContain(detail)
    else expect(card.textContent).not.toContain('未確認')
    expect(card.querySelector('[data-kpi-badge="warning"]') !== null).toBe(warning)
    expect(screen.getByRole('button', { name: new RegExp(`要確認.*${tab}`) })).toBeTruthy()
  })

  it('attention の一部が欠けた場合は取れた接続件数と未確認を分ける', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [account('a1', '取得済み'), { ...account('a2', '未取得'), connection: { status: 'ok' } }] })
    mocks.attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'a1', counts: { connections: 4, unhandledChats: 9 } }] } })
    render(<HqHomeV8 />)
    await screen.findAllByText('取得済み')
    const card = [...document.querySelectorAll('[data-kpi-presentation]:not([data-kpi-strip])')][3]
    await waitFor(() => expect(card.querySelector('[data-kpi-number]')?.textContent).toBe('4'))
    expect(card.textContent).toContain('要確認・未確認 1')
  })

  it('停止とアーカイブを要確認の対象へ加えず、未取得の接続は未確認へ数える', async () => {
    mocks.attention.mockResolvedValue({ success: true, data: { items: [{ accountId: 'a1', counts: { connections: 0 } }] } })
    mocks.list.mockResolvedValue({ success: true, data: [
      { ...account('a1', '確認対象'), connection: undefined },
      { ...account('a2', '停止'), isActive: false },
      { ...account('a3', '保管'), archivedAt: '2026-10-01T00:00:00Z' },
    ] })
    render(<HqHomeV8 />)
    await screen.findAllByText('確認対象')
    const card = [...document.querySelectorAll('[data-kpi-presentation]:not([data-kpi-strip])')][3]
    await waitFor(() => expect(card.textContent).toContain('未確認 1 件'))
    expect(card.querySelector('[data-kpi-number]')?.textContent).toBe('—')
    expect(screen.getByRole('button', { name: /要確認.*1/ })).toBeTruthy()
  })
})

describe('フォルダ削除確認：サーバーの既知件数だけを使う', () => {
  it.each([
    { itemCount: undefined, failed: true, phrase: '中のアカウントは' },
    { itemCount: undefined, failed: false, phrase: '中のアカウントは' },
    { itemCount: 0, failed: true, phrase: '中のアカウント 0 件は' },
    { itemCount: 7, failed: false, phrase: '中のアカウント 7 件は' },
  ])('server=$itemCount、一覧失敗=$failed', async ({ itemCount, failed, phrase }) => {
    mocks.folders.mockResolvedValue({ success: true, data: { folders: [
      { id: 'target', name: '対象の分類', displayOrder: 0, itemCount },
    ] } })
    if (failed) mocks.list.mockRejectedValue(new ApiError(503, 'account failed'))
    else mocks.list.mockResolvedValue({ success: true, data: [{ ...account('a1', '確認対象'), folderId: 'target' }] })
    render(<HqHomeV8 />)
    const menu = await screen.findByRole('button', { name: /対象の分類.*操作/ })
    fireEvent.click(menu)
    fireEvent.click(await screen.findByRole('menuitem', { name: /消す/ }))
    const dialog = await screen.findByRole('alertdialog', { name: '「対象の分類」を削除しますか？' })
    expect(dialog.textContent).toContain(phrase)
    if (itemCount === undefined) expect(dialog.textContent).not.toMatch(/アカウント \d+ 件/)
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(mocks.fetchApi).not.toHaveBeenCalled()
  })
})
