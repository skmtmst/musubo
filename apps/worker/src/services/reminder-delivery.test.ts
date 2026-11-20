import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LineClient } from '@line-crm/line-sdk'
import {
  claimReminderDeliveryRun,
  completeReminderIfDone,
  failReminderDeliveryRun,
  holdExpiredLineRetryRuns,
  restoreOperationIncident,
  resumeReminderRegistrant,
  retryReminderDeliveryRun,
  stopOperationCapabilities,
  verifyClaimedRunBeforeSend,
} from '@line-crm/db'

import { createTestD1, insertFriend } from '../test-utils/d1-sqlite.js'
import { classifyReminderDeliveryError, processReminderDeliveries } from './reminder-delivery.js'

function seedReminder(
  raw: import('better-sqlite3').Database,
  overrides: { isFollowing?: boolean; offsetMinutes?: number } = {},
): void {
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-1', 'channel-1', '本店', 'token', 'secret')`,
  ).run()
  insertFriend(raw, 'friend-1', {
    line_user_id: 'U-friend-1',
    line_account_id: 'account-1',
    display_name: '田中さくら',
    is_following: overrides.isFollowing === false ? 0 : 1,
  })
  raw.prepare(
    `INSERT INTO reminders
       (id, name, line_account_id, is_active, trigger_type, delivery_mode)
     VALUES ('reminder-1', '来店前のお知らせ', 'account-1', 1, 'manual', 'countdown')`,
  ).run()
  raw.prepare(
    `INSERT INTO reminder_steps
       (id, reminder_id, offset_minutes, message_type, message_content)
     VALUES ('step-1', 'reminder-1', ?, 'text', 'ご来店をお待ちしています')`,
  ).run(overrides.offsetMinutes ?? -60)
  raw.prepare(
    `INSERT INTO friend_reminders
       (id, friend_id, reminder_id, target_date, status, created_at, updated_at)
     VALUES ('enrollment-1', 'friend-1', 'reminder-1', '2026-08-28T10:00:00.000Z', 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).run()
}

function makeClient(
  send: (userId: string, retryKey: string | undefined) => Promise<{ requestId: string | null }>,
): LineClient {
  return {
    async pushMessageWithRequestId(userId: string, _messages: unknown[], retryKey?: string) {
      const result = await send(userId, retryKey)
      return { data: {}, requestId: result.requestId }
    },
  } as unknown as LineClient
}

const noPause = async () => undefined

describe('リマインダ配信の実行記録', () => {

  it('共通情報がないリマインダは送らず、失敗の理由を残す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-28T09:00:00Z'))
    const { db, raw } = createTestD1({ now: () => new Date() })
    try {
      seedReminder(raw)
      raw.prepare("UPDATE reminder_steps SET message_content='営業時間: {{var.hours}}' WHERE id='step-1'").run()
      const send = vi.fn(async () => ({ requestId: 'accepted' }))
      const client = makeClient(send)
      await processReminderDeliveries(db, client, { now: new Date(), pause: noPause, resolveClient: async () => client })
      expect(send).not.toHaveBeenCalled()
      expect(raw.prepare('SELECT var_key, reason FROM common_var_resolution_failures').all()).toEqual([{ var_key: 'hours', reason: 'missing' }])
    } finally { raw.close(); vi.useRealTimers() }
  })

  it.each(['cron','manual','queued','expired_manual','exhausted_manual'])('holds an ambiguous historical reminder via %s without another request',async mode=>{
    const {db,raw}=createTestD1();seedReminder(raw);let sends=0;
    const client=makeClient(async()=>{sends++;throw Object.assign(new Error('rejected'),{status:429});});
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:00:00Z'),pause:noPause,resolveClient:async()=>client});
    raw.exec("UPDATE reminder_delivery_runs SET last_error_code='line_temporary_failure'");
    const before=raw.prepare('SELECT id,line_retry_key,attempt_count FROM reminder_delivery_runs').get() as {id:string};
    if(mode==='expired_manual')raw.exec("UPDATE reminder_delivery_runs SET last_error_code='retry_key_expired',next_retry_at=NULL");
    if(mode==='exhausted_manual')raw.exec("UPDATE reminder_delivery_runs SET status='permanent_failed',last_error_code='retry_exhausted',next_retry_at=NULL");
    if(mode==='queued')raw.exec("UPDATE reminder_delivery_runs SET status='queued',retry_cycle_attempt_count=0");
    if(!mode.includes('manual'))await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:10:00Z'),pause:noPause,resolveClient:async()=>client});
    else expect((await retryReminderDeliveryRun(db,{id:before.id,requestKey:'new-request',now:'2026-08-28T09:10:00Z'}))?.kind).toBe('conflict');
    expect(sends).toBe(1);expect(raw.prepare('SELECT id,line_retry_key,attempt_count FROM reminder_delivery_runs').get()).toEqual(before);
    expect(raw.prepare('SELECT status,last_error_code FROM reminder_delivery_runs').get()).toEqual({status:'permanent_failed',last_error_code:'delivery_unknown'});raw.close();
  });

  it('holds an expired legacy claim with a frozen payload even if it predates the started marker',async()=>{
    const {db,raw}=createTestD1();seedReminder(raw);
    const input={lineAccountId:'account-1',reminderId:'reminder-1',friendReminderId:'enrollment-1',friendId:'friend-1',reminderStepId:'step-1',scheduledAt:'2026-08-28T09:00:00Z',now:'2026-08-28T09:00:00Z',leaseExpiresAt:'2026-08-28T09:05:00Z'};
    const first=await claimReminderDeliveryRun(db,input);expect(first).toBeTruthy();
    raw.prepare("UPDATE reminder_delivery_runs SET sent_message_content='frozen payload',last_error_code=NULL WHERE id=?").run(first!.id);
    expect(await claimReminderDeliveryRun(db,{...input,now:'2026-08-28T09:10:00Z',leaseExpiresAt:'2026-08-28T09:15:00Z'})).toBeNull();
    expect(raw.prepare('SELECT status,last_error_code,attempt_count,line_retry_key FROM reminder_delivery_runs').get()).toMatchObject({status:'permanent_failed',last_error_code:'delivery_unknown',attempt_count:1,line_retry_key:first!.line_retry_key});raw.close();
  });
  it.each(['disconnect','saved_result_failure'])('unknown reminder is held across cron and manual retry: %s',async failure=>{
    const {db,raw}=createTestD1();seedReminder(raw);let sends=0;
    const client=makeClient(async()=>{sends++;if(failure==='disconnect')throw new Error('lost response');return {requestId:'accepted-request'};});
    if(failure==='saved_result_failure')raw.exec("CREATE TRIGGER fail_reminder_result BEFORE INSERT ON messages_log BEGIN SELECT RAISE(ABORT,'injected'); END");
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:00:00Z'),pause:noPause,resolveClient:async()=>client});
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:10:00Z'),pause:noPause,resolveClient:async()=>client});
    expect(sends).toBe(1);
    const run=raw.prepare('SELECT id,status,last_error_code,next_retry_at,line_request_id FROM reminder_delivery_runs').get() as {id:string};
    expect(run).toMatchObject({status:'permanent_failed',last_error_code:'delivery_unknown',next_retry_at:null});
    if(failure==='saved_result_failure')expect(run).toMatchObject({line_request_id:'accepted-request'});
    expect((await retryReminderDeliveryRun(db,{id:run.id,requestKey:'new-request',now:'2026-08-28T09:11:00Z'}))?.kind).toBe('conflict');
    raw.close();
  });
  it('does not reclaim a started reminder when its lease expires before completion',async()=>{
    const {db,raw}=createTestD1();seedReminder(raw);let sends=0;let resolve!:()=>void;
    const client=makeClient(async()=>{sends++;await new Promise<void>(done=>{resolve=done});return {requestId:'accepted'};});
    const first=processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:00:00Z'),pause:noPause,resolveClient:async()=>client});
    await vi.waitFor(()=>expect(sends).toBe(1));
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:10:00Z'),pause:noPause,resolveClient:async()=>client});
    expect(sends).toBe(1);resolve();await first;
    expect(raw.prepare('SELECT status,last_error_code FROM reminder_delivery_runs').get()).toEqual({status:'permanent_failed',last_error_code:'delivery_unknown'});
    raw.close();
  });

  it('同意不明の明示台帳があれば送らず、実行記録に理由を残す',async()=>{
    const {db,raw}=createTestD1();seedReminder(raw);
    raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('account-1','friend-1','marketing','unknown','同意未確認','manual')");
    let sent=0;const client=makeClient(async()=>{sent++;return {requestId:null};});
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:00:00.000Z'),pause:noPause,resolveClient:async()=>client});
    expect(sent).toBe(0);
    expect(raw.prepare('SELECT status,last_error_code FROM reminder_delivery_runs').get()).toEqual({status:'skipped',last_error_code:'delivery_consent_suppressed'});
    raw.close();
  });

  it('未来の通を送らずqueuedで先に記録し、予定件数と次回日時を出せる', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw, { offsetMinutes: 60 })
    let pushCount = 0
    const client = makeClient(async () => {
      pushCount++
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(result).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 0 })
    expect(pushCount).toBe(0)
    expect(raw.prepare(
      `SELECT status, scheduled_at, attempt_count FROM reminder_delivery_runs`,
    ).get()).toEqual({
      status: 'queued',
      scheduled_at: '2026-08-28T11:00:00.000Z',
      attempt_count: 0,
    })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'active' })
  })

  it('LINE送信・成功履歴・本文ログを同じ1回として残し、次のcronで二重送信しない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: Array<{ userId: string; retryKey: string | undefined }> = []
    const client = makeClient(async (userId, retryKey) => {
      pushes.push({ userId, retryKey })
      return { requestId: 'line-request-1' }
    })
    const now = new Date('2026-08-28T09:00:00.000Z')

    const first = await processReminderDeliveries(db, client, {
      now,
      pause: noPause,
      resolveClient: async () => client,
    })
    const second = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:01:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(first).toEqual({ succeeded: 1, skipped: 0, retrying: 0, failed: 0, held: 0 })
    expect(second).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 0 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0].userId).toBe('U-friend-1')
    expect(pushes[0].retryKey).toMatch(/^[0-9a-f-]{36}$/)

    expect(raw.prepare(
      `SELECT status, attempt_count, line_request_id
         FROM reminder_delivery_runs`,
    ).get()).toEqual({ status: 'succeeded', attempt_count: 1, line_request_id: 'line-request-1' })
    expect(raw.prepare(
      `SELECT content, source, delivery_type, line_account_id FROM messages_log`,
    ).get()).toEqual({
      content: 'ご来店をお待ちしています',
      source: 'reminder',
      delivery_type: 'push',
      line_account_id: 'account-1',
    })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'completed' })
  })

  it('課金の状態で配信が止まっている統括は送らず、予約は残す（プランを選べば続きから届く）', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'line-request-1' }
    })
    const now = new Date('2026-08-28T09:00:00.000Z')

    const held = await processReminderDeliveries(db, client, {
      now,
      pause: noPause,
      resolveClient: async () => client,
      sendPermission: async () => ({ allowed: false, reason: '無料トライアルが終了', tenantId: 't', state: 'trial_expired' }),
    })
    expect(held.succeeded).toBe(0)
    expect(held.skipped).toBeGreaterThan(0)
    expect(pushes).toHaveLength(0)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM reminder_delivery_runs`).get()).toEqual({ n: 0 })

    const resumed = await processReminderDeliveries(db, client, {
      now,
      pause: noPause,
      resolveClient: async () => client,
      sendPermission: async () => ({ allowed: true, reason: null, tenantId: 't', state: 'active' }),
    })
    expect(resumed.succeeded).toBe(1)
    expect(pushes).toEqual(['U-friend-1'])
  })

  it('一時失敗は1分後に同じLINE再送キーで送り直し、成功後は止まる', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const retryKeys: string[] = []
    let attempts = 0
    const client = makeClient(async (_userId, retryKey) => {
      retryKeys.push(retryKey ?? '')
      attempts++
      if (attempts === 1) throw new Error('LINE API error: 429')
      return { requestId: 'line-request-after-retry' }
    })

    const failed = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    const tooEarly = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:59.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    const retried = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:01:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(failed).toEqual({ succeeded: 0, skipped: 0, retrying: 1, failed: 0, held: 0 })
    expect(tooEarly).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 0 })
    expect(retried).toEqual({ succeeded: 1, skipped: 0, retrying: 0, failed: 0, held: 0 })
    expect(retryKeys).toHaveLength(2)
    expect(retryKeys[1]).toBe(retryKeys[0])
    expect(raw.prepare(
      `SELECT status, attempt_count, retry_cycle_attempt_count, line_request_id
         FROM reminder_delivery_runs`,
    ).get()).toEqual({
      status: 'succeeded',
      attempt_count: 2,
      retry_cycle_attempt_count: 2,
      line_request_id: 'line-request-after-retry',
    })
  })

  it('ブロック済みの友だちは送らず、理由を残して登録を終える', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw, { isFollowing: false })
    let pushCount = 0
    const client = makeClient(async () => {
      pushCount++
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    expect(pushCount).toBe(0)
    expect(raw.prepare(
      `SELECT status, last_error_code, last_error_message FROM reminder_delivery_runs`,
    ).get()).toEqual({
      status: 'skipped',
      last_error_code: 'friend_not_following',
      last_error_message: 'ブロックまたは友だち解除のため送信しませんでした。',
    })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'completed' })
  })

  it('LINEアカウントが決められない古い登録を、既定アカウントで誤送信しない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    raw.prepare(`UPDATE reminders SET line_account_id = NULL WHERE id = 'reminder-1'`).run()
    raw.prepare(`UPDATE friends SET line_account_id = NULL WHERE id = 'friend-1'`).run()
    let pushCount = 0
    const fallbackClient = makeClient(async () => {
      pushCount++
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, fallbackClient, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
    })

    expect(result).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 1, held: 0 })
    expect(pushCount).toBe(0)
    expect(raw.prepare(
      `SELECT status, last_error_code, last_error_message FROM reminder_delivery_runs`,
    ).get()).toEqual({
      status: 'permanent_failed',
      last_error_code: 'line_account_not_found',
      last_error_message: '送信に使うLINEアカウント設定を確認してください。',
    })
  })

  it('共通基盤どおり自動再試行を3回で止め、手動確認が必要な言葉へ変える', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const client = makeClient(async () => {
      throw new Error('LINE API error: 429 body=secret')
    })
    const times = [
      '2026-08-28T09:00:00.000Z',
      '2026-08-28T09:01:00.000Z',
      '2026-08-28T09:06:00.000Z',
      '2026-08-28T09:36:00.000Z',
    ]

    for (const time of times) {
      await processReminderDeliveries(db, client, {
        now: new Date(time),
        pause: noPause,
        resolveClient: async () => client,
      })
    }

    expect(raw.prepare(
      `SELECT status, attempt_count, retry_cycle_attempt_count,
              last_error_code, last_error_message, next_retry_at
         FROM reminder_delivery_runs`,
    ).get()).toEqual({
      status: 'permanent_failed',
      attempt_count: 4,
      retry_cycle_attempt_count: 4,
      last_error_code: 'line_rate_limited_exhausted',
      last_error_message: '自動再試行の上限に達しました。LINE連携を確認し、必要なら手動で再試行してください。',
      next_retry_at: null,
    })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'completed' })
  })

  it('LINEの状態を、秘密の本文を出さず運用者向けの言葉へ変える', () => {
    expect(classifyReminderDeliveryError(new Error('LINE API error: 429 body=secret'))).toEqual({
      code: 'line_rate_limited',
      message: 'LINE側の送信上限に達しました。時間を置いて再試行します。',
      retryable: true,
    })
    expect(classifyReminderDeliveryError(new Error('LINE API error: 401 token=secret'))).toEqual({
      code: 'line_authentication_failed',
      message: 'LINE連携の認証を確認してください。',
      retryable: false,
    })
    expect(classifyReminderDeliveryError(new Error('REMINDER_LINE_ACCOUNT_NOT_FOUND'))).toEqual({
      code: 'line_account_not_found',
      message: '送信に使うLINEアカウント設定を確認してください。',
      retryable: false,
    })
  })

  it('429ではLINEのRetry-Afterを既定の1分より優先する', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const client = makeClient(async () => {
      throw Object.assign(new Error('LINE API error: 429'), {
        status: 429,
        retryAfter: '120',
      })
    })

    await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(raw.prepare(
      `SELECT status, next_retry_at FROM reminder_delivery_runs`,
    ).get()).toEqual({
      status: 'retry_wait',
      next_retry_at: '2026-08-28T09:02:00.000Z',
    })
  })

  it('取消と競合した通は送らず止める (claimed 後の取消も送らない)', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    insertFriend(raw, 'friend-2', {
      line_user_id: 'U-friend-2',
      line_account_id: 'account-1',
      display_name: '佐藤たろう',
    })
    raw.prepare(
      `INSERT INTO friend_reminders
         (id, friend_id, reminder_id, target_date, status)
       VALUES ('enrollment-2', 'friend-2', 'reminder-1', '2026-08-28T10:00:00.000Z', 'active')`,
    ).run()
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      // 2件目の claim の割り込みで取消が入った想定。claim が原子的に拒否する。
      pause: async () => {
        await db.prepare(
          `UPDATE friend_reminders SET status = 'cancelled', updated_at = ? WHERE id = 'enrollment-2'`,
        ).bind('2026-08-28T09:00:00.000Z').run()
      },
      resolveClient: async () => client,
    })

    expect(pushes).toEqual(['U-friend-1'])
    // claim 拒否は握っていないため skipped に数えない。送らず止める約束は同じ。
    expect(result).toEqual({ succeeded: 1, skipped: 0, retrying: 0, failed: 0, held: 0 })
    // 取消ずみの登録には実行行自体を作らない (取消時の回収が済みのため)。
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-2'`,
    ).get()).toBeUndefined()
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-2'`,
    ).get()).toEqual({ status: 'cancelled' })
  })

  it('active確認後・push直前の取消でも送らない (送信直前の原子検証)', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      // claim 直後の active 確認を通ってから、push 直前に利用者が取消した想定。
      // 旧実装はこの窓で送信していた。新実装は送らず止める。
      resolveClient: async (_accountId, fallback) => {
        await db.prepare(
          `UPDATE friend_reminders SET status = 'cancelled', updated_at = ? WHERE id = 'enrollment-1'`,
        ).bind('2026-08-28T09:00:00.000Z').run()
        return fallback
      },
    })

    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'cancelled' })
  })

  it('送信権の取得後に取消が確定しても送らない (検証後注入)', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
      // 1回目の検証を通った直後に取消を確定させる。
      // 旧実装 (再検証なし) はこの窓で送信していた。
      beforePush: async () => {
        await db.prepare(
          `UPDATE friend_reminders SET status = 'cancelled', updated_at = ? WHERE id = 'enrollment-1'`,
        ).bind('2026-08-28T09:00:00.000Z').run()
        await db.prepare(
          `UPDATE reminder_delivery_runs
              SET status = 'cancelled', completed_at = ?, updated_at = ?
            WHERE friend_reminder_id = 'enrollment-1' AND status = 'claimed'`,
        ).bind('2026-08-28T09:00:00.000Z', '2026-08-28T09:00:00.000Z').run()
      },
    })

    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'cancelled' })
    expect(raw.prepare(
      `SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ c: 0 })
  })
})

describe('緊急停止 (#1050)', () => {
  const NOW = new Date('2026-08-28T09:00:00.000Z')

  it('reminder_dispatch 停止中は claim せず外部へ1件も出さず、登録を active のまま残す', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'line-request-1' }
    })
    const stopped = await stopOperationCapabilities(db, {
      lineAccountId: 'account-1',
      capabilities: ['reminder_dispatch'],
      expectedVersion: 0,
      actorId: 'owner-1',
      reason: '障害対応',
    })
    if (stopped.status !== 'changed') throw new Error('stop failed')

    const held = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(held).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 1 })
    expect(pushes).toHaveLength(0)
    // 実行行すら積まない (claim しない)。復旧でそのまま届く。
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM reminder_delivery_runs`).get()).toEqual({ n: 0 })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'active' })

    const restored = await restoreOperationIncident(db, {
      incidentId: stopped.incident.id,
      expectedVersion: stopped.control.version,
      actorId: 'owner-1',
    })
    expect(restored.status).toBe('restored')

    const resumed = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(resumed.succeeded).toBe(1)
    expect(pushes).toEqual(['U-friend-1'])
  })

  it('claim 後・送信直前に停止へ切り替わった通は送らず、claim をキューへ戻す', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: null }
    })

    const result = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
      // claim 取得と外部送信のあいだで停止へ切り替わった想定。
      beforePush: async () => {
        const stopped = await stopOperationCapabilities(db, {
          lineAccountId: 'account-1',
          capabilities: ['reminder_dispatch'],
          expectedVersion: 0,
          actorId: 'owner-1',
          reason: '障害対応',
        })
        if (stopped.status !== 'changed') throw new Error('stop failed')
      },
    })

    expect(result).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 1 })
    expect(pushes).toHaveLength(0)
    // 停止を理由に failed/skipped へしない。queued へ戻して復旧で届く。
    expect(raw.prepare(
      `SELECT status, lease_expires_at, next_retry_at FROM reminder_delivery_runs`,
    ).get()).toEqual({ status: 'queued', lease_expires_at: null, next_retry_at: null })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'active' })
  })

  it('別の停止対象 (broadcast_dispatch) だけ止まっていてもリマインダは届く', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: null }
    })
    const stopped = await stopOperationCapabilities(db, {
      lineAccountId: 'account-1',
      capabilities: ['broadcast_dispatch'],
      expectedVersion: 0,
      actorId: 'owner-1',
      reason: '誤配信の防止',
    })
    if (stopped.status !== 'changed') throw new Error('stop failed')

    const result = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(result.succeeded).toBe(1)
    expect(result.held).toBe(0)
    expect(pushes).toEqual(['U-friend-1'])
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs`,
    ).get()).toEqual({ status: 'succeeded' })
  })

  it('グローバル停止 (*) はアカウント未割当の登録にも効く', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    raw.prepare(`UPDATE reminders SET line_account_id = NULL WHERE id = 'reminder-1'`).run()
    raw.prepare(`UPDATE friends SET line_account_id = NULL WHERE id = 'friend-1'`).run()
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: null }
    })
    const stopped = await stopOperationCapabilities(db, {
      lineAccountId: null,
      capabilities: ['reminder_dispatch'],
      expectedVersion: 0,
      actorId: 'owner-1',
      reason: '障害対応',
    })
    if (stopped.status !== 'changed') throw new Error('stop failed')

    const result = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(result.held).toBe(1)
    expect(pushes).toHaveLength(0)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM reminder_delivery_runs`).get()).toEqual({ n: 0 })
  })
})

