import type { LinkedAccountCounts } from './musubo-pricing.js';

export type SnsSlotBilling =
  | { kind: 'trialing' }
  | { kind: 'paid'; monthlyDaysRemaining: number; monthlyDaysInPeriod: number };

export type SnsGoogleConnectionState =
  | 'connected'
  | 'expired'
  | 'no_permission';

export interface SnsGoogleConnectionPort {
  id: string;
  label: string;
  state: SnsGoogleConnectionState;
  version: number;
  isPrimary: boolean;
}

export interface SnsConnectionPorts {
  lineAccountId: string;
  contracted: number;
  counts: LinkedAccountCounts;
  linkedSlots: number;
  billing: SnsSlotBilling | null;
  googleConnections: SnsGoogleConnectionPort[];
  primaryVersion: number;
}

export interface SetSnsGooglePrimaryInput {
  lineAccountId: string;
  connectionId: string;
  expectedVersion: number;
}

export interface SetSnsGooglePrimaryResult {
  connectionId: string;
  version: number;
}
