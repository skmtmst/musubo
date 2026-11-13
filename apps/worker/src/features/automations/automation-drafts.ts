import type { AutomationVersionContent } from './automation-version-content.js';
export type { AutomationVersionContent } from './automation-version-content.js';
import { validateTemplateMessage } from '../../services/template-message-validation.js';
import { buildMessage } from '../../services/line-message.js';
import { automationDraftCreationStatements } from './automation-draft-storage.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { readFolderAssignment, FolderAssignmentError } from '@line-crm/db';
import { resolveCommonActionVersion } from './automation-engine.js';
import { buildSegmentWhere, parseCondition } from '../../services/segment-query.js';
import { parseAutomationWait, type SegmentCondition } from '@line-crm/shared';

export type AutomationDraftActionType =
  | 'add_tag'
  | 'start_scenario'
  | 'send_message'
  | 'wait'
  | 'common_action'
  | 'notify_staff';
export type AutomationDraftTriggerType =
  | 'friend_add'
  | 'tag_change'
  | 'message_received'
  | 'form_submitted'
  | 'link_clicked'
  | 'calendar_booked'
  | 'restaurant.reservation.created'
  | 'restaurant.reservation.changed'
  | 'restaurant.reservation.cancelled'
  | 'restaurant.arrived'
  | 'restaurant.arrival_undone'
  | 'restaurant.departed'
  | 'restaurant.departure_undone'
  | 'restaurant.waitlist.invited'
  | 'datetime'
  | 'daily'
  | 'weekly'
  | 'ec.order.confirmed';

export interface AutomationDraftAction {
  id: string;
  type: AutomationDraftActionType;
  params: Record<string, unknown>;
  onFailure: 'stop';
}

export interface AutomationTemplateSummary {
  key: string;
  name: string;
  description: string;
  triggerLabel: string;
  actionLabel: string;
}

interface AutomationTemplateDefinition extends AutomationTemplateSummary {
  triggerType: AutomationDraftTriggerType;
  triggerConfig: Record<string, unknown>;
  actions: AutomationDraftAction[];
}

export interface AutomationDraftDetail {
  id: string;
  folderId: string | null;
  draftVersionId: string;
  name: string;
  description: string | null;
  eventType: AutomationDraftTriggerType;
  triggerConfig: Record<string, unknown>;
  conditions: Record<string, unknown>;
  actions: AutomationDraftAction[];
  /**
   * 監査 /: 下書きの各「共通アクションを実行」が、確認した時点で
   * どの公開版を指すか。送る内容の確認と実行前の照合の両方に使う。
   * 実行計画を立てる瞬間と同じ順番（下書きの処理の並び）で返す。
   */
  commonActionRefs: AutomationDraftCommonActionRef[];
  /**
   * `commonActionRefs` が指す版の中身。版のidを鍵にする。
   * 版の中身に入れ子の「共通アクションを実行」があるとき、その固定先の版も
   * 同じ地図へ入れるので、確認画面はネスト分も同じ版番号まで辿って出せる。
   */
  commonActionVersions: Record<string, AutomationDraftCommonActionVersionDetail>;
}

/** 下書きの処理1件が指す共通アクションの固定版（見つからないときは null）。 */
export interface AutomationDraftCommonActionRef {
  /** 下書きの処理の番号（束の consumer_path と同じ）。 */
  stepId: string;
  commonActionId: string;
  name: string | null;
  versionId: string | null;
  versionNumber: number | null;
}

/** 確認画面へ出すための、共通アクションの版の中身。 */
export interface AutomationDraftCommonActionVersionDetail {
  commonActionId: string;
  name: string;
  versionNumber: number;
  /** 版に保存された処理。共通アクションは多様な種別を持つので緩い形のまま。 */
  actions: Array<{
    id: string;
    type: string;
    params: Record<string, unknown>;
    onFailure: 'stop' | 'continue';
  }>;
}


async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 版の中身の指紋。**1文字でも違えば別の値**になる。
 *
 * 長さを前に付けてから繋ぐので、区切りの文字が中身に紛れていても
 * 別の組み合わせが同じ文字列にならない。
 */
export async function automationVersionFingerprint(content: AutomationVersionContent): Promise<string> {
  const joined = [
    content.trigger_type, content.trigger_config, content.condition_config, content.action_config,
  ].map((part) => `${part.length}:${part}`).join('|');
  return (await sha256Hex(joined)).slice(0, 32);
}

/**
 * 確認した版の revision は <版の行のid>.<中身の指紋> とし、画面は不透明な値として扱う。
 * 同じ行 ID の内容更新も検出できるよう指紋を含め、判定方法を画面と Worker へ重複させない。
 */
export async function automationRevisionToken(
  versionId: string,
  content: AutomationVersionContent,
): Promise<string> {
  return `${versionId}.${await automationVersionFingerprint(content)}`;
}

/** 札を、版の行のidと指紋に分ける。指紋の付いていない古い形も受け取る。 */
export function parseAutomationRevision(value: unknown): { versionId: string; fingerprint: string | null } {
  const raw = typeof value === 'string' ? value.trim() : '';
  // 版の行のidはUUIDで `.` を含まない。最後の `.` から後ろが指紋。
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return { versionId: raw, fingerprint: null };
  return { versionId: raw.slice(0, separator), fingerprint: raw.slice(separator + 1) };
}

export interface AutomationDraftResources {
  tags: Array<{ id: string; name: string }>;
  scenarios: Array<{ id: string; name: string }>;
  /** 呼び出せるのは公開済みだけ。下書き・保管済みは実行計画へ固定できない。 */
  commonActions: Array<{ id: string; name: string }>;
}

export class AutomationDraftError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'AutomationDraftError';
  }
}

