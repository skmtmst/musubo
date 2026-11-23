import type { SecurityAlertsResponse, SecurityAlertReviewResponse, SecurityMonitorStatus } from '@line-crm/shared';
import { fetchApi } from '../../api';

function base(accountId?: string) {
  return accountId === undefined ? '/api/ops/security-alerts' : '/api/operations/security-alerts';
}
function query(accountId?: string) {
  return accountId === undefined ? '' : `?account_id=${encodeURIComponent(accountId)}`;
}

/** Omit accountId only in the platform console; the server enforces platform membership. */
export const securityMonitorApi = {
  retryBilling: (id: string, expectedVersion: number) =>
    fetchApi<{ success: true; data: { status: 'retried' | 'reconciled' } }>(`/api/ops/security-alerts/${encodeURIComponent(id)}/retry-billing`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  /** Staging platform operators only; respects the five-minute lease. */
  runOnce: () => fetchApi<{ success: true; data: { monitor: SecurityMonitorStatus } }>(
    '/api/ops/security-alerts/run-once', { method: 'POST' }),
  list: (accountId?: string, offset = 0) => fetchApi<SecurityAlertsResponse>(`${base(accountId)}${query(accountId)}${accountId === undefined ? '?' : '&'}offset=${offset}`),
  acknowledge: (id: string, expectedVersion: number, accountId?: string) =>
    fetchApi<SecurityAlertReviewResponse>(`${base(accountId)}/${encodeURIComponent(id)}/acknowledge${query(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  resolve: (id: string, expectedVersion: number, accountId?: string) =>
    fetchApi<SecurityAlertReviewResponse>(`${base(accountId)}/${encodeURIComponent(id)}/resolve${query(accountId)}`,
      { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
};
