import type { Context } from 'hono';
import { getAutoReplyById, parseAutoReplyVersionSettings, getFolderById } from '@line-crm/db';
import type { AutoReplyDraftSettings, AutoReplyVersionRow } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { type AutoReplyCandidateReasonCode } from '../features/auto-replies/auto-reply/index.js';
import { fail } from '../lib/fail.js';
export /*
 * 「連投を防ぐ」の範囲外は、対象欄の名前と許容範囲が分かる日本語で断る。
 * 英語の内部項目名（cooldownMinutes ...）をそのまま出さない。
 * 下書き・直接作成・更新の3つの口で同じ文言を使う。
 */
const COOLDOWN_RANGE_ERROR = '「連投を防ぐ」は0〜10080の整数（分）で入力してください';

export async function validateAutoReplyFolder(
  db: D1Database,
  folderId: unknown,
): Promise<string | null> {
  if (folderId === null || folderId === '' || folderId === undefined) return null;
  if (typeof folderId !== 'string') return 'folderId must be a string';
  const folder = await getFolderById(db, folderId);
  if (!folder) return 'フォルダが見つかりません';
  if (folder.kind !== 'auto_reply') return '自動応答用ではないフォルダは選べません';
  return null;
}

export /*
 * m26c : 全アカウント共通（lineAccountId が null）の作成・共通化は
 * owner だけ。要件 -08 §7「全アカウント共通ルールはownerだけが作成・変更」。
 * m26c : テンプレートは所属アカウントが見える人だけが使える。
 * 所属なし（共通）のテンプレートは共有物として扱う。
 */
async function requireCommonRuleOwner(
  db: D1Database,
  staff: AuthenticatedStaff | undefined,
): Promise<{ ok: true } | { ok: false; error: string; field?: string }> {
  if (staff?.role === 'owner' && (await getVisibleLineAccountScope(db, staff)).canSeeUnassigned) return { ok: true };
  return { ok: false, error: '全アカウント共通の自動応答は統括だけが作成・変更できます' };
}

export async function assertTemplateVisible(
  db: D1Database,
  staff: AuthenticatedStaff | undefined,
  templateId: string | null,
  templateLineAccountId: string | null,
): Promise<string | null> {
  if (!templateId || templateLineAccountId === null) return null;
  if (!await canAccessAllLineAccounts(db, staff, [templateLineAccountId])) {
    return '選んだテンプレートを確認できません';
  }
  return null;
}

export async function requireVisibleAutoReply(c: Context<Env>, next: () => Promise<void>) {
  // B 元に戻す: 削除の取り消しは消えた行自体が対象。所属だけ確かめて通す。
  // 行の有無（404）は restore 側が deleted_at 込みで判断する。
  if (c.req.path.endsWith('/restore')) {
    const row = await c.env.DB
      .prepare(`SELECT line_account_id FROM auto_replies WHERE id = ?`)
      .bind(c.req.param('id')!)
      .first<{ line_account_id: string | null }>();
    if (!row || !await canAccessAllLineAccounts(
      c.env.DB,
      c.get('staff'),
      [row.line_account_id ?? null],
    )) {
      return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
    }
    await next();
    return;
  }
  const item = await getAutoReplyById(c.env.DB, c.req.param('id')!);
  if (!item || !await canAccessAllLineAccounts(
    c.env.DB,
    c.get('staff'),
    [item.line_account_id ?? null],
  )) {
    return fail(c, 404, 'AUTO_REPLY_NOT_FOUND');
  }
  await next();
}

export /** LINE から届くメッセージの種別。ここに無いものは対象にできない。 */
const MESSAGE_KINDS = ['text', 'image', 'video', 'audio', 'file', 'location', 'sticker', 'postback'];

export function readMessageKinds(raw: unknown): { ok: true; value: string[] | null } | { ok: false } {
  if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, value: null };
  }
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.some((v) => typeof v !== 'string' || !MESSAGE_KINDS.includes(v))) return { ok: false };
  return { ok: true, value: raw as string[] };
}

