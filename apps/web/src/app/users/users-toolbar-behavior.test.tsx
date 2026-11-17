// @vitest-environment happy-dom
/*
 * 統合ユーザーの頭と道具の段（操作の行は一重の枠・同じ高さ）。
 * 並べた部品がそれぞれ一覧の取り方へつながっていることを、押して確かめる。
 * - ［再計算］は最新の状態を取り直す
 * - 検索・UID 連携・所属アカウントの絞り込みは一覧の条件になる
 * 見た目（枠・高さ）は v8-screen-guard が画面を描いて見る。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/users',
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', useStaffIdentity: () => ({ name: '試験担当', role: 'owner', accountScope: 'all', permissionKeys: [] }), canManageRole: () => true }))
vi.mock('@/components/shared/select', () => ({
  default: ({ options, value, onChange, 'aria-label': label }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; 'aria-label'?: string }) => (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      usersGrouped: { ...actual.api.usersGrouped, list: fx.list },
      lineAccounts: { ...actual.api.lineAccounts, list: () => Promise.resolve({ success: true, data: [{ id: 'acc-b', name: '支店', isActive: true }] }) },
      duplicates: { ...actual.api.duplicates, stats: () => Promise.resolve({ success: false, error: 'x' }) },
    },
  }
})

const { default: UsersV8 } = await import('./users-screen')

const lastParams = () => fx.list.mock.calls.at(-1)?.[0] as Record<string, unknown>

beforeEach(() => {
  fx.list.mockReset().mockResolvedValue({ success: true, data: { rows: [], total: 0 } })
})
afterEach(() => cleanup())

it('統合ユーザーの状態と所属を表示し、内部の識別子を出さない', async () => {
  const row = (kind: 'uid' | 'url_token' | 'solo', index: number) => ({
    identityKey: `internal-key-${index}`, identityKeyKind: kind, displayName: `見本${index}`,
    pictureUrl: null, xUsername: null, emails: [], phones: [], lastActivityAt: '2026-10-01T00:00:00Z', isDuplicate: index === 3,
    accounts: [
      { accountId: 'a', accountName: '本店', lineUserId: `XQUIDPREFIX-${index}-QZTAIL`, isFollowing: true, joinedAt: '2026-01-01T00:00:00Z', friendId: `f${index}a` },
      { accountId: 'b', accountName: '支店', lineUserId: `XQUIDPREFIX-${index}-QZTAIL`, isFollowing: false, joinedAt: '2026-01-01T00:00:00Z', friendId: `f${index}b` },
    ],
  })
  const linkedPerson = { ...row('uid', 4), identityKey: 'uid:person-d' }
  fx.list.mockResolvedValue({ success: true, data: { rows: [row('uid', 1), row('url_token', 2), row('solo', 3), linkedPerson], total: 4 } })
  const view = render(<UsersV8 />)
  const uid = (await screen.findByText('見本1')).closest('tr')!
  const token = screen.getByText('見本2').closest('tr')!
  const solo = screen.getByText('見本3').closest('tr')!
  expect(screen.getByRole('button', { name: '見本4' })).toBeTruthy()
  expect(within(uid).getByText('UIDで連携')).toBeTruthy()
  expect(within(uid).queryByText('要確認')).toBeNull()
  expect(within(token).getAllByText('要確認').length).toBeGreaterThan(0)
  expect(within(solo).getByText('未連携')).toBeTruthy()
  expect(within(uid).queryByText('uid', { exact: true })).toBeNull()
  expect(within(token).queryByText('url_token', { exact: true })).toBeNull()
  expect(within(solo).queryByText('solo', { exact: true })).toBeNull()
  expect(within(solo).getByText('要確認').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning')
  expect(view.container.textContent).toContain('送信前に配信先の確認が必要です')
  expect(view.container.textContent).not.toContain('2通→1通')
  fireEvent.click(within(uid).getByRole('button', { name: '開く' }))
  const detail = uid.nextElementSibling as HTMLElement
  expect(within(detail).getByText('ブロック・削除')).toBeTruthy()
  expect(within(detail).getByText('友だち')).toBeTruthy()
  const accountItem = (name: string) => within(detail).getAllByRole('listitem').find(li => li.textContent?.includes(name))!
  expect(within(accountItem('本店')).getByText('友だち')).toBeTruthy()
  expect(within(accountItem('支店')).getByText('ブロック・削除')).toBeTruthy()
  expect(view.container.textContent).not.toContain('internal-key-')
  expect(view.container.textContent).not.toContain('internal')
  for (const part of ['XQUID', 'QZTAIL', 'TAIL']) {
    expect(view.container.textContent).not.toContain(part)
    expect([...view.container.querySelectorAll('[title]')].map(el => el.getAttribute('title')).join(' ')).not.toContain(part)
    expect(view.container.innerHTML).not.toContain(part)
  }
  expect(view.container.textContent).not.toContain('画像トークン')
  expect(view.container.textContent).not.toContain('worker キャッシュ')
  for (const [label, explanation] of [
    ['UID連携済みの説明', 'LINE UIDを根拠にまとめている数です'],
    ['複数アカウントの説明', '2つ以上のLINEアカウントに登録がある数です'],
  ]) {
    fireEvent.click(screen.getByRole('button', { name: label }))
    const body = document.body.textContent ?? ''
    expect(body).toContain(explanation)
    for (const banned of ['2通→1通', '画像トークン', 'worker キャッシュ']) expect(body).not.toContain(banned)
    fireEvent.click(screen.getByRole('button', { name: label }))
  }
  expect(screen.getByLabelText('UID連携で絞り込む')).toBeTruthy()
  fireEvent.click(within(uid).getByRole('button', { name: '閉じる' }))
  expect(screen.queryByText('ブロック・削除')).toBeNull()
  expect(within(uid).getByRole('button', { name: '開く' })).toBeTruthy()
})

it('［再計算］は最新の状態を取り直す', async () => {
  render(<UsersV8 />)
  await waitFor(() => expect(fx.list).toHaveBeenCalled())
  expect(lastParams().forceRefresh).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: /再計算/ }))
  await waitFor(() => expect(lastParams()).toMatchObject({ forceRefresh: true }))
})

it('検索・UID連携・所属アカウントの絞り込みが一覧の条件になる', async () => {
  render(<UsersV8 />)
  await waitFor(() => expect(fx.list).toHaveBeenCalled())
  fireEvent.change(screen.getByRole('searchbox', { name: '統合ユーザーを検索' }), { target: { value: 'たなか' } })
  await waitFor(() => expect(lastParams()).toMatchObject({ q: 'たなか' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'UID連携で絞り込む' }), { target: { value: 'linked' } })
  await waitFor(() => expect(lastParams()).toMatchObject({ q: 'たなか', uid: 'linked' }))
  await screen.findByRole('option', { name: '支店' })
  fireEvent.change(screen.getByRole('combobox', { name: '所属アカウントで絞り込む' }), { target: { value: 'acc-b' } })
  await waitFor(() => expect(lastParams()).toMatchObject({ q: 'たなか', uid: 'linked', account: 'acc-b', page: 1 }))
  fireEvent.click(screen.getByRole('checkbox', { name: '複数アカウントのみ' }))
  await waitFor(() => expect(lastParams()).toMatchObject({ onlyDups: true }))
  expect(screen.getByRole('button', { name: 'CSVで書き出す' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '統合ユーザーを作る' }).getAttribute('href')).toBe('/friends/identity-candidates')
})
