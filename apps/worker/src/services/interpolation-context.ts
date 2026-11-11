import { logger } from '@line-crm/shared/server';
import { normalizeStoreInterpolations, isBroadcastAssetKind } from '@line-crm/shared';
import {
  getFriendFieldMap,
  getCommonVarMap,
  type CommonVarResolutionFailureReason,
} from '@line-crm/db';

import { commonVarKeysInContent } from './common-var-snapshot.js';
import { resolveMusuboCommonVarsAt } from './google-common-vars.js';

/**
 * 差し込みに使う値をまとめて用意する。
 *
 * 友だち情報欄と共通情報の2つを引く。送信の経路が4か所（シナリオ・
 * 自動応答・フォームの返信・初回配信）あるので、それぞれで2本ずつ
 * クエリを書くと必ずどこかがずれる。
 *
 * 本文に差し込みが1つも書かれていなければ引かない。差し込みを使わない
 * テンプレートの送信で、毎回2クエリ増えるのは無駄。
 */
export interface InterpolationExtra {
  fields?: Record<string, string>;
  vars?: Record<string, string>;
}

const FIELD_PATTERN = /\{\{(#if_)?field\./;
const VAR_PATTERN = /\{\{var\./;

export async function resolveInterpolationExtra(
  db: D1Database,
  friendId: string,
  content: string,
): Promise<InterpolationExtra> {
  const needsFields = FIELD_PATTERN.test(content);
  const needsVars = VAR_PATTERN.test(normalizeStoreInterpolations(content));
  if (!needsFields && !needsVars) return {};

  const account = needsVars
    ? await db.prepare(`SELECT line_account_id FROM friends WHERE id = ?`)
      .bind(friendId)
      .first<{ line_account_id: string | null }>()
    : null;

  const [fields, vars] = await Promise.all([
    needsFields ? getFriendFieldMap(db, friendId) : Promise.resolve(undefined),
    needsVars ? getCommonVarMap(db, account?.line_account_id) : Promise.resolve(undefined),
  ]);
  if (vars && account?.line_account_id && commonVarKeysInContent(content).includes('business_hours')) {
    const resolved = await resolveMusuboCommonVarsAt(db, account.line_account_id, ['business_hours'], new Date().toISOString());
    vars.business_hours = resolved.ok ? resolved.values.business_hours : '';
  }
  return { fields, vars };
}

/*
 * 送信経路の共通情報解決（fail-closed）。
 *
 * resolveInterpolationExtra は画面のプレビュー向けで、消えた共通情報は
 * 空文字へ落ちる。送信ではそれを許さない——削除済み・未知・期限切れで
 * 代替なしの共通情報が1つでもあれば LINE 送信は0件にし、変数名と理由を
 * 共通情報解決失敗の台帳（common_var_resolution_failures）へ残す。
 * 台帳へ残すのは変数名と理由だけで、顧客本文や値は書かない。
 */
export type CommonVarSourceKind =
  | 'broadcast'
  | 'scenario'
  | 'first_step'
  | 'reminder'
  | 'form_reply'
  | 'auto_reply'
  | 'test_send'
  | 'chat'
  | 'automation'
  | 'friend_direct'
  | 'rich_menu_tap'
  | 'carousel_tap'
  | 'liff'
  | 'notification';

export interface CommonVarSendSource {
  kind: CommonVarSourceKind;
  id: string;
}

export interface CommonVarResolutionFailure {
  varKey: string;
  reason: CommonVarResolutionFailureReason;
}

export class CommonVarResolutionFailedError extends Error {
  constructor(
    readonly failures: ReadonlyArray<CommonVarResolutionFailure>,
    readonly source: CommonVarSendSource,
  ) {
    super(`common_var_unresolved:${failures.map((f) => f.varKey).join(',')}`);
    this.name = 'CommonVarResolutionFailedError';
  }
}

/**
 * アカウントが分かっている送信経路（一斉配信・テスト送信）向けの厳格解決。
 * 失敗時は台帳へ残して CommonVarResolutionFailedError を投げる。
 * 本文に {{var.…}} が無いときは undefined を返し、クエリを増やさない。
 */
export async function resolveSendCommonVars(
  db: D1Database,
  lineAccountId: string | null | undefined,
  content: string,
  source: CommonVarSendSource,
  executionAt = new Date().toISOString(),
): Promise<Record<string, string> | undefined> {
  const varKeys = commonVarKeysInContent(content);
  if (varKeys.length === 0) return undefined;
  if (!lineAccountId) {
    // 持ち主が分からないまま別アカウントの値で埋めることは絶対にしない。
    // 台帳は line_account_id 必須なので、ここでは送信拒否だけを返す。
    throw new CommonVarResolutionFailedError(
      varKeys.map((varKey) => ({ varKey, reason: 'missing' as const })),
      source,
    );
  }
  const resolved = await resolveMusuboCommonVarsAt(db, lineAccountId, varKeys, executionAt);
  if (!resolved.ok) {
    const now = new Date().toISOString();
    try {
      // retryable=1: 共通情報を直せば同じ送信を重複なく再試行できる失敗。
      // 台帳へ残すのは変数名・送信種別・理由・再試行可否だけで、
      // 顧客本文や共通情報の値は書かない。
      await db.batch(resolved.failures.map((failure) => db.prepare(
        `INSERT OR IGNORE INTO common_var_resolution_failures
           (id, line_account_id, source_kind, source_id, var_key, reason, retryable, execution_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        crypto.randomUUID(), lineAccountId, source.kind, source.id,
        failure.varKey, failure.reason, executionAt, now,
      )));
    } catch (ledgerError) {
      // 台帳の書き込み失敗で送信拒否自体を潰さない。拒否は必ず成立させる。
      logger.error("interpolation_context.resolve_send_common_vars_failed");
    }
    throw new CommonVarResolutionFailedError(resolved.failures, source);
  }
  return resolved.values;
}

/**
 * 友だち宛の送信経路（シナリオ・リマインド・自動応答・フォーム返信・
 * 初回配信・個別送信）向けの厳格解決。友だち情報欄は従来どおり
 * 未設定を空文字へ落とす（項目未設定はお客様側の入力差なので止めない）。
 */
export async function resolveSendInterpolationExtra(
  db: D1Database,
  friendId: string,
  content: string,
  source: CommonVarSendSource,
  executionAt?: string,
): Promise<InterpolationExtra> {
  const needsFields = FIELD_PATTERN.test(content);
  const varKeys = commonVarKeysInContent(content);
  if (!needsFields && varKeys.length === 0) return {};

  const account = varKeys.length > 0
    ? await db.prepare(`SELECT line_account_id FROM friends WHERE id = ?`)
      .bind(friendId)
      .first<{ line_account_id: string | null }>()
    : null;

  const [fields, vars] = await Promise.all([
    needsFields ? getFriendFieldMap(db, friendId) : Promise.resolve(undefined),
    resolveSendCommonVars(db, account?.line_account_id, content, source, executionAt),
  ]);
  return { fields, vars };
}

/** 本文が友だち情報欄の差し込みを使うか。 */
export function contentNeedsFriendFields(content: string): boolean {
  return FIELD_PATTERN.test(content);
}

// 判別は送信側が指定する種別を使う。JSONらしいplain textを推測で変換しない。
const STRUCTURED_MESSAGE_TYPES = new Set(['flex', 'carousel', 'location', 'image', 'video', 'audio', 'sticker', 'imagemap']);
function isStructuredMessageType(messageType: string): boolean {
  return STRUCTURED_MESSAGE_TYPES.has(messageType) || isBroadcastAssetKind(messageType);
}

function mapStringValues(value: unknown, visit: (text: string) => string): unknown {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map((item) => mapStringValues(item, visit));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStringValues(item, visit)]));
  }
  return value;
}

function commonVarContentValues(content: string, messageType: string | undefined): string {
  if (!isStructuredMessageType(messageType ?? 'text')) return content;
  const values: string[] = [];
  mapStringValues(JSON.parse(content), (text) => { values.push(text); return text; });
  return values.join('\n');
}

/** 解決済みの共通情報を本文へ流し込む。描画側と同じ空白許容の表記で拾う。 */
export function substituteCommonVars(
  content: string,
  vars: Record<string, string>,
  messageType = 'text',
): string {
  const substitute = (text: string) => normalizeStoreInterpolations(text).replace(
    /\{\{\s*var\.([a-z][a-z0-9_]*)\s*\}\}/g,
    (_match, key: string) => vars[key],
  );
  if (!isStructuredMessageType(messageType)) return substitute(content);
  return JSON.stringify(mapStringValues(JSON.parse(content), substitute));
}

/**
 * 差し込み描画の仕組みを持たない送信経路（オートメーション・イベント連携・
 * リッチメニュー・フォーム演出・カルーセル・LIFF・友だち詳細からの直接送信）
 * 向けの厳格展開。
 *
 * これらの経路はテンプレート本文をそのまま LINE へ送るので、{{var.*}} を
 * 含む本文は「未解決なら止める（fail-closed）・解決できたら値へ置き換える」
 * のどちらかでなければならない。生の差し込み名をそのまま届けない。
 * {{var.*}} を含まなければクエリを増やさずそのまま返す。
 */
export async function expandSendCommonVars(
  db: D1Database,
  content: string,
  source: CommonVarSendSource,
  target: { lineAccountId?: string | null; friendId?: string; messageType?: string },
  executionAt?: string,
): Promise<string> {
  const contentValues = commonVarContentValues(content, target.messageType);
  const varKeys = commonVarKeysInContent(contentValues);
  if (varKeys.length === 0) return content;
  let lineAccountId = target.lineAccountId;
  if (!lineAccountId && target.friendId) {
    const account = await db.prepare(
      `SELECT line_account_id FROM friends WHERE id = ?`,
    ).bind(target.friendId).first<{ line_account_id: string | null }>();
    lineAccountId = account?.line_account_id;
  }
  const vars = await resolveSendCommonVars(db, lineAccountId, contentValues, source, executionAt);
  return substituteCommonVars(content, vars ?? {}, target.messageType);
}

/**
 * 本文に書かれている差し込み名のうち、どこにも定義が無いものを拾う。
 *
 * 保存は止めない。テンプレートを先に書いて項目を後から足す、という
 * 順序は普通にあるので、そこで保存できないと作業が進まない。
 * 画面には注意として出す。
 */
export function findUnknownPlaceholders(
  content: string,
  known: { fields: Set<string>; vars: Set<string> },
): string[] {
  const unknown = new Set<string>();
  for (const match of content.matchAll(/\{\{(?:#if_)?field\.([a-z][a-z0-9_]*)\}\}/g)) {
    if (!known.fields.has(match[1])) unknown.add(`field.${match[1]}`);
  }
  for (const match of content.matchAll(/\{\{var\.([a-z][a-z0-9_]*)\}\}/g)) {
    if (!known.vars.has(match[1])) unknown.add(`var.${match[1]}`);
  }
  return [...unknown];
}
