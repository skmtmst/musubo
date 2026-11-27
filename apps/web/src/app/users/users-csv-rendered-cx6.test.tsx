// @vitest-environment happy-dom

import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const fixture = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/users',
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', useStaffIdentity: () => ({ name: '試験担当', role: 'owner', accountScope: 'all', permissionKeys: [] }), canManageRole: () => true }))
vi.mock('@/components/shared/select', () => ({
  default: ({ options, value, onChange, 'aria-label': label }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; 'aria-label'?: string }) => (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      usersGrouped: { ...actual.api.usersGrouped, list: fixture.list },
      lineAccounts: { ...actual.api.lineAccounts, list: () => Promise.resolve({ success: true, data: [] }) },
      duplicates: { ...actual.api.duplicates, stats: fixture.stats },
    },
  }
})

const { default: UsersV8 } = await import('./users-screen')

const person = (id: string) => ({
  id, identityKey: `uid:${id}`, displayName: `人${id}`, emails: [], phones: [], accounts: [{ accountName: 'A' }],
  identityKeyKind: 'uid', lastActivityAt: '2026-10-01T00:00:00Z',
})

beforeEach(() => {
  fixture.list.mockReset()
  fixture.stats.mockReset().mockResolvedValue({ success: false, error: 'x' })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('UIDの絞り込みを全ページへ送り、CSVに全員と危険な先頭文字を安全に書き出す', async () => {
  const created = vi.fn(() => 'blob:fixture')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fixture.list.mockImplementation(async (input: { pageSize?: number; page?: number }) => {
    if (input.pageSize === 200) return { success: true, data: { rows: (input.page === 1 ? ['=1+1', '+危険'] : ['-数値', '@名前', '普通,\"引用\"']).map((name, index) => ({ ...person(`${input.page}-${index}`), displayName: name })), total: 5 } }
    return { success: true, data: { rows: [person('1')], total: 2 } }
  })
  render(<UsersV8 />)
  await screen.findByText('人1')
  fireEvent.change(screen.getByLabelText('UID連携で絞り込む'), { target: { value: 'linked' } })
  await waitFor(() => expect(fixture.list).toHaveBeenCalledWith(expect.objectContaining({ uid: 'linked' })))
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
  const exports = fixture.list.mock.calls.map(([args]) => args as { page?: number; pageSize?: number; uid?: string }).filter(args => args.pageSize === 200)
  expect(exports.map(args => args.page)).toEqual([1, 2])
  expect(exports.every(args => args.uid === 'linked')).toBe(true)
  const blob = (created.mock.calls[0] as unknown as [Blob])[0]
  expect(Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
  const content = await blob.text()
  for (const name of ['=1+1', '+危険', '-数値', '@名前']) expect(content).toContain(`'${name}`)
  expect(content).toContain('\"普通,\"\"引用\"\"\"')
  expect(click).toHaveBeenCalledTimes(1)
  click.mockRestore()
})

it('書き出しに失敗しても再試行できる', async () => {
  const created = vi.fn(() => 'blob:fixture')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
  fixture.list.mockImplementation(async (input: { pageSize?: number }) => input.pageSize === 200
    ? { success: false, error: 'private' }
    : { success: true, data: { rows: [person('1')], total: 1 } })
  render(<UsersV8 />)
  await screen.findByText('人1')
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(await screen.findByText('CSVを書き出せませんでした。時間をおいてやり直してください。')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'CSVで書き出す' }) as HTMLButtonElement).disabled).toBe(false)
  expect(created).not.toHaveBeenCalled()
})

it('上限まで読み切れないときは途中までのCSVを作らない', async () => {
  const created = vi.fn(() => 'blob:fixture')
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
  fixture.list.mockImplementation(async (input: { pageSize?: number; page?: number }) => ({ success: true, data: { rows: [person(String(input.page ?? 1))], total: input.pageSize === 200 ? 501 : 1 } }))
  render(<UsersV8 />)
  await screen.findByText('人1')
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(await screen.findByText(/人数が多すぎるため、CSVに書き出せませんでした/)).toBeTruthy()
  expect(fixture.list.mock.calls.filter(([args]) => (args as { pageSize?: number }).pageSize === 200)).toHaveLength(500)
  expect(created).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'CSVで書き出す' }) as HTMLButtonElement).disabled).toBe(false)
})
