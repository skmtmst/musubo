import { describe, expect, it } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { matchStaffMember, scopeBundleToStaffRole, staffActionPolicy } from '@/v8/settings/staff/staff-actions'

function member(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'user-1',
    name: '見本 141',
    email: null,
    role: 'staff',
    lineLinked: false,
    twoFactorEnabled: false,
    isActive: true,
    permissionKeys: [],
    notificationPreferences: {},
    inviteStatus: 'active',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    assignedLineAccountId: null,
    canAccessDescendantAccounts: false,
    ...overrides,
  }
}

describe('ログインユーザーの危険操作', () => {
  it('自分自身を無効化できない理由を返す', () => {
    const policy = staffActionPolicy({
      member: member({ id: 'me', role: 'admin' }),
      currentUserId: 'me',
      administrator: true,
      activeAdministratorCount: 2,
    })
    expect(policy.statusBlockedReason).toContain('自分自身')
  })

  it('最後の管理者は無効化を押せない', () => {
    const policy = staffActionPolicy({
      member: member({ role: 'admin' }),
      currentUserId: 'another-admin',
      administrator: true,
      activeAdministratorCount: 1,
    })
    expect(policy.statusBlockedReason).toContain('管理者が一人もいなくなります')
  })

  it('閲覧のみの利用者には無効化操作を出さない', () => {
    const policy = staffActionPolicy({
      member: member(),
      currentUserId: 'viewer',
      administrator: false,
      activeAdministratorCount: 1,
    })
    expect(policy.showAccountActions).toBe(false)
  })

})

describe('アクセス表とスタッフ表の名寄せ(#530)', () => {
  const members = [
    member({ id: 'stf-1', name: '見本 110', email: 'sasaki@example.com' }),
    member({ id: 'stf-2', name: '見本 110', email: 'sasaki.2@example.com' }),
  ]

  it('IDが一致すれば名前もメールも見ない', () => {
    expect(matchStaffMember(members, { id: 'stf-2', email: 'other@example.com' })?.id).toBe('stf-2')
  })

  it('IDが無ければメール一致(大文字小文字を区別しない)を優先する', () => {
    expect(matchStaffMember(members, { id: 'unknown', email: 'SASAKI@example.com' })?.id).toBe('stf-1')
  })

  it('同姓同名だけでは結び付けない', () => {
    expect(matchStaffMember(members, { id: 'unknown', email: 'nobody@example.com' })).toBeNull()
    expect(matchStaffMember(members, { id: 'unknown', email: null })).toBeNull()
  })

  it('伏せ字のメール同士では結び付けない', () => {
    expect(matchStaffMember(members, { id: 'unknown', email: 's***@example.com' })).toBeNull()
  })
})

describe('見せる範囲の保存先(#530)', () => {
  it('管理者と閲覧のみはそのまま、運用と受付はスタッフへ寄る', () => {
    expect(scopeBundleToStaffRole('administrator')).toBe('admin')
    expect(scopeBundleToStaffRole('operations')).toBe('staff')
    expect(scopeBundleToStaffRole('reception')).toBe('staff')
    expect(scopeBundleToStaffRole('view_only')).toBe('viewer')
  })
})
