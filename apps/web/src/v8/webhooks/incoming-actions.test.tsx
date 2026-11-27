// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { IncomingWebhookDetail } from '@/lib/api'
const mocks = vi.hoisted(() => ({ resources: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonActions: { ...actual.api.commonActions, resources: mocks.resources }, webhooks: { ...actual.api.webhooks, incoming: { ...actual.api.webhooks.incoming, saveConfig: mocks.save } } } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
import IncomingActions from './incoming-actions'
const identity = { methods: [{ kind: 'harness_friend_id' as const, path: 'customer.id' }], onNotFound: 'unmatched_box' as const }
const detail = { id: 'hook-1', version: 7, identityMatching: identity, actions: [{ refKind: 'tag', refId: 'tag-old', refVersionId: null, displayName: '前のタグ' }] } as IncomingWebhookDetail
const resources = { tags: [{ id: 'tag-new', name: '新しいタグ' }], templates: [], scenarios: [], webhooks: [], richMenus: [], commonActions: [], supportMarks: [] }
const saved = vi.fn()
beforeEach(() => verifiedStaffRole('owner'))
afterEach(() => { cleanup(); vi.resetAllMocks() })
async function addTag() {
  await waitFor(() => expect(mocks.resources).toHaveBeenCalledWith('owner-account'))
  fireEvent.click(screen.getByRole('button', { name: '行うことを足す' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /タグを付ける/ }))
  const dialog = screen.getByRole('dialog', { name: 'タグを付ける対象を選ぶ' })
  fireEvent.click(within(dialog).getByRole('radio', { name: '新しいタグ' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
}
it('版と照合設定を保ち、確定した対象を順番どおり保存する', async () => {
  mocks.resources.mockResolvedValue({ success: true, data: resources }); mocks.save.mockResolvedValue({ success: true })
  render(<IncomingActions detail={detail} accountId="owner-account" readOnly={false} onSaved={saved} onGuardReady={() => {}} />)
  await addTag()
  fireEvent.click(screen.getByRole('button', { name: '行うことを保存する' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  expect(mocks.save).toHaveBeenCalledWith('hook-1', 'owner-account', { expectedVersion: 7, identityMatching: identity, actions: [
    { refKind: 'tag', refId: 'tag-old', refVersionId: null }, { refKind: 'tag', refId: 'tag-new', refVersionId: null },
  ] })
})
it('保存失敗でも追加した行を残し、再試行できる', async () => {
  mocks.resources.mockResolvedValue({ success: true, data: resources }); mocks.save.mockRejectedValueOnce(new Error('通信に失敗しました')).mockResolvedValue({ success: true })
  render(<IncomingActions detail={detail} accountId="owner-account" readOnly={false} onSaved={saved} onGuardReady={() => {}} />)
  await addTag(); fireEvent.click(screen.getByRole('button', { name: '行うことを保存する' }))
  await screen.findByText('通信に失敗しました')
  expect(screen.getByRole('button', { name: '新しいタグ' })).toBeTruthy(); expect(saved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '行うことを保存する' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1)); expect(mocks.save).toHaveBeenCalledTimes(2)
})
it('閲覧だけの人には変更を理由付きで残し、保存しない', () => {
  verifiedStaffRole('viewer')
  render(<IncomingActions detail={detail} accountId="owner-account" readOnly onSaved={saved} onGuardReady={() => {}} />)
  expect(screen.getByText('前のタグ')).toBeTruthy(); expect(screen.getByRole('button', { name: '行うことを足す' }).getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '行うことを足す' }))
  expect(mocks.save).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '行うことを保存する' })).toBeNull(); expect(mocks.resources).not.toHaveBeenCalled()
})
it('未変更の間は保存を出さず、変更すると保存を出して押せる', async () => {
  mocks.resources.mockResolvedValue({ success: true, data: resources })
  render(<IncomingActions detail={detail} accountId="owner-account" readOnly={false} onSaved={saved} onGuardReady={() => {}} />)
  expect(screen.queryByRole('button', { name: '行うことを保存する' })).toBeNull()
  expect(mocks.save).not.toHaveBeenCalled()
  await addTag()
  const button = screen.getByRole('button', { name: '行うことを保存する' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
})

it('既存のオートメーション参照を日本語で示し、別の行を追加しても保存する参照は変えない', async () => {
  mocks.resources.mockResolvedValue({ success: true, data: resources }); mocks.save.mockResolvedValue({ success: true })
  const legacy = { ...detail, actions: [{ refKind: 'automation', refId: 'automation-existing', refVersionId: null, displayName: '申込後の案内' }] } as IncomingWebhookDetail
  render(<IncomingActions detail={legacy} accountId="owner-account" readOnly={false} onSaved={saved} onGuardReady={() => {}} />)
  expect(screen.getByText('オートメーションを動かす')).toBeTruthy()
  await addTag()
  fireEvent.click(screen.getByRole('button', { name: '行うことを保存する' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  expect(mocks.save.mock.calls[0][2].actions[0]).toEqual({ refKind: 'automation', refId: 'automation-existing', refVersionId: null })
})
