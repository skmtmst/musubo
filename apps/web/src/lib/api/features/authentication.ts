import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type { OpsImpersonation } from '../types/ops'
import type { StepUpPurpose } from '../types/access'

export const authenticationMethods = {
  system: {
    health: () =>
      fetchApi<ApiResponse<{ status: 'ok' }>>('/api/health'),
  },
  auth: {
    trustCurrentLogin: (token: string) => fetchApi<ApiResponse<null>>('/api/auth/sessions/trust-current', { method: 'POST', headers: { 'X-Step-Up-Token': token }, body: '{}' }),
    /** 切替後の本人確認方式・代理モードを、使い回さずに確かめ直す。 */
    session: () => fetchApi<ApiResponse<{
      impersonation: OpsImpersonation | null
      unfamiliarAt?: string | null
      stepUpMethod?: 'totp' | 'password' | 'none'
    }>>('/api/auth/session', { cache: 'no-store' }),
    /*
     * 大事な操作の直前再確認（V-1）。2段階認証を使っている人は method 'totp' +
     * 6桁コード、使っていない人は method 'password' + パスワードを送る。
     * 成功したら返ってきた token を X-Step-Up-Token で本操作へ付ける。
     */
    stepUp: (input: { method: 'totp' | 'password'; value: string; purpose: StepUpPurpose }) =>
      fetchApi<ApiResponse<{ token: string; purpose: string; expiresAt: string }>>(
        '/api/auth/step-up',
        {
          method: 'POST',
          body: JSON.stringify(
            input.method === 'totp'
              ? { code: input.value, purpose: input.purpose }
              : { password: input.value, purpose: input.purpose },
          ),
        },
      ),
  },
}
