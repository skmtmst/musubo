import { permissionForApiPath } from './auth/permissions/auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 統括の担当者が行えない管理操作。画面を経由しないAPI要求にも適用する。 */
export function isHqAdministratorOperation(method: string, path: string, staffId: string): boolean {
  const verb = method.toUpperCase();
  if (path.startsWith('/api/ops/')) return true;
  if (SAFE_METHODS.has(verb)) return false;
  if (path === '/api/staff' || path.startsWith('/api/staff/')) {
    if (verb === 'PATCH' && path === `/api/staff/${staffId}`) return false;
    if (/^\/api\/staff\/[^/]+\/two-factor(?:\/|$)/.test(path) && path.split('/')[3] === staffId) return false;
    return true;
  }
  if (path === '/api/access' || path.startsWith('/api/access/')) return true;
  if (path === '/api/hq/billing' || path.startsWith('/api/hq/billing/')) return true;
  if (path.startsWith('/api/integrations/stripe/')) return true;
  if (/^\/api\/booking\/admin\/(?:payment-connection|payment-config|payment|payments|payment-events|menu-payments|pass-plans|pass-payments|cancellation-policy|deposit)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/booking\/admin\/menus\/[^/]+\/payment(?:\/|$)/.test(path)) return true;
  if (/^\/api\/events\/admin\/events\/[^/]+\/payment(?:\/|$)/.test(path)) return true;
  if (/^\/api\/restaurant-test\/menus\/[^/]+\/payment(?:\/|$)/.test(path)) return true;
  if (/^\/api\/booking\/admin\/bookings\/[^/]+\/charges(?:\/|$)/.test(path)) return true;
  if (/^\/api\/booking\/(?:admin\/charges\/[^/]+\/(?:refund|waive)|payments\/[^/]+\/refund)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/booking\/payments\/[^/]+\/booking(?:\/|$)/.test(path)) return true;
  if (/^\/api\/booking\/admin\/payment-events\/[^/]+\/replay$/.test(path)) return true;
  if (path === '/api/affiliate-payments' || path.startsWith('/api/affiliate-payments/')) return true;
  if (path === '/api/affiliate-payout-batches' || path.startsWith('/api/affiliate-payout-batches/')) return true;
  return false;
}

/** 担当者の業務範囲。既存の店舗別権限表と統括の業務APIに限定する。 */
export function isHqBusinessOperation(method: string, path: string, staffId: string): boolean {
  if (isHqAdministratorOperation(method, path, staffId)) return false;
  if (permissionForApiPath(path)) return true;
  if (method.toUpperCase() === 'GET' && (path === '/api/staff' || path.startsWith('/api/staff/'))) return true;
  return ['/api/hq/', '/api/restaurant-test/', '/api/line-accounts/', '/api/accounts/', '/api/integrations/', '/api/mcp-connections', '/api/settings/company']
    .some((prefix) => path.startsWith(prefix));
}
