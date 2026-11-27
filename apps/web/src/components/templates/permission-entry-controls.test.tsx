// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { api } from '@/lib/api'
import type { Folder } from '@line-crm/shared'
import EmptyList from '@/components/shared/empty-list'
import FolderPanel from '@/components/shared/folder-panel'
import ManagedFolderPanel from '@/components/shared/managed-folder-panel'
import { LockedCreatePage } from './locked-create-page'
import { BookingPage } from './booking-page'

afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.restoreAllMocks() })
const readProxy = () => act(() => rememberSessionSnapshot({ impersonation: { id: 'session', tenantId: 'tenant', mode: 'read', piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' }))
const folder: Folder = { id: 'folder', kind: 'scenario', name: '対象', parentId: null, displayOrder: 0, color: null, createdAt: '', updatedAt: '', itemCount: 2 }

it('空一覧の作成は閲覧者にも残し、移動と実行を止める', () => {
  verifiedStaffRole('viewer')
  const create = vi.fn()
  render(<EmptyList icon={null} title="まだありません" description="一覧です" canCreate={false} create={{ label: '作る', href: '/tags/new', onClick: create }} />)
  const button = screen.getByRole('button', { name: '作る' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('href')).toBe(false)
  fireEvent.click(button)
  fireEvent.pointerDown(button, { pointerType: 'touch' })
  expect(screen.getByRole('tooltip').textContent).toContain('閲覧のみ')
  expect(create).not.toHaveBeenCalled()
})

it('空一覧の許可trueでもread代理の作成は止め、通常ownerの作成は残す', () => {
  verifiedStaffRole('owner')
  const create = vi.fn()
  const element = <EmptyList icon={null} title="まだありません" description="一覧です" canCreate create={{ label: '作る', onClick: create }} />
  const { rerender } = render(element)
  fireEvent.click(screen.getByRole('button', { name: '作る' }))
  expect(create).toHaveBeenCalledTimes(1)
  readProxy()
  rerender(<EmptyList icon={null} title="まだありません" description="一覧です" canCreate create={{ label: '作る', onClick: create }} />)
  fireEvent.click(screen.getByRole('button', { name: '作る' }))
  expect(screen.getByRole('button', { name: '作る' }).getAttribute('aria-disabled')).toBe('true')
  expect(create).toHaveBeenCalledTimes(1)
})

it('read代理でも空一覧の絞り込み解除は動き、作成へ置き換わらない', () => {
  verifiedStaffRole('owner'); readProxy()
  const clear = vi.fn(), create = vi.fn()
  render(<EmptyList icon={null} title="まだありません" description="一覧です" canCreate={false} filtered onClearFilters={clear} create={{ label: '作る', onClick: create }} />)
  fireEvent.click(screen.getByRole('button', { name: '条件を外す' }))
  expect(clear).toHaveBeenCalledTimes(1)
  expect(create).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '作る' })).toBeNull()
})

it.each(['create', 'edit'] as const)('閲覧専用の%s案内は戻る入口を残し、入力や保存を始めない', mode => {
  render(<LockedCreatePage title="対象" mode={mode} scope="hq" backHref="/hq" backLabel="一覧へ" />)
  expect(screen.getByText(mode === 'create' ? '閲覧のみのため、ここでは作れません' : '閲覧のみのため、ここでは変えられません')).toBeTruthy()
  expect(screen.getByText(/統括の管理者に頼んでください/)).toBeTruthy()
  expect(screen.getByRole('link', { name: /一覧へ/ }).getAttribute('href')).toBe('/hq')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /保存/ })).toBeNull()
})

it.each([false, true])('予約の型はaside=%sでも権限帯を一度だけ題の下へ出す', aside => {
  verifiedStaffRole('viewer')
  const { container } = render(<BookingPage title="予約" readOnly aside={aside ? <span>次の予約</span> : undefined}><p>一覧</p></BookingPage>)
  expect(container.querySelectorAll('[data-read-only-notice]').length).toBe(1)
  expect(container.querySelector('[data-read-only-notice]')?.textContent).toContain('閲覧のみ')
  expect(screen.getByText('一覧')).toBeTruthy()
})

it('フォルダのロックは選ぶ操作を保ち、追加をマウスとキーで起動しない', () => {
  const add = vi.fn(), select = vi.fn()
  render(<FolderPanel rows={[{ id: 'all', label: 'すべて', kind: 'all', count: 1 }]} activeId="all" onSelect={select} onAddFolder={add} addFolderLockedReason="閲覧のみです" />)
  const button = screen.getByRole('button', { name: 'フォルダを追加する' })
  expect((button as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(button)
  expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'すべて 1' }))
  expect(select).toHaveBeenCalledWith('all')
  expect(add).not.toHaveBeenCalled()
})

it('選択専用のフォルダは編集の入口を出さず、行を選べる', () => {
  const select = vi.fn()
  render(<FolderPanel readOnly rows={[{ id: 'all', label: 'すべて', count: 1 }]} activeId="all" onSelect={select} onAddFolder={vi.fn()} addFolderLockedReason="閲覧のみです" />)
  expect(screen.queryByRole('button', { name: 'フォルダを追加する' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'すべて 1' }))
  expect(select).toHaveBeenCalledWith('all')
})

it.each(['read', 'unknown'] as const)('%sのフォルダ管理は追加・削除・並替APIを呼ばない', async state => {
  const create = vi.spyOn(api.folders, 'create').mockRejectedValue(new Error('unexpected create'))
  const remove = vi.spyOn(api.folders, 'delete').mockRejectedValue(new Error('unexpected delete'))
  const swap = vi.spyOn(api.folders, 'swapOrder').mockRejectedValue(new Error('unexpected swap'))
  if (state === 'read') { verifiedStaffRole('owner'); readProxy() } else verifiedStaffRole(null)
  render(<ManagedFolderPanel kind="scenario" folders={[folder]} activeId="folder" onSelect={vi.fn()} onChanged={vi.fn()} canManage={state === 'read'} lockedReason={state === 'unknown' ? null : undefined} itemLabel="対象" />)
  const button = screen.getByRole('button', { name: 'フォルダを追加' }) as HTMLButtonElement
  expect(button.disabled).toBe(state === 'unknown')
  expect(button.hasAttribute('data-permission-locked')).toBe(state === 'read')
  fireEvent.click(button)
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ「対象」の操作' }))
  const edit = await screen.findByRole('menuitem', { name: '名前を変更する' })
  expect(edit.getAttribute('aria-disabled')).toBe(state === 'read' ? 'true' : null)
  expect((edit as HTMLButtonElement).disabled).toBe(state === 'unknown')
  fireEvent.click(edit)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(create).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(swap).not.toHaveBeenCalled()
})