export /** "HH:MM"（24時間表記）かどうか。空文字と null は「指定なし」。 */
function parseHhmm(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return { ok: false };
  return { ok: true, value };
}

export /** 分。0 は「抑制しない」なので null に寄せる。 */
function parseCooldown(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_080) return { ok: false };
  return { ok: true, value: n === 0 ? null : n };
}

export interface EffectiveAccount {
  accountId: string;
  accountName: string;
  status: 'reply' | 'silent' | 'not_applicable';
  via: 'inline' | 'automation' | null;
}

export interface SerializedAutoReply {
  id: string;
  keyword: string;
  matchType: 'exact' | 'contains';
  responseType: string;
  responseContent: string;
  templateId: string | null;
  lineAccountId: string | null;
  isActive: boolean;
  activeFrom: string | null;
  activeUntil: string | null;
  cooldownMinutes: number | null;
  skipWhenOperatorActive: boolean;
  priority: number;
  messageKinds: string[] | null;
  receiveSources: Array<'line' | 'email'>;
  /** 応答したときに順に実行すること。 */
  actions: unknown[] | null;
  /** 応答する曜日（0=日 … 6=土）。null なら曜日を問わない。 */
  responseWeekdays: number[] | null;
  /** 'ignore' | 'include' | 'exclude'。 */
  responseHolidayRule: string | null;
  /** 1人につき1回だけ応答する。 */
  oncePerFriend: boolean;
  /** キーワードの複数行。null なら keyword / matchType を見る。 */
  keywords: unknown[] | null;
  /** 友だちの絞り込み（一斉配信・シナリオと同じ形）。 */
  friendConditions: unknown | null;
  /** キーワードを問わず、届いたメッセージすべてに応答する。 */
  respondToAll: boolean;
  /** 管理用の名前。空なら keyword を代わりに出す。 */
  name: string | null;
  /** 'any'（どれか1つ）か 'all'（すべて）。 */
  keywordMatchMode: string;
  /** フォルダ。分けていなければ null。 */
  folderId: string | null;
  /** 運用者だけが読むメモ。版スナップショットに保存し、友だちへは出さない。 */
  internalMemo: string | null;
  /** 'draft'（未公開）| 'published' | 'stopped'。一覧が再開の可否を分けるのに使う。 */
  lifecycleStatus: string;
  confirmationRevision: number;
  /** 機能08 点検 最後に停止した日時・担当者・理由。止めたことが無ければ null。 */
  stoppedAt: string | null;
  stoppedByStaffId: string | null;
  stoppedByStaffName: string | null;
  stopReason: string | null;
  /** 当たった回数。一覧でだけ入る。 */
  hits?: { period: number; total: number };
  /** 実行台帳で成功を確認できた後続処理の累計。 */
  actionExecutionCount?: number | null;
  /** 同じ受信に当たり得る、有効な別ルールの数。 */
  conflictAttentionCount?: number | null;
  createdAt: string;
  effectiveAccounts?: EffectiveAccount[];
}

export interface AutoReplyDraftInput {
  keyword: string;
  matchType: 'exact' | 'contains';
  responseType: string;
  responseContent: string;
  templateId: string | null;
  lineAccountId: string;
  activeFrom: string | null;
  activeUntil: string | null;
  cooldownMinutes: number | null;
  skipWhenOperatorActive: boolean;
  priority: number;
  messageKinds: string[] | null;
  receiveSources: Array<'line' | 'email'>;
  friendConditions: Record<string, unknown> | null;
  actions: unknown[] | null;
  responseWeekdays: number[] | null;
  responseHolidayRule: 'ignore' | 'include' | 'exclude' | null;
  oncePerFriend: boolean;
  keywords: Array<{
    keyword: string;
    matchType?: 'exact' | 'contains';
    minLength?: number;
    caseSensitive?: boolean;
  }> | null;
  respondToAll: boolean;
  name: string | null;
  keywordMatchMode: 'any' | 'all';
  normalizeKeywords?: boolean;
  folderId: string | null;
  internalMemo: string | null;
  replyDelaySeconds: number | null;
  unmatchedAction: Record<string, unknown> | null;
}

