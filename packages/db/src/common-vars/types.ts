import { type CommonVarUsageKind, type CommonVar } from './record-types.js';


export interface CommonVarVersion {
  id: string;
  common_var_id: string;
  version_no: number;
  name: string;
  value: string;
  memo: string;
  change_reason: string;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface CommonVarUsageImpact {
  total: number;
  /**
   * 過去に送り終わった配信と、送信開始時の値で固定済みの配信中を除き、
   * 削除すると現在の設定が壊れる件数。
   */
  blockingTotal: number;
  /** 送信済みで、共通情報を削除しても過去の配信内容が変わらない件数。 */
  historicalTotal: number;
  /** 配信中で、送信開始時に固定した値の写しがある件数。保存・削除で変わらない。 */
  sendingFixedTotal: number;
  /** LINEアカウントへの所属が無く、名前や本文を安全に返せない古いフォーム。 */
  unscopedFormTotal: number;
  byKind: Record<CommonVarUsageKind, number>;
  items: CommonVarUsageItem[];
}

export interface CommonVarUsageItem {
  source_table: string;
  kind: CommonVarUsageKind;
  source_id: string;
  source_parent_id: string | null;
  source_name: string;
  source_status: string | null;
  source_content: string;
  is_historical: number;
}

export interface CommonVarUsageSummary {
  total: number;
  byKind: Record<CommonVarUsageKind, number>;
}

export interface CommonVarSchedule {
  id: string;
  var_id: string;
  effective_from: string;
  value: string;
  applied_at: string | null;
}

export interface CommonVarExpiryCandidate {
  id: string;
  line_account_id: string;
  name: string;
  var_key: string;
  valid_until: string;
  expiry_notice_14_at: string | null;
  expiry_notice_3_at: string | null;
}

export interface CommonVarReplacementTarget {
  table: string;
  id: string;
  kind: CommonVarUsageKind;
  columns: Record<string, string>;
  originalColumns: Record<string, string>;
  fingerprint: string;
}

export interface CommonVarReplacementPlan {
  source: CommonVar;
  replacement: CommonVar;
  targets: CommonVarReplacementTarget[];
  usageTotal: number;
  replaceableTotal: number;
  blockedTotal: number;
  historicalTotal: number;
  unscopedFormTotal: number;
}

export type ReplacementSource = {
  table: string;
  kind: CommonVarUsageKind;
  columns: string[];
  sql: string;
};
