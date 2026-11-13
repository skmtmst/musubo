import { StyleError } from '../services/style-setup.js';
import { type Funnel } from '@line-crm/db';

export function serializeFunnel(f: Funnel) {
  return {
    id: f.id,
    name: f.name,
    windowDays: f.window_days,
    createdAt: f.created_at,
    status: f.status,
    confirmationRevision: f.confirmation_revision,
  };
}

export function funnelErrorStatus(error: unknown): 404 | 409 | 422 | 500 {
  if(error instanceof StyleError)return error.status===404?404:error.status===409?409:422;
  const message = error instanceof Error ? error.message : '';
  if (message.endsWith('_not_found')) return 404;
  if (message.endsWith('_conflict')) return 409;
  if (message.startsWith('analytics_funnel_')
      || message.startsWith('analytics_cross_')
      || message.startsWith('analytics_saved_')) return 422;
  return 500;
}
