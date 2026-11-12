// -----------------------------------------------------------------------------
// 受信Webhook (IncomingWebhook)
// -----------------------------------------------------------------------------

export interface IncomingWebhook {
  confirmationRevision?: number;
  folderId?: string | null;
  id: string;
  name: string;
  sourceType: string;
  // The raw secret is never exposed on list/get/update responses. Callers can
  // only know whether one is currently configured.
  hasSecret: boolean;
  // S: while a rotation grace window is open, when the previous secret stops
  // being accepted. Null once the window has passed or there is no previous key.
  previousSecretUsableUntil?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Returned ONLY from POST /api/webhooks/incoming so the operator can copy the
// generated secret. Subsequent GETs use IncomingWebhook (no `secret`).
export interface IncomingWebhookCreated extends Omit<IncomingWebhook, 'hasSecret' | 'updatedAt'> {
  secret: string;
}

// -----------------------------------------------------------------------------
// 送信Webhook (OutgoingWebhook)
// -----------------------------------------------------------------------------

export interface OutgoingWebhook {
  confirmationRevision?: number;
  /** 編集の版。旧サーバーとの互換性のため省略を許す。 */
  version?: number;
  /** 最後に設定を更新した担当のID。記録のない旧行・自動停止はnull。 */
  updatedBy?: string | null;
  folderId?: string | null;
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  hasSecret: boolean;
  isActive: boolean;
  /** 失敗したとき何回まで送り直すか。0 なら送り直さない */
  maxRetries?: number;
  /** 連続して失敗している回数。成功すると 0 に戻る */
  consecutiveFailures?: number;
  /** 最後に失敗した時刻。成功すると null に戻る */
  lastFailedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Returned ONLY from POST /api/webhooks/outgoing.
export interface OutgoingWebhookCreated extends Omit<OutgoingWebhook, 'hasSecret' | 'updatedAt'> {
  secret: string;
}

export type WebhookInteractionDirection = 'outgoing' | 'incoming';

export type WebhookInteractionStatus = 'pending' | 'succeeded' | 'failed' | 'retried';

/**
 * 失敗理由の内部記号。'unknown' は「相手先へ届いたか分からない」失敗で、
 * 無条件の再送をせず、相手先で確かめてから復旧する対象。
 */
export type WebhookInteractionFailureReason =
  | 'connection_failed'
  | 'response_4xx'
  | 'response_429'
  | 'response_5xx'
  | 'processing_failed'
  | 'unknown'
  | 'secret_unavailable';

/**
 * 外部連携の1回分の安全な表示。URL、シークレット、送受信本文は含めない。
 */
export interface WebhookInteraction {
  id: string;
  confirmationRevision?: number;
  webhookRevision?: number | null;
  direction: WebhookInteractionDirection;
  webhookName: string;
  eventType: string;
  triggerSummary: string;
  status: WebhookInteractionStatus;
  responseLabel: string;
  responseStatus: number | null;
  attemptCount: number;
  durationMs: number | null;
  /** 画面に出す日本語の失敗理由。 */
  failureReason: string | null;
  /** 判定に使う失敗理由の記号。'unknown' は送り直し前に相手先での確認を要する。 */
  failureReasonCode: WebhookInteractionFailureReason | null;
  canRetry: boolean;
  /**
   * 送り直せない理由。canRetry=false のとき、なぜ直せないかを
   * 画面へ出せるように返す。
   *   webhook_deleted       送り先が削除された
   *   webhook_inactive      送り先が止められている
   *   auto_retry_scheduled  自動の送り直しが動いている（もう届いている途中）
   *   already_delivered     自動の送り直しですでに届いた
   */
  retryBlockReason:
    | 'webhook_deleted'
    | 'webhook_inactive'
    | 'auto_retry_scheduled'
    | 'already_delivered'
    | null;
  /** 自動の送り直しの次回予定。予定が無いとき null。 */
  autoRetryNextAt: string | null;
  startedAt: string;
  completedAt: string | null;
  retryOfId: string | null;
}

export interface WebhookInteractionSummary {
  total: number;
  outgoing: number;
  incoming: number;
  succeeded: number;
  failed: number;
  /** 失敗のうち「届いたか分からない」件数。まとめて再送の対象外。 */
  resultUnknown: number;
  /** 送信の失敗の総数。受信の失敗と混ぜない。 */
  outgoingFailed: number;
  /** 送信の失敗のうち、今ここからまとめて送り直せる件数。 */
  retryable: number;
  averageDurationMs: number | null;
}

export interface WebhookInteractionList {
  items: WebhookInteraction[];
  total: number;
  page: number;
  limit: number;
  summary: WebhookInteractionSummary;
}

/** 送り先の409応答のdata。ApiError.dataから読み取る。 */
export interface OutgoingWebhookVersionConflict {
  currentVersion: number;
  updatedBy: string | null;
  updatedAt: string;
}
