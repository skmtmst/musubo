import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';

const dbMocks = vi.hoisted(() => ({
  ensureAutoReplyPublishedVersion: vi.fn(),
  isOperationCapabilityStopped: vi.fn(async () => false),
  finishAutoReplyActionRun: vi.fn(),
  getTemplateById: vi.fn(),
  markAutoReplyEvaluationFinished: vi.fn(),
  markAutoReplyEvaluationMatched: vi.fn(),
  markAutoReplyEvaluationSkipped: vi.fn(),
  recordAutoReplyEvaluationDetail: vi.fn(),
  reserveAutoReplyActionRun: vi.fn(),
  reserveAutoReplyEvaluation: vi.fn(),
  recordAutoReplyHit: vi.fn(),
}));

const conditionMocks = vi.hoisted(() => ({
  evaluateAutoReplyConditions: vi.fn(),
}));

const actionMocks = vi.hoisted(() => ({
  runActionRows: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  logOutgoingMessage: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('./auto-reply-conditions.js', () => conditionMocks);
vi.mock('../scenarios/scenario-actions.js', () => actionMocks);
vi.mock('../../services/event-bus.js', () => eventMocks);
vi.mock('../../services/interpolation-context.js', () => ({
  expandSendCommonVars: vi.fn(async (_db:unknown,value:string)=>value),
  resolveInterpolationExtra: vi.fn().mockResolvedValue({}),
  resolveSendInterpolationExtra: vi.fn().mockResolvedValue({}),
  resolveSendCommonVars: vi.fn().mockResolvedValue(undefined),
  contentNeedsFriendFields: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/step-delivery.js', () => ({
  resolveMetadata: vi.fn().mockResolvedValue({}),
  expandVariables: vi.fn((value: string) => value),
  buildMessage: vi.fn(() => ({ type: 'text', text: '返信しました' })),
  messageToLogPayload: vi.fn(() => ({ messageType: 'text', content: '返信しました' })),
}));

import { matchAndReply } from './auto-reply.js';
import { resolveSendInterpolationExtra } from '../../services/interpolation-context.js';

const friend = {
  id: 'friend-1',
  line_user_id: 'U1',
  display_name: '田中さん',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: 'account-1',
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-08-28T10:00:00.000+09:00',
  updated_at: '2026-08-28T10:00:00.000+09:00',
} as never;

function rule(responseType = 'text', actions: unknown[] = []) {
  return {
    id: 'rule-1',
    keyword: '予約',
    match_type: 'contains',
    response_type: responseType,
    response_content: '返信しました',
    template_id: null,
    line_account_id: 'account-1',
    is_active: 1,
    active_from: null,
    active_until: null,
    cooldown_minutes: null,
    skip_when_operator_active: 0,
    priority: 1,
    message_kinds_json: null,
    friend_conditions_json: null,
    folder_id: null,
    display_order: 1,
    actions_json: actions.length > 0 ? JSON.stringify(actions) : null,
    response_weekdays_json: null,
    response_holiday_rule: null,
    once_per_friend: 0,
    keywords_json: null,
    respond_to_all: 0,
    name: '予約問い合わせ',
    keyword_match_mode: 'any',
    created_at: '2026-08-01T00:00:00.000+09:00',
  };
}

function dbWithRules(items: unknown[], unmatched: string|null = null) {
  const statement = {
    bind: vi.fn(),
    all: vi.fn().mockResolvedValue({ results: items }),
    first: vi.fn().mockResolvedValue(unmatched ? {message:unmatched}:null),
    run: vi.fn().mockResolvedValue({meta:{changes:1}}),
  };
  statement.bind.mockReturnValue(statement);
  return { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database;
}

function opts(eventId = 'event-1') {
  return {
    lineAccountId: 'account-1',
    incomingEventId: eventId,
    incomingMessageLogId: 'incoming-log-1',
    occurredAt: '2026-08-28T01:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.reserveAutoReplyEvaluation.mockResolvedValue({
    created: true,
    row: { id: 'evaluation-1', status: 'received', reply_status: 'not_attempted' },
  });
  dbMocks.ensureAutoReplyPublishedVersion.mockResolvedValue({ id: 'version-1' });
  dbMocks.reserveAutoReplyActionRun.mockResolvedValue({ id: 'action-run-1', acquired: true });
  conditionMocks.evaluateAutoReplyConditions.mockResolvedValue({ matches: true, reasonCodes: [] });
  actionMocks.runActionRows.mockResolvedValue({
    executed: 1,
    skippedByCondition: 0,
    skippedByOnce: 0,
    failed: 0,
    skippedIncomplete: 0,
    scenarioTouched: false,
  });
  eventMocks.logOutgoingMessage.mockResolvedValue('outgoing-log-1');
});

describe('自動応答の受信イベント台帳', () => {
  it('イベントの確保が完了するまで返信もヒット記録も始めない', async () => {
    let release!: (value: Awaited<ReturnType<typeof dbMocks.reserveAutoReplyEvaluation>>) => void;
    dbMocks.reserveAutoReplyEvaluation.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const db = dbWithRules([rule()]);
    const replyMessageWithRequestId = vi.fn().mockResolvedValue({ data: {}, requestId: 'line-request-1' });
    const line = { replyMessageWithRequestId } as unknown as LineClient;
    const running = matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    await vi.waitFor(() => expect(dbMocks.reserveAutoReplyEvaluation).toHaveBeenCalledTimes(1));
    expect(replyMessageWithRequestId).not.toHaveBeenCalled();
    expect(dbMocks.recordAutoReplyHit).not.toHaveBeenCalled();
    release({ created: true, row: { id: 'evaluation-1', status: 'received', reply_status: 'not_attempted' } });
    expect(await running).toEqual({ matched: true, replyTokenConsumed: true });
    expect(replyMessageWithRequestId).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAutoReplyHit).toHaveBeenCalledTimes(1);
  });

  it('同じWebhookイベントは返信もアクションも二重実行しない', async () => {
    dbMocks.reserveAutoReplyEvaluation.mockResolvedValue({
      created: false,
      row: { id: 'evaluation-1', status: 'completed', reply_status: 'accepted' },
    });
    const db = dbWithRules([rule()]);
    const replyMessageWithRequestId = vi.fn();
    const line = { replyMessageWithRequestId } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(replyMessageWithRequestId).not.toHaveBeenCalled();
    expect(actionMocks.runActionRows).not.toHaveBeenCalled();
  });

  it('LINEが返信を受理した後だけヒットを記録する', async () => {
    const db = dbWithRules([rule()]);
    const line = {
      replyMessageWithRequestId: vi.fn().mockResolvedValue({ data: {}, requestId: 'line-request-1' }),
    } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result).toEqual({ matched: true, replyTokenConsumed: true });
    expect(dbMocks.markAutoReplyEvaluationFinished).toHaveBeenCalledWith(db, expect.objectContaining({
      status: 'completed',
      replyStatus: 'accepted',
      lineRequestId: 'line-request-1',
      messageLogId: 'outgoing-log-1',
    }));
    expect(dbMocks.recordAutoReplyHit).toHaveBeenCalledTimes(1);
    expect(dbMocks.markAutoReplyEvaluationFinished.mock.invocationCallOrder[0])
      .toBeLessThan(dbMocks.recordAutoReplyHit.mock.invocationCallOrder[0]);
  });

  it('共通情報を解決できない返信はLINEを呼ばず失敗にする', async () => {
    const db = dbWithRules([{ ...rule(), response_content: '営業時間: {{var.missing}}' }]);
    const replyMessageWithRequestId = vi.fn();
    vi.mocked(resolveSendInterpolationExtra).mockRejectedValueOnce(new Error('common_var_unresolved'));
    const result = await matchAndReply(db, { replyMessageWithRequestId } as unknown as LineClient, friend, '予約したい', 'reply-token', opts());
    expect(resolveSendInterpolationExtra).toHaveBeenCalledWith(db, 'friend-1', '営業時間: {{var.missing}}', { kind: 'auto_reply', id: 'rule-1' });
    expect(result).toEqual({ matched: true, replyTokenConsumed: false });
    expect(replyMessageWithRequestId).not.toHaveBeenCalled();
    expect(dbMocks.markAutoReplyEvaluationFinished).toHaveBeenCalledWith(db, expect.objectContaining({ status: 'reply_failed' }));
  });

  it('返信できなかったときはヒットに数えず、失敗として分ける', async () => {
    const db = dbWithRules([rule()]);
    const line = {
      replyMessageWithRequestId: vi.fn().mockRejectedValue(new Error('LINE rejected')),
    } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result).toEqual({ matched: true, replyTokenConsumed: false });
    expect(dbMocks.recordAutoReplyHit).not.toHaveBeenCalled();
    expect(dbMocks.markAutoReplyEvaluationFinished).toHaveBeenCalledWith(db, expect.objectContaining({
      status: 'reply_failed',
      replyStatus: 'failed',
    }));
  });

  it('返信しないルールは全アクションが成功したときだけヒットに数える', async () => {
    actionMocks.runActionRows.mockResolvedValue({
      executed: 0,
      skippedByCondition: 1,
      skippedByOnce: 0,
      failed: 0,
      skippedIncomplete: 0,
      scenarioTouched: false,
    });
    const db = dbWithRules([rule('silent', [
      { actionType: 'tag', config: { op: 'add', tagIds: ['tag-1'] } },
    ])]);
    const line = { replyMessageWithRequestId: vi.fn() } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result).toEqual({ matched: true, replyTokenConsumed: false });
    expect(dbMocks.recordAutoReplyHit).not.toHaveBeenCalled();
    expect(dbMocks.markAutoReplyEvaluationFinished).toHaveBeenCalledWith(db, expect.objectContaining({
      status: 'partial_failed',
      replyStatus: 'not_attempted',
    }));
  });

  it('動作が済んだあと完了記録だけ落ちても、成功した動作を permanent_failed に書き換えない', async () => {
    // 副作用は成功したのに台帳の完了書き込みだけ失敗したとき、
    // permanent_failed を書くと「もう一度実行」で成功した動作が二度動く。
    dbMocks.finishAutoReplyActionRun.mockRejectedValue(new Error('ledger write failed'));
    const db = dbWithRules([rule('silent', [
      { actionType: 'tag', config: { op: 'add', tagIds: ['tag-1'] } },
    ])]);
    const line = { replyMessageWithRequestId: vi.fn() } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result.matched).toBe(true);
    // permanent_failed への書き換えを試みない（行は claimed のまま残る）。
    expect(dbMocks.finishAutoReplyActionRun).toHaveBeenCalledTimes(1);
    expect(dbMocks.finishAutoReplyActionRun).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ status: 'permanent_failed' }),
    );
    // 動作自体は成功として集計・完了する。
    expect(dbMocks.markAutoReplyEvaluationFinished).toHaveBeenCalledWith(db, expect.objectContaining({
      status: 'completed',
      replyStatus: 'not_attempted',
    }));
  });

  it('動作そのものが失敗したときは permanent_failed として残し、失敗の記録も止まらない', async () => {
    actionMocks.runActionRows.mockRejectedValue(new Error('action broke'));
    const db = dbWithRules([rule('silent', [
      { actionType: 'tag', config: { op: 'add', tagIds: ['tag-1'] } },
    ])]);
    const line = { replyMessageWithRequestId: vi.fn() } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result.matched).toBe(true);
    expect(dbMocks.finishAutoReplyActionRun).toHaveBeenCalledWith(db, expect.objectContaining({
      id: 'action-run-1',
      status: 'permanent_failed',
    }));
    expect(dbMocks.markAutoReplyEvaluationFinished).toHaveBeenCalledWith(db, expect.objectContaining({
      status: 'partial_failed',
      replyStatus: 'not_attempted',
    }));
  });

  it('条件に合わないだけの受信は失敗にせず、何もしなかった理由を残す', async () => {
    conditionMocks.evaluateAutoReplyConditions.mockResolvedValue({
      matches: false,
      reasonCodes: ['operator_handling'],
    });
    const db = dbWithRules([rule()]);
    const line = { replyMessageWithRequestId: vi.fn() } as unknown as LineClient;

    const result = await matchAndReply(db, line, friend, '予約したい', 'reply-token', opts());

    expect(result).toEqual({ matched: false, replyTokenConsumed: false });
    expect(dbMocks.recordAutoReplyEvaluationDetail).toHaveBeenCalledWith(db, expect.objectContaining({
      result: 'skipped',
      reasonCodes: ['operator_handling'],
    }));
    expect(dbMocks.markAutoReplyEvaluationSkipped).toHaveBeenCalledWith(
      db,
      'evaluation-1',
      'no_matching_rule',
    );
    expect(dbMocks.markAutoReplyEvaluationFinished).not.toHaveBeenCalled();
  });
});

