/** 共通情報。テンプレートに {{var.shop_hours}} として差し込む */
export interface CommonVar {
  id: string;
  lineAccountId: string | null;
  folderId: string | null;
  name: string;
  varKey: string;
  type: "text" | "url" | "image" | "number" | "long_text" | "date" | "datetime" | "boolean";
  value: string;
  validFrom: string | null;
  validUntil: string | null;
  fallbackValue: string | null;
  expiryBehavior: "stop" | "fallback";
  /** Q: 保存した状態（下書き draft / 使用中 active / 止めた stopped）。 */
  status?: "draft" | "active" | "stopped";
  /** 画面に出す状態。期限切れは時刻から計算した表示用の状態。 */
  state?: "draft" | "active" | "stopped" | "expired";
  stoppedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  nextSchedule?: {
    effectiveFrom: string;
    value: string;
  } | null;
  pendingScheduleCount?: number;
  /** 一覧で確認する、差し込まれている場所の合計。 */
  usageCount?: number;
}

/** 共通情報の日付での切り替え予約 */
export interface CommonVarSchedule {
  id: string;
  varId: string;
  effectiveFrom: string;
  value: string;
  appliedAt: string | null;
}

/** 共通情報を差し込んでいる設定の種類。 */
export type CommonVarUsageKind =
  | "template"
  | "broadcast"
  | "scenario"
  | "reminder"
  | "auto_reply"
  | "form"
  | "automation"
  | "friend_add"
  | "common_action";

/** 共通情報を削除する前に、運用者へ見せる使用先。内部IDは専用項目で返さない。 */
export interface CommonVarDeleteImpactItem {
  kind: CommonVarUsageKind;
  kindLabel: string;
  name: string;
  status: string;
  href: string;
  blocksDeletion: boolean;
  referenceMode?: "live" | "pinned" | "operation" | "unknown";
  referencedVersion?: number | null;
  currentPreview: string;
}

/** 所属を確定できず、名前や本文を安全に見せられない使用先。 */
export interface CommonVarDeleteImpactUnavailableReference {
  kind: CommonVarUsageKind;
  kindLabel: string;
  count: number;
  reason: string;
}

/** 共通情報の削除前確認（GET /api/common-vars/:id/delete-impact）。 */
export interface CommonVarDeleteImpact {
  variable: { id: string; name: string; varKey: string };
  total: number;
  blockingTotal: number;
  historicalTotal: number;
  /**
   * 配信中で、送信開始時に固定した値の写し（スナップショット）を持つ
   * 使用先の件数。共通情報を直しても、その配信は固定済みの値のまま
   * 送られる。
   */
  sendingFixedTotal: number;
  unscopedFormTotal: number;
  canDelete: boolean;
  byKind: Record<CommonVarUsageKind, number>;
  items: CommonVarDeleteImpactItem[];
  unavailableReferences: CommonVarDeleteImpactUnavailableReference[];
  checkedAt: string;
  recommendedAction: "delete" | "review_references";
}

/**
 * 共通情報を**変える前**の1件（POST /api/common-vars/:id/impact-preview）。
 *
 * 削除前の1件に、保存すると何がどう変わるかを足したもの。
 */
export interface CommonVarChangeImpactItem extends CommonVarDeleteImpactItem {
  /** 保存すると変わるか。**送信済みの記録と、送信開始時の値で固定済みの配信中は変わらない。** */
  changesOnSave: boolean;
  /** 差し込みの目印を本文から読み取れたか。読めないと変更後の文を作れない。 */
  previewAvailable: boolean;
  /** 変更後の文。作れないときは `null`。**空文字と混ぜない。** */
  nextPreview: string | null;
  currentCharacterCount: number;
  /** 変更後の文字数。変更後の文を作れないときは `null`。**0と混ぜない。** */
  nextCharacterCount: number | null;
  /** LINEの本文になる使用先だけ上限がある。無いものは `null`。 */
  characterLimit: number | null;
  exceedsCharacterLimit: boolean;
  /** 保存を止める理由。空なら止めない。 */
  errors: string[];
  /** 保存はできるが、目で確かめてほしいこと。 */
  warnings: string[];
}

/** 共通情報の変更前確認（POST /api/common-vars/:id/impact-preview）。 */
export interface CommonVarChangeImpact extends Omit<CommonVarDeleteImpact, "items" | "variable" | "recommendedAction"> {
  variable: { id: string; name: string; varKey: string; currentValue: string; nextValue: string };
  items: CommonVarChangeImpactItem[];
  errorTotal: number;
  warningTotal: number;
  /** 1件でも `errors` があれば保存させない。 */
  canSave: boolean;
  recommendedAction: "fix_errors" | "confirm_changes" | "save";
}
