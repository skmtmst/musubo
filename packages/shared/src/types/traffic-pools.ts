// -----------------------------------------------------------------------------
// Traffic Pool — マルチアカウント分散先
// -----------------------------------------------------------------------------

export interface TrafficPool {
  id: string;
  confirmationRevision?: number;
  slug: string;
  name: string;
  activeAccountId: string | null;
  accountName?: string | null;
  liffId?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PoolAccount {
  id: string;
  poolId: string;
  lineAccountId: string;
  accountName?: string | null;
  liffId?: string | null;
  isActive: boolean;
  createdAt: string;
}

/** プールを1回の保存で全所属とともに作る。旧1所属の入力も有効。 */
export interface CreateTrafficPoolRequest {
  slug: string;
  name: string;
  activeAccountId: string;
  accountIds?: string[];
}