const TEMPLATES: readonly AutomationTemplateDefinition[] = [
  {
    key: 'welcome-scenario',
    name: '友だち追加のお迎え',
    description: '友だちになった人へ、選んだシナリオを始めます。',
    triggerLabel: '友だちになったとき',
    actionLabel: 'シナリオを始める',
    triggerType: 'friend_add',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'start_scenario', params: { scenarioId: '' }, onFailure: 'stop' }],
  },
  {
    key: 'received-message-tag',
    name: '問い合わせを見分ける',
    description: 'メッセージが届いた人へ、選んだタグを付けます。',
    triggerLabel: 'メッセージが届いたとき',
    actionLabel: 'タグを付ける',
    triggerType: 'message_received',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: '' }, onFailure: 'stop' }],
  },
  {
    key: 'tag-followup-scenario',
    name: 'タグからフォローを始める',
    description: '選んだタグが付いた人へ、選んだシナリオを始めます。',
    triggerLabel: 'タグが付いたとき',
    actionLabel: 'シナリオを始める',
    triggerType: 'tag_change',
    triggerConfig: { tagId: '', action: 'add' },
    actions: [{ id: 'step-1', type: 'start_scenario', params: { scenarioId: '' }, onFailure: 'stop' }],
  },
  {
    key: 'first-order-thanks',
    name: '初回購入のお礼',
    description: '注文が確定した人へ、お礼のメッセージを送ります。',
    triggerLabel: '注文が確定したとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'ec.order.confirmed',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'birthday-coupon',
    name: '誕生月のクーポン',
    description: '誕生月のタグが付いた人へ、クーポンのメッセージを送ります。',
    triggerLabel: 'タグが付いたとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'tag_change',
    triggerConfig: { tagId: '', action: 'add' },
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'shipping-notice',
    name: '発送のお知らせ',
    description: '発送済みのタグが付いた人へ、発送のメッセージを送ります。',
    triggerLabel: 'タグが付いたとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'tag_change',
    triggerConfig: { tagId: '', action: 'add' },
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'subscription-pause-guide',
    name: '定期便の休止案内',
    description: '休止を考えている人へ、休止ではなくお届け間隔の変更を案内します。',
    triggerLabel: 'タグが付いたとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'tag_change',
    triggerConfig: { tagId: '', action: 'add' },
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'monthly-first',
    name: '毎月1日のお知らせ',
    description: '毎月1日になったら、決めた人へ今月のお知らせを送ります。日時と対象は選び直します。',
    triggerLabel: '決めた時刻になったとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'datetime',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'form-thanks',
    name: 'フォーム回答のお礼',
    description: 'フォームに回答した人へ、お礼のメッセージを送ります。',
    triggerLabel: 'フォームに回答したとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'form_submitted',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'booking-confirm',
    name: '予約確定のお礼',
    description: '予約が確定した人へ、確認のメッセージを送ります。',
    triggerLabel: '予約が確定したとき',
    actionLabel: 'メッセージを送る',
    triggerType: 'calendar_booked',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
  {
    key: 'link-interest-tag',
    name: 'リンクを押した人へ',
    description: '選んだリンクを押した人へ、興味のタグを付けます。',
    triggerLabel: 'リンクが押されたとき',
    actionLabel: 'タグを付ける',
    triggerType: 'link_clicked',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: '' }, onFailure: 'stop' }],
  },
  {
    key: 'weekly-recommend',
    name: '毎週のおすすめ',
    description: '毎週決めた曜日に、決めた人へおすすめを送ります。対象は選び直します。',
    triggerLabel: '毎週決まった曜日・時刻',
    actionLabel: 'メッセージを送る',
    triggerType: 'weekly',
    triggerConfig: {},
    actions: [{ id: 'step-1', type: 'send_message', params: {}, onFailure: 'stop' }],
  },
] as const;

function template(key: string): AutomationTemplateDefinition {
  const found = TEMPLATES.find((item) => item.key === key);
  if (!found) throw new AutomationDraftError('template_not_found', '選んだ見本は現在使えません');
  return found;
}

function requiredString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AutomationDraftError('required', `${label}を選んでください`, field);
  }
  return value.trim();
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 下で保存データの不整合として扱う。
  }
  throw new AutomationDraftError('stored_data_invalid', `${label}を読み込めませんでした`);
}

function parseActions(raw: string): AutomationDraftAction[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value as AutomationDraftAction[];
  } catch {
    // 下で保存データの不整合として扱う。
  }
  throw new AutomationDraftError('stored_data_invalid', '下書きの処理を読み込めませんでした');
}

/**
 * 保存後の人数確認で条件が壊れないよう、保存前に計算側と同じ部品で条件を組み立てる。
 * 組み立てられない条件は版を作る前に断る。空の条件 {} は絞り込みなしとして許す。
 */
function assertDraftConditionUsable(conditions: unknown): void {
  if (conditions === null || typeof conditions !== 'object' || Array.isArray(conditions)) {
    throw new AutomationDraftError('condition_invalid', '対象条件を確認してください', 'conditions');
  }
  if (Object.keys(conditions as Record<string, unknown>).length === 0) return;
  const parsed = parseCondition(JSON.stringify(conditions));
  if (!parsed) {
    throw new AutomationDraftError('condition_invalid', '対象条件を確認してください', 'conditions');
  }
  assertSegmentConditionComputes(parsed);
}

/**
 * 条件を WHERE へ組み立てられるかの最終確認。組み立てられなければ
 * 「対象条件の形が正しくありません」として拒否する。
 */
function assertSegmentConditionComputes(condition: SegmentCondition): void {
  try {
    buildSegmentWhere(condition);
  } catch {
    throw new AutomationDraftError(
      'condition_invalid',
      '対象条件の形が正しくありません。条件を選び直してください',
      'conditions',
    );
  }
}

