import { api } from './api'
import { ApiError } from './api/transport/errors'
import { readStaffIdentity } from './staff-identity-state'
import { canManageRole } from './staff-role'
import { PENDING_REGISTRATION_RECEIPT, REGISTRATION_STYLE_KEY, registrationStorageKey } from '@/v8/account-new/public/registration-storage'

let readyAccountId: string | null = null
const entryListeners = new Set<() => void>()

export function isLineAccountEntryReady(accountId: string | null): boolean {
  return accountId !== null && readyAccountId === accountId
}

export function subscribeLineAccountEntry(listener: () => void): () => void {
  entryListeners.add(listener)
  return () => { entryListeners.delete(listener) }
}

/** The dashboard can only start its guide while its verified account entry is mounted. */
export function markLineAccountEntryReady(accountId: string): () => void {
  readyAccountId = accountId
  entryListeners.forEach(listener => listener())
  return () => {
    if (readyAccountId !== accountId) return
    readyAccountId = null
    entryListeners.forEach(listener => listener())
  }
}

type LineAccountEntry =
  | { destination: 'dashboard' | 'unavailable' }
  | { destination: 'registration' | 'handover' | 'billing'; href: string }

export function savedLineRegistrationAccount(): string | null {
  const staff = readStaffIdentity()
  if (!staff || staff.accountScope !== 'all' || staff.readOnly || staff.roleBundle === 'view_only'
      || !canManageRole(staff.role)) return null
  const key = registrationStorageKey(REGISTRATION_STYLE_KEY, staff)
  try {
    const saved = key ? sessionStorage.getItem(key) : null
    return saved?.startsWith(PENDING_REGISTRATION_RECEIPT) ? saved.slice(PENDING_REGISTRATION_RECEIPT.length) || null : saved
  } catch { return null }
}

export async function resolveLineAccountEntry(accountId: string): Promise<LineAccountEntry> {
  try {
    const response = await api.lineAccounts.accountEntry(accountId)
    if (!response.success) throw new Error(response.error)
    const { destination, canResume } = response.data
    const id = encodeURIComponent(accountId)
    if (destination === 'billing') return { destination, href: `/hq/billing/line-addition?accountId=${id}` }
    if (destination === 'registration' || (canResume && savedLineRegistrationAccount() === accountId)) {
      return { destination: 'registration', href: `/accounts/new?resume=${id}` }
    }
    if (destination === 'handover') return { destination, href: `/accounts/new/handover?accountId=${id}` }
    if (destination === 'dashboard' || destination === 'unavailable') return { destination }
    throw new Error('登録の状態を確認できませんでした')
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return { destination: 'unavailable' }
    throw error
  }
}
