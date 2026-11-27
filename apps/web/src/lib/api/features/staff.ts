import { fetchPrefetchedRead } from '../transport/prefetch'
import { fetchApi } from '../transport/request'
import type { ApiResponse, StaffMember } from '@line-crm/shared'

export const staffMethods = {
  staff: {
    list: (lineAccountId?: string) =>
      fetchApi<ApiResponse<StaffMember[]>>(`/api/staff${lineAccountId ? `?lineAccountId=${encodeURIComponent(lineAccountId)}` : ''}`),
    get: (id: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`),
    me: () => fetchPrefetchedRead<ApiResponse<StaffMember>>('/api/staff/me'),
    create: (data: { name: string; email: string; role: 'admin' | 'staff' | 'viewer'; permissionKeys?: string[]; notificationPreferences?: Record<string, { email: boolean; line: boolean }>; assignedLineAccountId: string | null; canAccessDescendantAccounts?: boolean; accountScope: 'all' | 'accounts'; scopedLineAccountIds?: string[]; managementContext?: 'hq' }) =>
      fetchApi<ApiResponse<StaffMember>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; email?: string | null; role?: string; isActive?: boolean; lineLinked?: false; permissionKeys?: string[]; notificationPreferences?: Record<string, { email: boolean; line: boolean }>; assignedLineAccountId?: string | null; canAccessDescendantAccounts?: boolean; accountScope?: 'all' | 'accounts'; scopedLineAccountIds?: string[]; managementContext?: 'hq'; roleBundle?: 'administrator' | 'operations' | 'reception' | 'view_only' | 'custom'; permissionScope?: Record<string, 'edit' | 'view' | 'none'>; permissionViewKeys?: string[]; emailMask?: 'full' | 'masked' | 'none'; idempotencyKey?: string; expectedPolicyVersion?: number }, stepUpToken?: string) =>
      /*
       * 本人が自分のメールを変えたとき、emailChangePending=true と pendingEmail
       * が返る（N-433）。その場合メールはまだ切り替わっていない。
       */
      fetchApi<ApiResponse<StaffMember & { emailChangePending?: boolean; pendingEmail?: string | null }>>(`/api/staff/${id}`, {
        method: 'PATCH',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
        body: JSON.stringify(data),
      }),
    /** N-433: メール変更の確認リンクから確定する。トークンは24時間・使い切り。 */
    confirmEmailChange: (token: string) =>
      fetchApi<ApiResponse<{ email: string }>>('/api/staff/email-change/confirm', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    loginSummary: (id: string) =>
      fetchApi<ApiResponse<{ loginCount: number }>>(`/api/staff/${id}/login-summary`),
    /** 権限者ごとの最終ログイン（統括のメンバー管理）。記録が無い人は入らない。 */
    lastLogins: () => fetchApi<ApiResponse<Record<string, string>>>('/api/staff/last-logins'),
    /** 招待メールを送り直す。まだメールを確認していない人だけ。 */
    resendInvite: (id: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${encodeURIComponent(id)}/resend-invite`, { method: 'POST', body: JSON.stringify({}) }),
    delete: (id: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`, {
        method: 'DELETE',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      }),
    /* 直前再確認は api.auth.stepUp に一本化（StepUpPrompt が目的を渡す）。 */
    acceptInvitation: (token: string) =>
      fetchApi<ApiResponse<{ status: 'pending_line' }>>('/api/staff/invitations/confirm/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    beginTwoFactorSetup: (id: string) =>
      fetchApi<ApiResponse<{ provisioningUri: string; manualKey: string }>>(`/api/staff/${id}/two-factor/setup`, { method: 'POST' }),
    confirmTwoFactorSetup: (id: string, code: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}/two-factor/confirm`, { method: 'POST', body: JSON.stringify({ code }) }),
    disableTwoFactor: (id: string, stepUpToken?: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}/two-factor`, {
        method: 'DELETE',
        headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
      }),
  },
  usersGrouped: {
    list: (opts?: {
      q?: string;
      onlyDups?: boolean;
      account?: string;
      memberAccountId?: string;
      /** FRIEND-09: UID連携の絞り込みは全件へかけるサーバー条件。 */
      uid?: 'linked' | 'unlinked';
      page?: number;
      pageSize?: number;
      forceRefresh?: boolean;
      signal?: AbortSignal;
    }) => {
      const p = new URLSearchParams();
      if (opts?.q) p.set('q', opts.q);
      if (opts?.onlyDups) p.set('onlyDups', '1');
      if (opts?.account) p.set('account', opts.account);
      if (opts?.memberAccountId) p.set('memberAccountId', opts.memberAccountId);
      if (opts?.uid) p.set('uid', opts.uid);
      if (opts?.page) p.set('page', String(opts.page));
      if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
      if (opts?.forceRefresh) p.set('refresh', '1');
      const qs = p.toString();
      return fetchApi<ApiResponse<{
        memberAccountId?: string;
        total: number;
        page: number;
        pageSize: number;
        computedAt: string;
        rows: Array<{
          identityKey: string;
          identityKeyKind: 'url_token' | 'uid' | 'solo';
          displayName: string | null;
          pictureUrl: string | null;
          accounts: Array<{
            accountId: string;
            accountName: string;
            lineUserId: string;
            isFollowing: boolean;
            joinedAt: string;
            friendId: string;
          }>;
          xUsername: string | null;
          emails: string[];
          phones: string[];
          lastActivityAt: string;
          isDuplicate: boolean;
        }>;
      }>>(`/api/users-grouped${qs ? `?${qs}` : ''}`, opts?.signal ? { signal: opts.signal } : undefined);
    },
  },
}