export interface AutoReplyDraftVersion {
  autoReplyId: string;
  versionId: string;
  versionNumber: number;
  status: 'draft' | 'published' | 'retired';
  settings: AutoReplyDraftInput;
  lastTestStatus: 'succeeded' | 'failed' | null;
  lastTestedAt: string | null;
  publishedAt: string | null;
  matchedLast28Days?: number | null;
}

export interface AutoReplyConflict {
  autoReplyId: string;
  name: string;
  certainty: 'certain' | 'possible';
  winnerAutoReplyId: string;
  reason: string;
}

export interface AutoReplyConflictPair {
  leftAutoReplyId: string;
  rightAutoReplyId: string;
  winnerAutoReplyId: string;
  certainty: 'certain' | 'possible';
  reason: string;
}

export interface AutoReplyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  conflicts: AutoReplyConflict[];
  lastTestStatus: 'succeeded' | 'failed' | null;
}

export interface AutoReplyDryRunResult {
  matched: boolean;
  draftWon: boolean;
  /** 試した友だちのトークが「対応中」か。有人対応の抑止説明に使う。 */
  operatorActive: boolean;
  winner: {
    autoReplyId: string;
    name: string;
    responseType: string;
    responseContent: string;
  } | null;
  candidates: Array<{
    autoReplyId: string;
    name: string;
    priority: number;
    result: 'not_matched' | 'skipped' | 'won';
    reasonCodes: AutoReplyCandidateReasonCode[];
    /** 「担当者が対応中のトークでは返さない」設定のルールか。 */
    suppressWhenOperatorActive: boolean;
  }>;
  actions: Array<{ kind: string }>;
  stateChanged: false;
}

export const HOLIDAY_RULES = ['ignore', 'include', 'exclude'] as const;

export type Read<T> = { ok: true; value: T } | { ok: false };

export /** 応答したときに実行することの並び。 */
function readActions(raw: unknown): Read<unknown[] | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false };
  return { ok: true, value: raw.length > 0 ? raw : null };
}

export /** 応答する曜日（0=日 … 6=土）。 */
function readWeekdays(raw: unknown): Read<number[] | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.some((v) => !Number.isInteger(v) || (v as number) < 0 || (v as number) > 6)) {
    return { ok: false };
  }
  return { ok: true, value: raw.length > 0 ? (raw as number[]) : null };
}

export function readHolidayRule(raw: unknown): Read<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !HOLIDAY_RULES.includes(raw as (typeof HOLIDAY_RULES)[number])) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

export const AUTO_REPLY_KEYWORDS_MAX = 100;

/** キーワードの複数行。1行ずつ言葉と当て方を持つ。 */
/** 保存できる言葉の上限。際限なく足すと一覧の描画と送信判定が重くなる。 */
export const AUTO_REPLY_KEYWORD_MAX = 200;

export function readKeywords(raw: unknown): Read<unknown[] | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.length > AUTO_REPLY_KEYWORDS_MAX) return { ok: false };
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false };
    const r = item as Record<string, unknown>;
    if (typeof r.keyword !== 'string' || r.keyword === '') return { ok: false };
    if ([...r.keyword].length > AUTO_REPLY_KEYWORD_MAX) return { ok: false };
    if (r.matchType !== undefined && r.matchType !== 'exact' && r.matchType !== 'contains') {
      return { ok: false };
    }
    if (r.minLength !== undefined && (!Number.isInteger(r.minLength) || (r.minLength as number) < 0)) {
      return { ok: false };
    }
  }
  return { ok: true, value: raw.length > 0 ? raw : null };
}

export /**
 * 友だちの絞り込み。読めない JSON は断る。
 *
 * 保存できてしまうと、応答のたびに黙って「返さない」に倒れる（判定側が
 * そうしている）。設定した人からは、当たるはずのルールが動かないだけに見える。
 */