async function requireResource(
  db: D1Database,
  table: 'tags' | 'scenarios',
  id: string,
  lineAccountId: string,
  field: string,
  label: string,
): Promise<void> {
  const activeClause = table === 'scenarios' ? ' AND is_active = 1' : '';
  const row = await db.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND line_account_id = ?${activeClause} LIMIT 1`,
  ).bind(id, lineAccountId).first<{ id: string }>();
  if (!row) throw new AutomationDraftError('resource_not_found', `${label}を選び直してください`, field);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AutomationDraftError('invalid', '選択内容を確認してください', field);
  }
  return value.trim();
}

async function requireScopedId(
  db: D1Database,
  input: { sql: string; binds: unknown[]; field: string; label: string },
): Promise<void> {
  const row = await db.prepare(input.sql).bind(...input.binds).first<{ id: string }>();
  if (!row) throw new AutomationDraftError('resource_not_found', `${input.label}を選び直してください`, input.field);
}

async function validateTriggerConfig(
  db: D1Database,
  eventType: AutomationDraftTriggerType,
  value: unknown,
  lineAccountId: string,
  allowMissingTag = false,
): Promise<Record<string, unknown>> {
  const config = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
  const allowed: Record<AutomationDraftTriggerType, ReadonlySet<string>> = {
    friend_add: new Set(),
    tag_change: new Set(['tagId', 'action']),
    message_received: new Set(['keyword']),
    form_submitted: new Set(['formId']),
    link_clicked: new Set(['trackedLinkId']),
    calendar_booked: new Set(['bookingType', 'menuId', 'eventId']),
    'restaurant.reservation.created': new Set(['storeId']),
    'restaurant.reservation.changed': new Set(['storeId']),
    'restaurant.reservation.cancelled': new Set(['storeId']),
    'restaurant.arrived': new Set(['storeId']),
    'restaurant.arrival_undone': new Set(['storeId']),
    'restaurant.departed': new Set(['storeId']),
    'restaurant.departure_undone': new Set(['storeId']),
    'restaurant.waitlist.invited': new Set(['storeId']),
    datetime: new Set(['at', 'friendIds']),
    daily: new Set(['time', 'friendIds']),
    weekly: new Set(['time', 'weekdays', 'friendIds']),
    'ec.order.confirmed': new Set(),
  };
  const unknown = Object.keys(config).find((key) => !allowed[eventType].has(key));
  if (unknown) throw new AutomationDraftError('trigger_config_invalid', 'きっかけの設定を確認してください', unknown);

  if (eventType.startsWith('restaurant.')) {
    const storeId=optionalString(config.storeId,'storeId');
    if(storeId)await requireScopedId(db,{sql:'SELECT id FROM rt_stores WHERE id=? AND line_account_id=?',binds:[storeId,lineAccountId],field:'storeId',label:'お店'});
    return storeId?{storeId}:{};
  }
  if (eventType === 'tag_change') {
    const tagId = allowMissingTag ? optionalString(config.tagId, 'triggerTagId') ?? '' : requiredString(config.tagId, 'triggerTagId', 'きっかけのタグ');
    if (tagId) await requireResource(db, 'tags', tagId, lineAccountId, 'triggerTagId', 'きっかけのタグ');
    if (config.action !== 'add' && config.action !== 'remove') {
      throw new AutomationDraftError('trigger_config_invalid', 'タグを付けたときか外したときを選んでください', 'triggerAction');
    }
    return { tagId, action: config.action };
  }
  if (eventType === 'message_received') {
    const keyword = optionalString(config.keyword, 'keyword');
    return keyword ? { keyword } : {};
  }
  if (eventType === 'form_submitted') {
    const formId = optionalString(config.formId, 'formId');
    if (formId) await requireScopedId(db, {
      sql: `SELECT form_id AS id FROM form_accounts WHERE form_id = ? AND line_account_id = ?`,
      binds: [formId, lineAccountId], field: 'formId', label: '回答フォーム',
    });
    return formId ? { formId } : {};
  }
  if (eventType === 'link_clicked') {
    const trackedLinkId = optionalString(config.trackedLinkId, 'trackedLinkId');
    if (trackedLinkId) await requireScopedId(db, {
      sql: `SELECT id FROM tracked_links WHERE id = ? AND line_account_id = ? AND is_active = 1`,
      binds: [trackedLinkId, lineAccountId], field: 'trackedLinkId', label: '計測リンク',
    });
    return trackedLinkId ? { trackedLinkId } : {};
  }
  if (eventType === 'calendar_booked') {
    const bookingType = optionalString(config.bookingType, 'bookingType');
    if (bookingType && bookingType !== 'salon' && bookingType !== 'event') {
      throw new AutomationDraftError('trigger_config_invalid', '予約の種類を選び直してください', 'bookingType');
    }
    const menuId = optionalString(config.menuId, 'menuId');
    const eventId = optionalString(config.eventId, 'eventId');
    if (menuId) await requireScopedId(db, {
      sql: `SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`,
      binds: [menuId, lineAccountId], field: 'menuId', label: '予約メニュー',
    });
    if (eventId) await requireScopedId(db, {
      sql: `SELECT id FROM events WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`,
      binds: [eventId, lineAccountId], field: 'eventId', label: 'イベント',
    });
    if ((bookingType === 'salon' && eventId) || (bookingType === 'event' && menuId)) {
      throw new AutomationDraftError('trigger_config_invalid', '予約の種類と絞り込み先が一致しません', 'bookingType');
    }
    return {
      ...(bookingType ? { bookingType } : {}),
      ...(menuId ? { menuId } : {}),
      ...(eventId ? { eventId } : {}),
    };
  }
  if (eventType === 'datetime' || eventType === 'daily' || eventType === 'weekly') {
    if (!Array.isArray(config.friendIds) || config.friendIds.length === 0 || config.friendIds.length > 100
      || config.friendIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new AutomationDraftError('trigger_config_invalid', '対象の友だちは1〜100人で選んでください', 'friendIds');
    }
    const friendIds = [...new Set(config.friendIds as string[])];
    const placeholders = sqlIdSet(friendIds).sql;
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM friends WHERE line_account_id = ? AND id IN (${placeholders})`,
    ).bind(lineAccountId, ...(friendIds.length ? sqlIdSet(friendIds).binds : [])).first<{ count: number }>();
    if (Number(count?.count ?? 0) !== friendIds.length) {
      throw new AutomationDraftError('resource_not_found', '対象の友だちを選び直してください', 'friendIds');
    }
    if (eventType === 'datetime') {
      const at = requiredString(config.at, 'at', '実行日時');
      if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) {
        throw new AutomationDraftError('trigger_config_invalid', 'タイムゾーンを含む日時を入力してください', 'at');
      }
      if (Date.parse(at) <= Date.now()) {
        throw new AutomationDraftError('trigger_config_invalid', 'これからの日時を入力してください', 'at');
      }
      return { at, friendIds };
    }
    const time = requiredString(config.time, 'time', '実行時刻');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || Number(time.slice(3)) % 5 !== 0) {
      throw new AutomationDraftError('trigger_config_invalid', '時刻は5分単位で入力してください', 'time');
    }
    if (eventType === 'weekly') {
      /*
       * R21: 曜日は0〜6の整数の配列だけを受け付ける。空の要素由来の
       * 混入（"1,3," → [1,3,0]）を防ぐため、文字列・小数・範囲外・
       * 空配列・重複はすべて受け付けず選び直しを求める。
       */
      if (!Array.isArray(config.weekdays) || config.weekdays.length === 0
        || config.weekdays.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)
        || new Set(config.weekdays as number[]).size !== (config.weekdays as unknown[]).length) {
        throw new AutomationDraftError('trigger_config_invalid', '曜日を1つ以上選んでください', 'weekdays');
      }
      return { time, weekdays: [...(config.weekdays as number[])].sort((a, b) => a - b), friendIds };
    }
    return { time, friendIds };
  }
  return {};
}

export function listAutomationTemplates(): AutomationTemplateSummary[] {
  return TEMPLATES.map(({ key, name, description, triggerLabel, actionLabel }) => ({
    key, name, description, triggerLabel, actionLabel,
  }));
}

export async function listAutomationDraftResources(
  db: D1Database,
  lineAccountId: string,
): Promise<AutomationDraftResources> {
  const [tags, scenarios, commonActions] = await Promise.all([
    db.prepare(
      'SELECT id, name FROM tags WHERE line_account_id = ? ORDER BY name ASC',
    ).bind(lineAccountId).all<{ id: string; name: string }>(),
    db.prepare(
      `SELECT id, name FROM scenarios
        WHERE line_account_id = ? AND is_active = 1 ORDER BY name ASC`,
    ).bind(lineAccountId).all<{ id: string; name: string }>(),
    db.prepare(
      `SELECT id, name FROM common_actions
        WHERE line_account_id = ? AND status = 'published'
          AND current_published_version_id IS NOT NULL
        ORDER BY name ASC`,
    ).bind(lineAccountId).all<{ id: string; name: string }>(),
  ]);
  return {
    tags: tags.results ?? [],
    scenarios: scenarios.results ?? [],
    commonActions: commonActions.results ?? [],
  };
}

/**
 * 別の新規作成で下書きを上書きしないよう、operationKey が同じ操作だけを同じ ID に収束させる。
 * 画面は新規作成ごとに鍵を発行し、再試行では同じ鍵を使う。世代番号は公開済みの下書き ID と衝突しないために使う。
 */
