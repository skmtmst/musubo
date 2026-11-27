// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  account: 'a',
  role: 'owner' as string,
  contextId: null as string | null,
  list: vi.fn(),
  context: vi.fn(),
  select: vi.fn(),
  media: vi.fn(),
  save: vi.fn(),
  link: vi.fn(),
  fetchApi: vi.fn(),
  notice: vi.fn(),
  saveNotice: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: net.account }) }))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
  useHideSettingsNav: () => {},
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => net.role,
  canManageRole: (role: string) => role === 'owner' || role === 'admin',
}))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({
  usePermissionLockReason: (allowed: boolean) => (allowed ? undefined : '閲覧のみのため変更できません'),
}))
vi.mock('@/lib/api', async (load) => ({ ...await load<typeof import('@/lib/api')>(), fetchApi: net.fetchApi }))
vi.mock('@/lib/restaurant-test-api', () => ({
  restaurantTestApi: {
    listStores: net.list,
    storeContext: net.context,
    selectStore: net.select,
    mediaLinks: net.media,
    saveMediaLink: net.save,
    reservationLink: net.link,
    closeNotificationSettings: net.notice,
    saveCloseNotificationSettings: net.saveNotice,
    snapshot: async () => ({ data: { memberships: [] } }),
  },
}))
vi.mock('@/lib/admin-version-cache', () => ({
  loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }),
}))
vi.mock('@/lib/line-accounts-cache', () => ({
  loadLineAccounts: async () => ({
    success: true,
    data: [
      { id: 'a', name: '対象LINE-A' },
      { id: 'b', name: '対象LINE-B' },
    ],
  }),
}))

import BookingMedia from './screen'
import { ApiError } from '@/lib/api'

type ChannelFixture = {
  code: string
  status: string
  daysWithoutReceipt: number | null
  receiveMethod: string
  emailImportSupported: boolean
  emailImportEnabled: boolean
  emailImportVersion: number
  heldCount: number
  expiringHeldCount: number
  nearestHeldExpiresAt: string | null
  daysUntilNearestHeldExpiry: number | null
  overdueCount?: number
  upcomingExpiringCount?: number
  daysUntilNearestUpcomingHeldExpiry?: number | null
}

let channelFixtures: ChannelFixture[] = []

function baseMediaRows() {
  return [
    {
      code: 'hotpepper',
      name: 'ホットペッパー',
      acceptsReservations: 1 as const,
      emailImportSupported: 1 as const,
      pageUrl: 'https://hotpepper.jp/strJ001/',
      loginUrl: 'https://manager.hotpepper.jp/',
      closeOnBooking: 1 as const,
      version: 3,
    },
    {
      code: 'tabelog',
      name: '食べログ',
      acceptsReservations: 1 as const,
      emailImportSupported: 1 as const,
      pageUrl: 'https://tabelog.com/shop/',
      loginUrl: 'https://owner.tabelog.com/',
      closeOnBooking: 1 as const,
      version: 2,
    },
    {
      code: 'retty',
      name: 'Retty',
      acceptsReservations: 0 as const,
      emailImportSupported: 0 as const,
      pageUrl: 'https://retty.me/shop/',
      loginUrl: null,
      closeOnBooking: 0 as const,
      version: 1,
    },
    {
      code: 'google',
      name: 'Google',
      acceptsReservations: 1 as const,
      emailImportSupported: 0 as const,
      pageUrl: 'https://g.page/shop',
      loginUrl: 'https://business.google.com/',
      closeOnBooking: 0 as const,
      version: 1,
    },
    {
      code: 'ikyu',
      name: '一休',
      acceptsReservations: 1 as const,
      emailImportSupported: 0 as const,
      pageUrl: 'https://restaurant.ikyu.com/shop/',
      loginUrl: null,
      closeOnBooking: 0 as const,
      version: 1,
    },
  ]
}

function defaultChannels(): ChannelFixture[] {
  return [
    {
      code: 'hotpepper',
      status: 'receiving',
      daysWithoutReceipt: 0,
      receiveMethod: 'email_forward',
      emailImportSupported: true,
      emailImportEnabled: true,
      emailImportVersion: 1,
      heldCount: 0,
      expiringHeldCount: 0,
      nearestHeldExpiresAt: null,
      daysUntilNearestHeldExpiry: null,
    },
    {
      code: 'tabelog',
      status: 'not_receiving',
      daysWithoutReceipt: 7,
      receiveMethod: 'email_forward',
      emailImportSupported: true,
      emailImportEnabled: true,
      emailImportVersion: 0,
      heldCount: 0,
      expiringHeldCount: 0,
      nearestHeldExpiresAt: null,
      daysUntilNearestHeldExpiry: null,
    },
  ]
}

