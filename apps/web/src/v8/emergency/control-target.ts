'use client'

import { useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { effectiveStaffRole, useStaffIdentity } from '@/lib/staff-role'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import type { LineAccount, StaffMember } from '@line-crm/shared'

function validAccountId(account: Pick<LineAccount, 'id'> | null | undefined): string | null {
  return account && typeof account.id === 'string' && account.id.trim().length > 0 ? account.id : null
}

/** 管理者の最初の読取を、許可一覧にある単一アカウントへ向ける。 */
export function initialEmergencyTarget(role: StaffMember['role'] | null, selectedId: string | null, accounts: Pick<LineAccount, 'id'>[]): string {
  if (!role) return ''
  if (role === 'owner') return 'all'
  if (!Array.isArray(accounts)) return ''
  const selected = typeof selectedId === 'string' && selectedId.trim().length > 0 ? selectedId : null
  if (selected) {
    const matched = accounts.find((account) => validAccountId(account) === selected)
    if (matched) return matched.id
  }
  for (const account of accounts) {
    const id = validAccountId(account)
    if (id) return id
  }
  return ''
}

export function useEmergencyTarget(accounts: LineAccount[]) {
  const safeAccounts = Array.isArray(accounts) ? accounts : []
  const identity = useStaffIdentity()
  const role = effectiveStaffRole(identity)
  const { selectedAccountId, loading } = useAccount()
  const defaultTargetAccountId = initialEmergencyTarget(role, selectedAccountId, safeAccounts)
  const [requested, setRequested] = useState<string | null>(null)
  const targetAccountId = requested && (requested === 'all' ? role === 'owner' : safeAccounts.some(account => validAccountId(account) === requested)) ? requested : defaultTargetAccountId
  const canReadTarget = identity !== null && !loading && Boolean(targetAccountId)
  const selectTarget = (value: string) => {
    const validValue = typeof value === 'string' && value.trim().length > 0 ? value : ''
    if (!validValue || !readStaffIdentity() || loading || (validValue === 'all' ? effectiveStaffRole(readStaffIdentity()) !== 'owner' : !safeAccounts.some(account => validAccountId(account) === validValue))) return false
    setRequested(validValue)
    return true
  }
  return { defaultTargetAccountId, targetAccountId, canReadTarget, selectTarget, role }
}
