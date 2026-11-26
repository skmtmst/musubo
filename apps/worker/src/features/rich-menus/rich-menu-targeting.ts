import { logger } from '@line-crm/shared/server';
import {
  getRichMenuTargetingCandidates,
  recordRichMenuAssignment,
  type RichMenuTargetingCandidate,
} from '@line-crm/db';

import { LineClient } from '@line-crm/line-sdk';
import { matchesCondition, parseCondition } from '../../services/segment-query.js';

// 友だちごとに出すメニューを切り替える。
//
// タグが付いた・友だちが増えた・購入があった、といったタイミングで呼ばれ、
// 「いまこの人に出すべきメニュー」を選び直す。
//
// 見る順は targeting_priority の小さい順。**最初に当てはまった1つ**を出す。
// 全部を見て最後に決めるのではなく、当たった時点で止めるのは、運用者が
// 「上にあるものが優先」と読むため。一覧の並びと動きを一致させる。
//
// どれにも当てはまらない場合は、その人に個別に貼ってあるメニューを剥がす。
// 剥がすと、LINE 側の「全員のデフォルト」に戻る。剥がさないと、条件から
// 外れた人にいつまでも古いメニューが出たままになる。

/** 出し分けを見直すきっかけになるイベント。 */
const TRIGGER_EVENTS = new Set(['tag_change', 'friend_add', 'cv_fire']);

export function isTargetingTrigger(eventType: string): boolean {
  return TRIGGER_EVENTS.has(eventType);
}

export type TargetingOutcome =
  | { kind: 'linked'; groupId: string; richMenuId: string }
  | { kind: 'unlinked' }
  | { kind: 'skipped'; reason: string };

/**
 * 条件に当てはまる最初のメニューを返す。
 *
 * 壊れた条件（読めない JSON）は飛ばす。全員に当たったことにして配ってしまうより、
 * そのメニューだけ無かったことにするほうが害が小さい。
 */
export async function pickMenuForFriend(
  db: D1Database,
  friendId: string,
  candidates: RichMenuTargetingCandidate[],
): Promise<RichMenuTargetingCandidate | null> {
  for (const candidate of candidates) {
    const condition = parseCondition(candidate.condition);
    if (!condition) {
      logger.warn("services_rich_menu_targeting_warn");
      continue;
    }
    if (await matchesCondition(db, friendId, condition)) return candidate;
  }
  return null;
}

export async function applyRichMenuTargeting(
  db: D1Database,
  friendId: string,
  accountId: string,
  lineAccessToken: string,
): Promise<TargetingOutcome> {
  const candidates = await getRichMenuTargetingCandidates(db, accountId);
  if (candidates.length === 0) return { kind: 'skipped', reason: 'no rules' };

  const friend = await db
    .prepare('SELECT line_platform_user_id AS line_user_id FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ line_user_id: string }>();
  if (!friend) return { kind: 'skipped', reason: 'friend not found' };

  const picked = await pickMenuForFriend(db, friendId, candidates);
  const line = new LineClient(lineAccessToken);

  if (picked?.lineRichMenuId) {
    await line.linkRichMenuToUser(friend.line_user_id, picked.lineRichMenuId);
    await recordRichMenuAssignment(db, {
      friendId,
      lineAccountId: accountId,
      lineRichMenuId: picked.lineRichMenuId,
      reasonKind: 'targeting_rule',
    });
    return { kind: 'linked', groupId: picked.groupId, richMenuId: picked.lineRichMenuId };
  }

  // どれにも当てはまらない。個別に貼ってあるものを剥がして、全員のデフォルトに戻す。
  // 貼られていないときに剥がしても LINE は 404 を返すだけなので、そこは黙って流す。
  try {
    await line.unlinkRichMenuFromUser(friend.line_user_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('404')) throw err;
  }
  await recordRichMenuAssignment(db, {
    friendId,
    lineAccountId: accountId,
    lineRichMenuId: null,
    reasonKind: 'targeting_rule_fallback',
  });
  return { kind: 'unlinked' };
}
