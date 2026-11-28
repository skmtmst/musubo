// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import type { ApiBroadcast } from '@/lib/api'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { useBroadcastFolderSelection } from './folder-selection'

const owner = { id: 'owner-a', role: 'owner', name: 'オーナー', permissionKeys: [] } as unknown as StaffMember
const storeRow = { id: 'bc-store', title: '店の配信', version: 1, status: 'draft' } as ApiBroadcast
const hqRow = { id: 'bc-hq', title: '本部配信', version: 1, status: 'draft', fromHeadquarters: true } as unknown as ApiBroadcast
const folders = [{ id: 'f1', name: '分類A', kind: 'broadcast' as const, color: null }]

function Harness({ broadcasts }: { broadcasts: ApiBroadcast[] }) {
  const selection = useBroadcastFolderSelection({
    accountId: 'account-a',
    canEdit: true,
    broadcasts,
    folders,
    onChanged: vi.fn(async () => {}),
  })
  return (
    <>
      {selection.pageCheckbox}
      {Array.isArray(broadcasts) ? broadcasts.map((row, index) => (
        <div key={row?.id ?? index}>{selection.checkbox(row)}</div>
      )) : null}
    </>
  )
}

beforeEach(() => {
  rememberStaffIdentity(owner)
})

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
})

describe('useBroadcastFolderSelection defensive guards', () => {
  it('excludes headquarters broadcasts and null entries from folder move checkboxes', () => {
    render(<Harness broadcasts={[hqRow, null as unknown as ApiBroadcast, storeRow]} />)
    expect(screen.queryByLabelText('本部配信を選ぶ')).toBeNull()
    expect(screen.getByLabelText('店の配信を選ぶ')).toBeTruthy()
  })

  it('hides pageCheckbox when only headquarters broadcasts or non-array broadcasts are passed', () => {
    const { container, rerender } = render(<Harness broadcasts={[hqRow]} />)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

    rerender(<Harness broadcasts={null as unknown as ApiBroadcast[]} />)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })
})
