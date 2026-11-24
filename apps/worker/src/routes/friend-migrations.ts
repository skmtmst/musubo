import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { logger } from '@line-crm/shared/server';
import { runJson } from './friend-migration-display.js';
import { consentRollbackConflicts, suppressionReconciliation } from '@line-crm/db/src/friend-delivery-consents.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import {
  UID_EVIDENCE_TYPES,
  getFriendFieldsForScope,
  validateFriendFieldValue,
  type ScopedFriendField,
  countUidMigrationItemDecisions,
  countUidMigrationItems,
  createUidMigrationRun,
  encodeScopedFriendLineUserId,
  getUidMigrationRun,
  isFriendLineUserIdConflict,
  listUidMigrationItems,
  listUidMigrationRuns,
  protectCsvCell,
  type UidEvidenceType,
  type UidMigrationClassification,
  type UidMigrationItemRow,
  type UidMigrationRunRow,
} from '@line-crm/db';


import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';

export const friendMigrations = new Hono<Env>();
const MAX_MAPPING_ROWS = 5_000;
const LEGACY_OTHER_ACCOUNT_UID_CONFLICT = '別のLINEアカウントに同じUIDがあります';
const EXPORT_COLUMNS = ['basic', 'friend_fields', 'tags_fields', 'support'] as const;
type ExportColumn = (typeof EXPORT_COLUMNS)[number];
type ImportCandidate = {
  id: string; display_name: string | null;
  real_name: string | null; system_display_name: string | null;
};

// CSV の見出し・入力キーには項目コードを使う。時刻も中央の検証を通す。
function importFields(raw: unknown, fields: ScopedFriendField[]):
  { values: Record<string, string | null>; error: string | null } {
  if (raw === undefined) return { values: {}, error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { values: {}, error: '友だち情報は項目コードと値で指定してください' };
  const values: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = fields.find((item) => item.field_key === key);
    if (!field || field.status !== 'active' || field.ec_is_master) return { values: {}, error: `${key}: 書き込める項目がありません` };
    const checked = validateFriendFieldValue(field, value);
    if (!checked.ok) return { values: {}, error: `${key}: ${checked.error}` };
    values[key] = checked.value;
  }
  return { values, error: null };
}

interface UidItemSnapshot {
  oldUserId: string | null;
  newUserId: string | null;
}

interface UidItemAfter {
  userId?: string;
}

/** before_json / after_json を安全に読む。壊れたJSONは null で「照合不能」にする。 */
function parseSnapshot(raw: string | null): UidItemSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UidItemSnapshot>;
    if (typeof value !== 'object' || value === null) return null;
    return {
      oldUserId: typeof value.oldUserId === 'string' ? value.oldUserId : null,
      newUserId: typeof value.newUserId === 'string' ? value.newUserId : null,
    };
  } catch {
    return null;
  }
}

function parseAfter(raw: string | null): UidItemAfter | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as UidItemAfter;
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** 実行結果の件数を items 表から数え直す。再実行でも二重計上しない。 */
async function recountMigrationResults(db: D1Database, runId: string) {
  const row = await db.prepare(`SELECT
      SUM(CASE WHEN result = 'applied' THEN 1 ELSE 0 END) AS applied,
      SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM uid_migration_items WHERE run_id = ?`).bind(runId)
    .first<{ applied: number | null; failed: number | null }>();
  return { applied: row?.applied ?? 0, failed: row?.failed ?? 0 };
}

function itemJson(row: UidMigrationItemRow) {
  return {
    id: row.id,
    oldUid: row.old_uid,
    newUid: row.new_uid,
    candidateName: row.candidate_name,
    evidenceType: row.evidence_type,
    classification: row.classification,
    conflictReason: row.conflict_reason,
    decision: row.decision,
    result: row.result,
    errorMessage: row.error_message,
  };
}

async function accessibleRun(c: Context<Env>, id: string) {
  const run = await getUidMigrationRun(c.env.DB, id);
  if (!run) return null;
  return await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [run.from_account_id, run.to_account_id])
    ? run
    : null;
}

friendMigrations.get('/api/friends/migrations', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const runs = await listUidMigrationRuns(c.env.DB, scope.allowedAccountIds);
    return c.json({ success: true, data: runs.map(runJson) });
  } catch (error) {
    throw error;
  }
});

friendMigrations.post('/api/friends/migrations', requireRole('owner', 'admin'), inputJsonBoundary({"fromAccountId":["string"],"toAccountId":["string"],"purpose":["string"],"sourceKind":["string"],"sourceFilename":["string"],"sourceChecksum":["string"],"mappings":["array"]}), async (c) => {
  try {
    const body = await c.req.json<{
      fromAccountId?: string;
      toAccountId?: string;
      purpose?: string;
      sourceKind?: 'csv' | 'verified_api' | 'manual';
      sourceFilename?: string;
      sourceChecksum?: string;
      mappings?: Array<{
        oldUid?: string;
        newUid?: string | null;
        evidenceType?: UidEvidenceType;
        evidence?: Record<string, string | number | boolean | null>;
      }>;
    }>();
    const from = body.fromAccountId?.trim();
    const to = body.toAccountId?.trim();
    const purpose = body.purpose?.trim();
    const mappings = body.mappings ?? [];
    if (!from || !to || !purpose || from === to) {
      return inputError(c, { success: false, error: '異なる移行元・移行先と利用目的を指定してください' }, 400, ["fromAccountId","toAccountId","purpose"]);
    }
    if (mappings.length === 0 || mappings.length > MAX_MAPPING_ROWS) {
      return inputError(c, { success: false, error: `対応表は1〜${MAX_MAPPING_ROWS}行で指定してください` }, 400, ["mappings"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [from, to])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const normalized = mappings.map((mapping) => ({
      oldUid: mapping.oldUid?.trim() ?? '',
      newUid: mapping.newUid?.trim() || null,
      evidenceType: mapping.evidenceType ?? 'operator_csv',
      evidence: mapping.evidence,
    }));
    if (normalized.some((mapping) => !mapping.oldUid || !UID_EVIDENCE_TYPES.includes(mapping.evidenceType))) {
      return inputError(c, { success: false, error: '旧UIDと確認済みの一致根拠が必要です' }, 400, ["mappings"]);
    }
    const staff = c.get('staff');
    const run = await createUidMigrationRun(c.env.DB, {
      fromAccountId: from,
      toAccountId: to,
      purpose,
      sourceKind: body.sourceKind ?? 'csv',
      sourceFilename: body.sourceFilename?.trim() || null,
      sourceChecksum: body.sourceChecksum?.trim() || null,
      mappings: normalized,
      createdBy: staff.id,
    });
    return c.json({ success: true, data: runJson(run) }, 201);
  } catch (error) {
    throw error;
  }
});

const ITEM_CLASSIFICATIONS = ['auto', 'review', 'unmatched', 'conflict'] as const;

friendMigrations.get('/api/friends/migrations/:id', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const run = await accessibleRun(c, c.req.param('id'));
    if (!run) return c.json({ success: false, error: 'Not found' }, 404);
    /*
      **対応表はページで区切って返す。** 全件返すと数千行で応答が重く、
      画面も先頭しか触れない。分類と「未判断のみ」の絞り込みもここで受ける。
    */
    const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 20, limitPolicy: { fallback: 'finite', truncate: true, minimum: 1, maximum: 500 }, offsetPolicy: { fallback: 'finite', truncate: true, minimum: 0 } });
    const classification = c.req.query('classification');
    if (classification !== undefined && !(ITEM_CLASSIFICATIONS as readonly string[]).includes(classification)) {
      return c.json({ success: false, error: '分類を確認してください' }, 400);
    }
    const pendingOnly = c.req.query('pendingOnly') === '1' || c.req.query('pendingOnly') === 'true';
    const filter = {
      classifications: classification === undefined
        ? undefined
        : [classification as UidMigrationClassification],
      pendingOnly: pendingOnly || undefined,
    };
    const [items, itemTotal, unresolved, decisionCounts] = await Promise.all([
      listUidMigrationItems(c.env.DB, run.id, filter, { limit, offset }),
      countUidMigrationItems(c.env.DB, run.id, filter),
      countUidMigrationItems(c.env.DB, run.id, { pendingOnly: true }),
      /*
        実行前の確認画面に「結び付け n 件・除外 m 件」を出すための
        判断別の件数。表示中のページだけでは数えられないので口で数える。
      */
      countUidMigrationItemDecisions(c.env.DB, run.id),
    ]);
    return c.json({
      success: true,
      data: buildOffsetListResponse({ ...runJson(run),
        items: items.map(itemJson),
        itemTotal,
        itemLimit: limit,
        itemOffset: offset,
        unresolved,
        decisionCounts,
        suppressionReconciliation: await suppressionReconciliation(c.env.DB, run.id), total: itemTotal, paging: { limit, offset }, sort: [] }),
    });
  } catch (error) {
    throw error;
  }
});