async function templateDraftId(
  input: {
    templateKey: string;
    lineAccountId: string;
    operationKey: string;
    createdBy?: string | null;
  },
  generation: number,
): Promise<string> {
  const seed = [
    'automation-template-draft',
    input.lineAccountId,
    input.templateKey,
    input.createdBy ?? 'anonymous',
    input.operationKey,
    String(generation),
  ].map((part) => `${part.length}:${part}`).join('|');
  const hex = await sha256Hex(seed);
  // 既存のidと同じ見た目（UUIDの形）に整える。
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * 連打防止はタブをまたげないため、冪等鍵を主鍵にして DB 側で下書きを1件に収める。
 * 定義と版をひとつのまとまりで保存し、途中の割り込みで版のない定義を残さない。既存の下書きには版を追加せず、そのまま返す。
 */
export async function createAutomationDraftFromTemplate(
  db: D1Database,
  input: {
    templateKey: string;
    lineAccountId: string;
    /** 新規作成の操作を識別する鍵。同じ操作の再試行だけが同じ鍵を使う。 */
    operationKey: unknown;
    folderId?: unknown;
    createdBy?: string | null;
  },
): Promise<{ id: string; draftVersionId: string }> {
  const folderId = await automationFolder(db, input.lineAccountId, input.folderId);
  const source = template(input.templateKey);
  /*
   * 鍵が無い・形が違う呼び出しは「別の操作」と見分けられないので断る。
   * ここを黙って通すと、古い画面や手作業の呼び出しが店・見本・担当者だけで
   * 前の下書きへ戻り、その中身を上書きする道が残る。
   */
  const operationKey = typeof input.operationKey === 'string' ? input.operationKey.trim() : '';
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(operationKey)) {
    throw new AutomationDraftError(
      'operation_key_invalid',
      '作成の鍵が正しくありません。画面を読み直してから、もう一度お試しください',
    );
  }
  const operation = { ...input, operationKey };
  const now = new Date().toISOString();

  // 公開済みなどで鍵が埋まっていたら、次の世代へずらす。
  for (let generation = 0; generation < 32; generation += 1) {
    const id = await templateDraftId(operation, generation);
    const versionId = crypto.randomUUID();
    await db.batch(automationDraftCreationStatements(db,{
      id,versionId,lineAccountId:input.lineAccountId,name:source.name,description:source.description,
      folderId,createdBy:input.createdBy,now,content:{trigger_type:source.triggerType,
        trigger_config:JSON.stringify(source.triggerConfig),condition_config:'{}',action_config:JSON.stringify(source.actions)},
    }));

    const row = await db.prepare(
      `SELECT d.current_draft_version_id, v.trigger_type, v.trigger_config,
              v.condition_config, v.action_config
         FROM automation_definitions d
         JOIN automation_versions v
           ON v.id = d.current_draft_version_id
          AND v.automation_id = d.id AND v.status = 'draft'
        WHERE d.id = ? AND d.line_account_id = ? AND d.status = 'draft'`,
    ).bind(id, input.lineAccountId).first<AutomationVersionContent & { current_draft_version_id: string }>();
    // この鍵が別の用途（公開済み・他店）で埋まっていたら次の世代を試す。
    if (!row) continue;
    return { id, draftVersionId: await automationRevisionToken(row.current_draft_version_id, row) };
  }
  throw new AutomationDraftError('template_conflict', '下書きを作れませんでした。少し待ってからもう一度お試しください');
}

interface AutomationDraftRow extends AutomationVersionContent {
  id: string;
  folder_id: string | null;
  name: string;
  description: string | null;
  current_draft_version_id: string;
  trigger_type: AutomationDraftDetail['eventType'];
  created_by: string | null;
  /** 定義の状態。公開済みの定義にも下書きをぶら下げられる。
      保管済みは読み取り側の WHERE で除くため、ここには現れない。 */
  definition_status: 'draft' | 'active' | 'stopped';
}

/**
 * 下書きを、保存されている生の文字列のまま読む。突き合わせはこの値で行う。
 *
 * 定義の状態は問わない。新規の下書き（`status='draft'`）だけでなく、
 * 動いている・止めている定義にぶら下がった改訂用の下書きも読む
 * （一覧の「編集」→ `createAutomationDraftFromDefinition` が作る）。
 * 保管済み（`archived`）は一覧から消えているので、ここでも開かせない。
 */
async function readAutomationDraftRow(
  db: D1Database,
  input: { id: string; lineAccountId: string },
): Promise<AutomationDraftRow> {
  const row = await db.prepare(
    `SELECT d.id, d.name, d.description, d.folder_id, d.status AS definition_status,
            d.current_draft_version_id, v.created_by,
            v.trigger_type, v.trigger_config, v.condition_config, v.action_config
       FROM automation_definitions d
       JOIN automation_versions v
         ON v.id = d.current_draft_version_id
        AND v.automation_id = d.id AND v.status = 'draft'
      WHERE d.id = ? AND d.line_account_id = ? AND d.status IN ('draft', 'active', 'stopped')`,
  ).bind(input.id, input.lineAccountId).first<AutomationDraftRow>();
  if (!row) throw new AutomationDraftError('not_found', '編集中の下書きが見つかりません');
  return row;
}

export async function getAutomationDraft(
  db: D1Database,
  input: { id: string; lineAccountId: string },
): Promise<AutomationDraftDetail> {
  const row = await readAutomationDraftRow(db, input);
  const actions = parseActions(row.action_config);
  const commonActionRefs = await resolveDraftCommonActionRefs(
    db, input.lineAccountId, row.id, actions,
  );
  const commonActionVersions = await collectCommonActionVersionDetails(
    db,
    input.lineAccountId,
    commonActionRefs.map((ref) => ref.versionId).filter((id): id is string => !!id),
  );
  return {
    id: row.id,
    folderId: row.folder_id ?? null,
    // 中身の指紋を混ぜた札を返す。画面はこれをそのまま送り返すだけでよい。
    draftVersionId: await automationRevisionToken(row.current_draft_version_id, row),
    name: row.name,
    description: row.description,
    eventType: row.trigger_type,
    triggerConfig: parseObject(row.trigger_config, '下書きのきっかけ'),
    conditions: parseObject(row.condition_config, '下書きの条件'),
    actions,
    commonActionRefs,
    commonActionVersions,
  };
}

/**
 * 下書きの各「共通アクションを実行」が実行時に使う版を、実行計画と同じ
 * 引き方（`resolveCommonActionVersion`）で解決する。束がまだ無い・参照先が
 * 消えた・公開版が無いときは `versionId` が null になり、確認画面は
 * 「送る内容を確かめられない」として送信へ進めない。
 */
async function resolveDraftCommonActionRefs(
  db: D1Database,
  lineAccountId: string,
  automationId: string,
  actions: AutomationDraftAction[],
): Promise<AutomationDraftCommonActionRef[]> {
  const refs: AutomationDraftCommonActionRef[] = [];
  for (const action of actions) {
    if (action.type !== 'common_action') continue;
    const commonActionId = typeof action.params.commonActionId === 'string'
      ? action.params.commonActionId
      : '';
    const versionId = await resolveCommonActionVersion(db, {
      lineAccountId, automationId, action,
    });
    const meta = await db.prepare(
      `SELECT ca.name, cav.version_number
         FROM common_actions ca
         LEFT JOIN common_action_versions cav ON cav.id = ?
        WHERE ca.id = ? AND ca.line_account_id = ?`,
    ).bind(versionId, commonActionId, lineAccountId)
      .first<{ name: string; version_number: number | null }>();
    refs.push({
      stepId: action.id,
      commonActionId,
      name: meta?.name ?? null,
      versionId,
      versionNumber: meta?.version_number == null ? null : Number(meta.version_number),
    });
  }
  return refs;
}