beforeEach(() => {
  vi.resetAllMocks()
  net.account = 'a'
  net.role = 'owner'
  net.contextId = null
  channelFixtures = defaultChannels()

  net.list.mockResolvedValue({
    data: {
      stores: [{ id: 'current', name: '現在の店', line_account_id: 'a', status: 'active' }],
    },
  })
  net.context.mockImplementation(async () => ({
    data: { selectedStore: net.contextId ? { id: net.contextId, name: '現在の店' } : null },
  }))
  net.select.mockImplementation(async (_account, id) => {
    net.contextId = id
    return { data: { selectedStore: { id, name: '店' } } }
  })
  net.media.mockResolvedValue({ data: baseMediaRows() })
  net.link.mockResolvedValue({ data: { url: 'https://fixture.invalid/reserve', html: '', available: true } })
  net.save.mockResolvedValue({ data: { version: 4 } })
  net.notice.mockResolvedValue({
    data: { notifyReopen: false, recipientMode: 'responsible', membershipIds: [], version: 1 },
  })
  net.saveNotice.mockResolvedValue({ data: { version: 2 } })
  net.fetchApi.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/restaurant-test/channels')) {
      return { success: true, data: channelFixtures.map((c) => ({ ...c })) }
    }
    if (url.startsWith('/api/restaurant-test/media-email-import/') && init?.method === 'PUT') {
      const code = decodeURIComponent(url.split('/media-email-import/')[1]!.split('?')[0]!)
      const body = JSON.parse(init.body ?? '{}') as {
        storeId: string
        enabled: boolean
        expectedVersion: number
        heldAction?: 'import' | 'archive'
      }
      const target = channelFixtures.find((c) => c.code === code)!
      target.emailImportEnabled = body.enabled
      target.emailImportVersion = body.expectedVersion + 1
      if (!body.enabled) {
        target.heldCount = 2
        target.expiringHeldCount = 1
        target.daysUntilNearestHeldExpiry = 5
      } else {
        const count = target.heldCount
        target.heldCount = 0
        target.expiringHeldCount = 0
        target.daysUntilNearestHeldExpiry = null
        return {
          success: true,
          data: {
            ...target,
            storeId: body.storeId,
            importedCount: body.heldAction === 'import' ? count : 0,
            archivedCount: body.heldAction === 'archive' ? count : 0,
            failedHeldCount: 0,
          },
        }
      }
      return {
        success: true,
        data: { ...target, storeId: body.storeId, importedCount: 0, archivedCount: 0, failedHeldCount: 0 },
      }
    }
    throw new Error(`Unexpected fetchApi call: ${url}`)
  })
})

afterEach(cleanup)

function rowFor(name: string): HTMLElement {
  return screen.getByText(name, { exact: true }).closest('tr')!
}

it('対象媒体だけに設定状態と受信状況を分けて出し、非対象媒体には停止ボタンを出さない', async () => {
  render(<BookingMedia />)
  await screen.findByText('ホットペッパー')

  const hpRow = rowFor('ホットペッパー')
  expect(within(hpRow).getByText('有効')).toBeTruthy()
  expect(within(hpRow).getByText('受信：届いています')).toBeTruthy()
  expect(within(hpRow).getByRole('button', { name: '止める', exact: true })).toBeTruthy()

  const tbRow = rowFor('食べログ')
  expect(within(tbRow).getByText('有効')).toBeTruthy()
  expect(within(tbRow).getByText('受信：7日届いていません')).toBeTruthy()
  expect(within(tbRow).getByRole('button', { name: '止める', exact: true })).toBeTruthy()

  const rettyRow = rowFor('Retty')
  expect(within(rettyRow).getByText('取り込まない')).toBeTruthy()
  expect(within(rettyRow).queryByRole('button', { name: '止める' })).toBeNull()
  expect(within(rettyRow).queryByRole('button', { name: '再開する' })).toBeNull()

  const googleRow = rowFor('Google')
  expect(within(googleRow).getByText('Google ビジネスと連携')).toBeTruthy()
  expect(within(googleRow).queryByRole('button', { name: '止める' })).toBeNull()

  const ikyuRow = rowFor('一休')
  expect(within(ikyuRow).getByText('未設定')).toBeTruthy()
  expect(within(ikyuRow).queryByRole('button', { name: '止める' })).toBeNull()
})