friendMigrations.patch('/api/friends/migrations/:id/items/:itemId', requireRole('owner', 'admin'), inputJsonBoundary({"decision":["string"]}), async (c) => {
  try {
    const run = await accessibleRun(c, c.req.param('id'));
    if (!run) return c.json({ success: false, error: 'Not found' }, 404);
    /*
      失敗した移行も判断を直せるようにする。
      'failed' のままだと失敗行の再確認・再試行のどちらにも進めない。
      'completed' / 'rolled_back' / 'executing' は締めたままにする。
    */
    if (!['review', 'ready', 'failed'].includes(run.status)) {
      return c.json({ success: false, error: 'このテスト移行は判断を変更できません' }, 409);
    }
    const body = await c.req.json<{ decision?: 'link' | 'create' | 'exclude' }>();
    if (!body.decision || !['link', 'create', 'exclude'].includes(body.decision)) {
      return inputError(c, { success: false, error: '判断を選んでください' }, 400, ["decision"]);
    }
    const item = await c.env.DB.prepare(
      'SELECT * FROM uid_migration_items WHERE id = ? AND run_id = ?',
    ).bind(c.req.param('itemId'), run.id).first<UidMigrationItemRow>();
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    if (body.decision === 'link' && (!item.old_friend_id || !item.new_friend_id)) {
      return inputError(c, { success: false, error: '新旧の友だちが両方見つからないため結び付けられません' }, 422, ["decision"]);
    }
    /*
      一致先のない行の「新規作成」は、本移行で移行先UIDの友だちを
      作る。移行先UIDがなければ作るものがなく、移行元の友だちがなければ
      引き継ぐ名前がないので、ここで止めて対応表の修正か除外へ案内する。
    */
    if (body.decision === 'create' && (!item.old_friend_id || !item.new_uid)) {
      return inputError(c, { success: false, error: '移行元の友だちと移行先のUIDがそろわない行は新規作成できません。対応表を直すか、除外してください' }, 422, ["decision"]);
    }
    const now = new Date().toISOString();
    await c.env.DB.prepare(`UPDATE uid_migration_items
      SET decision = ?, decided_by = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ?`).bind(
      body.decision, c.get('staff').id, now, now, item.id, run.id,
    ).run();
    const pending = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM uid_migration_items
      WHERE run_id = ? AND decision = 'pending'`).bind(run.id).first<{ count: number }>();
    await c.env.DB.prepare(`UPDATE uid_migration_runs SET status = ?, reviewed_at = ? WHERE id = ?`)
      .bind((pending?.count ?? 0) === 0 ? 'ready' : 'review', (pending?.count ?? 0) === 0 ? now : null, run.id)
      .run();
    return c.json({ success: true, data: { ...(runJson((await getUidMigrationRun(c.env.DB, run.id))!)), unresolved: pending?.count ?? null } });
  } catch (error) {
    throw error;
  }
});

friendMigrations.post('/api/friends/migrations/:id/execute', requireRole('owner'), inputJsonBoundary(), async (c) => {
  try {
    const run = await accessibleRun(c, c.req.param('id'));
    if (!run) return c.json({ success: false, error: 'Not found' }, 404);
    const staff = c.get('staff');
    if (run.created_by === staff.id) {
      return c.json({ success: false, error: '本移行は、テスト移行を作った人とは別のownerが確認してください' }, 409);
    }
    if (run.status === 'completed' || run.status === 'rolled_back') {
      return c.json({ success: false, error: 'この移行はすでに実行済みです。やり直す場合は先に切り戻してください' }, 409);
    }
    if (run.status === 'executing') {
      return c.json({ success: false, error: 'この移行は実行中です。履歴を読み直してください' }, 409);
    }
    /*
      一部失敗した移行の再試行を許す。
      'ready' か、未判断が残っていない 'failed' だけ実行できる。
      未判断が残るままの再実行は従来どおり止める。
    */
    const pending = await countUidMigrationItems(c.env.DB, run.id, { pendingOnly: true });
    if ((run.status !== 'ready' && run.status !== 'failed') || (run.status === 'failed' && pending > 0)) {
      return inputError(c, { success: false, error: '要確認をすべて判断してから本移行してください' }, 422, []);
    }
    const items = await listUidMigrationItems(c.env.DB, run.id);
    const targets=items.filter(i=>i.decision==='link'||i.decision==='create').map(i=>i.new_friend_id??i.new_uid).filter(Boolean);
    if(new Set(targets).size!==targets.length) return c.json({success:false,error:'同じ移行先が複数行あります。対応表を直してください'},409);
    const now = new Date().toISOString();
    /*
      二重実行はここで止める。status を 'executing' へ進められたのは
      最初の1回だけで、同時に踏んだ2本目は 0 行更新になる。
    */
    const claim = await c.env.DB.prepare(`UPDATE uid_migration_runs
      SET status = 'executing', approved_by = ?, executed_at = ? WHERE id = ? AND status IN ('ready', 'failed')`)
      .bind(staff.id, now, run.id).run();
    if ((claim.meta?.changes ?? 0) === 0) {
      return c.json({ success: false, error: 'この移行はすでに実行中か、実行できる状態ではありません' }, 409);
    }
    /*
     * 競合した行の失敗記録。before/after は書かない（何も変えていない
     * ため）。成功時の before_json は確認時＝書込時の現在値になる。
     */
    const failItem = async (itemId: string, message: string) => {
      await c.env.DB.prepare(`UPDATE uid_migration_items
        SET result = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
        .bind(message, now, itemId).run();
    };
    /*
      create 経路で確定した結び付け先。成功記録と対にし、外側の例外
      でも副作用を残さないための台帳。link 判断の行は従来どおり触らない。
    */
    const createdThisRun: Array<{
      itemId: string; oldFriendId: string; newFriendId: string;
      oldBefore: string | null; newBefore: string | null; created: boolean;
      pointerPreexisting: boolean; assigned: string | null;
    }> = [];
    try {
      for (const item of items) {
        /*
          反映済み・切り戻し済み・除外済みの行は再実行でも触らない。
          触ると before_json が統合後の状態で上書きされ、切り戻しで
          元の紐付けへ戻せなくなる。
        */
        if (item.result === 'applied' || item.result === 'rolled_back' || item.result === 'skipped') {
          continue;
        }
        if (item.decision === 'exclude') {
          await c.env.DB.prepare(`UPDATE uid_migration_items SET result = 'skipped', updated_at = ? WHERE id = ?`)
            .bind(now, item.id).run();
          continue;
        }
        /*
          判断 create は対応表の移行先UIDで友だちを新しく作り、名前は
          移行元の友だちから引き継ぐ。同じUIDが対象アカウントにあれば新規
          の重複は作らず採用し、並行作成・再送は一人に収束させる。
        */
        let createdFriendId: string | null = null;
        /*
          今作った行の後始末。項目の参照を外し、未連携のままの行だけ
          消す。採用した既存行・別操作で結び付いた行は残す。
        */
        const compensateCreated = async () => {
          if (!createdFriendId) return;
          const freshId = createdFriendId;
          createdFriendId = null;
          item.new_friend_id = null;
          await c.env.DB.prepare(`UPDATE uid_migration_items SET new_friend_id = NULL, updated_at = ?
            WHERE id = ? AND new_friend_id = ?`).bind(now, item.id, freshId).run();
          await c.env.DB.prepare(`DELETE FROM friends WHERE id = ? AND user_id IS NULL`)
            .bind(freshId).run();
        };
        if (item.decision === 'create') {
          if (!item.old_friend_id || !item.new_uid) {
            await failItem(item.id, 'この判断は自動反映できません。新しい友だちを確認してください');
            continue;
          }
          const oldFriendId: string = item.old_friend_id;
          const source = await c.env.DB.prepare(`SELECT id, line_account_id, user_id,
              display_name, real_name, system_display_name FROM friends WHERE id = ?`)
            .bind(item.old_friend_id)
            .first<{
              id: string; line_account_id: string | null; user_id: string | null;
              display_name: string | null; real_name: string | null; system_display_name: string | null;
            }>();
          if (!source || source.line_account_id !== run.from_account_id) {
            await failItem(item.id, '本移行前に結び付きが変わりました。確認してからもう一度実行してください');
            continue;
          }
          const selectTarget = () => c.env.DB.prepare(`SELECT id, user_id FROM friends
            WHERE line_account_id = ? AND line_platform_user_id = ? LIMIT 1`)
            .bind(run.to_account_id, item.new_uid)
            .first<{ id: string; user_id: string | null }>();
          /*
            対象アカウントの行を読む。見つかった行は作らず採用する。
            参照の確定より先に追跡へ載せ、後続の失敗でも把握漏れを出さない。
          */
          const trackTarget = (
            targetId: string, oldBefore: string | null, newBefore: string | null, created: boolean,
          ) => {
            createdThisRun.push({
              itemId: item.id, oldFriendId, newFriendId: targetId,
              oldBefore, newBefore, created,
              pointerPreexisting: item.new_friend_id !== null,
              assigned: null,
            });
          };
          let target = await selectTarget();
          if (!target) {
            const freshId = crypto.randomUUID();
            let inserted = false;
            try {
              await c.env.DB.prepare(`INSERT INTO friends (
                id, line_user_id, line_account_id, display_name, real_name, system_display_name,
                is_following, metadata, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 0, '{}', ?, ?)`).bind(
                freshId, encodeScopedFriendLineUserId(freshId, item.new_uid, run.to_account_id), run.to_account_id,
                source.display_name, source.real_name, source.system_display_name, now, now,
              ).run();
              inserted = true;
            } catch {
              inserted = false;
            }
            if (inserted) {
              target = { id: freshId, user_id: null };
              createdFriendId = freshId;
              trackTarget(freshId, source.user_id, null, true);
            } else {
              /*
                並行作成の競合は作り直さず、対象アカウントの行を採用して
                一人に収束させる。見つからない場合は原因が確定しないため、
                越境と断定せず再確認へ案内する（再送時は対象確認から入る）。
              */
              target = await selectTarget();
              if (!target) {
                await failItem(item.id, '本移行前に結び付きが変わりました。確認してからもう一度実行してください');
                continue;
              }
              trackTarget(target.id, source.user_id, target.user_id, false);
            }
          } else {
            trackTarget(target.id, source.user_id, target.user_id, false);
          }
          item.new_friend_id = target.id;
          await c.env.DB.prepare(`UPDATE uid_migration_items SET new_friend_id = ?, updated_at = ?
            WHERE id = ? AND (new_friend_id IS NULL OR new_friend_id = ?)`)
            .bind(target.id, now, item.id, target.id).run();
        }
        if ((item.decision !== 'link' && item.decision !== 'create') || !item.old_friend_id || !item.new_friend_id) {
          await failItem(item.id, 'この判断は自動反映できません。新しい友だちを確認してください');
          continue;
        }
        const pair = await c.env.DB.prepare(`SELECT id, user_id, display_name FROM friends
          WHERE (id = ? AND line_account_id = ? AND line_platform_user_id = ?)
            OR (id = ? AND line_account_id = ? AND line_platform_user_id = ?)`)
          .bind(item.old_friend_id, run.from_account_id, item.old_uid, item.new_friend_id, run.to_account_id, item.new_uid)
          .all<{ id: string; user_id: string | null; display_name: string | null }>();
        const oldFriend = pair.results.find((friend) => friend.id === item.old_friend_id);
        const newFriend = pair.results.find((friend) => friend.id === item.new_friend_id);
        if (!oldFriend || !newFriend || (oldFriend.user_id && newFriend.user_id && oldFriend.user_id !== newFriend.user_id)) {
          await compensateCreated();
          await failItem(item.id, '本移行前に結び付きが変わりました。確認してからもう一度実行してください');
          continue;
        }
        const userId = oldFriend.user_id ?? newFriend.user_id ?? crypto.randomUUID();
        /*
          この実行が割り当てた結び付きを控える。外側補償は現在値が
          この割当てと一致するときだけ戻し、他処理の結び付きを巻戻さない。
        */
        const tracked = createdThisRun.find((entry) => entry.itemId === item.id);
        if (tracked) tracked.assigned = userId;
        /*
         * 2件の付け替えは1文で同時に行う。確認時と現在値が両方一致
         * したときだけ2件更新になり、確認後の再連携は上書きしない。
         * 片方でも違うと0〜1件で止まり、この行は競合として残す（変更0）。
         * `IS` 比較なので未連携（NULL）の一致も見られる。
         */
        /*
         * 条件付きの付け替えだけを先に行い、2件とも一致したときだけ次へ進む。
         * 新規作成の本人行は付け替えの後に足す（競合時はゴミ行を作らない）。
         */
        const pairWrite = c.env.DB.prepare(
          `UPDATE friends
              SET user_id = CASE id WHEN ? THEN ? WHEN ? THEN ? END, updated_at = ?
            WHERE id IN (?, ?)
              AND ((id = ? AND line_account_id = ? AND user_id IS ?)
                OR (id = ? AND line_account_id = ? AND user_id IS ?))`,
        ).bind(
          oldFriend.id, userId, newFriend.id, userId, now,
          oldFriend.id, newFriend.id,
          oldFriend.id, run.from_account_id, oldFriend.user_id, newFriend.id, run.to_account_id, newFriend.user_id,
        );
        const recordWrites: D1PreparedStatement[] = [pairWrite];
        if (!oldFriend.user_id && !newFriend.user_id) {
          recordWrites.push(c.env.DB.prepare(`INSERT INTO users
            (id, display_name, primary_display_name, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`).bind(
            userId, newFriend.display_name ?? oldFriend.display_name, newFriend.display_name ?? oldFriend.display_name,
            staff.id, now, now,
          ));
        }
        recordWrites.push(
          /*
            再実行で前の before_json を消さないよう、未反映の行だけ
            result='applied' へ進める（WHERE result <> 'applied'）。
            条件付き書込みが通ったので、確認時の値は書込時と同じ。
          */
          c.env.DB.prepare(`UPDATE uid_migration_items
            SET result = 'applied', before_json = ?, after_json = ?, updated_at = ? WHERE id = ? AND result <> 'applied'`)
            .bind(JSON.stringify({ oldUserId: oldFriend.user_id, newUserId: newFriend.user_id }), JSON.stringify({ userId }), now, item.id),
          /*
           * 結び付きが変わるので本人の版を進める。後に開いた保存は
           * 409になり、移行前の中身が再保存されない。
           */
          c.env.DB.prepare(`UPDATE users SET revision = revision + 1, updated_at = ? WHERE id = ?`)
            .bind(now, userId),
        );
        try {
          await c.env.DB.batch(recordWrites);
        } catch(error) {
          if(String(error).includes('delivery_consent_identity_conflict')) {
            await compensateCreated();
            await failItem(item.id,'本移行前に結び付きが変わりました。確認してからもう一度実行してください');
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      /*
        create 経路は成功記録と対で戻す。pair まで進んで記録 batch が
        落ちると、結び付きだけ残って再試行・切り戻しのどちらからも見えなく
        なる。反映済みの行は触らず、未反映の行だけ実行前の状態へ寄せる。
        link 判断の行は従来どおり残す。
      */
      const compensatedAt = new Date().toISOString();
      try {
        for (const created of createdThisRun) {
          const state = await c.env.DB.prepare(`SELECT result FROM uid_migration_items WHERE id = ?`)
            .bind(created.itemId).first<{ result: string }>();
          if (!state || state.result === 'applied') continue;
          const pair = await c.env.DB.prepare(`SELECT id, user_id FROM friends WHERE id IN (?, ?)`)
            .bind(created.oldFriendId, created.newFriendId)
            .all<{ id: string; user_id: string | null }>();
          const currentOld = pair.results.find((friend) => friend.id === created.oldFriendId);
          const currentNew = pair.results.find((friend) => friend.id === created.newFriendId);
          /*
            片側ずつ、この実行の割当てと一致する側だけ戻す。一致しない側は
            他処理が結び付け直したものとして保持する。両側一致だけ戻す形だと、
            片側 relink 後に本操作が設定したままの側が成功記録なしで残る。
          */
          if (created.assigned !== null) {
            const restores: D1PreparedStatement[] = [];
            if (currentOld && currentOld.user_id === created.assigned) {
              restores.push(c.env.DB.prepare(`UPDATE friends SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS ?`)
                .bind(created.oldBefore, compensatedAt, created.oldFriendId, created.assigned));
            }
            if (currentNew && currentNew.user_id === created.assigned) {
              restores.push(c.env.DB.prepare(`UPDATE friends SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS ?`)
                .bind(created.newBefore, compensatedAt, created.newFriendId, created.assigned));
            }
            if (restores.length > 0) await c.env.DB.batch(restores);
          }
          /*
            参照は自分が付けた分だけ外す。元からあった参照は残し、再送が
            辿れるようにする。作った行は未連携のままなら消す。
          */
          if (created.created || !created.pointerPreexisting) {
            await c.env.DB.prepare(`UPDATE uid_migration_items SET new_friend_id = NULL, updated_at = ?
              WHERE id = ? AND new_friend_id = ?`).bind(compensatedAt, created.itemId, created.newFriendId).run();
          }
          if (created.created) {
            await c.env.DB.prepare(`DELETE FROM friends WHERE id = ? AND user_id IS NULL`)
              .bind(created.newFriendId).run();
          }
        }
      } catch (compensationError) {
        logger.error("friend_migrations.compensate_create_failed");
      }
      /*
        途中例外でも executing のまま放置しない。ここまでに反映・失敗した
        件数を履歴へ残し、反映済みの分だけ切り戻せる状態にする。
      */
      const totals = await recountMigrationResults(c.env.DB, run.id).catch(() => ({ applied: 0, failed: 0 }));
      await c.env.DB.prepare(`UPDATE uid_migration_runs SET status = 'failed', applied_count = ?,
        failed_count = ?, completed_at = ?, failure_reason = ? WHERE id = ?`)
        .bind(totals.applied, totals.failed, new Date().toISOString(), '実行の途中で失敗しました。反映済みの行は切り戻せます', run.id)
        .run();
      throw error;
    }
    const totals = await recountMigrationResults(c.env.DB, run.id);
    const status = totals.failed === 0 ? 'completed' : 'failed';
    await c.env.DB.prepare(`UPDATE uid_migration_runs SET status = ?, applied_count = ?, failed_count = ?,
      completed_at = ?, failure_reason = ? WHERE id = ?`).bind(
      status, totals.applied, totals.failed, now,
      totals.failed ? '一部の結び付きが反映できませんでした。失敗した行を確認して再実行するか、反映済みの行だけ切り戻してください' : null,
      run.id,
    ).run();
    return c.json({ success: true, data: runJson((await getUidMigrationRun(c.env.DB, run.id))!) });
  } catch (error) {
    throw error;
  }
});

friendMigrations.post('/api/friends/migrations/:id/rollback', requireRole('owner'), inputJsonBoundary(), async (c) => {
  try {
    const run = await accessibleRun(c, c.req.param('id'));
    if (!run) return c.json({ success: false, error: 'Not found' }, 404);
    /*
      切り戻しの可否・照合・冪等性をここで固める。
      - 'completed' または一部失敗（failed かつ applied>0）だけ対象。
      - 2回目以降は何も書かず 409 で止める（冪等）。
      - 移行後に統合ユーザーが変わった行は上書きせず、競合として返す。
    */
    if (run.status === 'rolled_back') {
      return c.json({ success: false, error: 'この移行はすでに切り戻し済みです' }, 409);
    }
    if (run.status === 'executing') {
      return c.json({ success: false, error: '実行中の移行は切り戻せません' }, 409);
    }
    if (run.status !== 'completed' && !(run.status === 'failed' && run.applied_count > 0)) {
      return c.json({
        success: false,
        error: run.status === 'failed'
          ? '反映済みの行がないため、切り戻す対象がありません'
          : '本移行がまだ実行されていないため、切り戻す対象がありません',
      }, 409);
    }
    const items = await listUidMigrationItems(c.env.DB, run.id);
    const appliedItems = items.filter((value) => value.result === 'applied');
    if (appliedItems.length === 0) {
      return c.json({ success: false, error: '切り戻せる反映済みの行がありません' }, 409);
    }
    const now = new Date().toISOString();
    /*
      先に全行を照合し、競合があれば1行も書かず 409 で止める。
      「移行直後の状態」と違う行へ before_json を書き戻すと、別担当の
      正当な変更まで消えるため。
    */
    type Prepared = { item: UidMigrationItemRow; before: UidItemSnapshot; afterUserId: string };
    const conflicts: Array<{ itemId: string; oldUid: string; reason: string }> = [];
    const prepared: Prepared[] = [];
    let alreadyRestored = 0;
    const consentConflicts = new Set(await consentRollbackConflicts(c.env.DB, run.id));
    for (const item of appliedItems) {
      if (consentConflicts.has(item.id)) {
        conflicts.push({itemId:item.id,oldUid:item.old_uid,reason:'移行後に配信停止・同意の状態が変更されています'});
        continue;
      }
      const before = parseSnapshot(item.before_json);
      const after = parseAfter(item.after_json);
      if (!before || !after?.userId || !item.old_friend_id || !item.new_friend_id) {
        conflicts.push({ itemId: item.id, oldUid: item.old_uid, reason: '実行時の記録が不足しているため照合できません' });
        continue;
      }
      const pair = await c.env.DB.prepare('SELECT id, user_id FROM friends WHERE id IN (?, ?)')
        .bind(item.old_friend_id, item.new_friend_id)
        .all<{ id: string; user_id: string | null }>();
      const currentOld = pair.results.find((friend) => friend.id === item.old_friend_id);
      const currentNew = pair.results.find((friend) => friend.id === item.new_friend_id);
      if (!currentOld || !currentNew) {
        conflicts.push({ itemId: item.id, oldUid: item.old_uid, reason: '対象の友だちが見つかりません' });
        continue;
      }
      if (currentOld.user_id !== after.userId || currentNew.user_id !== after.userId) {
        /*
          前回の切り戻しが friends 更新の直後で止まった行は、すでに
          移行前の状態へ戻っている。冪等にするため、ここで項目側だけ
          'rolled_back' へ寄せて再試行で詰まらないようにする。
        */
        if (currentOld.user_id === before.oldUserId && currentNew.user_id === before.newUserId) {
          await c.env.DB.prepare(`UPDATE uid_migration_items SET result = 'rolled_back', updated_at = ?
            WHERE id = ? AND result = 'applied'`).bind(now, item.id).run();
          alreadyRestored += 1;
          continue;
        }
        conflicts.push({ itemId: item.id, oldUid: item.old_uid, reason: '移行後に統合ユーザーが変更されています' });
        continue;
      }
      prepared.push({ item, before, afterUserId: after.userId });
    }
    if (conflicts.length > 0) {
      return c.json({
        success: false,
        error: `移行後に別の変更があった ${conflicts.length} 行があるため切り戻せません。競合を確認してください`,
        data: { conflicts },
      }, 409);
    }
    /*
      書き戻しも現在値を条件にする（冪等・競合の二重防御）。照合と書込みの
      間に変わった行は 0 件更新になり、その行だけ競合として報告する。
      既に 'rolled_back' の行へは何も書かない。
    */
    const lateConflicts: typeof conflicts = [];
    let rolledBack = 0;
    for (const { item, before, afterUserId } of prepared) {
      /*
       * ペア2件の書き戻しは1文で行う。両方一致のときだけ2件更新に
       * なり、遅い競合では1件も変わらない（部分復旧を出さない）。
       * 変わらなかった行は applied のまま残り、移行後の状態も保たれるので
       * 再試行できる。`IS` 比較で未連携（NULL）の一致も見られる。
       */
      const restorePair = c.env.DB.prepare(
        `UPDATE friends
            SET user_id = CASE id WHEN ? THEN ? WHEN ? THEN ? END, updated_at = ?
          WHERE id IN (?, ?)
            AND ((id = ? AND user_id IS ?) OR (id = ? AND user_id IS ?))`,
      ).bind(
        item.old_friend_id, before.oldUserId, item.new_friend_id, before.newUserId, now,
        item.old_friend_id, item.new_friend_id,
        item.old_friend_id, afterUserId, item.new_friend_id, afterUserId,
      );
      let restored: D1Result;
      try {
        [restored] = await c.env.DB.batch([
          restorePair,
          c.env.DB.prepare(`UPDATE uid_migration_items SET result='rolled_back',updated_at=? WHERE id=? AND result='applied'
            AND (SELECT user_id FROM friends WHERE id=?) IS ? AND (SELECT user_id FROM friends WHERE id=?) IS ?`)
            .bind(now,item.id,item.old_friend_id,before.oldUserId,item.new_friend_id,before.newUserId),
        ]);
      } catch(error) {
        if(String(error).includes('delivery_consent_conflict')) {
          lateConflicts.push({itemId:item.id,oldUid:item.old_uid,reason:'切り戻しの直前に配信停止・同意が変更されました'});
          continue;
        }
        throw error;
      }
      if ((restored.meta?.changes ?? 0) !== 2) {
        /*
         * 片方だけ戻った場合は、今書いた値のままの行だけを移行後の
         * 値へ戻す（ペア全体で変更0へ寄せ、再試行できる状態に保つ）。
         */
        await c.env.DB.batch([
          c.env.DB.prepare(
            `UPDATE friends SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS ?`,
          ).bind(afterUserId, now, item.old_friend_id, before.oldUserId),
          c.env.DB.prepare(
            `UPDATE friends SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS ?`,
          ).bind(afterUserId, now, item.new_friend_id, before.newUserId),
        ]);
        lateConflicts.push({ itemId: item.id, oldUid: item.old_uid, reason: '切り戻しの直前に統合ユーザーが変更されました' });
        continue;
      }
      /*
       * 結び付きが変わるので関係する本人の版を進める。後に開いた
       * 保存は409になり、切り戻し前の中身が再保存されない。
       */
      const bumped = [...new Set(
        [before.oldUserId, before.newUserId, afterUserId].filter((id) => id !== null),
      )];
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE uid_migration_items SET result = 'rolled_back', updated_at = ?
          WHERE id = ? AND result = 'applied'`).bind(now, item.id),
        ...bumped.map((userId) => c.env.DB.prepare(
          `UPDATE users SET revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).bind(now, userId)),
      ]);
      rolledBack += 1;
    }
    if (lateConflicts.length > 0) {
      return c.json({
        success: false,
        error: `${rolledBack + alreadyRestored} 行を切り戻しましたが、${lateConflicts.length} 行は直前の変更により残りました`,
        data: { conflicts: lateConflicts, rolledBack: rolledBack + alreadyRestored },
      }, 409);
    }
    await c.env.DB.prepare(`UPDATE uid_migration_runs SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?`)
      .bind(now, run.id).run();
    return c.json({
      success: true,
      data: { ...runJson((await getUidMigrationRun(c.env.DB, run.id))!), rolledBack: rolledBack + alreadyRestored },
    });
  } catch (error) {
    throw error;
  }
});