/**
 * 確認画面へ出す版の中身を集める。種の版から辿れる入れ子の固定先
 * （版の中身に書き込まれた `commonActionVersionId`）も同じ地図へ足す。
 * 上限は実行計画の呼び出し深さと同じ考え方で絞る。
 */
const COMMON_ACTION_VERSION_MAP_MAX = 50;

async function collectCommonActionVersionDetails(
  db: D1Database,
  lineAccountId: string,
  seedVersionIds: string[],
): Promise<Record<string, AutomationDraftCommonActionVersionDetail>> {
  const versions: Record<string, AutomationDraftCommonActionVersionDetail> = {};
  const queue = [...seedVersionIds];
  while (queue.length > 0 && Object.keys(versions).length < COMMON_ACTION_VERSION_MAP_MAX) {
    const versionId = queue.shift() ?? '';
    if (!versionId || versions[versionId]) continue;
    const row = await db.prepare(
      `SELECT cav.common_action_id, cav.version_number, cav.action_config, ca.name
         FROM common_action_versions cav
         JOIN common_actions ca ON ca.id = cav.common_action_id
        WHERE cav.id = ? AND cav.status = 'published' AND ca.line_account_id = ?`,
    ).bind(versionId, lineAccountId).first<{
      common_action_id: string; version_number: number; action_config: string; name: string;
    }>();
    if (!row) continue;
    let steps: AutomationDraftCommonActionVersionDetail['actions'] = [];
    try {
      const parsed: unknown = JSON.parse(row.action_config);
      if (Array.isArray(parsed)) steps = parsed as AutomationDraftCommonActionVersionDetail['actions'];
    } catch {
      // 読めない版は空として出し、確認画面が「中身を確かめられない」側へ倒す。
    }
    versions[versionId] = {
      commonActionId: row.common_action_id,
      name: row.name,
      versionNumber: Number(row.version_number),
      actions: steps,
    };
    for (const step of steps) {
      const nested = typeof step.params?.commonActionVersionId === 'string'
        ? step.params.commonActionVersionId.trim()
        : '';
      if (nested && !versions[nested]) queue.push(nested);
    }
  }
  return versions;
}

