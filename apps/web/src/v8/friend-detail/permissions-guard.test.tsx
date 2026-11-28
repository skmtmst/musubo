// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendField } from '@line-crm/shared'

const useStaffRoleMock = vi.hoisted(() => vi.fn())
const canEditFeatureMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/staff-role', () => ({
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
  useStaffRole: () => useStaffRoleMock(),
}))

vi.mock('@/lib/staff-capability', () => ({
  canEditFeature: (key: string, role: string | null) => canEditFeatureMock(key, role),
}))

import { useFriendDetailPermissions, type FriendDetailPermissions } from './permissions'

let captured: FriendDetailPermissions | null = null

function Probe() {
  captured = useFriendDetailPermissions()
  return null
}

beforeEach(() => {
  vi.resetAllMocks()
  captured = null
})

afterEach(cleanup)

describe('useFriendDetailPermissions canEditField guard', () => {
  it('returns false safely instead of throwing when field is null or undefined for non-managers', () => {
    useStaffRoleMock.mockReturnValue('staff')
    canEditFeatureMock.mockImplementation((key: string) => key === 'attribute.personal_info.edit')
    render(<Probe />)
    expect(captured).not.toBeNull()
    expect(captured!.canEditField(null as unknown as FriendField)).toBe(false)
    expect(captured!.canEditField(undefined as unknown as FriendField)).toBe(false)
    expect(captured!.canEditField({ isPersonal: true } as FriendField)).toBe(true)
    expect(captured!.canEditField({ isPersonal: false } as FriendField)).toBe(false)
  })
})
