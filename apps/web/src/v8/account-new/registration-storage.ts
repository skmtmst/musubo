import { ACCOUNT_STYLES, type AccountStyle, type StaffMember } from '@line-crm/shared'

export const PENDING_REGISTRATION_RECEIPT = 'receipt:'
export const REGISTRATION_STYLE_KEY = 'musubo-registration-style'

/** 本人APIで確認できた利用者・統括の保存値だけを読む。共通キーは移行しない。 */
export function registrationStorageKey(base: string, identity: Pick<StaffMember, 'id' | 'tenantId'> | null): string | null {
  if (!identity?.id || !identity.tenantId) return null
  return `${base}:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.id)}`
}

/** 登録時の引き継ぎ選択は本人と登録したアカウントに結び付ける。 */
export function registrationImportChoiceKey(resumeKey: string | null, accountId: string): string | null {
  return resumeKey && accountId ? `${resumeKey}:import:${encodeURIComponent(accountId)}` : null
}


export interface RegistrationPresentation {
  noticeDone?: boolean
  styleOpen?: boolean
  choice?: AccountStyle | ''
  viewing?: AccountStyle
  demoOpen?: boolean
  demoPage?: number
}

export function registrationPresentationKey(resumeKey: string | null, accountId: string): string | null {
  return resumeKey && accountId ? `${resumeKey}:presentation:${encodeURIComponent(accountId)}` : null
}

export function readRegistrationPresentation(key: string | null): RegistrationPresentation {
  try {
    const value = key ? sessionStorage.getItem(key) : null
    if (!value) return {}
    const state = JSON.parse(value) as RegistrationPresentation | null
    return state ? {
      noticeDone: state.noticeDone === true,
      styleOpen: state.styleOpen !== false,
      choice: state.choice && ACCOUNT_STYLES.includes(state.choice) ? state.choice : '',
      viewing: state.viewing && ACCOUNT_STYLES.includes(state.viewing) ? state.viewing : undefined,
      demoOpen: state.demoOpen === true,
      demoPage: Number.isInteger(state.demoPage) ? Math.min(4, Math.max(0, state.demoPage!)) : 0,
    } : {}
  } catch { return {} }
}

export function rememberRegistrationPresentation(key: string | null, change: RegistrationPresentation): void {
  try {
    if (key) sessionStorage.setItem(key, JSON.stringify({ ...readRegistrationPresentation(key), ...change }))
  } catch { /* 操作は続けられる。 */ }
}