describe('契約先の利用停止', () => {
  const NOW = new Date('2026-08-28T09:00:00.000Z')

  it('停止中に期限を過ぎた通は送らず終端履歴にし、復帰後も遅れて送らない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    raw.prepare(
      `INSERT INTO tenants (id, name, status) VALUES ('tenant-stopped', '停止中契約先', 'suspended')`,
    ).run()
    raw.prepare(`UPDATE line_accounts SET tenant_id = 'tenant-stopped' WHERE id = 'account-1'`).run()
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'unexpected' }
    })

    const stopped = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(stopped).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    expect(pushes).toHaveLength(0)
    expect(raw.prepare(
      `SELECT status, last_error_code FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'skipped', last_error_code: 'tenant_suspended' })

    raw.prepare(`UPDATE tenants SET status = 'active' WHERE id = 'tenant-stopped'`).run()
    const restored = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T10:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(restored).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 0 })
    expect(pushes).toHaveLength(0)
  })
})

describe('監査の直し (R337・R339・R340・R341・R342・R344)', () => {
  it('R337: 古い実行行が止まっても未送信の予定がある間は完了にしない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    // 日時変更で古い行が止まり、新しい行が積まれた状態。
    raw.prepare(
      `INSERT INTO reminder_delivery_runs
        (id, reminder_id, friend_reminder_id, friend_id, reminder_step_id, scheduled_at,
         idempotency_key, line_retry_key, status, created_at, updated_at)
       VALUES ('old-run','reminder-1','enrollment-1','friend-1','step-1','2026-08-28T08:00:00.000Z',
         'k-old','rk-old','cancelled','2026-08-28T07:00:00.000Z','2026-08-28T07:00:00.000Z')`,
    ).run()
    raw.prepare(
      `INSERT INTO reminder_delivery_runs
        (id, reminder_id, friend_reminder_id, friend_id, reminder_step_id, scheduled_at,
         idempotency_key, line_retry_key, status, created_at, updated_at)
       VALUES ('new-run','reminder-1','enrollment-1','friend-1','step-1','2026-08-28T09:00:00.000Z',
         'k-new','rk-new','queued','2026-08-28T07:00:00.000Z','2026-08-28T07:00:00.000Z')`,
    ).run()
    // 新しい予定の送信が1回失敗しても、登録は active のまま残る。
    const failing = makeClient(async () => {
      throw Object.assign(new Error('temporary'), { status: 429, retryable: true })
    })
    const failed = await processReminderDeliveries(db, failing, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => failing,
    })
    expect(failed.retrying).toBe(1)
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`).get()).toEqual({
      status: 'active',
    })
    // 送り直して成功したら完了になる。
    const succeeding = makeClient(async () => ({ requestId: 'req-1' }))
    const done = await processReminderDeliveries(db, succeeding, {
      now: new Date('2026-08-28T09:01:00.000Z'),
      pause: noPause,
      resolveClient: async () => succeeding,
    })
    expect(done.succeeded).toBe(1)
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`).get()).toEqual({
      status: 'completed',
    })
  })

  it('R339: 候補読込後の日時変更では古い基準日で送らない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'req-1' }
    })
    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
      // 1回目の検証と送信の間に予約が翌日へ動いた想定。
      // 2回目の検証で起点ずれを検知し、古い予定では送らない。
      beforePush: async () => {
        await db.prepare(`UPDATE friend_reminders SET target_date = ? WHERE id = 'enrollment-1'`)
          .bind('2026-08-29T10:00:00.000Z').run()
      },
    })
    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    expect(raw.prepare(`SELECT target_date FROM friend_reminders WHERE id = 'enrollment-1'`).get()).toEqual({
      target_date: '2026-08-29T10:00:00.000Z',
    })
  })

  it('R339: 古い起点の claim は握らない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    // 読込後に翌日へ動いた登録へ、古い起点では握れない。
    const stale = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
      expectedTargetDate: '2026-08-27T10:00:00.000Z',
    })
    expect(stale).toBeNull()
    // 読み直した起点なら握れる。
    const fresh = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
      expectedTargetDate: '2026-08-28T10:00:00.000Z',
    })
    expect(fresh).not.toBeNull()
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM reminder_delivery_runs`).get()).toEqual({ count: 1 })
  })

  it('R339: ルール停止後の claim は握らない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    raw.prepare(`UPDATE reminders SET is_active = 0 WHERE id = 'reminder-1'`).run()
    const run = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
      expectedTargetDate: '2026-08-28T10:00:00.000Z',
    })
    expect(run).toBeNull()
    // 再開すれば握れる。
    raw.prepare(`UPDATE reminders SET is_active = 1 WHERE id = 'reminder-1'`).run()
    const retried = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
      expectedTargetDate: '2026-08-28T10:00:00.000Z',
    })
    expect(retried).not.toBeNull()
  })

  it('R340: 期限切れの古い処理は新しい持ち主の行を上書きしない', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const first = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
    })
    expect(first).not.toBeNull()
    const oldLease = first!.lease_expires_at
    // 期限切れ後に新しい処理が握り直した想定。
    raw.prepare(`UPDATE reminder_delivery_runs SET lease_expires_at = ? WHERE id = ?`)
      .bind('2026-08-28T09:11:00.000Z', first!.id).run()
    // 古い持ち主の検証・失敗・完了はどれも 0 件になる。
    await expect(verifyClaimedRunBeforeSend(db, {
      id: first!.id,
      friendReminderId: 'enrollment-1',
      now: '2026-08-28T09:06:00.000Z',
      leaseExpiresAt: '2026-08-28T09:11:00.000Z',
      expectedLeaseExpiresAt: [oldLease!],
    })).resolves.toBe(false)
    await expect(failReminderDeliveryRun(db, {
      id: first!.id,
      code: 'line_temporary_failure',
      message: 'stale',
      retryAt: '2026-08-28T09:07:00.000Z',
      now: '2026-08-28T09:06:00.000Z',
      expectedLeaseExpiresAt: [oldLease!],
    })).resolves.toBe(false)
    const row = raw.prepare(
      `SELECT status, lease_expires_at, next_retry_at FROM reminder_delivery_runs WHERE id = ?`,
    ).get(first!.id) as { status: string; lease_expires_at: string; next_retry_at: string | null }
    expect(row).toMatchObject({ status: 'claimed', lease_expires_at: '2026-08-28T09:11:00.000Z' })
    // 新しい持ち主の失敗は記録できる。
    await expect(failReminderDeliveryRun(db, {
      id: first!.id,
      code: 'line_temporary_failure',
      message: 'fresh',
      retryAt: '2026-08-28T09:12:00.000Z',
      now: '2026-08-28T09:11:00.000Z',
      expectedLeaseExpiresAt: ['2026-08-28T09:11:00.000Z'],
    })).resolves.toBe(true)
  })

  it('R341: 再開は取消ずみの未来予定を作り直す (送信ずみは触らない)', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    raw.prepare(
      `INSERT INTO reminder_delivery_runs
        (id, reminder_id, friend_reminder_id, friend_id, reminder_step_id, scheduled_at,
         idempotency_key, line_retry_key, status, created_at, updated_at)
       VALUES ('cancelled-run','reminder-1','enrollment-1','friend-1','step-1','2026-08-28T09:00:00.000Z',
         'k1','rk1','cancelled','2026-08-28T07:00:00.000Z','2026-08-28T07:00:00.000Z')`,
    ).run()
    raw.prepare(`UPDATE friend_reminders SET status = 'cancelled', lock_version = 3 WHERE id = 'enrollment-1'`).run()
    const resumed = await resumeReminderRegistrant(db, {
      reminderId: 'reminder-1',
      enrollmentId: 'enrollment-1',
      expectedLockVersion: 3,
      now: '2026-08-28T08:00:00.000Z',
      expectedRuns: [{ reminderStepId: 'step-1', scheduledAt: '2026-08-28T09:00:00.000Z' }],
    })
    expect(resumed.state).toBe('updated')
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`).get()).toEqual({
      status: 'active',
    })
    // 同じ予定の cancelled 行が queued へ戻る (一意制約で二重に作らない)。
    expect(raw.prepare(
      `SELECT status, COUNT(*) AS count FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'queued', count: 1 })
    // 予定時刻に送れる。
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'req-1' }
    })
    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(result.succeeded).toBe(1)
    expect(pushes).toEqual(['U-friend-1'])
  })

  it('R342: 手動再試行でも同じ再試行キーを使う', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const run = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
    })
    expect(run).not.toBeNull()
    const keyBefore = run!.line_retry_key
    await failReminderDeliveryRun(db, {
      id: run!.id,
      code: 'line_temporary_failure',
      message: 'boom',
      retryAt: '2026-08-28T09:01:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      expectedLeaseExpiresAt: [run!.lease_expires_at!],
    })
    const retried = await retryReminderDeliveryRun(db, {
      id: run!.id,
      requestKey: 'manual-1',
      now: '2026-08-28T09:02:00.000Z',
    })
    expect(retried?.kind).toBe('scheduled')
    // キーは作り直さない。同じ通知の再試行は同じキーで送る。
    expect(retried && 'run' in retried && retried.run.line_retry_key).toBe(keyBefore)
  })

  it('R344: 未送信と確認できる行も期限後の自動送信を止め、手動だけを許可する', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const run = await claimReminderDeliveryRun(db, {
      lineAccountId: 'account-1',
      reminderId: 'reminder-1',
      friendReminderId: 'enrollment-1',
      friendId: 'friend-1',
      reminderStepId: 'step-1',
      scheduledAt: '2026-08-28T09:00:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      leaseExpiresAt: '2026-08-28T09:05:00.000Z',
    })
    expect(run).not.toBeNull()
    await failReminderDeliveryRun(db, {
      id: run!.id,
      code: 'line_temporary_failure',
      message: 'boom',
      retryAt: '2026-08-28T09:01:00.000Z',
      now: '2026-08-28T09:00:00.000Z',
      expectedLeaseExpiresAt: [run!.lease_expires_at!],
    })
    // 24時間1秒後に cron が戻っても自動では送らない。
    const held = await holdExpiredLineRetryRuns(db, { now: '2026-08-29T09:00:01.000Z' })
    expect(held).toBe(1)
    expect(raw.prepare(
      `SELECT next_retry_at, last_error_code FROM reminder_delivery_runs WHERE id = ?`,
    ).get(run!.id)).toMatchObject({ next_retry_at: null, last_error_code: 'retry_key_expired' })
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'req-1' }
    })
    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-29T09:00:01.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 0, retrying: 0, failed: 0, held: 0 })
    // このfixtureは本文の凍結前に失敗し、LINE要求を始めていない。
    // 未送信と確認できる場合だけ、手動の再試行を許可する。
    const retried = await retryReminderDeliveryRun(db, {
      id: run!.id,
      requestKey: 'manual-1',
      now: '2026-08-29T09:00:02.000Z',
    })
    expect(retried?.kind).toBe('scheduled')
    const manual = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-29T09:00:03.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(manual.succeeded).toBe(1)
    expect(pushes).toEqual(['U-friend-1'])
  })

  it('R344: 24時間以内の再試行は同じキーで自動回復する', async () => {
    const { db, raw } = createTestD1()
    seedReminder(raw)
    const seenKeys: Array<string | undefined> = []
    let first = true
    const client = makeClient(async (_userId, retryKey) => {
      seenKeys.push(retryKey)
      if (first) {
        first = false
        throw Object.assign(new Error('temporary'), { status: 429, retryable: true })
      }
      return { requestId: 'req-1' }
    })
    const failed = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(failed.retrying).toBe(1)
    // 期限内は止めない。
    const held = await holdExpiredLineRetryRuns(db, { now: '2026-08-28T10:00:00.000Z' })
    expect(held).toBe(0)
    const done = await processReminderDeliveries(db, client, {
      now: new Date('2026-08-28T10:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
    })
    expect(done.succeeded).toBe(1)
    // 2回の送信は同じキー。
    expect(seenKeys).toHaveLength(2)
    expect(seenKeys[0]).toBeTruthy()
    expect(seenKeys[1]).toBe(seenKeys[0])
  })
})

