/*
 * 停止・再開・失敗先への再送で、同じ人へ二重に届かないことを守る。
 * 外へ出た可能性がある送信は at-most-once で再送せず、欠けた分は台帳で確認する。
 * 試験では停止位置と送信先を検証するため、stealth の束間待機だけを省く。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';

vi.mock('../../services/stealth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/stealth.js')>()),
  sleep: async () => {},
  calculateStaggerDelay: () => 0,
}));

import { processQueuedBroadcasts, processBroadcastSend } from './broadcast.js';
import { processMultiAccountDedupBroadcast } from '../../services/dedup-broadcast.js';
import {
  requestBroadcastStop,
  resumeBroadcastSending,
  beginBroadcastRetryAttempt,
  reopenFailedClaims,
  closeClaimsForStop,
  countBroadcastLedger,
  markBroadcastRecipientsDispatched,
  settleBroadcastRecipients,
} from '@line-crm/db';

type LineClient = import('@line-crm/line-sdk').LineClient;

/** LINE の口の代わり。送った相手を控え、必要なら落ちる。 */
function makeLineClient(opts: {
  onMulticast?: (userIds: string[], callIndex: number) => Promise<void> | void;
} = {}) {
  const calls: string[][] = [];
  const client = {
    async multicast(userIds: string[]) {
      const index = calls.length;
      calls.push([...userIds]);
      await opts.onMulticast?.(userIds, index);
      return { requestId: 'req-1' };
    },
    async pushMessage(userId: string) {
      calls.push([userId]);
    },
    async pushMessageWithRequestId(userId: string) {
      calls.push([userId]);
      return { requestId: 'req-1' };
    },
    async broadcast() {
      return { requestId: 'req-1' };
    },
  } as unknown as LineClient;
  return { client, calls, sentUserIds: () => calls.flat() };
}

/**
 * 流れた文を見分けられるようにした D1。
 *
 * `batch` に**何と何が一緒に載ったか**と、条件付き更新が**何行動かしたか**を
 * 読む。どちらも「同時に確定するか」「条件が効いたか」を見るのに要る。
 */
function recordingD1(db: D1Database) {
  const batches: string[][] = [];
  const runs: Array<{ sql: string; changes: number }> = [];
  const original = db.prepare.bind(db);
  const wrapped = {
    ...db,
    prepare(sql: string) {
      const statement = original(sql) as D1PreparedStatement;
      const decorate = (st: D1PreparedStatement): D1PreparedStatement => ({
        ...st,
        __sql: sql,
        bind: (...args: unknown[]) => decorate(st.bind(...args)),
        run: async () => {
          const result = await st.run();
          runs.push({ sql, changes: result.meta?.changes ?? 0 });
          return result;
        },
      } as unknown as D1PreparedStatement);
      return decorate(statement);
    },
    async batch(statements: D1PreparedStatement[]) {
      batches.push(statements.map((st) => (st as unknown as { __sql?: string }).__sql ?? ''));
      return db.batch(statements);
    },
  } as unknown as D1Database;
  return { db: wrapped, batches, runs };
}

