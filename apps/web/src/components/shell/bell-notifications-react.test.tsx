// @vitest-environment happy-dom
/*
 * ★V8 上の帯のベルの小窓（V8.pen DIHFx/D2eAyQ・小窓 mV28V・オーナー 2026-10-07）。
 *
 *   - ベルを押すと、ページを移らずに小窓（role=dialog「通知」）が開く。もう一度押すと閉じる
 *   - タブは「すべて・未読・システム」。未読は口の unread=1、システムは category=error で読む
 *   - Esc で閉じ、焦点はベルへ戻る。小窓の外を押しても閉じる。小窓の中を押しても閉じない
 *   - 一覧は最大5件・未読が先。行を押すと既読にして行き先へ移る
 *   - すべて既読は押した瞬間に反映し、失敗したら戻す
 *   - 店を選んでいないときは読まずに案内だけ
 *   - 小窓を渡さない帯（管理画面 など）は、今までどおり通知の一覧へのリンク
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationCenterItem } from '@line-crm/shared'
import { formatDateTime } from '@/lib/format'

const fixture = vi.hoisted(() => ({
  role: 'owner' as string | null,
  push: vi.fn(),
  list: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  changeAccount: vi.fn((_id: string, after?: () => void) => after?.()),
  toast: vi.fn(),
}))
vi.mock('@/lib/staff-role', async (original) => ({ ...(await original<object>()), useStaffRole: () => fixture.role }))
vi.mock('@/components/shared/use-permission-lock-reason', async (original) => ({
  ...(await original<object>()),
  usePermissionLockReason: (allowed: boolean) => fixture.role === 'viewer' && !allowed
    ? '閲覧のみのため変更できません。オーナーか管理者に頼んでください。'
    : undefined,
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push }), usePathname: () => '/' }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...props }, children) }
})
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, notifications: { ...actual.api.notifications,
    center: { ...actual.api.notifications.center, list: fixture.list, markRead: fixture.markRead, markAllRead: fixture.markAllRead },
  } } }
})
vi.mock('@/components/shared/toast', async (original) => ({ ...(await original<object>()), notifyToast: fixture.toast, notifySaved: fixture.toast }))

import TopBar from '@/components/shared/top-bar'
import BellNotifications from './bell-notifications'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function item(id: string, over: Partial<NotificationCenterItem> = {}): NotificationCenterItem {
  return {
    id,
    eventType: 'broadcast.failed',
    category: 'error',
    title: `お知らせ ${id}`,
    body: '',
    metadata: null,
    isRead: false,
    createdAt: '2026-10-07T00:00:00.000Z',
    ...over,
  }
}

function centerData(items: NotificationCenterItem[]) {
  const unread = items.filter((row) => !row.isRead).length
  return {
    success: true,
    data: {
      items,
      counts: { all: items.length, error: items.filter((row) => row.category === 'error').length, update: items.filter((row) => row.category === 'update').length, unread },
      unreadCount: unread,
    },
  }
}

function Harness({ accountId = 'account-1', accounts = [], withPopover = true, hqOrigin = false }: { accountId?: string | null; accounts?: Array<{ id: string; label: string }>; withPopover?: boolean; hqOrigin?: boolean }) {
  const [unread, setUnread] = useState<number | null>(3)
  return (
    <TopBar
      title="ホーム"
      accounts={[{ id: 'account-1', label: '然 本店' }]}
      selectedAccountId={accountId ?? ''}
      onAccountChange={() => {}}
      roleLabel="オーナー"
      userName="Kenta"
      onLogout={() => {}}
      notificationUnreadCount={unread}
      renderNotifications={withPopover ? (popover) => (
        <BellNotifications hqOrigin={hqOrigin} popover={popover} target={accountId ? { kind: 'store', accountId } : accounts.length ? { kind: 'all' } : { kind: 'none' }} accounts={accounts} onAccountChange={fixture.changeAccount} onUnreadChange={setUnread} />
      ) : undefined}
      v8Chrome
      chromeVariant="shell"
    />
  )
}

const bell = () => screen.getByRole('button', { name: /^通知(?:（.*）)?$/ })

async function openPopover() {
  await act(async () => { fireEvent.click(bell()) })
  return screen.findByRole('dialog', { name: '通知' })
}

describe('★V8 ベルの小窓', () => {
  beforeEach(() => {
    fixture.role = 'owner'
    document.documentElement.dataset.theme = 'v8'
    fixture.push.mockReset()
    fixture.toast.mockReset()
    fixture.list.mockReset()
    fixture.markRead.mockReset()
    fixture.markAllRead.mockReset()
    fixture.changeAccount.mockClear()
    fixture.markRead.mockResolvedValue({ success: true, data: null })
    fixture.markAllRead.mockResolvedValue({ success: true, data: { updated: 3 } })
    fixture.list.mockResolvedValue(centerData([
      item('r1', { isRead: true, title: '既読のお知らせ' }),
      item('u1', { title: '未読のエラー' }),
      item('u2', { category: 'update', eventType: 'release', title: '未読のアップデート' }),
      item('r2', { isRead: true }),
      item('r3', { isRead: true }),
      item('r4', { isRead: true }),
      item('u3', { eventType: 'ec.sync_failed', title: 'EC連携が止まった' }),
    ]))
  })

  it('統括のベルから通知一覧にも戻り先を引き継ぐ', async () => {
    render(<Harness hqOrigin />)
    const panel = await openPopover()
    await within(panel).findByText('未読のエラー')
    fireEvent.click(within(panel).getByRole('button', { name: /すべて見る/ }))
    expect(fixture.push).toHaveBeenLastCalledWith('/notifications?from=hq')
  })

  it.each(['viewer', null])('権限が %s の間は規定どおり無効化し、通知の移動はできる', async (role) => {
    fixture.role = role
    render(<Harness />)
    const panel = await openPopover()
    await within(panel).findByText('未読のエラー')
    const markAll = within(panel).getByRole('button', { name: 'すべて既読にする' })
    if (role === 'viewer') {
      expect(markAll.getAttribute('data-permission-locked')).not.toBeNull()
      expect(markAll.getAttribute('aria-disabled')).toBe('true')
      fireEvent.focus(markAll)
      expect(screen.getByRole('tooltip').textContent).toContain('閲覧のみ')
    } else {
      expect((markAll as HTMLButtonElement).disabled).toBe(true)
      expect(within(panel).queryByRole('status')).toBeNull()
      expect(within(panel).queryByRole('tooltip')).toBeNull()
    }
    await act(async () => { fireEvent.click(markAll) })
    expect(fixture.markAllRead).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(panel).getByText('未読のエラー')) })
    expect(fixture.markRead).not.toHaveBeenCalled()
    expect(fixture.markAllRead).not.toHaveBeenCalled()
    expect(fixture.push).toHaveBeenCalled()
  })

  it('統括では全アカウントの通知をまとめ、通知を押すと対象アカウントへ切り替えて知らせる', async () => {
    render(<Harness accountId={null} accounts={[{ id: 'account-1', label: '本店' }, { id: 'account-2', label: '渋谷店' }]} />)
    const panel = await openPopover()
    await within(panel).findByText('本店：未読のエラー')
    expect(fixture.list).toHaveBeenCalledTimes(2)
    expect(within(panel).getByText('渋谷店：未読のエラー')).toBeTruthy()
    await act(async () => { fireEvent.click(within(panel).getByText('渋谷店：未読のエラー')) })
    expect(fixture.changeAccount).toHaveBeenCalledWith('account-2', expect.any(Function))
    expect(fixture.toast).toHaveBeenCalledWith('渋谷店 に切り替えました', { tone: 'info' })
    expect(fixture.push).toHaveBeenCalled()
  })

  it('統括で1店だけ取得に失敗しても読めた店の通知を出し、知らせは1つ・全店件数は不明にする', async () => {
    fixture.list.mockImplementation(async (id: string) => id === 'account-2'
      ? { success: false, error: 'failed' }
      : centerData([item('available', { title: '本店で読めた通知' })]))
    render(<Harness accountId={null} accounts={[{ id: 'account-1', label: '本店' }, { id: 'account-2', label: '渋谷店' }]} />)

    const dialog = await openPopover()
    expect(await within(dialog).findByText('本店：本店で読めた通知')).toBeTruthy()
    const statuses = within(dialog).getAllByRole('status')
    expect(statuses).toHaveLength(1)
    expect(statuses.find((entry) => entry.textContent?.includes('渋谷店 の通知を読み込めませんでした'))).toBeTruthy()
    expect(statuses.filter((entry) => entry.textContent?.includes('全店の未読件数を確認できないため、すべて既読にできません。'))).toHaveLength(1)
    expect(within(dialog).getByText('未読 —')).toBeTruthy()
    expect(within(dialog).queryByText('未読 1')).toBeNull()
    expect(within(dialog).queryByText('通知はまだありません。')).toBeNull()
    expect(bell().getAttribute('aria-label')).toBe('通知（未読数を確認できません）')
    const unknownBadge = bell().querySelector('[data-count-unknown]')
    expect(unknownBadge?.textContent).toBe('')
    expect(unknownBadge?.getAttribute('aria-hidden')).toBe('true')
    expect(fixture.list).toHaveBeenCalledTimes(2)
    const markAll = within(dialog).getByRole('button', { name: 'すべて既読にする' })
    expect((markAll as HTMLButtonElement).disabled).toBe(false)
    expect(markAll.getAttribute('aria-disabled')).toBe('true')
    expect(within(dialog).getAllByRole('status').filter((entry) => entry.textContent?.includes('全店の未読件数を確認できないため、すべて既読にできません。'))).toHaveLength(1)
    fireEvent.focus(markAll)
    expect(screen.getByRole('tooltip').textContent).toContain('未読件数を確認できないため、すべて既読にできません。')
    await act(async () => { fireEvent.click(markAll) })
    expect(fixture.markAllRead).not.toHaveBeenCalled()
    expect(within(dialog).getByText('未読 —')).toBeTruthy()
    expect(within(dialog).queryByText('未読 0')).toBeNull()
    expect(bell().getAttribute('aria-label')).toBe('通知（未読数を確認できません）')
  })

  it('統括で全店の取得に失敗したらエラーを出し、未読0と既読操作を出さない', async () => {
    fixture.list.mockResolvedValue({ success: false, error: 'failed' })
    render(<Harness accountId={null} accounts={[{ id: 'account-1', label: '本店' }, { id: 'account-2', label: '渋谷店' }]} />)

    const dialog = await openPopover()
    const errorNotice = await within(dialog).findByRole('alert')
    expect(errorNotice.textContent).toContain('未読件数を確認できないため、すべて既読にできません。')
    expect(within(dialog).queryByText('未読 0')).toBeNull()
    expect(within(dialog).queryByText('通知はまだありません。')).toBeNull()
    const markAll = within(dialog).getByRole('button', { name: 'すべて既読にする' }) as HTMLButtonElement
    expect(markAll.disabled).toBe(false)
    expect(markAll.getAttribute('aria-disabled')).toBe('true')
    expect(within(dialog).queryByRole('status')).toBeNull()
    fireEvent.focus(markAll)
    expect(screen.getByRole('tooltip').textContent).toContain('未読件数を確認できないため、すべて既読にできません。')
    await act(async () => { fireEvent.click(markAll) })
    expect(fixture.markAllRead).not.toHaveBeenCalled()
  })

  it('名前のない失敗店舗が複数あっても部分失敗の文言を重ねない', async () => {
    fixture.list.mockImplementation(async (id: string) => id === 'account-1'
      ? centerData([item('available', { title: '読めた通知' })])
      : { success: false, error: 'failed' })
    render(<Harness accountId={null} accounts={[
      { id: 'account-1', label: '本店' }, { id: 'account-2', label: '' }, { id: 'account-3', label: '  ' },
    ]} />)

    const dialog = await openPopover()
    expect(await within(dialog).findByText('本店：読めた通知')).toBeTruthy()
    const notice = within(dialog).getAllByRole('status').find((entry) => entry.textContent?.includes('の通知を読み込めませんでした'))
    expect(notice).toBeTruthy()
    expect(notice.textContent?.match(/一部の店舗/g)).toHaveLength(1)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    delete document.documentElement.dataset.theme
  })

  it('相対時刻に元の日時を添え、本文の案内も残す', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    fixture.list.mockResolvedValue(centerData([item('recent', { title: '最近の通知', body: '通知の本文', createdAt: recent })]))
    render(<Harness />)
    const panel = await openPopover()
    const row = (await within(panel).findByText('最近の通知')).closest('button')!
    expect(row.getAttribute('title')).toBe('通知の本文')
    expect(within(row).getByText('2時間前').getAttribute('title')).toBe(formatDateTime(recent, '日時不明'))
  })

  it('ベルを押すとページを移らずに小窓が開き、もう一度押すと閉じる', async () => {
    render(<Harness />)
    expect(bell().tagName).toBe('BUTTON')
    expect(bell().getAttribute('aria-haspopup')).toBe('dialog')
    expect(bell().getAttribute('aria-expanded')).toBe('false')
    const dialog = await openPopover()
    expect(bell().getAttribute('aria-expanded')).toBe('true')
    expect(bell().getAttribute('aria-controls')).toBe(dialog.id)
    expect(fixture.push).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(bell()) })
    expect(screen.queryByRole('dialog', { name: '通知' })).toBeNull()
    expect(bell().getAttribute('aria-expanded')).toBe('false')
  })

  it('Esc で閉じて焦点がベルへ戻る', async () => {
    render(<Harness />)
    await openPopover()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog', { name: '通知' })).toBeNull()
    expect(document.activeElement).toBe(bell())
  })

  it('上の帯の端ではなく、押したベルの下から開く', async () => {
    render(<Harness />)
    vi.spyOn(bell(), 'getBoundingClientRect').mockReturnValue(new DOMRect(800, 60, 36, 36))
    const dialog = await openPopover()
    expect(dialog.parentElement?.style.top).toBe('100px')
  })

  it('小窓の外を押すと閉じ、中を押しても閉じない', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    await act(async () => { fireEvent.pointerDown(within(dialog).getByText('通知', { selector: 'h2' })) })
    expect(screen.getByRole('dialog', { name: '通知' })).toBeTruthy()
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(screen.queryByRole('dialog', { name: '通知' })).toBeNull()
  })

  it('最大5件・未読が先（新しい順のまま）。未読の数を頭に出す', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    const rows = within(dialog).getAllByRole('listitem')
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.getAttribute('data-unread'))).toEqual(['true', 'true', 'true', 'false', 'false'])
    expect(rows[0].textContent).toContain('未読のエラー')
    expect(rows[2].textContent).toContain('EC連携を開く →')
    expect(fixture.list).toHaveBeenCalledWith('account-1', { limit: 50 })
  })

  it('タブは「すべて・未読・システム」。アップデートのタブは無い', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    const tabs = within(dialog).getByRole('group', { name: '通知の種類' })
    expect(within(tabs).getAllByRole('button').map((button) => button.textContent)).toEqual(['すべて', '未読', 'システム'])
    expect(within(dialog).queryByRole('button', { name: 'アップデート' })).toBeNull()
  })

  it('未読のタブは口で未読だけに絞って読む（先頭5件に切っても6件目より後ろの未読が埋もれない）', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    const buried = [1, 2, 3, 4, 5, 6].map((n) => item(`old-unread-${n}`, { title: `古い未読 ${n}`, createdAt: `2026-09-0${n}T00:00:00.000Z` }))
    fixture.list.mockImplementation(async (_account: string, query: { unread?: boolean }) => centerData(query.unread ? buried.slice(4) : []))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '未読' })) })
    await waitFor(() => expect(fixture.list).toHaveBeenLastCalledWith('account-1', { unread: true, limit: 50 }))
    expect(await within(dialog).findByText('古い未読 6')).toBeTruthy()
  })

  it('システムのタブは運用の異常（category=error）で読み直す', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'システム' })) })
    await waitFor(() => expect(fixture.list).toHaveBeenLastCalledWith('account-1', { category: 'error', limit: 50 }))
  })

  it.each([
    ['owner', 'アカウントを見る →'],
    ['admin', 'アカウントを見る →'],
    ['staff', 'アカウントを見る →'],
    ['viewer', 'アカウントを見る →'],
    [null, 'アカウントを見る →'],
  ])('LINE の鍵の知らせは、そのアカウントの設定へ。権限 %s の行の言葉は %s', async (role, label) => {
    fixture.role = role
    fixture.list.mockResolvedValue(centerData([item('token', { eventType: 'line_token_expiring', title: 'LINEの鍵があと6日で切れます' })]))
    render(<Harness />)
    const dialog = await openPopover()
    const row = await within(dialog).findByRole('button', { name: /LINEの鍵があと6日で切れます/ })
    expect(row.textContent).toContain(label)
    await act(async () => { fireEvent.click(row) })
    expect(fixture.push).toHaveBeenCalledWith('/accounts/detail?id=account-1')
  })

  it('日本時間の今日とそれより前に分け、各組の中では未読を先にする', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T15:30:00.000Z'))
    fixture.list.mockResolvedValue(centerData([
      item('today-read', { title: '今日の既読', isRead: true, createdAt: '2026-10-22T15:20:00Z' }),
      item('earlier', { title: '前の日の未読', createdAt: '2026-10-22T14:59:59Z' }),
      item('today-unread', { title: '今日の未読', createdAt: '2026-10-22 15:00:00' }),
    ]))
    render(<Harness />)
    const dialog = await openPopover()
    const today = await within(dialog).findByRole('region', { name: '今日' })
    expect(within(today).getAllByRole('listitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('今日の未読'), expect.stringContaining('今日の既読'),
    ])
    const earlier = within(dialog).getByRole('region', { name: 'それより前' })
    expect(within(earlier).getByText('前の日の未読')).toBeTruthy()
    expect(within(dialog).getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual(['今日', 'それより前'])
  })

  it('日時が壊れた通知を消さず、不明として読める。空の日付の組は出さない', async () => {
    fixture.list.mockResolvedValue(centerData([item('unknown', { createdAt: 'invalid', title: '日時のない通知' })]))
    render(<Harness />)
    const dialog = await openPopover()
    const unknown = await within(dialog).findByRole('region', { name: '日時不明' })
    expect(within(unknown).getByText('日時のない通知')).toBeTruthy()
    expect(within(dialog).queryByRole('region', { name: '今日' })).toBeNull()
    expect(within(dialog).queryByRole('region', { name: 'それより前' })).toBeNull()
  })

  it('行を押すと既読にして行き先へ移り、小窓を閉じる。ベルの数も減る', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /EC連携が止まった/ })) })
    expect(fixture.markRead).toHaveBeenCalledWith('u3', 'account-1')
    expect(fixture.push).toHaveBeenCalledWith('/ec-commerce')
    expect(screen.queryByRole('dialog', { name: '通知' })).toBeNull()
    expect(bell().getAttribute('aria-label')).toBe('通知（未読 2 件）')
  })

  it('すべて既読は押した瞬間に反映し、失敗したら戻す', async () => {
    let fail: (value: unknown) => void = () => {}
    fixture.markAllRead.mockReturnValue(new Promise((resolve) => { fail = resolve }))
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'すべて既読にする' })) })
    expect(within(dialog).getByText('未読 0')).toBeTruthy()
    expect(fixture.markAllRead).toHaveBeenCalledWith('account-1', 'all')
    expect(bell().getAttribute('aria-label')).toBe('通知')
    await act(async () => { fail({ success: false, error: 'boom' }) })
    await within(dialog).findByText('未読 3')
    expect(fixture.toast).toHaveBeenCalled()
  })

  it('統括で一部の既読処理が失敗したら読み直し、成功した店を未読に戻さない', async () => {
    let saved = false
    fixture.list.mockImplementation(async (accountId: string) => centerData([item('same', { isRead: saved && accountId === 'account-1' })]))
    fixture.markAllRead.mockImplementation(async (accountId: string) => accountId === 'account-2'
      ? { success: false, error: '保存できませんでした' }
      : (saved = true, { success: true, data: { updated: 1 } }))
    render(<Harness accountId={null} accounts={[{ id: 'account-1', label: '本店' }, { id: 'account-2', label: '渋谷店' }]} />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 2')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'すべて既読にする' })) })
    await within(dialog).findByText('未読 1')
    expect(fixture.list).toHaveBeenCalledTimes(4)
    expect(fixture.markAllRead.mock.calls.map(([id]) => id)).toEqual(['account-1', 'account-2'])
    expect(fixture.toast).toHaveBeenCalledWith('通知をまとめて既読にできませんでした。', expect.objectContaining({ tone: 'error' }))
  })

  it('通知を押して閉じた後の既読失敗も知らせ、札をサーバーの未読へ戻す', async () => {
    let finish!: (result: { success: boolean; error: string }) => void
    fixture.markRead.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /EC連携が止まった/ })) })
    expect(screen.queryByRole('dialog', { name: '通知' })).toBeNull()
    expect(bell().getAttribute('aria-label')).toBe('通知（未読 2 件）')
    await act(async () => { finish({ success: false, error: 'failed' }) })
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('通知（未読 3 件）'))
    expect(fixture.toast).toHaveBeenCalledWith('通知を既読にできませんでした。', { tone: 'error' })
  })

  it('店を替えたあとの古い既読失敗は新しい店の札や知らせを変えない', async () => {
    let finish!: (result: { success: boolean; error: string }) => void
    fixture.markRead.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const view = render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /EC連携が止まった/ })) })
    view.rerender(<Harness accountId="account-2" />)
    fixture.list.mockResolvedValue(centerData([item('new-store')]))
    const nextDialog = await openPopover()
    await within(nextDialog).findByText('未読 1')
    await act(async () => { finish({ success: false, error: 'old failed' }) })
    expect(bell().getAttribute('aria-label')).toBe('通知（未読 1 件）')
    expect(fixture.toast).not.toHaveBeenCalled()
  })

  it('同じIDの別店の通知を取り違えず、指定した店だけ既読にする', async () => {
    fixture.list.mockImplementation(async (id: string) => centerData([item('same', { title: `店${id}` })]))
    render(<Harness accountId={null} accounts={[{ id: 'account-1', label: '本店' }, { id: 'account-2', label: '渋谷店' }]} />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 2')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /渋谷店：店account-2/ })) })
    expect(fixture.markRead).toHaveBeenCalledExactlyOnceWith('same', 'account-2')
  })

  it('既読失敗後の再読込も失敗したとき、未取得の数を0件にしない', async () => {
    fixture.markAllRead.mockResolvedValue({ success: false, error: 'failed' })
    render(<Harness />)
    const dialog = await openPopover()
    await within(dialog).findByText('未読 3')
    fixture.list.mockResolvedValue({ success: false, error: '読めません' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'すべて既読にする' })) })
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('通知（未読数を確認できません）'))
    expect(within(dialog).queryByText('未読 0')).toBeNull()
  })

  it.each(['single', 'all'])('%s既読の保留中にタブを替えたら、失敗後も現在のタブで再取得し旧応答を捨てる', async (mode) => {
    let finishMutation!: (value: { success: boolean; error: string }) => void
    const pendingMutation = new Promise((resolve) => { finishMutation = resolve })
    if (mode === 'single') fixture.markRead.mockReturnValue(pendingMutation)
    else fixture.markAllRead.mockReturnValue(pendingMutation)
    let finishOld!: (value: ReturnType<typeof centerData>) => void
    const oldResponse = new Promise(resolve => { finishOld = resolve })
    let holdOld = false
    fixture.list.mockImplementation(async (_id: string, query: { category?: string }) => query.category === 'error'
      ? centerData([item('system', { title: '現在のシステム行' })])
      : holdOld ? oldResponse : centerData([item('all', { title: '最初のすべて行' })]))
    render(<Harness />)
    let dialog = await openPopover()
    await within(dialog).findByText('最初のすべて行')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: mode === 'single' ? /最初のすべて行/ : 'すべて既読にする' })) })
    holdOld = true
    if (mode === 'single') dialog = await openPopover()
    else await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '未読' })) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'システム' })) })
    await within(dialog).findByText('現在のシステム行')
    const beforeRecovery = fixture.list.mock.calls.length
    await act(async () => { finishMutation({ success: false, error: 'failed' }) })
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(beforeRecovery + 1))
    expect(fixture.list).toHaveBeenLastCalledWith('account-1', { category: 'error', limit: 50 })
    await act(async () => { finishOld(centerData([item('old', { title: '遅れた旧タブの行' })])) })
    expect(await within(dialog).findByText('現在のシステム行')).toBeTruthy()
    expect(within(dialog).queryByText('遅れた旧タブの行')).toBeNull()
    expect(within(dialog).queryByText('最初のすべて行')).toBeNull()
  })

  it('閉じた小窓の遅い読込結果はベルの未読数を変えない', async () => {
    let finish!: (value: ReturnType<typeof centerData>) => void
    fixture.list.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    render(<Harness />)
    await openPopover()
    await waitFor(() => expect(fixture.list).toHaveBeenCalled())
    await act(async () => { fireEvent.click(bell()) })
    await act(async () => { finish(centerData([])) })
    expect(bell().getAttribute('aria-label')).toBe('通知（未読 3 件）')
  })

  it('すべて見るは小窓を閉じて通知の画面へ。下に押すものは「すべて見る」1つだけ（歯車は置かない）', async () => {
    render(<Harness />)
    const dialog = await openPopover()
    expect(within(dialog).queryByRole('button', { name: '通知設定' })).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'すべて見る →' })) })
    expect(fixture.push).toHaveBeenLastCalledWith('/notifications')
    expect(screen.queryByRole('dialog', { name: '通知' })).toBeNull()
  })

  it('店を選んでいないとき（統括）は読まずに案内だけ', async () => {
    render(<Harness accountId={null} />)
    const dialog = await openPopover()
    expect(within(dialog).getByText('LINEアカウントを選ぶと、そのアカウントの通知が出ます。')).toBeTruthy()
    expect(fixture.list).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'すべて見る →' })).toBeTruthy()
  })

  it('小窓を渡さない帯は、今までどおり通知の一覧へのリンク', () => {
    render(<Harness withPopover={false} />)
    const link = screen.getByRole('link', { name: /^通知/ })
    expect(link.getAttribute('href')).toBe('/notifications')
  })
})
