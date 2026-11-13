import { getNenRankRules, getNenRankSettings, jstNow, type NenRankSetting } from '@line-crm/db';


export class NenRankDeleteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly currentCount?:number) { super(message); }
}

export type ConfirmedRankMember={friendId:string;customerId:string|null};
export async function rankDeleteMembers(db:D1Database,accountId:string,rankKey:string):Promise<ConfirmedRankMember[]> {
  return (await db.prepare(`SELECT s.friend_id AS friendId,s.customer_id AS customerId FROM nen_ec_member_snapshots s JOIN friends f ON f.id=s.friend_id
    WHERE f.line_account_id=? AND s.member_rank_key=? ORDER BY s.friend_id`).bind(accountId,rankKey).all<ConfirmedRankMember>()).results;
}

// ECから届いたランクキーだけを移し替えの対象にする。
const effectiveRank = 's.member_rank_key';

export async function countRankMembers(db: D1Database, accountId: string, rankKey: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM nen_ec_member_snapshots s JOIN friends f ON f.id = s.friend_id
    WHERE f.line_account_id = ? AND ${effectiveRank} = ?`).bind(accountId, rankKey).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 会員・タグ・設定の版・ECへの送信待ちを同じトランザクションで変更する。 */
export async function deleteNenRank(
  db: D1Database, accountId: string, rankId: string, replacementRankId: string | null, expectedVersion: number,
  prepareTags: (ranks: NenRankSetting[], now: string) => Promise<NenRankSetting[]>,
  actor: string, confirmedMembers?:ConfirmedRankMember[],
) {
  const [ranks, rules] = await Promise.all([getNenRankSettings(db, accountId), getNenRankRules(db, accountId)]);
  const source = ranks.find((rank) => rank.id === rankId);
  if (!source) throw new NenRankDeleteError('削除するランクが見つかりません', confirmedMembers===undefined?404:409,confirmedMembers===undefined?undefined:0);
  if (!rules || rules.version !== expectedVersion) throw new NenRankDeleteError('版が変わりました。読み直してから削除してください', 409,confirmedMembers===undefined?undefined:await countRankMembers(db,accountId,source.rank_key));
  if(confirmedMembers!==undefined){
    const current=await rankDeleteMembers(db,accountId,source.rank_key);
    const expected=new Map(confirmedMembers.map(member=>[member.friendId,member.customerId]));
    if(current.length!==expected.size||current.some(member=>!expected.has(member.friendId)||member.customerId!==expected.get(member.friendId)))throw new NenRankDeleteError('会員が変わりました。読み直してから削除してください',409,current.length);
  }
  if (source.annual_threshold_yen === 0) throw new NenRankDeleteError('しきい値が0円のランクは削除できません', 409);
  const target = ranks.find((rank) => rank.id === replacementRankId);
  if (replacementRankId && (!target || target.id === source.id)) throw new NenRankDeleteError('移す先は同じアカウントの別のランクを選んでください', 400);
  if (!target && await countRankMembers(db, accountId, source.rank_key) > 0) throw new NenRankDeleteError('会員がいるランクには移す先が必要です', 400);
  const now = jstNow();
  const prepared = await prepareTags(target ? [source, target] : [source], now);
  const sourceTag = prepared[0]!.tag_id;
  const targetTag = prepared[1]?.tag_id;
  // batch内だけの印。失敗した版検査の後続SQLが、他の削除を実行しないようにする。
  const operation = crypto.randomUUID();
  const gate = `EXISTS (SELECT 1 FROM nen_rank_rules WHERE line_account_id = ? AND sync_error = ?)`;
  const members = `SELECT s.friend_id FROM nen_ec_member_snapshots s JOIN friends f ON f.id = s.friend_id
    WHERE f.line_account_id = ? AND ${effectiveRank} = ?`;
  const snapshotGuard=confirmedMembers===undefined?'':` AND (SELECT COUNT(*) FROM (${members}))=json_array_length(?)
    AND NOT EXISTS (SELECT 1 FROM nen_ec_member_snapshots s JOIN friends f ON f.id=s.friend_id
      WHERE f.line_account_id=? AND s.member_rank_key=? AND NOT EXISTS
        (SELECT 1 FROM json_each(?) expected WHERE json_extract(expected.value,'$.friendId')=s.friend_id AND json_extract(expected.value,'$.customerId') IS s.customer_id))`;
  const snapshotBinds=confirmedMembers===undefined?[]:[accountId,source.rank_key,JSON.stringify(confirmedMembers),accountId,source.rank_key,JSON.stringify(confirmedMembers)];
  const statements = [db.prepare(`UPDATE nen_rank_rules SET version = version + 1, sync_status = 'pending', sync_error = ?, updated_at = ?
    WHERE line_account_id = ? AND version = ?
      AND (? IS NOT NULL OR NOT EXISTS (${members})) ${snapshotGuard}`).bind(operation, now, accountId, expectedVersion, target?.id ?? null, accountId, source.rank_key,...snapshotBinds)];
  if (target && targetTag) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at)
      SELECT friend_id, ?, ? FROM (${members}) WHERE ${gate}`).bind(targetTag, now, accountId, source.rank_key, accountId, operation));
  }
  if (sourceTag) {
    statements.push(db.prepare(`DELETE FROM friend_tags WHERE tag_id = ? AND friend_id IN
      (${members}) AND ${gate}`).bind(sourceTag, accountId, source.rank_key, accountId, operation));
  }
  const updateIndex = statements.length;
  if (target) {
    statements.push(db.prepare(`INSERT INTO nen_member_rank_sync
      (id, operation_id, line_account_id, friend_id, customer_id, rank_key, actor, reason, created_at, updated_at)
      SELECT 'rank-delete:' || ? || ':' || lower(hex(randomblob(16))), ?, ?, s.friend_id, s.customer_id, ?, ?, ?, ?, ?
      FROM nen_ec_member_snapshots s WHERE s.friend_id IN (${members}) AND ${gate}`)
      .bind(operation, operation, accountId, target.rank_key, actor, 'ランク削除による移し替え', now, now,
        accountId, source.rank_key, accountId, operation));
    statements.push(db.prepare(`UPDATE nen_ec_member_snapshots SET member_rank_key = ?, member_rank = ?, ec_member_rank_name = NULL, mile_rate_percent = ?
      WHERE friend_id IN (${members}) AND ${gate}`).bind(target.rank_key, target.name, target.mile_rate_percent, accountId, source.rank_key, accountId, operation));
  }
  statements.push(db.prepare(`DELETE FROM nen_rank_settings WHERE id = ? AND line_account_id = ? AND ${gate}`).bind(source.id, accountId, accountId, operation));
  statements.push(db.prepare(`UPDATE nen_rank_rules SET sync_error = NULL WHERE line_account_id = ? AND sync_error = ?`).bind(accountId, operation));
  const result = await db.batch(statements);
  if (Number(result[0]?.meta.changes) !== 1) throw new NenRankDeleteError('版または会員数が変わりました。読み直してから削除してください', 409,await countRankMembers(db,accountId,source.rank_key));
  return {
    id: source.id, replacementRankId: target?.id ?? null,
    movedMembers: target ? Number(result[updateIndex + 1]?.meta.changes ?? 0) : 0,
    version: expectedVersion + 1, ecSync: 'pending' as const, message: '次の同期で反映',
    operationId: operation,
  };
}