function seedAccount(raw: Database.Database): void {
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
     VALUES ('acc1', 'ch1', '店舗1', 'tok1', 'sec1', 1)`,
  ).run();
}

function seedFriends(raw: Database.Database, count: number): void {
  const insert = raw.transaction(() => {
    for (let i = 0; i < count; i++) {
      insertFriend(raw, `f${String(i).padStart(4, '0')}`, { line_account_id: 'acc1' });
    }
  });
  insert();
}

/**
 * 送信中の絞り込み配信。cron（processQueuedBroadcasts）が拾う形。
 *
 * `line_account_id` を入れない。入れるとアカウントの権限札から本物の
 * LineClient が組み立てられ、試験が外の口を叩きに行く。
 */
function seedSendingSegmentBroadcast(raw: Database.Database, id = 'b1'): void {
  raw.prepare(
    `INSERT INTO broadcasts
       (id, title, message_type, message_content, target_type, segment_conditions,
        status, batch_offset, track_links, line_account_id, lock_version, created_at)
     VALUES (?, '案内', 'text', 'こんにちは', 'segment', ?, 'sending', 0, 0, NULL, 1, '2026-09-11T10:00:00.000')`,
  ).run(id, JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] }));
  raw.prepare(`INSERT OR REPLACE INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) SELECT ?,id,line_account_id,'claimed' FROM friends`).run(id);
  raw.prepare('UPDATE broadcasts SET total_count=(SELECT COUNT(*) FROM friends) WHERE id=?').run(id);
}

function ledgerRows(raw: Database.Database, id = 'b1') {
  return raw
    .prepare(`SELECT friend_id, state FROM broadcast_send_claims WHERE broadcast_id = ? ORDER BY friend_id`)
    .all(id) as Array<{ friend_id: string; state: string }>;
}

function broadcastRow(raw: Database.Database, id = 'b1') {
  return raw
    .prepare(`SELECT status, stopped_at, batch_offset, success_count, send_attempt_no FROM broadcasts WHERE id = ?`)
    .get(id) as {
      status: string; stopped_at: string | null; batch_offset: number;
      success_count: number; send_attempt_no: number;
    };
}

/** HTTP の状態番号が付いた失敗。LINE が受け取らなかった（誰にも配られていない）。 */
function rejectedByLine(status: number): Error {
  const err = new Error(`LINE API error: ${status}`);
  Object.assign(err, { status });
  return err;
}

describe('一斉配信の停止（#662）', () => {
  describe('絞り込み配信', () => {
    it('停止すると、送っている束を送り終えたところで止まり、次の束は始めない', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bstop-'));
      const file = join(dir, 'db.sqlite');
      const worker: SqliteD1 = createTestD1({ file });
      // 運用者の停止は**別の接続**から入る。1接続で await を挟むだけでは、
      // 送信中の実行と停止が本当に取り合えているかまでは分からない。
      const operator: SqliteD1 = createTestD1({ file, attach: true });
      try {
        seedAccount(worker.raw);
        seedFriends(worker.raw, 600);
        seedSendingSegmentBroadcast(worker.raw);

        const { client, calls, sentUserIds } = makeLineClient({
          onMulticast: async (_ids, index) => {
            // 1束目を外へ出した直後に停止が入る。
            if (index === 0) {
              await requestBroadcastStop(operator.db, { id: 'b1', expectedVersion: 1 });
            }
          },
        });
        await processQueuedBroadcasts(worker.db, client);

        // 2束目は始まっていない。
        expect(calls).toHaveLength(1);
        expect(sentUserIds()).toHaveLength(500);

        const row = broadcastRow(worker.raw);
        expect(row.status).toBe('sending');
        expect(row.stopped_at).not.toBeNull();
        expect(row.batch_offset).toBe(500);
        expect(row.success_count).toBe(500);

        // 台帳には開始時の600人が在り、外へ出たのは1束目の500人だけ。
        const rows = ledgerRows(worker.raw);
        expect(rows).toHaveLength(600);
        expect(rows.filter(r => r.state === 'sent')).toHaveLength(500);
        expect(rows.filter(r => r.state === 'claimed')).toHaveLength(100);

        // もう一度cronが回っても、停止中の配信は拾わない。
        const second = makeLineClient();
        await processQueuedBroadcasts(worker.db, second.client);
        expect(second.calls).toHaveLength(0);
      } finally {
        worker.raw.close();
        operator.raw.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('再開すると続きから送り、同じ人へ二度送らない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedSendingSegmentBroadcast(raw);

      const first = makeLineClient({
        onMulticast: async (_ids, index) => {
          if (index === 0) await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
        },
      });
      await processQueuedBroadcasts(db, first.client);

      await resumeBroadcastSending(db, { id: 'b1', expectedVersion: 2 });
      const second = makeLineClient();
      await processQueuedBroadcasts(db, second.client);

      const all = [...first.sentUserIds(), ...second.sentUserIds()];
      expect(all).toHaveLength(600);
      expect(new Set(all).size).toBe(600);
      expect(broadcastRow(raw).status).toBe('sent');
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 600, failed: 0, unknown: 0, claimed: 0,
      });
    });

    it('外へ出したまま決着が付かなかった相手は送達不明になり、再送の対象に入らない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedSendingSegmentBroadcast(raw);

      /*
       * Worker が「外へ出した直後・記録の前」に消えた形を作る。押さえだけが
       * 残り、決着が無い。ここで停止が入ると送達不明になる。
       */
      raw.prepare(
        `INSERT OR REPLACE INTO broadcast_send_claims
           (broadcast_id, friend_id, line_account_id, attempt_no, state, dispatched_at, created_at, updated_at)
         VALUES ('b1', 'f0000', 'acc1', 1, 'claimed', '2026-09-11T10:00:00.000',
                 '2026-09-11T10:00:00.000', '2026-09-11T10:00:00.000')`,
      ).run();
      await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
      await closeClaimsForStop(db, 'b1');
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 0, failed: 599, unknown: 1, claimed: 0,
      });

      // 再開して送り直しても、その相手には送らない。
      await resumeBroadcastSending(db, { id: 'b1', expectedVersion: 2 });
      const { client, sentUserIds } = makeLineClient();
      await processQueuedBroadcasts(db, client);
      expect(sentUserIds()).toHaveLength(599);
      expect(sentUserIds()).not.toContain('Uf0000');
    });

    it('断られた相手だけ送り直し、届いた相手へは二度送らない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedSendingSegmentBroadcast(raw);

      // 2束目（100人）が LINE に断られる。要求は届いていて、誰にも配られていない。
      // 送り直すのは一時的な失敗だけなので、429（速度制限）で断る。
      // 400 だと恒常的な失敗になり、送り直しの対象に入らない。
      const first = makeLineClient({
        onMulticast: (_ids, index) => {
          if (index === 1) throw rejectedByLine(429);
        },
      });
      await processQueuedBroadcasts(db, first.client);
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 500, failed: 100, unknown: 0, claimed: 0,
      });

      // 運用者は止めてから送り直す。止めないと、次のcronが同じ束を
      // そのまま送り直そうとする（同じ試行の中の再試行）。
      let version = (raw.prepare(`SELECT lock_version FROM broadcasts WHERE id = 'b1'`).get() as { lock_version: number }).lock_version;
      await requestBroadcastStop(db, { id: 'b1', expectedVersion: version });
      version += 1;
      const attempt = await beginBroadcastRetryAttempt(db, { id: 'b1', expectedVersion: version });
      expect(attempt).toEqual({ changes: 1, attemptNo: 2 });
      await expect(reopenFailedClaims(db, 'b1', 2)).resolves.toBe(100);

      const retry = makeLineClient();
      await processQueuedBroadcasts(db, retry.client);

      // 送り直したのは失敗した100人だけ。
      expect(retry.sentUserIds()).toHaveLength(100);
      const firstSent = new Set(first.sentUserIds().slice(0, 500));
      expect(retry.sentUserIds().some((id) => firstSent.has(id))).toBe(false);
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 600, failed: 0, unknown: 0, claimed: 0,
      });
      expect(broadcastRow(raw).send_attempt_no).toBe(2);
    });

    it('応答が返らなかった相手は送り直さない（二重に届く側へ倒さない）', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedSendingSegmentBroadcast(raw);

      // 状態番号の無い失敗＝網の途中で切れた。LINE が受け取ったあとかもしれない。
      const first = makeLineClient({
        onMulticast: (_ids, index) => {
          if (index === 1) throw new Error('network unreachable');
        },
      });
      await processQueuedBroadcasts(db, first.client);
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 500, failed: 0, unknown: 100, claimed: 0,
      });

      // 送り直す相手がいない。
      await expect(reopenFailedClaims(db, 'b1', 2)).resolves.toBe(0);
      const retry = makeLineClient();
      await processQueuedBroadcasts(db, retry.client);
      expect(retry.sentUserIds()).toHaveLength(0);
    });


    it('束の一部だけが塞がっているとき、送るのも数えるのも残りだけ', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedSendingSegmentBroadcast(raw);

      // 1束目のうち3人は前の試行で決着済み（届いた1人・送達不明2人）。
      for (const [friendId, state] of [['f0000', 'sent'], ['f0001', 'unknown'], ['f0002', 'unknown']] as const) {
        raw.prepare(
          `INSERT OR REPLACE INTO broadcast_send_claims
             (broadcast_id, friend_id, attempt_no, state, dispatched_at, settled_at, created_at, updated_at)
           VALUES ('b1', ?, 1, ?, '2026-09-11T10:00:00.000', '2026-09-11T10:01:00.000',
                   '2026-09-11T10:00:00.000', '2026-09-11T10:01:00.000')`,
        ).run(friendId, state);
      }

      const { client, calls, sentUserIds } = makeLineClient();
      await processQueuedBroadcasts(db, client);

      // 1束目は 500 人ではなく 497 人。
      expect(calls[0]).toHaveLength(500);
      expect(sentUserIds()).not.toContain('Uf0000');
      expect(sentUserIds()).not.toContain('Uf0001');
      // 今回の597人と以前に届いた1人を数え、送達不明の2人は数えない。
      expect(broadcastRow(raw).success_count).toBe(598);
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 598, failed: 0, unknown: 2, claimed: 0,
      });
    });

    it('1人ずつ送る経路でも、送達不明の相手は飛ばす', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 25);
      raw.prepare(
        `INSERT INTO broadcasts
           (id, title, message_type, message_content, target_type, segment_conditions,
            status, batch_offset, track_links, line_account_id, lock_version, created_at)
         VALUES ('b1', '案内', 'text', '{{name}} さんへ', 'segment', ?, 'sending', 0, 0, NULL, 1, '2026-09-11T10:00:00.000')`,
      ).run(JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] }));
      raw.exec("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state) SELECT 'b1',id,'claimed' FROM friends; UPDATE broadcasts SET total_count=25 WHERE id='b1'");
      raw.prepare(
        `INSERT OR REPLACE INTO broadcast_send_claims
           (broadcast_id, friend_id, attempt_no, state, dispatched_at, settled_at, created_at, updated_at)
         VALUES ('b1', 'f0003', 1, 'unknown', '2026-09-11T10:00:00.000', '2026-09-11T10:01:00.000',
                 '2026-09-11T10:00:00.000', '2026-09-11T10:01:00.000')`,
      ).run();

      const { client, sentUserIds } = makeLineClient();
      await processQueuedBroadcasts(db, client);

      expect(sentUserIds()).toHaveLength(24);
      expect(sentUserIds()).not.toContain('Uf0003');
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 24, failed: 0, unknown: 1, claimed: 0,
      });
    });

    it('拾ったあとに停止が入ったら、送信権を取らずに降りる', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bstop-lock-'));
      const file = join(dir, 'db.sqlite');
      const worker: SqliteD1 = createTestD1({ file });
      const operator: SqliteD1 = createTestD1({ file, attach: true });
      try {
        seedAccount(worker.raw);
        seedFriends(worker.raw, 600);
        seedSendingSegmentBroadcast(worker.raw);

        /*
         * 「拾う」と「送信権を取る」のあいだに停止を差し込む。
         *
         * 拾う側の絞り込み（stopped_at IS NULL）だけでは、この隙間を
         * 通り抜けた実行が送り始めてしまう。**送信権を取る条件付き更新に
         * も同じ条件が要る。**
         */
        const recorder = recordingD1(worker.db);
        const original = recorder.db.prepare.bind(recorder.db);
        let injected = false;
        (recorder.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
          const statement = original(sql) as D1PreparedStatement & { all: <T>() => Promise<T> };
          if (!sql.includes("SELECT * FROM broadcasts WHERE status = 'sending'")) return statement;
          const all = statement.all.bind(statement);
          return {
            ...statement,
            all: async <T>() => {
              const result = await all<T>();
              if (!injected) {
                injected = true;
                await requestBroadcastStop(operator.db, { id: 'b1', expectedVersion: 1 });
              }
              return result;
            },
          } as unknown as D1PreparedStatement;
        };

        const { client, calls } = makeLineClient();
        await processQueuedBroadcasts(recorder.db, client);

        expect(injected).toBe(true);
        expect(calls).toHaveLength(0);
        expect(ledgerRows(worker.raw)).toHaveLength(600);
        // **送信権を取る条件付き更新が1行も動かしていない。**
        // 束ごとの停止確認だけでは、いったん取った権利を返すだけで
        // 「取らなかった」ことにはならない。
        const lockRuns = recorder.runs.filter((r) => r.sql.includes('SET batch_offset = -1'));
        expect(lockRuns).toHaveLength(1);
        expect(lockRuns[0].changes).toBe(0);
        expect(broadcastRow(worker.raw).batch_offset).toBe(0);
      } finally {
        worker.raw.close();
        operator.raw.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });


    it('送達の記録と台帳の決着を、同じひとまとめで確定させる', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 20);
      seedSendingSegmentBroadcast(raw);

      const recorder = recordingD1(db);
      const { client } = makeLineClient();
      await processQueuedBroadcasts(recorder.db, client);

      /*
       * 分けて流すと、送達の記録だけ残って台帳が押さえたままの窓ができる。
       * その相手は停止のときに「届いたのに送達不明」へ倒れ、再送の対象から
       * 外れたまま台帳に残る。
       */
      const deliveryBatch = recorder.batches.find((sqls) =>
        sqls.some((sql) => sql.includes('INSERT INTO messages_log')),
      );
      expect(deliveryBatch).toBeDefined();
      expect(deliveryBatch!.filter((sql) => sql.includes('INSERT INTO messages_log'))).toHaveLength(20);
      expect(deliveryBatch!.filter((sql) => sql.includes('UPDATE broadcast_send_claims'))).toHaveLength(20);
    });

    it('cronが2本同時に回っても、束は一度しか外へ出ない', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bstop-race-'));
      const file = join(dir, 'db.sqlite');
      const a: SqliteD1 = createTestD1({ file });
      const b: SqliteD1 = createTestD1({ file, attach: true });
      try {
        seedAccount(a.raw);
        seedFriends(a.raw, 600);
        seedSendingSegmentBroadcast(a.raw);

        const first = makeLineClient();
        const second = makeLineClient();
        await Promise.all([
          processQueuedBroadcasts(a.db, first.client),
          processQueuedBroadcasts(b.db, second.client),
        ]);

        const all = [...first.sentUserIds(), ...second.sentUserIds()];
        expect(all).toHaveLength(600);
        expect(new Set(all).size).toBe(600);
      } finally {
        a.raw.close();
        b.raw.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('タグ配信（その場で送り切る経路）', () => {
    function seedTagBroadcast(raw: Database.Database): void {
      raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag1', '見込み', 'acc1')`).run();
      raw.prepare(
        `INSERT INTO friend_tags (friend_id, tag_id)
         SELECT id, 'tag1' FROM friends`,
      ).run();
      raw.prepare(
        `INSERT INTO broadcasts
           (id, title, message_type, message_content, target_type, target_tag_id,
            status, batch_offset, track_links, line_account_id, lock_version, created_at)
         VALUES ('b1', '案内', 'text', 'こんにちは', 'tag', 'tag1', 'sending', 0, 0, 'acc1', 1, '2026-09-11T10:00:00.000')`,
      ).run();
    }

    it('その場送信の停止と再送が重なっても、古い実行は同じ相手に送らない', async () => {
      const {db,raw}=createTestD1();
      try {
        seedAccount(raw); seedFriends(raw,1); seedTagBroadcast(raw);
        let release!:()=>void; let reached!:()=>void;
        const gate=new Promise<void>(r=>{release=r;}); const paused=new Promise<void>(r=>{reached=r;});
        let held=false;
        const oldDb={...db,prepare(sql:string) {
          const stmt=db.prepare(sql);
          if (!sql.includes('SELECT DISTINCT friend_id FROM friend_delivery_consents')) return stmt;
          return {...stmt, bind(...args:unknown[]) {
            const bound=stmt.bind(...args);
            return {...bound, async all() {
              if (!held) {held=true; reached(); await gate;}
              return bound.all();
            }};
          }} as D1PreparedStatement;
        }} as D1Database;
        const old=makeLineClient(); const oldRun=processBroadcastSend(oldDb,old.client,'b1');
        await paused;
        expect(await requestBroadcastStop(db,{id:'b1',expectedVersion:1})).toBe(1);
        await closeClaimsForStop(db,'b1');
        expect(await beginBroadcastRetryAttempt(db,{id:'b1',expectedVersion:2})).toEqual({changes:1,attemptNo:2});
        expect(await reopenFailedClaims(db,'b1',2)).toBe(1);
        await markBroadcastRecipientsDispatched(db,{broadcastId:'b1',attemptNo:2,lineAccountId:'acc1',friendIds:['f0000']});
        await settleBroadcastRecipients(db,{broadcastId:'b1',friendIds:['f0000'],state:'sent'});
        release(); await oldRun;
        expect(old.sentUserIds()).toEqual([]);
        expect(broadcastRow(raw)).toMatchObject({status:'sending',send_attempt_no:2});
      } finally {raw.close();}
    });

    it('停止すると次の束を始めず、送信済みにもしない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedTagBroadcast(raw);

      const { client, calls } = makeLineClient({
        onMulticast: async (_ids, index) => {
          if (index === 0) await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
        },
      });
      await processBroadcastSend(db, client, 'b1');

      expect(calls).toHaveLength(1);
      const row = broadcastRow(raw);
      expect(row.status).toBe('sending');
      expect(row.stopped_at).not.toBeNull();
      expect(ledgerRows(raw)).toHaveLength(600);
      expect(ledgerRows(raw).filter(r=>r.state==='claimed')).toHaveLength(100);
    });

    it('断られた束の相手が台帳に残り、再送の対象になる', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedTagBroadcast(raw);

      const { client } = makeLineClient({
        onMulticast: (_ids, index) => {
          if (index === 1) throw rejectedByLine(400);
        },
      });
      await processBroadcastSend(db, client, 'b1');

      // 失敗した宛先を保存し、再送の対象を特定できることを確かめる。
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 500, failed: 100, unknown: 0, claimed: 0,
      });
      expect(broadcastRow(raw).status).toBe('sent');
    });
  });

  describe('複数アカウントの重複除外配信', () => {
    /*
     * この経路は自前の進捗（identKey の集合）で再開するが、**送れなかった人・
     * 外へ出たか分からない人**は覚えていない。停止が束の切れ目で効くこと、
     * 送達台帳が閉じることを、送信本体（processMultiAccountDedupBroadcast）へ
     * 直に当てて確かめる。cron 経由だと本物の LineClient が組み立てられて
     * 外の口を叩きに行くため、ここは差し替え口（factory）を使う。
     */
    function seedDedupBroadcast(raw: Database.Database): void {
      raw.prepare(
        `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
         VALUES ('acc2', 'ch2', '店舗2', 'tok2', 'sec2', 1)`,
      ).run();
      raw.prepare(
        `INSERT INTO broadcasts
           (id, title, message_type, message_content, target_type, account_ids, dedup_priority,
            status, batch_offset, track_links, lock_version, created_at)
         VALUES ('b1', '案内', 'text', 'こんにちは', 'multi-account-dedup', '["acc1","acc2"]', '["acc1","acc2"]',
                 'sending', 0, 0, 1, '2026-09-11T10:00:00.000')`,
      ).run();
    }

    const dedupBroadcastArg = {
      id: 'b1',
      account_ids: '["acc1","acc2"]',
      dedup_priority: '["acc1","acc2"]',
      message_type: 'text',
      message_content: 'こんにちは',
    };

    it('停止すると次の束を始めず、完了にもしない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedDedupBroadcast(raw);

      const { client, calls } = makeLineClient({
        onMulticast: async (_ids, index) => {
          if (index === 0) await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
        },
      });
      const result = await processMultiAccountDedupBroadcast(db, dedupBroadcastArg, () => client);

      expect(calls).toHaveLength(1);
      expect(result.stopped).toBe(true);
      // complete=false なので、呼び出し側は送信済みにしない。
      expect(result.complete).toBe(false);
      // 台帳には開始時の600人が在り、外へ出たのは1束目の500人だけ。
      const rows = ledgerRows(raw);
      expect(rows).toHaveLength(500);
      expect(new Set(rows.map((r) => r.state))).toEqual(new Set(['sent']));
    });

    it('再開すると続きから送り、同じ人へ二度送らない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedDedupBroadcast(raw);

      const first = makeLineClient({
        onMulticast: async (_ids, index) => {
          if (index === 0) await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
        },
      });
      await processMultiAccountDedupBroadcast(db, dedupBroadcastArg, () => first.client);
      await resumeBroadcastSending(db, { id: 'b1', expectedVersion: 2 });

      const progress = (raw.prepare(`SELECT dedup_progress FROM broadcasts WHERE id = 'b1'`).get() as {
        dedup_progress: string | null;
      }).dedup_progress;
      const second = makeLineClient();
      const result = await processMultiAccountDedupBroadcast(
        db,
        { ...dedupBroadcastArg, dedup_progress: progress },
        () => second.client,
      );

      const all = [...first.sentUserIds(), ...second.sentUserIds()];
      expect(all).toHaveLength(600);
      expect(new Set(all).size).toBe(600);
      expect(result.complete).toBe(true);
      expect(result.stopped).toBe(false);
      expect(await countBroadcastLedger(db, 'b1')).toEqual({
        sent: 600, failed: 0, unknown: 0, claimed: 0,
      });
    });

    it('外へ出たまま止まった相手は送達不明になり、再開しても送らない', async () => {
      const { db, raw } = createTestD1();
      seedAccount(raw);
      seedFriends(raw, 600);
      seedDedupBroadcast(raw);

      const first = makeLineClient({
        onMulticast: async (_ids, index) => {
          if (index === 0) await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
        },
      });
      await processMultiAccountDedupBroadcast(db, dedupBroadcastArg, () => first.client);

      // 2束目の1人が「外へ出したまま決着なし」で残っていた形にする。
      raw.prepare(
        `INSERT OR REPLACE INTO broadcast_send_claims
           (broadcast_id, friend_id, line_account_id, attempt_no, state, dispatched_at, created_at, updated_at)
         VALUES ('b1', 'f0599', 'acc1', 1, 'claimed', '2026-09-11T10:00:00.000',
                 '2026-09-11T10:00:00.000', '2026-09-11T10:00:00.000')`,
      ).run();
      await closeClaimsForStop(db, 'b1');
      await resumeBroadcastSending(db, { id: 'b1', expectedVersion: 2 });

      const progress = (raw.prepare(`SELECT dedup_progress FROM broadcasts WHERE id = 'b1'`).get() as {
        dedup_progress: string | null;
      }).dedup_progress;
      const second = makeLineClient();
      await processMultiAccountDedupBroadcast(
        db,
        { ...dedupBroadcastArg, dedup_progress: progress },
        () => second.client,
      );
      expect(second.sentUserIds()).not.toContain('Uf0599');
      expect(second.sentUserIds()).toHaveLength(99);
    });
  });
});