friendMigrations.post('/api/friends/exports', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"],"columns":["array"],"encoding":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ accountId?: string; columns?: ExportColumn[]; encoding?: 'utf-8' | 'shift_jis' }>();
    const accountId = body.accountId?.trim();
    const columns = body.columns ?? ['basic'];
    if (!accountId || columns.some((column) => !EXPORT_COLUMNS.includes(column))) {
      return inputError(c, { success: false, error: '対象アカウントと書き出す項目を選んでください' }, 400, ["accountId","columns"]);
    }
    // タグと対応情報の書き出しは未接続。友だち情報は friend_fields で指定。
    // 5列だけのCSVを渡すより、作る前に理由を返して止める（Shift_JISと同じ扱い）。
    if (columns.some((column) => column !== 'basic' && column !== 'friend_fields')) {
      return inputError(c, { success: false, error: 'タグ・友だち情報、対応情報の書き出しはまだ使えません。基本だけ選んでください' }, 422, ["columns"]);
    }
    if (body.encoding === 'shift_jis') {
      return inputError(c, { success: false, error: 'Shift_JIS書き出しはまだ接続されていません。UTF-8を選んでください' }, 422, ["encoding"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM friends WHERE line_account_id = ?')
      .bind(accountId).first<{ count: number }>();
    const id = crypto.randomUUID();
    const now = new Date();
    const staff = c.get('staff');
    await c.env.DB.prepare(`INSERT INTO friend_export_jobs
      (id, line_account_id, filter_json, columns_json, encoding, status, row_count,
       created_by, created_by_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`).bind(
      id, accountId, JSON.stringify({ accountId }), JSON.stringify(columns), body.encoding ?? 'utf-8',
      count?.count ?? 0, staff.id, staff.name, now.toISOString(), new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    ).run();
    c.set('outputAudit', { count: count?.count ?? null, accountId, targetId: id, phase: 'requested' });
    return c.json({ success: true, data: { id, rowCount: count?.count ?? null, status: 'completed', downloadUrl: `/api/friends/exports/${id}/download` } }, 201);
  } catch (error) {
    throw error;
  }
});

friendMigrations.get('/api/friends/exports/:id/download', requireRole('owner', 'admin'), async (c) => {
  const job = await c.env.DB.prepare('SELECT * FROM friend_export_jobs WHERE id = ?').bind(c.req.param('id'))
    .first<{ line_account_id: string; expires_at: string; columns_json: string }>();
  if (!job || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [job.line_account_id])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  if (job.expires_at <= new Date().toISOString()) return c.json({ success: false, error: 'ダウンロード期限が切れています' }, 410);
  type ExportRow = { id: string; line_user_id: string; display_name: string | null; real_name: string | null; system_display_name: string | null; created_at: string };
  const fields = (JSON.parse(job.columns_json) as ExportColumn[]).includes('friend_fields')
    ? await getFriendFieldsForScope(c.env.DB, { tenantId: c.get('staff').tenantId ?? DEFAULT_TENANT_ID, lineAccountId: job.line_account_id }, { status: 'active' })
    : [];
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE line_account_id=?').bind(job.line_account_id).first<{ n: number }>();
  c.set('outputAudit', { count: count?.n ?? 0, accountId: job.line_account_id, targetId: c.req.param('id') });
  const encoder = new TextEncoder();
  let offset = 0;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        controller.enqueue(encoder.encode('\uFEFF' + ['LINEユーザーID', 'LINE表示名', '本名', 'システム表示名', '登録日', ...fields.map((field) => field.field_key)].map(protectCsvCell).join(',') + '\r\n'));
        started = true;
      }
      const page = await c.env.DB.prepare(`SELECT id, line_platform_user_id AS line_user_id, display_name, real_name, system_display_name, created_at
        FROM friends WHERE line_account_id = ? ORDER BY created_at DESC, id ASC LIMIT 500 OFFSET ?`)
        .bind(job.line_account_id, offset).all<ExportRow>();
      if (page.results.length === 0) {
        controller.close();
        return;
      }
      const valueMap = new Map<string, string | null>();
      // D1 の1文あたりのbind上限を守って、500件のページを分けて読む。
      if (fields.length) for (let index = 0; index < page.results.length; index += 90) {
        const ids = page.results.slice(index, index + 90).map((row) => row.id);
        const values = await c.env.DB.prepare(
          `SELECT friend_id, field_id, value FROM friend_field_values WHERE friend_id IN (${ids.map(() => '?').join(',')})`,
        ).bind(...ids).all<{ friend_id: string; field_id: string; value: string | null }>();
        for (const value of values.results) valueMap.set(`${value.friend_id}:${value.field_id}`, value.value);
      }
      const csv = page.results.map((row) => [row.line_user_id, row.display_name, row.real_name, row.system_display_name, row.created_at,
        ...fields.map((field) => valueMap.get(`${row.id}:${field.id}`) ?? field.default_value)]
        .map((cell) => protectCsvCell(cell)).join(',')).join('\r\n') + '\r\n';
      controller.enqueue(encoder.encode(csv));
      offset += page.results.length;
      if (page.results.length < 500) controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="friends-${c.req.param('id')}.csv"` },
  });
});

friendMigrations.post('/api/friends/imports', requireRole('owner', 'admin'), inputJsonBoundary({"accountId":["string"],"sourceFilename":["string"],"sourceChecksum":["string"],"rows":["array"]}), async (c) => {
  try {
    const body = await c.req.json<{
      accountId?: string;
      sourceFilename?: string;
      sourceChecksum?: string;
      rows?: Array<{
        lineUid?: string;
        friendFields?: Record<string, unknown>;
        displayName?: string | null;
        realName?: string | null;
        systemDisplayName?: string | null;
      }>;
    }>();
    const accountId = body.accountId?.trim();
    const filename = body.sourceFilename?.trim();
    const checksum = body.sourceChecksum?.trim();
    let rows = body.rows ?? [];
    if (!accountId || !filename || !checksum || rows.length === 0 || rows.length > MAX_MAPPING_ROWS) {
      return inputError(c, { success: false, error: `対象・ファイル情報と1〜${MAX_MAPPING_ROWS}行のデータが必要です` }, 400, ["accountId","sourceFilename","sourceChecksum","rows"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const previous = await c.env.DB.prepare(
      'SELECT id, status, rows_json, result_json FROM friend_import_jobs WHERE line_account_id = ? AND source_checksum = ?',
    ).bind(accountId, checksum).first<{ id: string; status: string; rows_json: string; result_json: string }>();
    if (previous) {
      const result = JSON.parse(previous.result_json) as { rows?: Array<{ kind?: string; reason?: string }> };
      if (previous.status !== 'previewed' || !result.rows?.some((row) =>
        row.kind === 'conflict' && row.reason === LEGACY_OTHER_ACCOUNT_UID_CONFLICT)) {
        return c.json({ success: true, data: { id: previous.id, status: previous.status, result, duplicate: true } });
      }
      // 以前の規則で止まった確認だけ、同じファイルの再確認に応じて作り直す。
      rows = JSON.parse(previous.rows_json) as typeof rows;
    }
    const fields = rows.some((row) => row.friendFields !== undefined)
      ? await getFriendFieldsForScope(c.env.DB, { tenantId: c.get('staff').tenantId ?? DEFAULT_TENANT_ID, lineAccountId: accountId }) : [];
    const seen = new Set<string>();
    const results: Array<{
      lineUid: string;
      kind: 'add' | 'update' | 'unchanged' | 'conflict' | 'error';
      reason: string | null;
      values: { displayName: string | null; realName: string | null; systemDisplayName: string | null; friendFields?: Record<string, string | null> };
    }> = [];
    for (const raw of rows) {
      const lineUid = raw.lineUid?.trim() ?? '';
      const checkedFields = importFields(raw.friendFields, fields);
      const values = {
        ...(raw.friendFields === undefined ? {} : { friendFields: checkedFields.values }),
        displayName: raw.displayName?.trim() || null,
        realName: raw.realName?.trim() || null,
        systemDisplayName: raw.systemDisplayName?.trim() || null,
      };
      if (!lineUid || seen.has(lineUid)) {
        results.push({ lineUid, kind: 'error', reason: lineUid ? '同じUIDがファイルに複数あります' : 'LINEユーザーIDがありません', values });
        continue;
      }
      seen.add(lineUid);
      if (checkedFields.error) {
        results.push({ lineUid, kind: 'error', reason: checkedFields.error, values });
        continue;
      }
      const sameAccount = await c.env.DB.prepare(`SELECT id, display_name, real_name, system_display_name
        FROM friends WHERE line_account_id = ? AND line_platform_user_id = ? LIMIT 1`).bind(accountId, lineUid).first<ImportCandidate>();
      if (!sameAccount) {
        results.push({ lineUid, kind: 'add', reason: null, values });
        continue;
      }
      if (
        sameAccount.display_name === values.displayName
        && sameAccount.real_name === values.realName
        && sameAccount.system_display_name === values.systemDisplayName
        && Object.keys(checkedFields.values).length === 0
      ) {
        results.push({ lineUid, kind: 'unchanged', reason: null, values });
      } else {
        results.push({ lineUid, kind: 'update', reason: null, values });
      }
    }
    const count = (kind: typeof results[number]['kind']) => results.filter((row) => row.kind === kind).length;
    const id = previous?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const staff = c.get('staff');
    const summary = { add: count('add'), update: count('update'), unchanged: count('unchanged'), conflict: count('conflict'), error: count('error') };
    const result = { summary, rows: results };
    if (previous) {
      const refreshed = await c.env.DB.prepare(`UPDATE friend_import_jobs
        SET result_json=?, total_count=?, add_count=?, update_count=?, unchanged_count=?, conflict_count=?, error_count=?
        WHERE id=? AND line_account_id=? AND status='previewed' AND result_json=?`)
        .bind(JSON.stringify(result), results.length, summary.add, summary.update, summary.unchanged,
          summary.conflict, summary.error, id, accountId, previous.result_json).run();
      if (refreshed.meta.changes !== 1) {
        return c.json({ success: false, error: '取り込み状況が変わりました。もう一度確認してください' }, 409);
      }
      return c.json({ success: true, data: { id, status: 'previewed', result, duplicate: false } });
    }
    await c.env.DB.prepare(`INSERT INTO friend_import_jobs (
      id, line_account_id, source_filename, source_checksum, rows_json, result_json,
      status, total_count, add_count, update_count, unchanged_count, conflict_count,
      error_count, created_by, created_by_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id, accountId, filename, checksum, JSON.stringify(rows), JSON.stringify(result),
      results.length, summary.add, summary.update, summary.unchanged, summary.conflict, summary.error,
      staff.id, staff.name, now,
    ).run();
    return c.json({ success: true, data: { id, status: 'previewed', result, duplicate: false } }, 201);
  } catch (error) {
    throw error;
  }
});