it('有効な媒体で残った保留を件数付きで示し、停止せず再試行できる', async () => {
  channelFixtures[0]!.heldCount = 2
  render(<BookingMedia />)
  await screen.findByText('ホットペッパー')
  const row = rowFor('ホットペッパー')
  expect(within(row).getByText('保留 2 通')).toBeTruthy()
  fireEvent.click(within(row).getByRole('button', { name: '保留分を再試行' }))
  const dialog = await screen.findByRole('dialog', { name: 'ホットペッパーの保留メールを再試行' })
  fireEvent.click(within(dialog).getByRole('button', { name: '実行する' }))
  await waitFor(() => expect(net.fetchApi.mock.calls.some(([url, init]) => String(url).includes('/media-email-import/hotpepper') && JSON.parse(init?.body ?? '{}').heldAction === 'import')).toBe(true))
  await waitFor(() => expect(within(rowFor('ホットペッパー')).queryByRole('button', { name: '保留分を再試行' })).toBeNull())
})

it('再開後も保管された原文の期限を警告し、再開操作を求めない', async () => {
  channelFixtures[0]!.emailImportEnabled = true
  channelFixtures[0]!.heldCount = 0
  channelFixtures[0]!.expiringHeldCount = 1
  channelFixtures[0]!.daysUntilNearestHeldExpiry = 5
  render(<BookingMedia />)
  const warning = await screen.findByText(/停止中に受け取った予約メール 1 通が、あと 5 日で保管期限/)
  expect(warning.textContent).not.toContain('［再開する］')
  expect(within(rowFor('ホットペッパー')).queryByRole('button', { name: '保留分を再試行' })).toBeNull()
})

it('期限を過ぎて削除待ちの原文は、あと0日ではなく超過を知らせる', async () => {
  channelFixtures[0]!.emailImportEnabled = false
  channelFixtures[0]!.heldCount = 0
  channelFixtures[0]!.expiringHeldCount = 1
  channelFixtures[0]!.daysUntilNearestHeldExpiry = 0
  render(<BookingMedia />)
  const warning = await screen.findByText(/保管期限を過ぎています/)
  expect(warning.textContent).toContain('原文の削除を再試行しています')
  expect(warning.textContent).not.toContain('あと 0 日')
  expect(screen.queryByRole('button', { name: '再開・保管を選ぶ' })).toBeNull()
})

it('期限超過と7日以内のメールが混在しても、それぞれを警告し期限前の保留を選べる', async () => {
  Object.assign(channelFixtures[0]!, { emailImportEnabled: false, heldCount: 1, expiringHeldCount: 2,
    daysUntilNearestHeldExpiry: 0, overdueCount: 1, upcomingExpiringCount: 1, daysUntilNearestUpcomingHeldExpiry: 4 })
  render(<BookingMedia />)
  expect(await screen.findByText(/保管期限を過ぎています/)).toBeTruthy()
  expect(screen.getByText(/あと 4 日で保管期限（最長30日）を迎えます/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '再開・保管を選ぶ' }))
  const dialog = await screen.findByRole('dialog', { name: 'ホットペッパーの予約メールの取り込みを再開' })
  expect(within(dialog).getByText(/保管期限を過ぎています/)).toBeTruthy()
  expect(within(dialog).getByText(/あと 4 日で保管期限/)).toBeTruthy()
})

