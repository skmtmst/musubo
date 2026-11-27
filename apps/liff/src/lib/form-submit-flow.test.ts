import { describe, expect, test } from 'vitest';
import {
  conflictMessage,
  decideFormSubmitStep,
  FORM_SUBMIT_INCOMPLETE_MESSAGE,
} from './form-submit-flow.js';

/**
 * フォーム送信の再送判定表の直接テスト。
 *
 * 命題は1つ: 内容違い・期限切れの 409 を新しい回答として自動で送り直す
 * 経路は存在しない。付け替えは利用者の明示の操作だけが行う。
 */
describe('decideFormSubmitStep', () => {
  test('200/201 は終わり', () => {
    expect(decideFormSubmitStep({ status: 200, body: { success: true } })).toEqual({ action: 'done' });
    expect(decideFormSubmitStep({ status: 201, body: { success: true } })).toEqual({ action: 'done' });
  });

  test('202 は同じキーでの送り直しだけを返す(新しいキーは作らない)', () => {
    expect(decideFormSubmitStep({
      status: 202,
      body: { success: true, data: { complete: false }, retryable: true },
    })).toEqual({ action: 'poll-same' });
    // 送り直し不可の 202 は打ち止め。
    expect(decideFormSubmitStep({ status: 202, body: { success: true } })).toEqual({
      action: 'fail',
      message: FORM_SUBMIT_INCOMPLETE_MESSAGE,
    });
  });

  test('内容違い・期限切れの 409 は利用者の操作待ちにし、自動送り直しにしない', () => {
    for (const code of ['idempotency_content_mismatch', 'idempotency_expired'] as const) {
      const decision = decideFormSubmitStep({ status: 409, body: { success: false, code } });
      expect(decision).toEqual({ action: 'conflict', code });
      // conflict にキーも送り直しも含まれない。
      expect(decision).not.toHaveProperty('key');
      expect(decision).not.toBe({ action: 'poll-same' });
      expect(typeof conflictMessage(code) === 'string' && conflictMessage(code).length > 0).toBe(true);
    }
  });

  test('元のキーへの誘導は、新しい回答を作らない再開として付け替える', () => {
    expect(decideFormSubmitStep({
      status: 409,
      body: { success: false, code: 'idempotency_recovery_pending', retryable: true, idempotencyKey: 'orig-key' },
    })).toEqual({ action: 'adopt-key', key: 'orig-key' });
    // 誘導先がなければ打ち止め(空キーへの付け替えはしない)。
    expect(decideFormSubmitStep({
      status: 409,
      body: { success: false, code: 'idempotency_recovery_pending' },
    })).toMatchObject({ action: 'fail' });
  });

  test('処理中は待って同じキーで送り直す', () => {
    expect(decideFormSubmitStep({ status: 429, body: { success: false, retryable: true } }))
      .toEqual({ action: 'busy' });
    expect(decideFormSubmitStep({ status: 200, body: null })).toMatchObject({ action: 'fail' });
  });

  test('それ以外はサーバの文言で打ち止め', () => {
    expect(decideFormSubmitStep({ status: 400, body: { success: false, error: '締め切りました' } }))
      .toEqual({ action: 'fail', message: '締め切りました' });
    expect(decideFormSubmitStep({ status: 500, body: null }).action).toBe('fail');
  });
});

  test('書類を付けられない時は選び直す案内を画面へ渡す', () => {
    const message = '書類を回答に付けられませんでした。書類をもう一度選んで、送信してください';
    expect(decideFormSubmitStep({ status: 409, body: { success: false, code: 'document_attachment_failed', error: message } })).toEqual({ action: 'fail', message });
  });