export async function updateAutomationDraft(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedDraftVersionId: unknown;
    folderId?: unknown;
    name: unknown;
    eventType: unknown;
    triggerConfig: unknown;
    conditions?: unknown;
    actions: unknown;
    transaction?:{before?:D1PreparedStatement[];after?:(versionId:string)=>D1PreparedStatement[]};
  },
): Promise<{ draftVersionId: string }> {
  const folderId = await automationFolder(db, input.lineAccountId, input.folderId);
  const current = await readAutomationDraftRow(db, { id: input.id, lineAccountId: input.lineAccountId });
  const expected = requiredString(input.expectedDraftVersionId, 'expectedDraftVersionId', '編集中の版');
  // 札には中身の指紋が入っているので、この1行で「行が同じか」だけでなく
  // 「中身が同じか」まで見ている。指紋の無い古い形の札は中身を守れないので
  // 受け取らない（黙って素通しすると、守っているつもりの穴が残る）。
  const requested = parseAutomationRevision(expected);
  if (!requested.fingerprint) {
    throw new AutomationDraftError('version_conflict', '編集中の版を読み直してください', 'expectedDraftVersionId');
  }
  if (await automationRevisionToken(current.current_draft_version_id, current) !== expected) {
    throw new AutomationDraftError('version_conflict', '別の人が下書きを更新しました。再読み込みしてください');
  }
  const expectedVersionId = requested.versionId;
  const name = requiredString(input.name, 'name', 'ルール名');
  const allowedTriggers = new Set<AutomationDraftTriggerType>([
    'friend_add', 'tag_change', 'message_received', 'form_submitted', 'link_clicked',
    'calendar_booked', 'datetime', 'daily', 'weekly', 'ec.order.confirmed',
    'restaurant.reservation.created', 'restaurant.reservation.changed', 'restaurant.reservation.cancelled', 'restaurant.arrived', 'restaurant.arrival_undone', 'restaurant.departed', 'restaurant.departure_undone', 'restaurant.waitlist.invited',
  ]);
  const eventType = requiredString(input.eventType, 'eventType', 'きっかけ');
  if (!allowedTriggers.has(eventType as AutomationDraftTriggerType)) {
    throw new AutomationDraftError('trigger_unsupported', 'このきっかけはまだ実行まで接続されていません', 'eventType');
  }
  const triggerConfig = await validateTriggerConfig(
    db, eventType as AutomationDraftTriggerType, input.triggerConfig, input.lineAccountId, true,
  );
  const conditions = input.conditions === undefined
    ? parseObject(current.condition_config, '下書きの条件')
    : input.conditions;
  assertDraftConditionUsable(conditions);

  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 20) {
    throw new AutomationDraftError('actions_invalid', 'することは1〜20個で選んでください', 'actions');
  }
  const actions: AutomationDraftAction[] = [];
  const ids = new Set<string>();
  /*
   * 共通アクションの呼び出し束。
   *
   * 版は実行計画へ焼き付けるとき `common_action_bindings` から引く
   * （`automation-engine.ts` の `resolveCommonActionVersion`）。
   * `consumer_path` には処理の番号（action.id）を使うので、ここで
   * （このオートメーション, この処理番号, この共通アクション）へ
   * いま公開中の版を束ねておく。
   */
  const commonActionBindings: Array<{ path: string; commonActionId: string; versionId: string }> = [];
  for (const [index, candidate] of input.actions.entries()) {
    const raw = candidate as Partial<AutomationDraftAction>;
    if (!raw || !new Set(['add_tag', 'start_scenario', 'send_message', 'common_action', 'notify_staff', 'wait']).has(String(raw.type))) {
      throw new AutomationDraftError('action_unsupported', 'この処理はまだ実行まで接続されていません', `actions.${index}`);
    }
    const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
      ? { ...raw.params }
      : {};
    if (raw.type === 'add_tag') {
      const tagId = optionalString(params.tagId, `actions.${index}.tagId`) ?? '';
      if (tagId) await requireResource(db, 'tags', tagId, input.lineAccountId, `actions.${index}.tagId`, '付けるタグ');
      params.tagId = tagId;
    } else if (raw.type === 'start_scenario') {
      const scenarioId = requiredString(params.scenarioId, `actions.${index}.scenarioId`, '始めるシナリオ');
      await requireResource(db, 'scenarios', scenarioId, input.lineAccountId, `actions.${index}.scenarioId`, '始めるシナリオ');
      params.scenarioId = scenarioId;
    } else if (raw.type === 'common_action') {
      const commonActionId = requiredString(
        params.commonActionId, `actions.${index}.commonActionId`, '使う共通アクション',
      );
      const commonAction = await db.prepare(
        `SELECT id, current_published_version_id FROM common_actions
          WHERE id = ? AND line_account_id = ? AND status = 'published'`,
      ).bind(commonActionId, input.lineAccountId)
        .first<{ id: string; current_published_version_id: string | null }>();
      if (!commonAction?.current_published_version_id) {
        throw new AutomationDraftError(
          'resource_not_found', '公開済みの共通アクションを選び直してください',
          `actions.${index}.commonActionId`,
        );
      }
      params.commonActionId = commonActionId;
      commonActionBindings.push({
        path: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `step-${index + 1}`,
        commonActionId,
        versionId: commonAction.current_published_version_id,
      });
    } else if (raw.type === 'wait') {
      const wait = parseAutomationWait(params);
      if (!wait) throw new AutomationDraftError('wait_invalid', '待つ時間は5分単位、翌日の時刻は時と分で指定してください', `actions.${index}.params.${params.mode === 'next_day' ? 'sendAtTime' : 'durationMinutes'}`);
      for (const key of Object.keys(params)) delete params[key];
      Object.assign(params,wait);
    } else if (raw.type === 'notify_staff') {
      // 担当者通知のルールは、有効ないまの版をこの店の範囲で指す。
      // 送り先・文面の初期値はルール側、追加のひと言はここで足す。
      const notificationRuleId = requiredString(
        params.notificationRuleId, `actions.${index}.notificationRuleId`, '担当者通知',
      );
      const rule = await db.prepare(
        `SELECT id FROM notification_rules
          WHERE id = ? AND line_account_id = ? AND is_active = 1 LIMIT 1`,
      ).bind(notificationRuleId, input.lineAccountId).first<{ id: string }>();
      if (!rule) {
        throw new AutomationDraftError(
          'resource_not_found', '担当者通知が見つからないか、別のLINE公式アカウントにあります',
          `actions.${index}.notificationRuleId`,
        );
      }
      params.notificationRuleId = notificationRuleId;
      params.message = requiredString(params.message, `actions.${index}.message`, '通知文');
    } else {
      params.messageType = typeof params.messageType==='string'?params.messageType:'text';
      params.content = requiredString(params.content, `actions.${index}.content`, '送る文面');
      const checked=validateTemplateMessage(params.messageType as string,params.content as string);
      if(!checked.ok)throw new AutomationDraftError('message_invalid',checked.error,`actions.${index}.content`);
      try{buildMessage(params.messageType as string,params.content as string);}catch{throw new AutomationDraftError('message_invalid','送る内容を確認してください',`actions.${index}.content`);}
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `step-${index + 1}`;
    if (ids.has(id)) throw new AutomationDraftError('action_id_duplicate', '処理の番号が重複しています', `actions.${index}.id`);
    ids.add(id);
    actions.push({ id, type: raw.type as AutomationDraftActionType, params, onFailure: 'stop' });
  }
  const now = new Date().toISOString();
  const nextContent: AutomationVersionContent = {
    trigger_type: eventType,
    trigger_config: JSON.stringify(triggerConfig),
    condition_config: JSON.stringify(conditions),
    action_config: JSON.stringify(actions),
  };
  const nextVersionId = crypto.randomUUID();
  /*
   * 同時保存と未確認の文面の送信を防ぐため、版の行は不変にし、新しい行へ下書きの参照を差し替える。
   * startAutomationRun の版 ID 照合が CAS として働き、更新された版では実行記録を作る前に止まる。
   * 過去の版は実行記録から参照されるため削除しない。
   */
  const statements = [
    db.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, trigger_config,
          condition_config, action_config, created_by, created_at)
       SELECT ?, ?,
              COALESCE((SELECT MAX(version_number) FROM automation_versions WHERE automation_id = ?), 0) + 1,
              'draft', ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM automation_definitions d
            JOIN automation_versions v ON v.id = d.current_draft_version_id
           WHERE d.id = ? AND d.line_account_id = ?
             AND d.status IN ('draft', 'active', 'stopped')
             AND d.current_draft_version_id = ?
             AND v.trigger_type = ? AND v.trigger_config = ?
             AND v.condition_config = ? AND v.action_config = ?
        )`,
    ).bind(
      nextVersionId, current.id, current.id,
      nextContent.trigger_type, nextContent.trigger_config,
      nextContent.condition_config, nextContent.action_config,
      current.created_by ?? null, now,
      current.id, input.lineAccountId, expectedVersionId,
      current.trigger_type, current.trigger_config,
      current.condition_config, current.action_config,
    ),
    db.prepare(
      // 1文目が当たらなかったとき（＝読んだあとに中身が変わったとき）は、
      // ここも当ててはいけない。**無い版を指しにいってしまう。**
      // 新しい版が本当にできたときだけ差し替える。
      `UPDATE automation_definitions
          SET confirmation_revision = confirmation_revision + 1, name = ?, updated_at = ?, current_draft_version_id = ?,
              folder_id = CASE WHEN ? THEN ? ELSE folder_id END
        WHERE id = ? AND line_account_id = ?
          AND status IN ('draft', 'active', 'stopped')
          AND current_draft_version_id = ?
          AND EXISTS (
            SELECT 1 FROM automation_versions WHERE id = ? AND automation_id = ?
          )`,
    ).bind(
      name, now, nextVersionId, folderId !== undefined ? 1 : 0, folderId ?? null, current.id, input.lineAccountId, expectedVersionId,
      nextVersionId, current.id,
    ),
    /*
     * 下書きにある共通アクションの呼び出しだけを INSERT OR IGNORE で追加する。
     * 公開版も同じ束を参照するため、下書き保存で既存の版を変更・削除しない。利用先の更新は共通アクション側で管理する。
     */
    ...commonActionBindings.map((binding) => db.prepare(
      `INSERT OR IGNORE INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'automation', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), input.lineAccountId, binding.commonActionId, binding.versionId,
      current.id, binding.path, current.created_by ?? null, now, now,
    )),
  ];
  const before=input.transaction?.before??[];
  const results = await db.batch([...before,...statements,...(input.transaction?.after?.(nextVersionId)??[])]);
  if ((results[before.length].meta?.changes ?? 0) !== 1 || (results[before.length+1].meta?.changes ?? 0) !== 1) {
    throw new AutomationDraftError('version_conflict', '編集中の下書きが変わりました。再読み込みしてください');
  }
  // 版が新しくなったので札も変わる。画面はこれを次の突き合わせに使う。
  return { draftVersionId: await automationRevisionToken(nextVersionId, nextContent) };
}

