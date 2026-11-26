import { fetchApi } from '@/lib/api'

export type FirstMessageStatus =
  | 'ready' | 'identity_required' | 'friend_required' | 'sending_stopped'
  | 'sending' | 'sent' | 'received' | 'busy' | 'connection' | 'unknown' | 'failed'

export type FirstMessageState = {
  status: FirstMessageStatus
  accountName: string | null
  friendUrl: string | null
  retryAt: number | null
  verificationPending: boolean
}

function request<T>(accountId: string, action?: 'identity' | 'send'): Promise<T> {
  const path = '/api/getting-started/first-message' + (action ? '/' + action : '')
  return fetchApi<{ success: true; data: T }>(path + '?' + new URLSearchParams({ account_id: accountId }), {
    accountId,
    method: action ? 'POST' : 'GET',
    cache: 'no-store',
  }).then(result => result.data)
}

export const firstMessageApi = {
  status: (accountId: string) => request<FirstMessageState>(accountId),
  identity: (accountId: string) => request<{ verificationUrl: string | null }>(accountId, 'identity'),
  send: (accountId: string) => request<FirstMessageState>(accountId, 'send'),
}
