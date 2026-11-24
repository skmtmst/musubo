import { readStaffIdentity } from './staff-identity-state'

/** 保存前の案内画面を同じタブで再開する。利用者、LINE、店舗が一致する控えだけを読む。 */
export function guideDraftKey(kind: string, accountId: string | null | undefined, storeId: string | null | undefined): string | null {
  const identity = readStaffIdentity()
  if (!identity?.tenantId || !identity.id || !accountId || !storeId) return null
  return ['musubo-guide-draft', identity.tenantId, identity.id, accountId, storeId, kind].map(encodeURIComponent).join(':')
}

export function readGuideDraft<T>(key: string | null): T | null {
  try {
    const value = key ? sessionStorage.getItem(key) : null
    return value ? JSON.parse(value) as T : null
  } catch { return null }
}

export function writeGuideDraft(key: string | null, value: unknown): void {
  if (!key) return
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
  } catch { /* 控えが使えなくても編集は続けられる。 */ }
}
