import { jstNow } from './utils.js';
import { DELIVERY_CONSENT_ALLOWED_SQL } from './friend-delivery-consents.js';

/**
 * 一斉配信の送達台帳。
 *
 * 配信×相手で1行。**「送ったかどうか」を、送る前と送った後の2回に分けて
 * 書く**のが要点。
 *
 *   claimed  … この試行で送る相手として押さえた。まだ外へ出していない
 *   sent     … 外へ出て、受け付けられた
 *   failed   … 外へ出たが断られた／外へ出す前に止まった。**送り直してよい**
 *   unknown  … 外へ出したところで結果が分からなくなった。**送り直さない**
 *
 * unknown を送り直さないのは、この現場の既定が at-most-once だから。
 * 二重に届くと相手のトークに残って取り消せないが、1回分欠けたほうは
 * この台帳に `unknown` として残るので、こちら側で気づいて手当てできる。
 */
export type BroadcastSendClaimState = 'claimed' | 'sent' | 'failed' | 'unknown';

export interface BroadcastLedgerCounts {
  /** 送達を確かめられた相手。 */
  sent: number;
  /** 送れなかったと断定できた相手。再送の対象。 */
  failed: number;
  /** 外へ出たかもしれないが確かめられない相手。再送の対象にしない。 */
  unknown: number;
  /** まだ決着していない相手（送信中の tick が抱えている）。 */
  claimed: number;
}

/**
 * この配信で「もう送ってはいけない相手」の集合。
 *
 * 送達済み（sent）と送達不明（unknown）。**1回のクエリで配信ぶんをまとめて
 * 引く。**相手の id を並べて `IN (...)` で引くと、D1 の 100 個という
 * バインド上限に当たる（500人ぶん並べた瞬間に落ちる）。
 */
export async function getBlockedRecipientIds(
  db: D1Database,
  broadcastId: string,
): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT friend_id FROM broadcast_send_claims
        WHERE broadcast_id = ? AND state IN ('sent', 'unknown')`,
    )
    .bind(broadcastId)
    .all<{ friend_id: string }>();
  return new Set((rows.results ?? []).map((row) => row.friend_id));
}

/**
 * 再送の対象（一時的な失敗だけ）。
 *
 * failed のうち、送り直す意味がある理由（混み合い・止める前で未送信）だけ。
 * ブロック・友だち解除などの恒常的な失敗は送り直しても通らないので入れない。
 * unknown と sent は入らない（at-most-once）。
 */
export async function getRetryableRecipientIds(
  db: D1Database,
  broadcastId: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT friend_id FROM broadcast_send_claims
        WHERE broadcast_id = ? AND state = 'failed'
          AND error_code IN ('line_http_429', 'stopped_before_dispatch')
        ORDER BY friend_id`,
    )
    .bind(broadcastId)
    .all<{ friend_id: string }>();
  return (rows.results ?? []).map((row) => row.friend_id);
}

export async function countBroadcastLedger(
  db: D1Database,
  broadcastId: string,
): Promise<BroadcastLedgerCounts> {
  const rows = await db
    .prepare(
      `SELECT state, COUNT(*) AS cnt FROM broadcast_send_claims
        WHERE broadcast_id = ? AND COALESCE(error_code,'') NOT LIKE 'simulation_%' GROUP BY state`,
    )
    .bind(broadcastId)
    .all<{ state: BroadcastSendClaimState; cnt: number }>();
  const counts: BroadcastLedgerCounts = { sent: 0, failed: 0, unknown: 0, claimed: 0 };
  for (const row of rows.results ?? []) {
    if (row.state in counts) counts[row.state] = Number(row.cnt);
  }
  return counts;
}

export interface MarkDispatchedInput {
  broadcastId: string;
  attemptNo: number;
  lineAccountId: string | null;
  friendIds: string[];
  /** キュー処理が取得した版。復旧や停止後の古い処理は送信できない。 */
  expectedLockVersion?: number;
  expectedRecipients?: Array<{ id: string; lineUserId: string }>;
  at?: string;
}

/**
 * 外へ出す**直前**に「出す」と書く。
 *
 * ここを送信のあとに回すと、送信と記録のあいだで Worker が消えたときに
 * 「届いたのに台帳は空」になる。次の試行がその相手を再送対象と読んで、
 * 同じ人へ2通目が出る。**先に書くから、消えても unknown として残る。**
 *
 * 1文ずつに分けて `batch` で流すのは、D1 のバインド上限（100）に当てない
 * ため。1行あたり7個なので、まとめて VALUES に並べると14行で超える。
 *
 * 送達済み・送達不明の行には**書かない**（`WHERE` で弾く）。停止をまたいだ
 * 再送でも、既に外へ出た相手を押さえ直すことはない。
 */
