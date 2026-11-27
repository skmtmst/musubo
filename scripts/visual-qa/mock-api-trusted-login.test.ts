import { describe, expect, it } from 'vitest'
import { trustedLoginAuthRead } from './mock-api-trusted-login.mjs'
import { VISUAL_QA_PASSKEYS } from './mock-small-responses.mjs'

describe('認証設定の偽 API', () => {
  it('信頼済みログインと既存の認証設定を同じ形で返す', () => {
    expect(trustedLoginAuthRead('GET', '/api/auth/trusted-logins')).toEqual({ success: true, data: [] })
    expect(trustedLoginAuthRead('GET', '/api/auth/two-factor/policy')).toEqual({ success: true, data: { required: true, canEdit: true, configured: true, notice: null, registered: 4, total: 6 } })
    expect(trustedLoginAuthRead('GET', '/api/auth/two-factor/self')).toEqual({ success: true, data: { staffId: 'visual-qa-owner', enabledAt: '2026-10-12T03:00:00Z', remaining: 8, total: 8, canEdit: true, configured: true, notice: null } })
    expect(trustedLoginAuthRead('GET', '/api/auth/passkeys/self')).toEqual({ success: true, data: VISUAL_QA_PASSKEYS })
  })
  it('別の要求は呼び出し元へ渡す', () => {
    expect(trustedLoginAuthRead('POST', '/api/auth/trusted-logins')).toBeNull()
    expect(trustedLoginAuthRead('GET', '/api/auth/session')).toBeNull()
  })
})