function readFriendConditions(raw: unknown): Read<unknown | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw === 'string') {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

export /** 151 で増えた設定をまとめて読む。作成と更新で同じものを使う。 */
function readExtras(body: Record<string, unknown>):
  | { ok: true; value: {
      actions?: unknown[] | null;
      responseWeekdays?: number[] | null;
      responseHolidayRule?: string | null;
      oncePerFriend?: boolean;
      keywords?: unknown[] | null;
      friendConditions?: unknown | null;
      respondToAll?: boolean;
      name?: string | null;
      keywordMatchMode?: 'any' | 'all';
      normalizeKeywords?: boolean;
      folderId?: string | null;
      internalMemo?: string | null;
      replyDelaySeconds?: number | null;
      unmatchedAction?: Record<string, unknown> | null;
    } }
  | { ok: false; error: string; field?: string } {
  const value: Record<string, unknown> = {};

  if ('actions' in body) {
    const parsed = readActions(body.actions);
    if (!parsed.ok) return { ok: false, error: 'actions must be an array' , field: "actions" };
    value.actions = parsed.value;
  }
  if ('responseWeekdays' in body) {
    const parsed = readWeekdays(body.responseWeekdays);
    if (!parsed.ok) return { ok: false, error: 'responseWeekdays must be integers from 0 (Sun) to 6 (Sat)' , field: "responseWeekdays" };
    value.responseWeekdays = parsed.value;
  }
  if ('responseHolidayRule' in body) {
    const parsed = readHolidayRule(body.responseHolidayRule);
    if (!parsed.ok) return { ok: false, error: `responseHolidayRule must be one of ${HOLIDAY_RULES.join(', ')}` , field: "responseHolidayRule" };
    value.responseHolidayRule = parsed.value;
  }
  if ('oncePerFriend' in body) {
    if (typeof body.oncePerFriend !== 'boolean') {
      return { ok: false, error: 'oncePerFriend must be boolean' , field: "oncePerFriend" };
    }
    value.oncePerFriend = body.oncePerFriend;
  }
  if ('keywords' in body) {
    const parsed = readKeywords(body.keywords);
    if (!parsed.ok) {
      return { ok: false, error: `keywords must be an array of { keyword, matchType?, minLength?, caseSensitive? } (at most ${AUTO_REPLY_KEYWORDS_MAX} items, ${AUTO_REPLY_KEYWORD_MAX} characters each)` , field: "keywords" };
    }
    value.keywords = parsed.value;
  }
  if ('friendConditions' in body) {
    const parsed = readFriendConditions(body.friendConditions);
    if (!parsed.ok) return { ok: false, error: 'friendConditions must be valid JSON' , field: "friendConditions" };
    value.friendConditions = parsed.value;
  }
  if ('respondToAll' in body) {
    if (typeof body.respondToAll !== 'boolean') {
      return { ok: false, error: 'respondToAll must be boolean' , field: "respondToAll" };
    }
    value.respondToAll = body.respondToAll;
  }
  if ('folderId' in body) {
    if (body.folderId === null || body.folderId === '') {
      value.folderId = null;
    } else if (typeof body.folderId !== 'string') {
      return { ok: false, error: 'folderId must be a string' , field: "folderId" };
    } else {
      value.folderId = body.folderId;
    }
  }
  if ('normalizeKeywords' in body) {
    if (typeof body.normalizeKeywords !== 'boolean') return {ok:false,error:'キーワードをそろえる設定はtrueまたはfalseで指定してください', field: "normalizeKeywords" };
    value.normalizeKeywords = body.normalizeKeywords;
  }
  if ('keywordMatchMode' in body) {
    if (body.keywordMatchMode !== 'any' && body.keywordMatchMode !== 'all') {
      return { ok: false, error: "keywordMatchMode must be 'any' or 'all'" , field: "keywordMatchMode" };
    }
    value.keywordMatchMode = body.keywordMatchMode;
  }
  if ('name' in body) {
    if (body.name === null || body.name === '') {
      value.name = null;
    } else if (typeof body.name !== 'string') {
      return { ok: false, error: 'name must be a string' , field: "name" };
    } else if ([...body.name].length > 250) {
      return { ok: false, error: 'name must be 250 characters or fewer' , field: "name" };
    } else {
      value.name = body.name;
    }
  }
  if ('internalMemo' in body) {
    if (body.internalMemo === null || body.internalMemo === '') {
      value.internalMemo = null;
    } else if (typeof body.internalMemo !== 'string') {
      return { ok: false, error: 'internalMemo must be a string' , field: "internalMemo" };
    } else if ([...body.internalMemo].length > 1_000) {
      return { ok: false, error: 'internalMemo must be 1000 characters or fewer' , field: "internalMemo" };
    } else {
      value.internalMemo = body.internalMemo;
    }
  }
  if ('replyDelaySeconds' in body) {
    if (body.replyDelaySeconds === null || body.replyDelaySeconds === 0) {
      value.replyDelaySeconds = null;
    } else if (!Number.isInteger(body.replyDelaySeconds)
      || Number(body.replyDelaySeconds) < 0
      || Number(body.replyDelaySeconds) > 86_400) {
      return { ok: false, error: 'replyDelaySeconds must be an integer from 0 to 86400' , field: "replyDelaySeconds" };
    } else {
      value.replyDelaySeconds = Number(body.replyDelaySeconds);
    }
  }
  if ('unmatchedAction' in body) {
    if (body.unmatchedAction === null) {
      value.unmatchedAction = null;
    } else if (!body.unmatchedAction || typeof body.unmatchedAction !== 'object'
      || Array.isArray(body.unmatchedAction)) {
      return { ok: false, error: 'unmatchedAction must be an object' , field: "unmatchedAction" };
    } else {
      value.unmatchedAction = body.unmatchedAction as Record<string, unknown>;
    }
  }

  return { ok: true, value };
}

export const AUTO_REPLY_RESPONSE_MAX = 5000;

export /** 保存されている JSON を読む。壊れていても画面を落とさない。 */
function readJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

export function draftInputFromSettings(settings: AutoReplyDraftSettings): AutoReplyDraftInput {
  return {
    keyword: settings.keyword,
    matchType: settings.matchType,
    responseType: settings.responseType,
    responseContent: settings.responseContent,
    templateId: settings.templateId,
    lineAccountId: settings.lineAccountId ?? '',
    activeFrom: settings.activeFrom,
    activeUntil: settings.activeUntil,
    cooldownMinutes: settings.cooldownMinutes,
    skipWhenOperatorActive: settings.skipWhenOperatorActive,
    priority: settings.priority,
    messageKinds: readJson<string[]>(settings.messageKinds),
    receiveSources: settings.receiveSources,
    friendConditions: readJson<Record<string, unknown>>(settings.friendConditions),
    actions: readJson<unknown[]>(settings.actions),
    responseWeekdays: readJson<number[]>(settings.responseWeekdays),
    responseHolidayRule: settings.responseHolidayRule as AutoReplyDraftInput['responseHolidayRule'],
    oncePerFriend: settings.oncePerFriend,
    keywords: readJson<AutoReplyDraftInput['keywords']>(settings.keywords),
    respondToAll: settings.respondToAll,
    name: settings.name,
    normalizeKeywords: settings.normalizeKeywords !== false,
    keywordMatchMode: settings.keywordMatchMode === 'all' ? 'all' : 'any',
    folderId: settings.folderId,
    internalMemo: settings.internalMemo ?? null,
    replyDelaySeconds: settings.replyDelaySeconds ?? null,
    unmatchedAction: readJson<Record<string, unknown>>(settings.unmatchedAction),
  };
}

export function draftVersionResponse(version: AutoReplyVersionRow): AutoReplyDraftVersion {
  return {
    autoReplyId: version.auto_reply_id,
    versionId: version.id,
    versionNumber: Number(version.version_number),
    status: version.status,
    settings: draftInputFromSettings(parseAutoReplyVersionSettings(version)),
    lastTestStatus: version.last_test_status,
    lastTestedAt: version.last_tested_at,
    publishedAt: version.published_at,
  };
}

export type DraftReadResult =
  // m26c : テンプレートの所属も返す。呼び出し側が閲覧権限を検査する。
  | { ok: true; value: AutoReplyDraftSettings; templateLineAccountId: string | null }
  | { ok: false; error: string; field?: string };