it('取り込みを止めると他行の未保存URL編集を残したまま保留件数と期限警告を表示し、再開の窓から取り込みまたは保管だけを選べる', async () => {
  render(<BookingMedia />)
  await screen.findByText('ホットペッパー')

  fireEvent.click(within(rowFor('食べログ')).getByRole('button', { name: '食べログのその他操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'URL を変える', exact: true }))
  const editDialog = await screen.findByRole('dialog', { name: '食べログの URL', exact: true })
  fireEvent.change(within(editDialog).getByRole('textbox', { name: '店舗ページの URL' }), {
    target: { value: 'https://tabelog.com/unsaved-edit/' },
  })
  fireEvent.click(within(editDialog).getByRole('button', { name: '変える', exact: true }))

  fireEvent.click(within(rowFor('ホットペッパー')).getByRole('button', { name: '止める', exact: true }))

  await waitFor(() =>
    expect(
      net.fetchApi.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/media-email-import/hotpepper') &&
          init?.method === 'PUT' &&
          JSON.parse(init.body).enabled === false &&
          JSON.parse(init.body).expectedVersion === 1,
      ),
    ).toBe(true),
  )

  const hpAfterStop = rowFor('ホットペッパー')
  await within(hpAfterStop).findByText('止めています（保留 2 通）')
  expect(within(hpAfterStop).getByText(/受信：届いています・保管期限まであと5日/)).toBeTruthy()
  expect(screen.getByText(/あと 5 日で保管期限（最長30日）を迎えます/)).toBeTruthy()
  expect(within(rowFor('食べログ')).getByRole('link', { name: 'tabelog.com/unsaved-edit/' })).toBeTruthy()

  fireEvent.click(within(hpAfterStop).getByRole('button', { name: '再開する', exact: true }))
  const resumeDialog = await screen.findByRole('dialog', {
    name: 'ホットペッパーの予約メールの取り込みを再開',
    exact: true,
  })
  await within(resumeDialog).findByText('対象LINE-A')
  expect(within(resumeDialog).getByText('現在の店')).toBeTruthy()
  expect(within(resumeDialog).getByText(/停止中に受け取ったメールのうち 1 通が、あと 5 日で保管期限（最長30日）を迎えます/)).toBeTruthy()

  const archiveRadio = within(resumeDialog).getByRole('radio', { name: /取り込まない（保管だけにする/ })
  fireEvent.click(archiveRadio)
  fireEvent.click(within(resumeDialog).getByRole('button', { name: '再開する', exact: true }))

  await waitFor(() =>
    expect(
      net.fetchApi.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/media-email-import/hotpepper') &&
          init?.method === 'PUT' &&
          JSON.parse(init.body).enabled === true &&
          JSON.parse(init.body).expectedVersion === 2 &&
          JSON.parse(init.body).heldAction === 'archive',
      ),
    ).toBe(true),
  )

  await within(rowFor('ホットペッパー')).findByText('有効')
})

it('閲覧のみの利用者には停止・再開ボタンを灰色と理由付きで出し、押しても送信しない', async () => {
  net.role = 'viewer'
  channelFixtures[0]!.emailImportEnabled = false
  channelFixtures[0]!.heldCount = 3

  render(<BookingMedia />)
  await screen.findByText('ホットペッパー')

  const resumeBtn = within(rowFor('ホットペッパー')).getByRole('button', { name: '再開する', exact: true })
  const stopBtn = within(rowFor('食べログ')).getByRole('button', { name: '止める', exact: true })
  expect(resumeBtn.getAttribute('aria-disabled')).toBe('true')
  expect(stopBtn.getAttribute('aria-disabled')).toBe('true')
  expect(resumeBtn.hasAttribute('data-permission-locked')).toBe(true)
  const reasonId = resumeBtn.getAttribute('aria-describedby')
  expect(reasonId).toBeTruthy()
  expect(document.getElementById(reasonId!)?.textContent).toBeTruthy()

  fireEvent.click(resumeBtn)
  fireEvent.click(stopBtn)
  expect(screen.queryByRole('dialog', { name: /予約メールの取り込みを再開/ })).toBeNull()
  expect(net.fetchApi.mock.calls.some(([url]) => String(url).includes('/media-email-import/'))).toBe(false)
})

it('再開の通信失敗では窓と選択を残して再試行でき、409競合では再読込の帯を出す', async () => {
  channelFixtures[0]!.emailImportEnabled = false
  channelFixtures[0]!.emailImportVersion = 2
  channelFixtures[0]!.heldCount = 1

  let failMode: '500' | '409' | null = '500'
  const baseFetch = net.fetchApi.getMockImplementation()!
  net.fetchApi.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/restaurant-test/media-email-import/') && init?.method === 'PUT') {
      if (failMode === '500') throw new ApiError(500, '一時的な障害')
      if (failMode === '409') throw new ApiError(409, '競合', 'version_conflict')
    }
    return baseFetch(url, init)
  })

  render(<BookingMedia />)
  await screen.findByText('ホットペッパー')

  fireEvent.click(within(rowFor('ホットペッパー')).getByRole('button', { name: '再開する', exact: true }))
  const dialog = await screen.findByRole('dialog', {
    name: 'ホットペッパーの予約メールの取り込みを再開',
    exact: true,
  })
  const archiveRadio = within(dialog).getByRole('radio', { name: /取り込まない（保管だけにする/ }) as HTMLInputElement
  fireEvent.click(archiveRadio)
  fireEvent.click(within(dialog).getByRole('button', { name: '再開する', exact: true }))

  await within(dialog).findByRole('alert')
  expect(archiveRadio.checked).toBe(true)

  failMode = '409'
  fireEvent.click(within(dialog).getByRole('button', { name: '再開する', exact: true }))
  await screen.findByText(/ほかの人が先にこの店の媒体の設定を変えました/)
  expect(screen.queryByRole('dialog', { name: 'ホットペッパーの予約メールの取り込みを再開' })).toBeNull()

  failMode = null
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む', exact: true }))
  await waitFor(() => expect(screen.queryByText(/ほかの人が先にこの店の媒体の設定を変えました/)).toBeNull())
})
