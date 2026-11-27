import { VISUAL_QA_PASSKEYS } from './mock-small-responses.mjs'

/** 認証設定の読み取り用の見本。該当しない要求は呼び出し元へ戻す。 */
export function trustedLoginAuthRead(method, pathname) {
  if (method === 'GET' && pathname === '/api/auth/trusted-logins') return { success: true, data: [] }
  if (method === 'GET' && pathname === '/api/auth/two-factor/policy') return { success: true, data: { required: true, canEdit: true, configured: true, notice: null, registered: 4, total: 6 } }
  if (method === 'GET' && pathname === '/api/auth/two-factor/self') return { success: true, data: { staffId: 'visual-qa-owner', enabledAt: '2026-10-12T03:00:00Z', remaining: 8, total: 8, canEdit: true, configured: true, notice: null } }
  if (method === 'GET' && pathname === '/api/auth/passkeys/self') return { success: true, data: VISUAL_QA_PASSKEYS }
  return null
}