export async function markBroadcastRecipientsDispatched(
  db: D1Database,
  input: MarkDispatchedInput,
): Promise<string[]> {
  if (input.friendIds.length === 0) return [];
  const now = input.at ?? jstNow();
  if (input.expectedLockVersion !== undefined) {
    const statements=input.friendIds.map(friendId=>db.prepare(`UPDATE broadcast_send_claims
      SET state='claimed',attempt_no=?,dispatched_at=?,settled_at=NULL,error_code=NULL,updated_at=?
      WHERE broadcast_id=? AND friend_id=? AND ((state='claimed' AND dispatched_at IS NULL)
        OR (state='failed' AND error_code IN ('line_http_429','stopped_before_dispatch') AND attempt_no=?))
      AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND status='sending' AND stopped_at IS NULL AND batch_offset=-1 AND lock_version=?)`)
      .bind(input.attemptNo,now,now,input.broadcastId,friendId,input.attemptNo,input.broadcastId,input.expectedLockVersion));
    if (input.expectedRecipients) {
      if (input.expectedRecipients.length !== input.friendIds.length || input.expectedRecipients.some((item,index) => item.id !== input.friendIds[index])) return [];
      const guard=db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND status='sending' AND stopped_at IS NULL AND batch_offset=-1 AND lock_version=?)
        AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(
          SELECT 1 FROM friends f JOIN broadcast_send_claims c ON c.friend_id=f.id AND c.broadcast_id=?
          WHERE f.id=json_extract(e.value,'$.id') AND f.line_user_id=json_extract(e.value,'$.lineUserId')
            AND f.line_account_id IS ? AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND (${DELIVERY_CONSENT_ALLOWED_SQL})
            AND ((c.state='claimed' AND c.dispatched_at IS NULL) OR (c.state='failed' AND c.error_code IN ('line_http_429','stopped_before_dispatch') AND c.attempt_no=?))))
        THEN 1 ELSE json('HQ_RECIPIENT_CHANGED') END`)
        .bind(input.broadcastId,input.expectedLockVersion,JSON.stringify(input.expectedRecipients),input.broadcastId,input.lineAccountId,input.attemptNo);
      try {
        const results=await db.batch([guard,...statements]);
        return input.friendIds.filter((_,i)=>(results[i+1].meta.changes??0)>0);
      } catch (error) {
        if (error instanceof Error && /malformed json/i.test(error.message)) return [];
        throw error;
      }
    }
    const results=await db.batch(statements);
    return input.friendIds.filter((_,i)=>(results[i].meta.changes??0)>0);
  }
  const statements = input.friendIds.map((friendId) =>
    db
      .prepare(
        `INSERT INTO broadcast_send_claims
           (broadcast_id, friend_id, line_account_id, attempt_no, state, dispatched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?)
         ON CONFLICT (broadcast_id, friend_id) DO UPDATE SET
           line_account_id = excluded.line_account_id,
           attempt_no      = excluded.attempt_no,
           state           = 'claimed',
           dispatched_at   = excluded.dispatched_at,
           settled_at      = NULL,
           error_code      = NULL,
           updated_at      = excluded.updated_at
         WHERE broadcast_send_claims.state NOT IN ('sent', 'unknown')`,
      )
      .bind(
        input.broadcastId,
        friendId,
        input.lineAccountId,
        input.attemptNo,
        now,
        now,
        now,
      ),
  );
  await db.batch(statements);
  return input.friendIds;
}

export interface SettleInput {
  broadcastId: string;
  friendIds: string[];
  /**
   * 決着。`claimed` へは戻せない（押さえ直しは markBroadcastRecipientsDispatched）。
   * `unknown` は送信側が「外へ出たが結果が読めない」と判断したときに使う。
   */
  state: Extract<BroadcastSendClaimState, 'sent' | 'failed' | 'unknown'>;
  errorCode?: string | null;
  /**
   * LINE の要求 ID（応答ヘッダー）。`sent` のときだけ書き込む。
   * 応答に無いときは null のまま残し、代わりの値を作らない。
   */
  lineRequestId?: string | null;
  at?: string;
}

/**
 * 決着を書く文を組み立てて返す（実行はしない）。
 *
 * 呼び出し側が messages_log の追記と**同じ `batch`** に載せられるようにする
 * ため。別々に流すと、送達の記録だけ残って台帳が claimed のまま——つまり
 * 「届いたのに送達不明」——になる窓ができる。
 *
 * 決着の向きで条件を変えてある。
 *
 *   sent   … `claimed` に加えて `unknown` も上書きしてよい。外の口が「受け
 *            取った」と返したあとに書くので、送達不明だった行が確かに届いて
 *            いたと分かった、という向きの訂正になる。再送の対象から外れる点は
 *            どちらでも同じなので、二重送信は増えない
 *   failed … `claimed` だけ。unknown を failed へ落とすと**再送の対象に
 *            戻ってしまう**。外へ出たかもしれない相手を送り直す側へ倒すのは、
 *            この現場の既定（at-most-once）の逆
 */
export function buildBroadcastSettleStatements(
  db: D1Database,
  input: SettleInput,
): D1PreparedStatement[] {
  const now = input.at ?? jstNow();
  const allowed = input.state === 'sent' ? "'claimed', 'unknown'" : "'claimed'";
  // 要求 ID は「届いた」ときだけ残す。失敗・不明の行に要求 ID を書くと、
  // 「送った証拠があるのに失敗」と読めてしまう。
  const stampRequestId = input.state === 'sent' && input.lineRequestId != null;
  return input.friendIds.map((friendId) =>
    db
      .prepare(
        stampRequestId
          ? `UPDATE broadcast_send_claims
              SET state = ?, settled_at = ?, error_code = ?, line_request_id = ?, updated_at = ?
            WHERE broadcast_id = ? AND friend_id = ? AND state IN (${allowed})`
          : `UPDATE broadcast_send_claims
              SET state = ?, settled_at = ?, error_code = ?, updated_at = ?
            WHERE broadcast_id = ? AND friend_id = ? AND state IN (${allowed})`,
      )
      .bind(
        ...(stampRequestId
          ? [input.state, now, input.errorCode ?? null, input.lineRequestId, now, input.broadcastId, friendId]
          : [input.state, now, input.errorCode ?? null, now, input.broadcastId, friendId]),
      ),
  );
}

export async function settleBroadcastRecipients(
  db: D1Database,
  input: SettleInput,
): Promise<void> {
  if (input.friendIds.length === 0) return;
  await db.batch(buildBroadcastSettleStatements(db, input));
}

/**
 * 停止を受け付けたときの台帳の締め。
 *
 * - 外へ出したあとで決着していない行 → **unknown**。成功とも失敗とも
 *   断定しない。再送の対象にしない
 * - 外へ出す前に押さえただけの行 → **failed**。まだ誰にも届いていないので
 *   送り直してよい
 *
 * 返すのはそれぞれの件数。停止の応答と監査記録に載せる。
 */
export async function closeClaimsForStop(
  db: D1Database,
  broadcastId: string,
  at?: string,
): Promise<{ unknown: number; failed: number }> {
  const now = at ?? jstNow();
  const unknownResult = await db
    .prepare(
      `UPDATE broadcast_send_claims
          SET state = 'unknown', settled_at = ?, error_code = 'stopped_mid_dispatch', updated_at = ?
        WHERE broadcast_id = ? AND state = 'claimed' AND dispatched_at IS NOT NULL`,
    )
    .bind(now, now, broadcastId)
    .run();
  const failedResult = await db
    .prepare(
      `UPDATE broadcast_send_claims
          SET state = 'failed', settled_at = ?, error_code = 'stopped_before_dispatch', updated_at = ?
        WHERE broadcast_id = ? AND state = 'claimed' AND dispatched_at IS NULL`,
    )
    .bind(now, now, broadcastId)
    .run();
  return {
    unknown: unknownResult.meta.changes ?? 0,
    failed: failedResult.meta.changes ?? 0,
  };
}

/**
 * 再送の試行を開始する（一時的な失敗だけを新しい試行番号で押さえ直す）。
 *
 * `dispatched_at` を NULL に戻すのは、この行が**まだ外へ出ていない**から。
 * sent / unknown の行には触れない。恒常的な失敗（ブロックなど）も触れない——
 * 送り直しても通らない相手へ送らない。
 */
export async function reopenFailedClaims(
  db: D1Database,
  broadcastId: string,
  attemptNo: number,
  at?: string,
): Promise<number> {
  const now = at ?? jstNow();
  const result = await db
    .prepare(
      `UPDATE broadcast_send_claims
          SET state = 'claimed', attempt_no = ?, dispatched_at = NULL,
              settled_at = NULL, error_code = NULL, updated_at = ?
        WHERE broadcast_id = ? AND state = 'failed'
          AND error_code IN ('line_http_429', 'stopped_before_dispatch')`,
    )
    .bind(attemptNo, now, broadcastId)
    .run();
  return result.meta.changes ?? 0;
}
