// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { READ_ONLY_MESSAGE } from '@/components/shared/read-only-notice'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import GoogleV8 from './google'

const fixture = vi.hoisted(() => ({ role: 'owner' as string | null, tab: 'posts', accountLoading: false, connection: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fixture.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', setSelectedAccountId: vi.fn(), accounts: [], loading: fixture.accountLoading }) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/restaurant-test/google', useSearchParams: () => new URLSearchParams(`tab=${fixture.tab}`), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({version:'1',deploy_env:'staging'}) }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: { connection: fixture.connection } }))
vi.mock('./posts', () => ({ PostsBoard: () => <div>投稿の見本</div>, PostEditor: () => null, PostConfirm: () => null }))
vi.mock('./reviews', () => ({ ReviewsBoard: () => <div>口コミの見本</div>, ReviewDraft: () => null }))
vi.mock('./performance', () => ({ default: () => <div>数値の見本</div> }))
vi.mock('./profile', () => ({ default: () => <div>プロフィールの見本</div> }))
vi.mock('./hours', () => ({ default: () => <div>営業時間の見本</div> }))
vi.mock('./settings', () => ({ default: () => <div>設定の見本</div> }))
let resolve!: (data: GoogleConnectionData) => void
let reject!: (error: Error) => void
const data = (canManageConnection = true) => ({ store: { id: 's', name: '合成店' }, stores: [], connection: { status: 'connected' }, summary: {}, permissions: { canManageConnection, canPublishReply: true } }) as unknown as GoogleConnectionData
const notices = () => document.querySelectorAll('[data-read-only-notice]')
function identity(role: string | null) {
  fixture.role = verifiedStaffRole(role)
  if (role !== null) rememberStaffIdentity({ ...readStaffIdentity()!, ...(role === 'viewer' ? { role: 'staff' as const, readOnly: true, roleBundle: 'view_only' as const } : {}), permissionViewKeys: ['/restaurant-test/google'] })
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.tab = 'posts'; fixture.accountLoading = false; identity('owner')
  fixture.connection.mockReturnValue(new Promise<GoogleConnectionData>((ok, fail) => { resolve = ok; reject = fail }))
})
afterEach(cleanup)
it.each(['owner', 'admin', 'viewer', null])('接続データを読む間（%s）は権限の帯を出さない', async role => {
  identity(role); render(<GoogleV8 />)
  await screen.findByLabelText('Googleビジネスを読み込んでいます')
  expect(notices()).toHaveLength(0)
  expect(screen.getByRole('heading', { name: 'Googleビジネス' })).toBeTruthy()
  expect(screen.getByRole('tablist', { name: 'Googleビジネスの機能' })).toBeTruthy()
  expect(document.querySelector('[data-template-region="notice"]')).toBeNull()
})
it('読み込みに失敗した時は権限の帯を出さず、失敗と再読込を示す', async () => {
  render(<GoogleV8 />)
  await act(async () => { reject(new Error('fixture failure')) })
  await screen.findByRole('button', { name: 'もう一度読み込む' })
  expect(document.querySelector('[data-list-state="error"]')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
  expect(notices()).toHaveLength(0)
  expect(screen.getByRole('heading', { name: 'Googleビジネス' })).toBeTruthy()
  expect(screen.getByRole('tablist', { name: 'Googleビジネスの機能' })).toBeTruthy()
  expect(document.querySelector('[data-template-region="notice"]')).toBeNull()
})
it('アカウント自体を読んでいる間も帯を出さない', async () => {
  fixture.accountLoading = true; identity('viewer'); render(<GoogleV8 />)
  await act(async () => { resolve(data()) })
  expect(screen.getByLabelText('Googleビジネスを読み込んでいます')).toBeTruthy()
  expect(notices()).toHaveLength(0)
})
it.each([
  ['reviews', 'feature'], ['posts', 'feature'], ['performance', 'feature'], ['profile', 'manager'],
] as const)('%s はデータを読んだ後に %s の帯を題の下へ1本だけ出す', async (tab, need) => {
  fixture.tab = tab; identity('staff'); render(<GoogleV8 />)
  await act(async () => { resolve(data(false)) })
  await waitFor(() => expect(notices()).toHaveLength(1))
  expect(notices()[0].textContent).toBe(PERMISSION_LOCK_SUMMARY[need])
  const header = document.querySelector('header[data-template-region="heading"]')!
  expect(header.querySelectorAll('[data-read-only-notice]')).toHaveLength(0)
  expect(header.querySelector('h1')?.textContent).toBe('Googleビジネス')
  const group = document.querySelector('[data-google-notices]')!
  await screen.findByText(/検証環境です。予約サイトへは送りません/)
  expect(group.querySelectorAll('[data-design-part="notice"]')).toHaveLength(2)
  expect(group.firstElementChild).toBe(notices()[0])
  expect(group.lastElementChild?.textContent).toContain('検証環境です。予約サイトへは送りません')
  expect(header.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
it.each(['reviews', 'posts', 'performance', 'profile'])('閲覧のみの %s も標準の帯が1本だけ', async tab => {
  fixture.tab = tab; identity('viewer'); render(<GoogleV8 />)
  await act(async () => { resolve(data()) })
  await waitFor(() => expect(notices()).toHaveLength(1))
  expect(notices()[0].textContent).toBe(READ_ONLY_MESSAGE)
  expect(document.querySelector('[data-google-notices]')?.firstElementChild).toBe(notices()[0])
})
it.each(['owner', null])('データ取得後も、許可された人と未知の本人（%s）に帯を作らない', async role => {
  identity(role); render(<GoogleV8 />)
  await act(async () => { resolve(data()) })
  expect(await screen.findByText('投稿の見本')).toBeTruthy()
  expect(notices()).toHaveLength(0)
  expect(document.querySelector('[data-template-region="notice"]')).toBeNull()
})

it('営業時間は専用の識別を保ち、口コミの注意書きと権限の帯を重ねない', async () => {
  fixture.tab = 'hours'; identity('viewer'); render(<GoogleV8 />)
  await act(async () => { resolve({ ...data(), connection: { status: 'connected', locationName: 'locations/example' } } as GoogleConnectionData) })
  expect(await screen.findByText('営業時間の見本')).toBeTruthy()
  expect(document.querySelector('[data-google-hours-page]')).toBeTruthy()
  expect(document.querySelector('[data-design-node="tYbl8"]')).toBeTruthy()
  expect(screen.queryByText(/Google への返信は/)).toBeNull()
  expect(notices()).toHaveLength(0)
})
