/**
 * フォーム送信の再送判定表。
 *
 * サーバの応答から、利用者の次の操作を1つに決める。安全側の決めごと:
 *
 * - 内容違い・期限切れの 409 は、自動で新しいキーに付け替えない。
 *   付け替えは「別の回答として送り直す」など、利用者の明示の操作の
 *   ときだけ行う(自動変換は二重回答・二重特典を作れる)。
 * - 未完の 202 は、同じキーで送り直す(新しい回答は作らない)。
 * - 元のキーへの誘導(recovery_pending)は、新しい回答を作らない再開なの
 *   で付け替えて続ける。
 */
export interface FormSubmitAttempt {
  status: number;
  body: {
    success?: boolean;
    error?: string;
    code?: string;
    data?: { complete?: boolean };
    retryable?: boolean;
    idempotencyKey?: string;
  } | null;
}

export type FormSubmitDecision =
  /** 終わった。 */
  | { action: 'done' }
  /** 未完なので、同じキーで送り直す。 */
  | { action: 'poll-same' }
  /** 元のキーでの再開へ誘導されたので、付けて続ける。 */
  | { action: 'adopt-key'; key: string }
  /** 内容違い・期限切れ。自動では送り直さず、利用者の操作を待つ。 */
  | { action: 'conflict'; code: 'idempotency_content_mismatch' | 'idempotency_expired' }
  /** 処理中。待って同じキーで送り直す。 */
  | { action: 'busy' }
  /** 打ち止め。利用者に文言を出す。 */
  | { action: 'fail'; message: string };

export const FORM_SUBMIT_INCOMPLETE_MESSAGE =
  '送信を受け付けましたが、一部の処理が終わっていません。時間をおいて送り直してください。';

export function conflictMessage(code: 'idempotency_content_mismatch' | 'idempotency_expired'): string {
  return code === 'idempotency_expired'
    ? '送信の有効期限が切れました。もう一度送る場合は下のボタンから送り直してください。'
    : '送信済みの内容と異なるため、そのままでは送れません。別の回答として送る場合は下のボタンから送り直してください。';
}

export function decideFormSubmitStep(attempt: FormSubmitAttempt): FormSubmitDecision {
  const { status, body } = attempt;
  if (status === 200 || status === 201) {
    if (body?.success !== true) return { action: 'fail', message: '送信結果を確認できませんでした。' };
    if (body.data?.complete === false) return { action: 'fail', message: FORM_SUBMIT_INCOMPLETE_MESSAGE };
    return { action: 'done' };
  }
  if (status === 202) {
    if (body?.retryable) return { action: 'poll-same' };
    return { action: 'fail', message: FORM_SUBMIT_INCOMPLETE_MESSAGE };
  }
  const code = body?.code;
  if (status === 429 || code === 'idempotent_in_progress') return { action: 'busy' };
  if (status === 409 && (code === 'idempotency_content_mismatch' || code === 'idempotency_expired')) {
    return { action: 'conflict', code };
  }
  if (
    status === 409
    && code === 'idempotency_recovery_pending'
    && typeof body?.idempotencyKey === 'string'
    && body.idempotencyKey !== ''
  ) {
    return { action: 'adopt-key', key: body.idempotencyKey };
  }
  return {
    action: 'fail',
    message: body?.error || `送信に失敗しました(${status})。もう一度お試しください。`,
  };
}