it('公開版の待つ時間を使って予約し、期限切れになる返信トークンを保存しない', async () => {
 const db=dbWithRules([{...rule(),definition_snapshot:JSON.stringify({replyDelaySeconds:60,normalizeKeywords:true,receiveSources:['line']})}]);
 const replyMessageWithRequestId=vi.fn();
 const result=await matchAndReply(db,{replyMessageWithRequestId} as unknown as LineClient,friend,'予約','token',opts());
 expect(result).toEqual({matched:true,replyTokenConsumed:false});
 expect(replyMessageWithRequestId).not.toHaveBeenCalled();
 expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO auto_reply_deliveries'));
 expect(dbMocks.recordAutoReplyHit).not.toHaveBeenCalled();
});
it('公開版がメール受信だけならLINEに返信しない',async()=>{
 const db=dbWithRules([{...rule(),definition_snapshot:JSON.stringify({receiveSources:['email']})}]);
 const replyMessageWithRequestId=vi.fn();
 expect(await matchAndReply(db,{replyMessageWithRequestId} as unknown as LineClient,friend,'予約','token',opts())).toEqual({matched:false,replyTokenConsumed:false});
 expect(replyMessageWithRequestId).not.toHaveBeenCalled();
});


it('キーワード未一致なら設定した返事だけを送り、未設定・有人対応停止では送らない', async () => {
 const replyMessageWithRequestId=vi.fn().mockResolvedValue({requestId:'fallback-request'});
 const line={replyMessageWithRequestId} as unknown as LineClient;
 expect(await matchAndReply(dbWithRules([rule()],'受信しました'),line,friend,'こんにちは','reply-token',opts('fallback'))).toEqual({matched:true,replyTokenConsumed:true});
 expect(replyMessageWithRequestId).toHaveBeenCalledWith('reply-token',[{type:'text',text:'受信しました'}]);
 replyMessageWithRequestId.mockClear();
 expect(await matchAndReply(dbWithRules([rule()]),line,friend,'こんにちは','reply-token',opts('unset'))).toEqual({matched:false,replyTokenConsumed:false});
 expect(replyMessageWithRequestId).not.toHaveBeenCalled();
 conditionMocks.evaluateAutoReplyConditions.mockResolvedValue({matches:false,reasonCodes:['operator_active']});
 await matchAndReply(dbWithRules([rule()],'受信しました'),line,friend,'予約したい','reply-token',opts('operator'));
 expect(replyMessageWithRequestId).not.toHaveBeenCalled();
});
