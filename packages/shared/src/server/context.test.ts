import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentRequestId, createInvocationContext, resumeInvocation, runWithInvocation, traceQueueMessage, withInvocation } from './context.js';
import { tracedFetch } from './fetch.js';
import { logger } from './logger.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('invocation context', () => {
  it('キューの内部メタデータだけを足し、業務キー・本文と旧メッセージを保つ', () => {
    const message = { kind: 'inspect_relay', slackEventId: 'event', threadTs: 'thread' };
    expect(traceQueueMessage(message)).toBe(message);
    withInvocation('http', () => {
      const traced = traceQueueMessage({ ...message, requestId: 'untrusted-customer' });
      expect(traced).toEqual({ ...message, requestId: currentRequestId() });
      expect(JSON.parse(JSON.stringify(traced))).toEqual(traced);
      expect(traced.requestId).not.toBe('untrusted-customer');
      let restored: string | undefined;
      expect(() => { restored = resumeInvocation({ toString: 'untrusted-customer' }, () => currentRequestId()); }).not.toThrow();
      expect(restored).toBe(currentRequestId());
    });
  });
  it('並列の依頼とwaitUntil相当の継続でIDを混ぜない', async () => {
    const rows: Array<[string, string | undefined]> = [];
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const contexts = [createInvocationContext('http'), createInvocationContext('cron')];
    await Promise.all(contexts.map(async (context, i) => runWithInvocation(context, async () => {
      await new Promise(resolve => setTimeout(resolve, i ? 1 : 4));
      rows.push([context.requestId, currentRequestId()]);
      logger.info('invocation.test');
    })));
    expect(rows.every(([expected, actual]) => expected === actual)).toBe(true);
    expect(new Set(log.mock.calls.map(([text]) => JSON.parse(String(text)).requestId)).size).toBe(2);
    expect(currentRequestId()).toBeUndefined();
  });
  it('外部通信のbody・認証・中断・再試行キーを保ってIDを通す', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await withInvocation('cron', async () => {
      const id = currentRequestId();
      await tracedFetch('https://external.invalid/send', { method: 'POST', body: 'unchanged', signal, redirect: 'manual',
        headers: { Authorization: 'Bearer secret', 'X-Line-Retry-Key': 'same-key', 'X-Request-ID': 'untrusted' } });
      const options = fetch.mock.calls[0][1];
      expect(options).toMatchObject({ method: 'POST', body: 'unchanged', signal, redirect: 'manual' });
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer secret');
      expect(new Headers(options.headers).get('X-Line-Retry-Key')).toBe('same-key');
      expect(new Headers(options.headers).get('X-Request-ID')).toBe(id);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('定期処理の固定分類だけを構造フィールドへ残す',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    logger.error('scheduled.job_failed',{scheduledJob:'booking_expirer',failureKind:'type_error'});
    logger.error('scheduled.job_failed',{scheduledJob:'unregistered-job',failureKind:'unregistered-kind'} as never);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({scheduledJob:'booking_expirer',failureKind:'type_error'});
    expect(JSON.parse(String(log.mock.calls[1][0]))).not.toHaveProperty('scheduledJob');
    expect(JSON.parse(String(log.mock.calls[1][0]))).not.toHaveProperty('failureKind');
  });
  it('決済通知のログに許可したイベント種別・処理段階・失敗理由だけを残す', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const billingWebhook = { eventType: 'invoice.paid', stage: 'contract', reason: 'schema_missing' };
    logger.warn('billing_webhook_retry', { status: 503, billingWebhook });
    for (const field of ['eventType', 'stage', 'reason']) {
      logger.warn('billing_webhook_retry', { billingWebhook: { ...billingWebhook, [field]: 'private-customer-data' } });
    }

    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      billingEventType: 'invoice.paid', billingStage: 'contract', billingReason: 'schema_missing', status: 503,
    });
    for (const [line] of log.mock.calls.slice(1)) {
      expect(String(line)).not.toMatch(/billingEventType|billingStage|billingReason|private-customer-data/);
    }
  });
  it('失敗数は数値だけを記録する', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('nen_tag_refresh.friend_failed', { failedCount: 2 });
    logger.error('nen_tag_refresh.friend_failed', { failedCount: 'customer' } as never);
    expect(JSON.parse(String(log.mock.calls[0][0])).failedCount).toBe(2);
    expect(JSON.parse(String(log.mock.calls[1][0]))).not.toHaveProperty('failedCount');
  });
  it('構造化ログに秘密・個人情報・例外や任意の値を混ぜない', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    withInvocation('http', () => logger.error('fixed.failure', {
      status: 500, token: 'do-not-log-secret', email: 'customer@example.invalid',
      error: new Error('D1_ERROR secret'), route: '/person/secret?token=secret',
    } as { status: number }));
    const text = String(log.mock.calls[0][0]);
    expect(JSON.parse(text)).toMatchObject({ level: 'error', code: 'fixed.failure', source: 'http', status: 500, requestId: expect.any(String), timestamp: expect.any(String) });
    expect(text).not.toMatch(/secret|customer|D1_ERROR|\/person/);
  });
});
