import type { StaffMember } from '@line-crm/shared'

export const PENDING_REGISTRATION_RECEIPT = 'receipt:'

/** 本人APIで確認できた利用者・統括の保存値だけを読む。共通キーは移行しない。 */
export function registrationStorageKey(base: string, identity: Pick<StaffMember, 'id' | 'tenantId'> | null): string | null {
  if (!identity?.id || !identity.tenantId) return null
  return `${base}:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.id)}`
}

/** 登録時の引き継ぎ選択は本人と登録したアカウントに結び付ける。 */
export function registrationImportChoiceKey(resumeKey: string | null, accountId: string): string | null {
  return resumeKey && accountId ? `${resumeKey}:import:${encodeURIComponent(accountId)}` : null
}