describe('停止と再送の件数（全経路）', () => {
  // 停止 → 再開 → 失敗分の再送 を通しで動かし、**届いた人の総数が
  // 母集団と一致し、誰も2通受け取らない**ことを経路ごとに確かめる。
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bcount-'));
  });

  it('絞り込み配信: 停止→再開→失敗分再送 で 600人に1通ずつ', async () => {
    const { db, raw } = createTestD1();
    seedAccount(raw);
    seedFriends(raw, 600);
    seedSendingSegmentBroadcast(raw);

    // 1束目で停止
    const t1 = makeLineClient({
      onMulticast: async (_ids, index) => {
        if (index === 0) await requestBroadcastStop(db, { id: 'b1', expectedVersion: 1 });
      },
    });
    await processQueuedBroadcasts(db, t1.client);

    // 再開したら2束目が断られる
    await resumeBroadcastSending(db, { id: 'b1', expectedVersion: 2 });
    const t2 = makeLineClient({ onMulticast: () => { throw rejectedByLine(429); } });
    await processQueuedBroadcasts(db, t2.client);
    expect(await countBroadcastLedger(db, 'b1')).toEqual({
      sent: 500, failed: 100, unknown: 0, claimed: 0,
    });

    // 失敗した相手だけ送り直す
    let version = (raw.prepare(`SELECT lock_version FROM broadcasts WHERE id = 'b1'`).get() as { lock_version: number }).lock_version;
    await requestBroadcastStop(db, { id: 'b1', expectedVersion: version });
    version += 1;
    const attempt = await beginBroadcastRetryAttempt(db, { id: 'b1', expectedVersion: version });
    expect(attempt.attemptNo).toBe(2);
    await reopenFailedClaims(db, 'b1', attempt.attemptNo!);
    const t3 = makeLineClient();
    await processQueuedBroadcasts(db, t3.client);

    const delivered = [...t1.sentUserIds(), ...t3.sentUserIds()];
    expect(delivered).toHaveLength(600);
    expect(new Set(delivered).size).toBe(600);
    expect(await countBroadcastLedger(db, 'b1')).toEqual({
      sent: 600, failed: 0, unknown: 0, claimed: 0,
    });
    expect(broadcastRow(raw).status).toBe('sent');
  });
});