export async function publishAutomationDraft(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedDraftVersionId: unknown;
    activate: unknown;
    /**
     * 公開の確認時に画面が見ていた稼働状態。
     * 渡されたときだけ書き込み条件に入れ、読み取り後の停止・再開を
     * 読んだ時点の状態で上書きしない。省略時は従来どおり状態を見ない。
     */
    expectedStatus?: unknown;
    transaction?:{before?:D1PreparedStatement[];after?:(versionId:string)=>D1PreparedStatement[]};
  },
): Promise<{ id: string; versionId: string; versionNumber: number; status: 'active' | 'stopped' }> {
  const current = await readAutomationDraftRow(db, { id: input.id, lineAccountId: input.lineAccountId });
  const expected = requiredString(input.expectedDraftVersionId, 'expectedDraftVersionId', '公開する版');
  const requested = parseAutomationRevision(expected);
  if (!requested.fingerprint) {
    throw new AutomationDraftError('version_conflict', '公開する版を読み直してください', 'expectedDraftVersionId');
  }
  // 見ていない中身をそのまま公開しないよう、公開も中身で突き合わせる。
  if (await automationRevisionToken(current.current_draft_version_id, current) !== expected) {
    throw new AutomationDraftError('version_conflict', '別の人が下書きを更新しました。再読み込みしてください');
  }
  const expectedVersionId = requested.versionId;
  const version = await db.prepare(
    `SELECT version_number FROM automation_versions
      WHERE id = ? AND automation_id = ? AND status = 'draft'`,
  ).bind(expectedVersionId, current.id).first<{ version_number: number }>();
  if (!version) throw new AutomationDraftError('not_found', '公開する下書きが見つかりません');
  if (current.trigger_type === 'tag_change') {
    await validateTriggerConfig(db, 'tag_change', parseObject(current.trigger_config, 'きっかけ'), input.lineAccountId);
  }
  for (const [index, action] of parseActions(current.action_config).entries()) {
    if (action.type !== 'add_tag') continue;
    const tagId = requiredString(action.params?.tagId, `actions.${index}.tagId`, '付けるタグ');
    await requireResource(db, 'tags', tagId, input.lineAccountId, `actions.${index}.tagId`, '付けるタグ');
  }
  /*
   * 古い保存口を通った壊れた条件を、そのまま公開しない。
   * 修復は `updateAutomationDraft` で条件を直して保存し直すだけでよい。
   * 公開は状態を確定させる操作なので、計算できない条件はここでも断る。
   */
  const publishingConditions = parseObject(current.condition_config, '下書きの条件');
  if (Object.keys(publishingConditions).length > 0) {
    const parsed = parseCondition(current.condition_config);
    if (!parsed) {
      throw new AutomationDraftError(
        'condition_invalid',
        '対象条件が読めません。下書きの条件を確認して保存し直してください',
        'conditions',
      );
    }
    assertSegmentConditionComputes(parsed);
  }
  /*
   * 新規の下書き（定義が draft）は `activate` で動かすか止めたままかを選ぶ。
   * **動いている・止めている定義の改訂下書きは、いまの稼働状態を保つ。**
   * 止めているルールを直して公開したら勝手に動き出す、を防ぐ。
   *
   * 読み取りから書き込みまでの間に別の担当が停止（または再開）しても、
   * 読んだ時点の状態で上書きしないよう、画面が見た状態を
   * `expectedStatus` で受け取って書き込み条件に入れる。
   * 食い違えば当てずに 409 で返し、最新の状態変更を残す。
   */
  const status: 'active' | 'stopped' = current.definition_status === 'draft'
    ? (input.activate === false ? 'stopped' : 'active')
    : current.definition_status;
  const expectedStatus = typeof input.expectedStatus === 'string' ? input.expectedStatus : null;
  if (expectedStatus !== null && !['draft', 'active', 'stopped'].includes(expectedStatus)) {
    throw new AutomationDraftError('status_invalid', '公開するルールの状態を確認してください');
  }
  const now = new Date().toISOString();
  /*
   * 2文はひとつのまとまりで当てる。版だけ先に公開済みへ倒れると、
   * 下書きの指し先が宙に浮いて編集面が開けなくなる。
   * 1文目にも定義の指し先と状態の条件を付けて、2文目と同時に
   * 当たる・外れるようにする（batch はひとつの取引きで流れる）。
   */
  const definitionGuard = `EXISTS (
    SELECT 1 FROM automation_definitions d
     WHERE d.id = ? AND d.line_account_id = ?
       AND d.status IN ('draft', 'active', 'stopped')
       ${expectedStatus === null ? '' : 'AND d.status = ?'}
       AND d.current_draft_version_id = ?
  )`;
  const definitionGuardBinds = expectedStatus === null
    ? [current.id, input.lineAccountId, expectedVersionId]
    : [current.id, input.lineAccountId, expectedStatus, expectedVersionId];
  const before=input.transaction?.before??[];
  const results = await db.batch([...before,
    db.prepare(
      `UPDATE automation_versions SET status = 'published', published_at = ?
        WHERE id = ? AND automation_id = ? AND status = 'draft'
          AND trigger_type = ? AND trigger_config = ?
          AND condition_config = ? AND action_config = ?
          AND ${definitionGuard}`,
    ).bind(
      now, expectedVersionId, current.id,
      current.trigger_type, current.trigger_config,
      current.condition_config, current.action_config,
      ...definitionGuardBinds,
    ),
    db.prepare(
      `UPDATE automation_definitions
          SET confirmation_revision = confirmation_revision + 1, status = ?, current_published_version_id = ?, current_draft_version_id = NULL, updated_at = ?
        WHERE id = ? AND line_account_id = ?
          AND status IN ('draft', 'active', 'stopped')
          ${expectedStatus === null ? '' : 'AND status = ?'}
          AND current_draft_version_id = ?`,
    ).bind(
      status, expectedVersionId, now, current.id, input.lineAccountId,
      ...(expectedStatus === null ? [] : [expectedStatus]),
      expectedVersionId,
    ),
  ...(input.transaction?.after?.(expectedVersionId)??[])]);
  if ((results[before.length].meta?.changes ?? 0) !== 1 || (results[before.length+1].meta?.changes ?? 0) !== 1) {
    throw new AutomationDraftError('version_conflict', '公開する前に下書きが変わりました。再読み込みしてください');
  }
  return { id: current.id, versionId: expectedVersionId, versionNumber: Number(version.version_number), status };
}

/**
 * 動いている・止めている定義に「改訂用の下書き」をぶら下げる。
 *
 * 公開済みの版は不変（`trg_automation_published_version_immutable`）なので、
 * 直すには **公開版を写した下書き**を作ってから `publishAutomationDraft` で
 * 差し替える。一覧の「編集」はここへ来る。
 *
 * **何度呼んでも1件。** すでに下書きがぶら下がっていれば新しく作らず
 * それを返す（2つのタブで同時に押しても下書きは1つ）。
 */