friendMigrations.post('/api/friends/imports/:id/execute', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    const job = await c.env.DB.prepare('SELECT * FROM friend_import_jobs WHERE id = ?').bind(c.req.param('id')).first<{
      id: string; line_account_id: string; status: string; result_json: string;
    }>();
    if (!job || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [job.line_account_id])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (job.status === 'completed') return c.json({ success: true, data: { id: job.id, status: 'completed', duplicate: true } });
    if (job.status !== 'previewed') return c.json({ success: false, error: '確認が終わったファイルだけ反映できます' }, 409);
    const result = JSON.parse(job.result_json) as { rows: Array<{
      lineUid: string; kind: 'add' | 'update' | 'unchanged' | 'conflict' | 'error';
      values: { displayName: string | null; realName: string | null; systemDisplayName: string | null; friendFields?: Record<string, string | null> };
    }> };
    /*
      **競合・エラーが残るまま反映しない。** 画面は無効化しているが、
      直接呼ばれると該当行を捨てて `completed` になっていた。
    */
    const remainingConflict = result.rows.filter((row) => row.kind === 'conflict').length;
    const remainingError = result.rows.filter((row) => row.kind === 'error').length;
    if (remainingConflict > 0) {
      return c.json({ success: false, error: `競合が${remainingConflict}件のこっています。確認画面で解消してから反映してください` }, 409);
    }
    if (remainingError > 0) {
      return inputError(c, { success: false, error: `入力不備が${remainingError}件のこっています。ファイルを確認画面で直してから反映してください` }, 422, []);
    }
    const now = new Date().toISOString();
    const fields = result.rows.some((row) => row.values.friendFields !== undefined)
      ? await getFriendFieldsForScope(c.env.DB, { tenantId: c.get('staff').tenantId ?? DEFAULT_TENANT_ID, lineAccountId: job.line_account_id }) : [];
    const statements: D1PreparedStatement[] = [];
    let applied = 0;
    for (const row of result.rows) {
      const checked = importFields(row.values.friendFields, fields);
      if (checked.error) return inputError(c, { success: false, error: `${row.lineUid}: ${checked.error}` }, 422, []);
      if (row.kind === 'add') {
        applied += 1;
        const id = crypto.randomUUID();
        statements.push(c.env.DB.prepare(`INSERT INTO friends (
          id, line_user_id, line_account_id, display_name, real_name, system_display_name,
          is_following, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, '{}', ?, ?)`).bind(
          id, encodeScopedFriendLineUserId(id, row.lineUid, job.line_account_id), job.line_account_id, row.values.displayName,
          row.values.realName, row.values.systemDisplayName, now, now,
        ));
      } else if (row.kind === 'update') {
        applied += 1;
        statements.push(c.env.DB.prepare(`UPDATE friends
          SET display_name = ?, real_name = ?, system_display_name = ?, updated_at = ?
          WHERE line_account_id = ? AND line_platform_user_id = ?`).bind(
          row.values.displayName, row.values.realName, row.values.systemDisplayName,
          now, job.line_account_id, row.lineUid,
        ));
      }
      if (row.kind === 'add' || row.kind === 'update') {
        for (const [key, value] of Object.entries(checked.values)) {
          const field = fields.find((item) => item.field_key === key)!;
          const friendSelect = 'SELECT id FROM friends WHERE line_account_id = ? AND line_platform_user_id = ?';
          statements.push(value === null
            ? c.env.DB.prepare(`DELETE FROM friend_field_values WHERE field_id = ? AND friend_id IN (${friendSelect})`).bind(field.id, job.line_account_id, row.lineUid)
            : c.env.DB.prepare(`INSERT INTO friend_field_values (friend_id, field_id, value, updated_by, updated_at)
                SELECT id, ?, ?, ?, ? FROM friends WHERE line_account_id = ? AND line_platform_user_id = ?
                ON CONFLICT(friend_id, field_id) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
              .bind(field.id, value, c.get('staff').id, now, job.line_account_id, row.lineUid));
        }
      }
    }
    try {
      if (statements.length > 0) await c.env.DB.batch(statements);
    } catch (error) {
      if (!isFriendLineUserIdConflict(error)) throw error;
      return c.json({ success: false, error: 'このLINEアカウントの友だちが追加されました。もう一度内容を確認してください' }, 409);
    }
    await c.env.DB.prepare(`UPDATE friend_import_jobs SET status = 'completed', executed_at = ? WHERE id = ? AND status = 'previewed'`)
      .bind(now, job.id).run();
    return c.json({ success: true, data: { id: job.id, status: 'completed', applied, duplicate: false } });
  } catch (error) {
    throw error;
  }
});

friendMigrations.get('/api/friends/migration-jobs', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (scope.allowedAccountIds.length === 0) return c.json({ success: true, data: [] });
    const placeholders = sqlIdSet(scope.allowedAccountIds).sql;
    const [exports, imports] = await Promise.all([
      c.env.DB.prepare(`SELECT id, line_account_id, row_count, status, created_by_name, created_at, expires_at
        FROM friend_export_jobs WHERE line_account_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 20`)
        .bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])).all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT id, line_account_id, total_count, update_count, conflict_count, status,
        created_by_name, created_at FROM friend_import_jobs WHERE line_account_id IN (${placeholders})
        ORDER BY created_at DESC LIMIT 20`).bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])).all<Record<string, unknown>>(),
    ]);
    const jobs = [
      ...exports.results.map((row) => ({ ...row, kind: 'export', sortCreatedAt: String(row['created_at']) })),
      ...imports.results.map((row) => ({ ...row, kind: 'import', sortCreatedAt: String(row['created_at']) })),
    ];
    return c.json({ success: true, data: jobs
      .sort((a, b) => b.sortCreatedAt.localeCompare(a.sortCreatedAt))
      .slice(0, 20)
      .map(({ sortCreatedAt: _sortCreatedAt, ...job }) => job) });
  } catch (error) {
    throw error;
  }
});