describe('Meet個別相談の送信の最終関係フェンス', () => {
  beforeEach(() => { vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-11-01T00:00:00Z')) })
  afterEach(() => vi.useRealTimers())
  const NOW = new Date('2026-08-28T09:00:00.000Z')
  const TARGET = '2026-08-28T10:00:00.000Z'

  function seedMeetLinked(raw: import('better-sqlite3').Database, target = TARGET): void {
    seedReminder(raw)
    raw.prepare(
      `UPDATE friend_reminders
          SET source_kind = 'meet', source_id = 'consult-1', source_event_id = 'evt-1',
              target_date = ?
        WHERE id = 'enrollment-1'`,
    ).run(target)
    raw.prepare(
      `INSERT INTO staff (id, line_account_id, name, display_name)
       VALUES ('staff-1', 'account-1', '担当', '担当')`,
    ).run()
    raw.prepare(
      `INSERT INTO menus (id, line_account_id, name, duration_minutes, buffer_after_minutes, base_price)
       VALUES ('menu-1', 'account-1', '相談', 60, 0, 0)`,
    ).run()
    const end = new Date(new Date(target).getTime() + 60 * 60 * 1000).toISOString()
    raw.prepare(
      `INSERT INTO bookings
         (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at,
          block_ends_at, status, price_at_booking, requested_at, lock_version)
       VALUES ('booking-1', 'account-1', 'friend-1', 'staff-1', 'menu-1', ?, ?, ?, 'confirmed', 0, ?, 0)`,
    ).run(target, end, end, '2026-08-01T00:00:00.000Z')
    raw.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url,
          status, booking_id, booking_version)
       VALUES ('consult-1', 'evt-1', 'friend-1', '個別相談', ?, ?,
         'https://meet.google.com/aaa-bbbb-ccc', 'confirmed', 'booking-1', 0)`,
    ).run(target, end)
  }

  it('関係が生きている通常候補は送る (対照)', async () => {
    const { db, raw } = createTestD1()
    seedMeetLinked(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'line-request-1' }
    })

    const result = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
    })

    expect(pushes).toEqual(['U-friend-1'])
    expect(result).toEqual({ succeeded: 1, skipped: 0, retrying: 0, failed: 0, held: 0 })
  })

  it('claim後の照合await中に実registerで両新版へ進めても旧payloadを送らない', async () => {
    // 実registerは未来日時のみ受けるため、未来の候補で組み立てる。
    const futureTarget = '2026-11-02T10:00:00.000Z'
    const futureEnd = '2026-11-02T11:00:00.000Z'
    const { db, raw } = createTestD1()
    seedMeetLinked(raw, futureTarget)
    const { registerMeetConsultation } = await import('./meet-consultation-reminders.js')
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'line-request-1' }
    })

    const result = await processReminderDeliveries(db, client, {
      now: new Date('2026-11-02T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
      // 最終送信権の直前で勝者が実再登録 (同日時・両版のみ更新)。
      // 日時が同じため日時照合は通り、候補写しの結合だけが旧payloadを止める。
      beforePush: async () => {
        await db.prepare(
          `UPDATE bookings SET lock_version = 1, updated_at = ? WHERE id = 'booking-1'`,
        ).bind('2026-11-02T09:00:00.000Z').run()
        const renewed = await registerMeetConsultation(db, {
          externalEventId: 'evt-1',
          friendId: 'friend-1',
          title: '個別相談',
          startsAt: futureTarget,
          endsAt: futureEnd,
          meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
          bookingId: 'booking-1',
          bookingVersion: 1,
        })
        expect(renewed.updated).toBe(true)
      },
    })

    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    // 実行行だけを取り消し、勝者の新版通知 (登録・相談・予約) は残す。
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'cancelled' })
    expect(raw.prepare(
      `SELECT status, target_date FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'active', target_date: futureTarget })
    expect(raw.prepare(
      `SELECT status, booking_version, starts_at FROM meet_consultations WHERE id = 'consult-1'`,
    ).get()).toEqual({ status: 'confirmed', booking_version: 1, starts_at: futureTarget })
    expect(raw.prepare(
      `SELECT lock_version FROM bookings WHERE id = 'booking-1'`,
    ).get()).toEqual({ lock_version: 1 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ c: 0 })
  })

  it('停止照会await中に実registerで両新版へ進めても旧payloadを送らない', async () => {
    // A候補の日時は未来に置く (実registerは未来日時のみ受ける)。
    const targetA = '2026-11-02T10:00:00.000Z'
    const targetB = '2026-11-03T10:00:00.000Z'
    const endB = '2026-11-03T11:00:00.000Z'
    const { db, raw } = createTestD1()
    seedMeetLinked(raw, targetA)
    // 勝者の実再登録が 登録を動かすための予約ルール (published)。
    // 登録-1をこのルールへ結び替える (製品のmeet 登録と同じ所属)。
    raw.prepare(
      `INSERT INTO reminders
         (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
       VALUES ('rb-booking', '予約', 'account-1', 1, 'booking', 'countdown', 'published')`,
    ).run()
    raw.prepare(
      `INSERT INTO reminder_steps
         (id, reminder_id, offset_minutes, message_type, message_content)
       VALUES ('step-b', 'rb-booking', -60, 'text', 'ご来店をお待ちしています')`,
    ).run()
    raw.prepare(
      `UPDATE friend_reminders SET reminder_id = 'rb-booking' WHERE id = 'enrollment-1'`,
    ).run()
    // 新版へ再利用される前の子IDを先に固定する (旧senderが触らないことの対照)。
    raw.prepare(
      `INSERT INTO meet_consultation_notification_runs
         (id, consultation_id, kind, scheduled_at, status, retry_count)
       VALUES ('mcr-day-seed', 'consult-1', 'day_before', '2026-11-01T10:00:00.000Z', 'pending', 0),
              ('mcr-hour-seed', 'consult-1', 'hour_before', '2026-11-02T09:00:00.000Z', 'pending', 0)`,
    ).run()
    const { registerMeetConsultation } = await import('./meet-consultation-reminders.js')
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'line-request-1' }
    })
    // 最終の停止照会awaitの中で勝者が動くよう、DBにシームを仕掛ける。
    // beforePush (照合より前) では武装だけし、移動自体は停止照会の解決中に終える。
    const arm = { current: false }
    type MiniBound = {
      all: (...a: unknown[]) => Promise<unknown>
      first: (...a: unknown[]) => Promise<unknown>
      run: (...a: unknown[]) => Promise<unknown>
    }
    const realPrepare = db.prepare.bind(db) as unknown as (sql: string) => {
      bind: (...a: unknown[]) => MiniBound
    }
    const stopSeamDb = {
      prepare: (sql: string) => {
        if (!sql.includes('operation_control_sets')) return realPrepare(sql)
        const realBind = realPrepare(sql).bind
        return {
          bind: (...a: unknown[]) => {
            const bound = realBind(...a)
            return {
              ...bound,
              all: async (...callArgs: unknown[]) => {
                if (arm.current) {
                  arm.current = false
                  await db.prepare(
                    `UPDATE bookings SET lock_version = 1, starts_at = ?, updated_at = ? WHERE id = 'booking-1'`,
                  ).bind(targetB, '2026-11-02T09:00:00.000Z').run()
                  const renewed = await registerMeetConsultation(db, {
                    externalEventId: 'evt-1',
                    friendId: 'friend-1',
                    title: '個別相談',
                    startsAt: targetB,
                    endsAt: endB,
                    meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
                    bookingId: 'booking-1',
                    bookingVersion: 1,
                  })
                  expect(renewed.updated).toBe(true)
                }
                return bound.all(...callArgs)
              },
            }
          },
        }
      },
      batch: db.batch.bind(db),
    } as unknown as Parameters<typeof processReminderDeliveries>[0]

    const result = await processReminderDeliveries(stopSeamDb, client, {
      now: new Date('2026-11-02T09:00:00.000Z'),
      pause: noPause,
      resolveClient: async () => client,
      beforePush: async () => {
        arm.current = true
      },
    })

    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    // 実行行は勝者の reconcile で取消ずみ。旧senderは送らず、行にも触れない。
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'cancelled' })
    // 勝者の新版通知は残る: 登録active・新対象日、相談版1・新日時、予約版1。
    expect(raw.prepare(
      `SELECT status, target_date FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'active', target_date: targetB })
    expect(raw.prepare(
      `SELECT status, booking_version, starts_at FROM meet_consultations WHERE id = 'consult-1'`,
    ).get()).toEqual({ status: 'confirmed', booking_version: 1, starts_at: targetB })
    expect(raw.prepare(
      `SELECT lock_version, starts_at FROM bookings WHERE id = 'booking-1'`,
    ).get()).toEqual({ lock_version: 1, starts_at: targetB })
    // 新版の子はpending・新予定日時・子ID不変。旧senderは作りも壊しもしない。
    expect(raw.prepare(
      `SELECT id, kind, status, scheduled_at FROM meet_consultation_notification_runs
        WHERE consultation_id = 'consult-1' ORDER BY kind,schedule_revision`,
    ).all()).toEqual([
      {id:'mcr-day-seed',kind:'day_before',status:'cancelled',scheduled_at:'2026-11-01T10:00:00.000Z'},
      { id: expect.any(String), kind: 'day_before', status: 'pending', scheduled_at: '2026-11-02T10:00:00.000Z' },
      {id:'mcr-hour-seed',kind:'hour_before',status:'cancelled',scheduled_at:'2026-11-02T09:00:00.000Z'},
      { id: expect.any(String), kind: 'hour_before', status: 'pending', scheduled_at: '2026-11-03T09:00:00.000Z' },
    ])
    expect(raw.prepare(
      `SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ c: 0 })
  })

  it('送信権の取得後に相談が取消されても送らない (最終関係フェンス)', async () => {
    const { db, raw } = createTestD1()
    seedMeetLinked(raw)
    const pushes: string[] = []
    const client = makeClient(async (userId) => {
      pushes.push(userId)
      return { requestId: 'line-request-1' }
    })

    const result = await processReminderDeliveries(db, client, {
      now: NOW,
      pause: noPause,
      resolveClient: async () => client,
      // 最終送信権の直前に勝者が相談を取り消した想定。の登録・実行行は
      // 生きたまま (共有取消が版ガードで止められた残差)。旧実装は送っていた。
      beforePush: async () => {
        await db.prepare(
          `UPDATE meet_consultations SET status = 'cancelled', updated_at = ? WHERE id = 'consult-1'`,
        ).bind('2026-08-28T09:00:00.000Z').run()
      },
    })

    expect(pushes).toEqual([])
    expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 })
    // 実行行だけを取り消し、登録・相談・予約の新状態には触れない。
    expect(raw.prepare(
      `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'cancelled' })
    expect(raw.prepare(
      `SELECT status FROM friend_reminders WHERE id = 'enrollment-1'`,
    ).get()).toEqual({ status: 'active' })
    expect(raw.prepare(
      `SELECT status, booking_version FROM meet_consultations WHERE id = 'consult-1'`,
    ).get()).toEqual({ status: 'cancelled', booking_version: 0 })
    expect(raw.prepare(
      `SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id = 'enrollment-1'`,
    ).get()).toEqual({ c: 0 })
  })
})


it('登録前に過ぎた通は送らず、送らなかった記録を残す', async () => {
  const { db, raw } = createTestD1(); seedReminder(raw);
  raw.prepare("UPDATE friend_reminders SET created_at = '2026-08-28T09:30:00Z', updated_at = '2026-08-28T09:30:00Z' WHERE id = 'enrollment-1'").run();
  let pushes = 0;
  const client = makeClient(async () => { pushes++; return { requestId: null }; });
  await processReminderDeliveries(db, client, { now: new Date('2026-08-28T09:31:00Z'), pause: noPause, resolveClient: async () => client });
  expect(pushes).toBe(0);
  expect(raw.prepare("SELECT status, last_error_code FROM reminder_delivery_runs WHERE friend_reminder_id = 'enrollment-1'").get()).toEqual({ status: 'skipped', last_error_code: 'scheduled_before_enrollment' });
  raw.close();
});


it('古いJST形式の登録日時でも未来だった通を誤って捨てない', async () => {
  const {db,raw}=createTestD1(); seedReminder(raw);
  raw.prepare("UPDATE friend_reminders SET updated_at='2026-08-28T17:30:00.000' WHERE id='enrollment-1'").run();
  let pushes=0; const client=makeClient(async()=>{pushes++;return {requestId:null};});
  await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:01:00Z'),pause:noPause,resolveClient:async()=>client});
  expect(pushes).toBe(1);
  raw.close();
});


it('preserves an over-budget provider deadline and blocks both cron and manual retry', async () => {
  const {db,raw}=createTestD1(); seedReminder(raw);
  try {
    let sends=0;
    const client=makeClient(async()=>{sends++;throw Object.assign(new Error('rejected'),{status:429,retryAfter:'7200'});});
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:00:00Z'),pause:noPause,resolveClient:async()=>client});
    const run=raw.prepare('SELECT * FROM reminder_delivery_runs').get() as {id:string,line_retry_key:string,attempt_count:number};
    expect(run).toMatchObject({status:'permanent_failed',last_error_code:'retry_after_exceeds_budget',next_retry_at:'2026-08-28T11:00:00.000Z',attempt_count:1});
    const retry=await retryReminderDeliveryRun(db,{id:run.id,requestKey:crypto.randomUUID(),now:'2026-08-28T09:30:00Z'});
    expect(retry?.kind).toBe('conflict');
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:30:00Z'),pause:noPause,resolveClient:async()=>client});
    expect(sends).toBe(1);
    expect(raw.prepare('SELECT line_retry_key,attempt_count FROM reminder_delivery_runs').get()).toEqual({line_retry_key:run.line_retry_key,attempt_count:1});
  } finally {raw.close();}
});

it('does not let manual retry bypass a normal provider deadline',async()=>{
  const {db,raw}=createTestD1();seedReminder(raw);
  try {
    const client=makeClient(async()=>{throw Object.assign(new Error('rejected'),{status:429,retryAfter:'120'});});
    await processReminderDeliveries(db,client,{now:new Date('2026-08-28T09:00:00Z'),pause:noPause,resolveClient:async()=>client});
    const run=raw.prepare('SELECT id FROM reminder_delivery_runs').get() as {id:string};
    expect((await retryReminderDeliveryRun(db,{id:run.id,requestKey:crypto.randomUUID(),now:'2026-08-28T09:01:00Z'}))?.kind).toBe('conflict');
    expect((await retryReminderDeliveryRun(db,{id:run.id,requestKey:crypto.randomUUID(),now:'2026-08-28T09:02:00Z'}))?.kind).toBe('scheduled');
  }finally{raw.close();}
});

it('starts provider delta seconds at the response even when the sweep began earlier',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-28T09:00:00Z'));
 const {db,raw}=createTestD1();seedReminder(raw);
 try {
  const client=makeClient(async()=>{vi.advanceTimersByTime(1500);throw Object.assign(new Error('rejected'),{status:429,retryAfter:'120'});});
  await processReminderDeliveries(db,client,{pause:noPause,resolveClient:async()=>client});
  expect(raw.prepare('SELECT next_retry_at FROM reminder_delivery_runs').get()).toEqual({next_retry_at:'2026-08-28T09:02:01.500Z'});
 }finally{raw.close();vi.useRealTimers();}
});
