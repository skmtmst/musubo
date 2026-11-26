// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const model = vi.hoisted(() => ({ download: vi.fn(), created: false, locked: false, expires: '2030-01-01T00:00:00Z', status: 'completed' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/friends/migrations', useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams() }))
vi.mock('./use-friend-migrations', () => ({
  MANAGE_FORBIDDEN: '管理者だけが操作できます', JOB_STATUS_LABELS: { completed: '反映ずみ' }, formatImportBytes: () => '',
  useFriendMigrations: () => ({ status: 'ready', summary: null, file: null, importId: null, message: '', exportResult: model.created ? { id: 'new-export', rowCount: 2, downloadUrl: '/unused' } : null, busy: false,
    jobs: [{ id: 'export/1', kind: 'export', status: model.status, created_at: '2026-01-01T00:00:00Z', created_by_name: '担当', row_count: 2, expires_at: model.expires }],
    accounts: [], columns: ['basic'], accountId: 'acc', manageLocked: model.locked, downloadExport: model.download, setAccountId: vi.fn(), toggleColumn: vi.fn(), createExport: vi.fn(), onPickFile: vi.fn(), previewImport: vi.fn(), cancelImport: vi.fn(), executeImport: vi.fn(), load: vi.fn(),
  }),
}))
import Csv from './csv'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import type { StaffMember } from '@line-crm/shared'
afterEach(() => { cleanup(); forgetStaffIdentity() })
beforeEach(() => { rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember); model.download.mockClear(); model.created = false; model.locked = false; model.expires = '2030-01-01T00:00:00Z'; model.status = 'completed' })
test.each(['constructor', 'toString', '__proto__', 'new_status'])('未知の状態 %s は確認中と表示しCSVを保存させない', (status) => {
  model.status = status
  render(<Csv />)
  expect(screen.getByText('確認中')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'CSVで書き出す', exact: true })).toBeNull()
})
test('未知の状態は履歴を書き出したCSVでも確認中になる', async () => {
  model.status = 'constructor'
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    render(<Csv />)
    fireEvent.click(screen.getByRole('button', { name: '表示中をCSVで書き出す' }))
    const blob = create.mock.calls[0]?.[0] as Blob
    expect(await blob.text()).toContain('確認中')
    expect(await blob.text()).not.toContain('function Object')
  } finally { create.mockRestore(); revoke.mockRestore(); click.mockRestore() }
})
test('期限内の完成済みCSVは既存のダウンロード先を開く', () => {
  render(<Csv />)
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す', exact: true }))
  expect(model.download).toHaveBeenCalledWith('export/1')
})
test('期限切れの履歴にはダウンロードの操作を出さない', () => {
  model.expires = '2000-01-01T00:00:00Z'
  render(<Csv />)
  expect(screen.queryByRole('button', { name: 'CSVで書き出す', exact: true })).toBeNull()
})
test('閲覧者は履歴を読め、管理操作は灰色と理由で残して起動しない', async () => {
  model.locked = true
  render(<Csv />)
  expect(screen.getByText('反映ずみ')).toBeTruthy()
  for (const name of ['CSVで書き出す', '書き出しを作る', 'まず確認だけする']) await expectPermissionLocked(screen.getByRole('button', { name, exact: true }))
  expect(model.download).not.toHaveBeenCalled()
})

test('先に作ったCSVの保存も閲覧者では理由付きで起動しない', async () => {
  model.created = true
  model.locked = true
  render(<Csv />)
  for (const button of screen.getAllByRole('button', { name: /^CSVで書き出す/ })) await expectPermissionLocked(button)
  expect(model.download).not.toHaveBeenCalled()
})
test('書き出し直後の保存も同じ認証付き操作へ渡す', () => {
  model.created = true
  render(<Csv />)
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す（2件）' }))
  expect(model.download).toHaveBeenCalledWith('new-export')
})


test('CSVを追加する欄をキー操作でき、閲覧者はファイルを追加できない', () => {
  const { rerender } = render(<Csv />)
  const zone = screen.getByRole('button', { name: 'CSVを追加', exact: true })
  expect(zone.querySelector('button')).toBeNull()
  const input = zone.querySelector('input')!; const opened = vi.fn(); input.addEventListener('click', opened)
  fireEvent.keyDown(zone, { key: 'Enter' }); expect(opened).toHaveBeenCalledTimes(1)
  model.locked = true; rerender(<Csv />)
  fireEvent.keyDown(zone, { key: 'Enter' }); expect(opened).toHaveBeenCalledTimes(1)
  expect(zone.getAttribute('aria-disabled')).toBe('true')
})

test('本人未取得では拒否理由を決めつけず、管理操作を止める', () => {
  forgetStaffIdentity(); model.locked = true
  render(<Csv />)
  const button = screen.getByRole('button', { name: '書き出しを作る' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.hasAttribute('data-permission-locked')).toBe(false)
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
  fireEvent.click(button)
  expect(model.download).not.toHaveBeenCalled()
})