export async function createAutomationDraftFromDefinition(
  db: D1Database,
  input: { id: string; lineAccountId: string; createdBy?: string | null },
): Promise<{ id: string; draftVersionId: string }> {
  const definition = await db.prepare(
    `SELECT id, status, current_draft_version_id, current_published_version_id
       FROM automation_definitions
      WHERE id = ? AND line_account_id = ? AND status IN ('draft', 'active', 'stopped')`,
  ).bind(input.id, input.lineAccountId).first<{
    id: string;
    status: 'draft' | 'active' | 'stopped';
    current_draft_version_id: string | null;
    current_published_version_id: string | null;
  }>();
  if (!definition) throw new AutomationDraftError('not_found', '編集するオートメーションが見つかりません');

  if (definition.current_draft_version_id) {
    try {
      // 既にある下書きをそのまま返す（冪等）。
      const existing = await readAutomationDraftRow(db, input);
      return {
        id: existing.id,
        draftVersionId: await automationRevisionToken(existing.current_draft_version_id, existing),
      };
    } catch (error) {
      /*
       * 指し先が「下書きではない版」や、もう無い版を指している。
       * 古い保存口が残した指し先や、途中で切れた指し替えの名残で、
       * 開ける下書きは実際には無い。ここで not_found のまま返すと一覧の
       * 「編集」が永久に失敗するので、公開版から作り直して指し直す。
       * 生きた下書きがあるときだけは上書きしない（下の UPDATE の WHERE が守る）。
       */
      if (!(error instanceof AutomationDraftError && error.code === 'not_found')) throw error;
    }
  }
  if (!definition.current_published_version_id) {
    throw new AutomationDraftError('not_found', '編集できる公開済みの版がありません');
  }
  const source = await db.prepare(
    `SELECT trigger_type, trigger_config, condition_config, action_config
       FROM automation_versions
      WHERE id = ? AND automation_id = ? AND status = 'published'`,
  ).bind(definition.current_published_version_id, definition.id)
    .first<AutomationVersionContent>();
  if (!source) throw new AutomationDraftError('not_found', '公開済みの版を読み込めませんでした');

  const nextVersionId = crypto.randomUUID();
  const now = new Date().toISOString();
  /*
   * 「下書きが無い」と判定できるのは、指し先が空か、指す版がこの定義の
   * 下書きでなくなっているときだけ。書き込み側でも同じ条件を確認するので、
   * 読み取りから書き込みまでの間に別の下書きがぶら下がっても潰さない
   * （その場合は読み直しでそちらの下書きを返す）。
   */
  const noLiveDraft = `(
    d.current_draft_version_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM automation_versions dv
       WHERE dv.id = d.current_draft_version_id
         AND dv.automation_id = d.id AND dv.status = 'draft'
    )
  )`;
  await db.batch([
    db.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, trigger_config,
          condition_config, action_config, created_by, created_at)
       SELECT ?, ?,
              COALESCE((SELECT MAX(version_number) FROM automation_versions WHERE automation_id = ?), 0) + 1,
              'draft', ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM automation_definitions d
           WHERE d.id = ? AND d.line_account_id = ? AND d.status IN ('draft', 'active', 'stopped')
             AND ${noLiveDraft}
        )`,
    ).bind(
      nextVersionId, definition.id, definition.id,
      source.trigger_type, source.trigger_config, source.condition_config, source.action_config,
      input.createdBy ?? null, now,
      definition.id, input.lineAccountId,
    ),
    db.prepare(
      // 先に下書きがぶら下がった側を守る。指し替えは1回だけ。
      `UPDATE automation_definitions AS d SET confirmation_revision = confirmation_revision + 1, current_draft_version_id = ?, updated_at = ?
        WHERE d.id = ? AND d.line_account_id = ? AND d.status IN ('draft', 'active', 'stopped')
          AND ${noLiveDraft}
          AND EXISTS (SELECT 1 FROM automation_versions WHERE id = ? AND automation_id = ?)`,
    ).bind(nextVersionId, now, definition.id, input.lineAccountId, nextVersionId, definition.id),
  ]);
  const row = await readAutomationDraftRow(db, input);
  return {
    id: row.id,
    draftVersionId: await automationRevisionToken(row.current_draft_version_id, row),
  };
}

/**
 * 一覧の「複製」。いま見えている版を写した **新しい下書き** を作る。
 *
 * 同名のままだと一覧で見分けられないので「のコピー」を付ける。
 * 共通アクションの束は利用先（consumer_id）ごとに張られているため、
 * 新しい定義へ写さないと呼び出し版を固定できずに失敗する。
 */
export async function duplicateAutomationDefinition(
  db: D1Database,
  input: { id: string; lineAccountId: string; createdBy?: string | null },
): Promise<{ id: string; draftVersionId: string }> {
  const definition = await db.prepare(
    `SELECT id, current_draft_version_id, current_published_version_id, name, description, priority
       FROM automation_definitions
      WHERE id = ? AND line_account_id = ? AND status IN ('draft', 'active', 'stopped')`,
  ).bind(input.id, input.lineAccountId).first<{
    id: string;
    current_draft_version_id: string | null;
    current_published_version_id: string | null;
    name: string;
    description: string | null;
    priority: number;
  }>();
  if (!definition) throw new AutomationDraftError('not_found', '複製するオートメーションが見つかりません');
  const versionId = definition.current_draft_version_id ?? definition.current_published_version_id;
  if (!versionId) {
    throw new AutomationDraftError('not_found', '写せる版がありません');
  }
  const source = await db.prepare(
    `SELECT trigger_type, trigger_config, condition_config, action_config
       FROM automation_versions
      WHERE id = ? AND automation_id = ?`,
  ).bind(versionId, definition.id).first<AutomationVersionContent>();
  if (!source) throw new AutomationDraftError('not_found', '写す版を読み込めませんでした');

  // 共通アクションの束も写す。consumer_id を新しい定義へ付け替えるだけで、
  // 版の固定は元の束と同じものを引き継ぐ。
  // **1件ずつ新しいidを振る。** INSERT...SELECT で1つのUUIDを束ねると、
  // 元の定義に束が2件以上あるとき全行同じidでPRIMARY KEY衝突になる。
  const sourceBindings = await db.prepare(
    `SELECT line_account_id, common_action_id, common_action_version_id, consumer_path
       FROM common_action_bindings
      WHERE line_account_id = ? AND consumer_type = 'automation' AND consumer_id = ?`,
  ).bind(input.lineAccountId, definition.id).all<{
    line_account_id: string;
    common_action_id: string;
    common_action_version_id: string;
    consumer_path: string;
  }>();

  const newId = crypto.randomUUID();
  const nextVersionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = `${definition.name} のコピー`;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO automation_definitions
         (id, line_account_id, name, description, status, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    ).bind(newId, input.lineAccountId, name, definition.description, definition.priority,
      input.createdBy ?? null, now, now),
    db.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, trigger_config,
          condition_config, action_config, created_by, created_at)
       VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?)`,
    ).bind(nextVersionId, newId, source.trigger_type, source.trigger_config,
      source.condition_config, source.action_config, input.createdBy ?? null, now),
    db.prepare(
      `UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, current_draft_version_id = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'
          AND EXISTS (SELECT 1 FROM automation_versions WHERE id = ? AND automation_id = ?)`,
    ).bind(nextVersionId, now, newId, nextVersionId, newId),
    ...(sourceBindings.results ?? []).map((binding) =>
      db.prepare(
        `INSERT INTO common_action_bindings
           (id, line_account_id, common_action_id, common_action_version_id,
            consumer_type, consumer_id, consumer_path, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'automation', ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), binding.line_account_id, binding.common_action_id,
        binding.common_action_version_id, newId, binding.consumer_path,
        input.createdBy ?? null, now, now),
    ),
  ]);
  if ((results[0].meta?.changes ?? 0) !== 1 || (results[2].meta?.changes ?? 0) !== 1) {
    throw new AutomationDraftError('duplicate_failed', '複製できませんでした。もう一度お試しください');
  }
  return {
    id: newId,
    draftVersionId: await automationRevisionToken(nextVersionId, source),
  };
}

async function automationFolder(db: D1Database, accountId: string, value: unknown) {
  try { return await readFolderAssignment(db, 'automation', accountId, value); }
  catch (error) {
    if (error instanceof FolderAssignmentError) throw new AutomationDraftError(error.code, error.message, 'folderId');
    throw error;
  }
}
