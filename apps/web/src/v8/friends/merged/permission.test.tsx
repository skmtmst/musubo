// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
const model = vi.hoisted(() => ({ role: 'viewer' as string | null, open: vi.fn(), edit: vi.fn(), unlink: vi.fn(), delivery: vi.fn() }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => model.role }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', loading: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({push: vi.fn(), replace: vi.fn()}), usePathname: () => '/friends', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/components/merged-person/use-merged-person', () => ({ useMergedPerson: () => ({
  phase: 'ready', person: { id: 'p', revision: 1, status: 'active', primaryDisplayName: '花子', profileValues: [], profileCandidates: [], tagCandidates: [], history: [],
    linkedFriends: [{ friendId: 'f', displayName: '花子', lineAccountId: 'a', lineAccountName: '本店', isFollowing: true, linkedAt: '2026-10-01T00:00:00Z', linkMethod: 'operator_review' }],
    deliveryPriorities: [{ friendId: 'f', purpose: 'broadcast', priority: 1, isActive: true }] },
  editing: false, profileEditing: false, profileDraft: {}, profileSaving: false, unlinkTarget: null, unlinkReason: '', unlinking: false, saving: false, saveError: '',
  unlink: vi.fn(), setUnlinkReason: vi.fn(), setProfileDraft: vi.fn(), setProfileEditing: vi.fn(), saveProfile: vi.fn(), save: vi.fn(),
  openProfileEditor: model.open, setEditing: model.edit, setUnlinkTarget: model.unlink, setDeliveryActive: model.delivery,
  setSaveError: vi.fn(), reload: vi.fn(),
}) }))
import Merged from './person'
beforeEach(() => { model.role = 'viewer'; rememberStaffIdentity({ id: 'v', role: 'viewer' } as StaffMember) })
afterEach(() => { cleanup(); forgetStaffIdentity() })
it('閲覧のみでは編集と解除を灰色で残し、何も変更しない', async () => {
  render(<Merged personId="p" onClose={() => {}} />)
  for (const name of ['使う値を編集する', '目的ごとの順位を編集 →', '解除する']) await expectPermissionLocked(screen.getByRole('button', { name }))
  await expectPermissionLocked(screen.getByRole('switch'))
  for (const fn of [model.open, model.edit, model.unlink, model.delivery]) expect(fn).not.toHaveBeenCalled()
})
it('本人未取得では誤った拒否文を出さず、操作を止める', () => {
  model.role = null; forgetStaffIdentity()
  render(<Merged personId="p" onClose={() => {}} />)
  const button = screen.getByRole('button', { name: '使う値を編集する' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.hasAttribute('data-permission-locked')).toBe(false)
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
})