it('タグ配信は非表示・ブロック中・別店の相手を送らず、事前人数と一致する', async () => {
  const { db, raw } = createTestD1();
  try {
    seedAccount(raw);
    insertFriend(raw, 'shown', { line_account_id: 'acc1' });
    insertFriend(raw, 'hidden', { line_account_id: 'acc1', is_hidden: 1 });
    insertFriend(raw, 'blocked', { line_account_id: 'acc1', is_following: 0 });
    insertFriend(raw, 'other', { line_account_id: 'other-account' });
    raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('target','Target','acc1'); INSERT INTO friend_tags(friend_id,tag_id) SELECT id,'target' FROM friends;");
    raw.exec("INSERT INTO broadcasts(id,title,message_type,message_content,target_type,target_tag_id,status,track_links,line_account_id) VALUES('hidden-check','Check','text','Hello','tag','target','draft',0,'acc1')");
    const { countAudience } = await import('./broadcast-preflight.js');
    const counted = await countAudience(db, { targetType: 'tag', targetTagId: 'target', lineAccountId: 'acc1' });
    const { client, sentUserIds } = makeLineClient();
    await processBroadcastSend(db, client, 'hidden-check');
    expect(sentUserIds()).toEqual(['Ushown']);
    expect(sentUserIds().length).toBe(counted.total);
    expect(counted.hiddenExcluded).toBe(1);
    expect(raw.prepare("SELECT total_count,success_count FROM broadcasts WHERE id='hidden-check'").get())
      .toEqual({ total_count: 1, success_count: 1 });
  } finally { raw.close(); }
});

describe('友だちの配信停止・同意を送信前に参照',()=>{
 it('キュー配信は停止した人を送らず、別の人は送り、未送信理由を残す',async()=>{
  const fixture=createTestD1();seedAccount(fixture.raw);seedFriends(fixture.raw,2);seedSendingSegmentBroadcast(fixture.raw);
  fixture.raw.exec("INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('acc1','f0000','marketing','revoked','停止希望','manual')");
  const line=makeLineClient();await processQueuedBroadcasts(fixture.db,line.client);
  const stopped=fixture.raw.prepare("SELECT line_user_id FROM friends WHERE id='f0000'").get() as {line_user_id:string};
  expect(line.sentUserIds()).not.toContain(stopped.line_user_id);expect(line.sentUserIds()).toHaveLength(1);
  expect(fixture.raw.prepare("SELECT state,error_code,dispatched_at FROM broadcast_send_claims WHERE friend_id='f0000'").get()).toEqual({state:'failed',error_code:'delivery_consent_suppressed',dispatched_at:null});
  fixture.raw.close();
 });
});
