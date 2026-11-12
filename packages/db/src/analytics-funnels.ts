import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from './analytics-event-types.js';
import {
  getFunnelById,
  getFunnelSteps,
  type Funnel,
  type FunnelStatus,
  type FunnelStepKind,
} from './funnels.js';

const DAY_MS = 86_400_000;

export const V6_FUNNEL_STEP_KINDS = [
  'friend_add',
  'tag',
  'field',
  'form',
  'site_event',
  'purchase',
  'link_click',
  'conversion',
  'message',
  'booking',
  'automation',
] as const;

export type V6FunnelStepKind = (typeof V6_FUNNEL_STEP_KINDS)[number];

export interface V6FunnelStep {
  stepOrder: number;
  label: string;
  kind: V6FunnelStepKind;
  match: Record<string, string>;
}

export type FunnelAudienceFilter =
  | { kind: 'all' }
  | { kind: 'tag'; tagId: string }
  | { kind: 'field'; fieldId: string; choiceKey?: string };

export interface FunnelComparisonGroup {
  key: string;
  label: string;
  filter: FunnelAudienceFilter;
}

export interface FunnelTimelineEvent {
  id: string;
  friendId: string;
  eventType: AnalyticsEventType;
  occurredAt: string;
  dimensions: Record<string, string | number | boolean>;
}

export interface FunnelMemberEvaluation {
  friendId: string;
  groupKey: string;
  highestStepOrder: number;
  state: 'completed' | 'in_progress' | 'dropped';
  startedAt: string;
  lastReachedAt: string;
  deadlineAt: string;
  reachedAt: string[];
}

export interface FunnelStepEvaluation {
  stepOrder: number;
  label: string;
  reached: number;
  conversionFromPrevious: number | null;
  droppedAfter: number;
  inProgressAfter: number;
  averageSecondsFromPrevious: number | null;
  medianSecondsFromPrevious: number | null;
}

export interface FunnelGroupEvaluation {
  key: string;
  label: string;
  entrants: number;
  completed: number;
  steps: FunnelStepEvaluation[];
}

export interface ChronologicalFunnelEvaluation {
  groups: FunnelGroupEvaluation[];
  members: FunnelMemberEvaluation[];
}

export interface FunnelVersion {
  id: string;
  funnelId: string;
  lineAccountId: string;
  versionNumber: number;
  windowDays: number;
  steps: V6FunnelStep[];
  segment: FunnelAudienceFilter;
  comparisonGroups: FunnelComparisonGroup[];
  createdBy: string | null;
  createdAt: string;
}

export interface FunnelWithCurrentVersion extends Funnel {
  currentVersion: {
    id: string;
    versionNumber: number;
    createdAt: string;
  } | null;
}

export interface FunnelWithCurrentVersionPage {
  items: FunnelWithCurrentVersion[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FunnelRunResult {
  runId: string | null;
  funnelId: string;
  versionId: string | null;
  versionNumber: number | null;
  lineAccountId: string;
  cohortFrom: string;
  cohortTo: string;
  timeZone: string;
  dataCutoffAt: string;
  state: 'available' | 'unavailable' | 'partial' | 'failed';
  stateReason: string | null;
  groups: FunnelGroupEvaluation[];
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

export function validateFunnelAudienceFilter(raw: unknown): FunnelAudienceFilter {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('analytics_funnel_filter_invalid');
  }
  const value = raw as Record<string, unknown>;
  if (value.kind === 'all') return { kind: 'all' };
  if (value.kind === 'tag') {
    return { kind: 'tag', tagId: requiredString(value.tagId, 'analytics_funnel_tag_required') };
  }
  if (value.kind === 'field') {
    return {
      kind: 'field',
      fieldId: requiredString(value.fieldId, 'analytics_funnel_field_required'),
      choiceKey: optionalString(value.choiceKey),
    };
  }
  throw new Error(`analytics_funnel_filter_kind_unknown:${String(value.kind)}`);
}

function validateMatch(kind: V6FunnelStepKind, raw: unknown): Record<string, string> {
  const match = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  switch (kind) {
    case 'friend_add':
      return {};
    case 'tag':
      return {
        tagId: requiredString(match.tagId, 'analytics_funnel_tag_required'),
        action: optionalString(match.action) ?? 'add',
      };
    case 'field':
      return {
        fieldId: requiredString(match.fieldId, 'analytics_funnel_field_required'),
        ...(optionalString(match.choiceKey) ? { choiceKey: optionalString(match.choiceKey)! } : {}),
      };
    case 'form':
      return { formId: requiredString(match.formId, 'analytics_funnel_form_required') };
    case 'site_event':
      return {
        eventType: optionalString(match.eventType) ?? 'page_view',
        ...(optionalString(match.pathGroup) ? { pathGroup: optionalString(match.pathGroup)! } : {}),
      };
    case 'purchase': {
      const status = optionalString(match.status) ?? 'confirmed';
      if (!['confirmed', 'shipped'].includes(status)) {
        throw new Error(`analytics_funnel_purchase_status_unknown:${status}`);
      }
      return { status };
    }
    case 'link_click':
      return { trackedLinkId: requiredString(match.trackedLinkId, 'analytics_funnel_link_required') };
    case 'conversion':
      return {
        conversionPointId: requiredString(
          match.conversionPointId,
          'analytics_funnel_conversion_point_required',
        ),
        ...(optionalString(match.approvalStatus)
          ? { approvalStatus: optionalString(match.approvalStatus)! }
          : {}),
      };
    case 'message': {
      const direction = optionalString(match.direction) ?? 'received';
      if (!['received', 'sent'].includes(direction)) {
        throw new Error(`analytics_funnel_message_direction_unknown:${direction}`);
      }
      return {
        direction,
        ...(optionalString(match.messageType) ? { messageType: optionalString(match.messageType)! } : {}),
      };
    }
    case 'booking': {
      const status = optionalString(match.status) ?? 'confirmed';
      if (!['confirmed', 'cancelled'].includes(status)) {
        throw new Error(`analytics_funnel_booking_status_unknown:${status}`);
      }
      return {
        status,
        ...(optionalString(match.menuId) ? { menuId: optionalString(match.menuId)! } : {}),
      };
    }
    case 'automation':
      return {
        automationId: requiredString(match.automationId, 'analytics_funnel_automation_required'),
        ...(optionalString(match.status) ? { status: optionalString(match.status)! } : {}),
      };
  }
}

export function validateV6FunnelSteps(raw: unknown): V6FunnelStep[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 10) {
    throw new Error('analytics_funnel_steps_must_be_2_to_10');
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('analytics_funnel_step_invalid');
    }
    const value = item as Record<string, unknown>;
    const kind = String(value.kind) as V6FunnelStepKind;
    if (!(V6_FUNNEL_STEP_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`analytics_funnel_step_kind_unknown:${String(value.kind)}`);
    }
    return {
      stepOrder: index + 1,
      label: requiredString(value.label, 'analytics_funnel_step_label_required'),
      kind,
      match: validateMatch(kind, value.match),
    };
  });
}

export function validateFunnelComparisonGroups(raw: unknown): FunnelComparisonGroup[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 3) {
    throw new Error('analytics_funnel_comparison_groups_max_3');
  }
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('analytics_funnel_comparison_group_invalid');
    }
    const value = item as Record<string, unknown>;
    const key = requiredString(value.key, 'analytics_funnel_comparison_key_required');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key) || key === 'all' || seen.has(key)) {
      throw new Error(`analytics_funnel_comparison_key_invalid:${key}`);
    }
    seen.add(key);
    return {
      key,
      label: requiredString(value.label, 'analytics_funnel_comparison_label_required'),
      filter: validateFunnelAudienceFilter(value.filter),
    };
  });
}

function dimensionMatches(
  dimensions: Record<string, string | number | boolean>,
  key: string,
  expected: string | undefined,
): boolean {
  return expected === undefined || String(dimensions[key] ?? '') === expected;
}

export function eventMatchesFunnelStep(event: FunnelTimelineEvent, step: V6FunnelStep): boolean {
  const match = step.match;
  switch (step.kind) {
    case 'friend_add':
      return event.eventType === 'friend_add';
    case 'tag':
      return event.eventType === 'tag_change'
        && dimensionMatches(event.dimensions, 'tagId', match.tagId)
        && dimensionMatches(event.dimensions, 'action', match.action);
    case 'field':
      return event.eventType === 'field_change'
        && dimensionMatches(event.dimensions, 'fieldId', match.fieldId)
        && dimensionMatches(event.dimensions, 'choiceKey', match.choiceKey);
    case 'form':
      return event.eventType === 'form_submitted'
        && dimensionMatches(event.dimensions, 'formId', match.formId);
    case 'site_event':
      return event.eventType === 'site_event'
        && dimensionMatches(event.dimensions, 'eventType', match.eventType)
        && dimensionMatches(event.dimensions, 'pathGroup', match.pathGroup);
    case 'purchase':
      return event.eventType === `ec.order.${match.status}`;
    case 'link_click':
      return event.eventType === 'url_clicked'
        && dimensionMatches(event.dimensions, 'trackedLinkId', match.trackedLinkId);
    case 'conversion':
      return (match.approvalStatus === undefined
        ? ['conversion_created', 'conversion_approved', 'conversion_rejected'].includes(event.eventType)
        : event.eventType === (match.approvalStatus === 'approved'
          ? 'conversion_approved'
          : match.approvalStatus === 'rejected'
            ? 'conversion_rejected'
            : 'conversion_created'))
        && dimensionMatches(event.dimensions, 'conversionPointId', match.conversionPointId)
        && (event.eventType !== 'conversion_created'
          || dimensionMatches(event.dimensions, 'approvalStatus', match.approvalStatus));
    case 'message':
      return event.eventType === `message_${match.direction}`
        && dimensionMatches(event.dimensions, 'messageType', match.messageType);
    case 'booking':
      return event.eventType === `booking_${match.status}`
        && dimensionMatches(event.dimensions, 'menuId', match.menuId);
    case 'automation':
      return event.eventType === 'automation_completed'
        && dimensionMatches(event.dimensions, 'automationId', match.automationId)
        && dimensionMatches(event.dimensions, 'status', match.status);
  }
}

export function funnelStepEventTypes(step: V6FunnelStep): AnalyticsEventType[] {
  switch (step.kind) {
    case 'friend_add': return ['friend_add'];
    case 'tag': return ['tag_change'];
    case 'field': return ['field_change'];
    case 'form': return ['form_submitted'];
    case 'site_event': return ['site_event'];
    case 'purchase': return [`ec.order.${step.match.status}` as AnalyticsEventType];
    case 'link_click': return ['url_clicked'];
    case 'conversion':
      return step.match.approvalStatus === 'approved'
        ? ['conversion_approved']
        : step.match.approvalStatus === 'rejected'
          ? ['conversion_rejected']
          : step.match.approvalStatus
            ? ['conversion_created']
            : ['conversion_created', 'conversion_approved', 'conversion_rejected'];
    case 'message': return [`message_${step.match.direction}` as AnalyticsEventType];
    case 'booking': return [`booking_${step.match.status}` as AnalyticsEventType];
    case 'automation': return ['automation_completed'];
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function evaluateChronologicalFunnel(input: {
  events: FunnelTimelineEvent[];
  steps: V6FunnelStep[];
  windowDays: number;
  cohortFrom: string;
  cohortTo: string;
  dataCutoffAt: string;
  groupLabels?: Record<string, string>;
  friendGroups?: Map<string, string[]>;
}): ChronologicalFunnelEvaluation {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 365) {
    throw new Error('analytics_funnel_window_days_invalid');
  }
  const steps = validateV6FunnelSteps(input.steps);
  const cohortFromMs = Date.parse(input.cohortFrom);
  const cohortToMs = Date.parse(input.cohortTo);
  const cutoffMs = Date.parse(input.dataCutoffAt);
  if (![cohortFromMs, cohortToMs, cutoffMs].every(Number.isFinite) || cohortFromMs > cohortToMs) {
    throw new Error('analytics_funnel_range_invalid');
  }

  const seenEventIds = new Set<string>();
  const byFriend = new Map<string, FunnelTimelineEvent[]>();
  for (const event of input.events) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    const occurred = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurred) || occurred > cutoffMs) continue;
    const list = byFriend.get(event.friendId) ?? [];
    list.push(event);
    byFriend.set(event.friendId, list);
  }
  for (const events of byFriend.values()) {
    events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
  }

  const members: FunnelMemberEvaluation[] = [];
  for (const [friendId, events] of byFriend) {
    const first = events.find((event) => {
      const at = Date.parse(event.occurredAt);
      return at >= cohortFromMs && at <= cohortToMs && eventMatchesFunnelStep(event, steps[0]);
    });
    if (!first) continue;
    const startedAtMs = Date.parse(first.occurredAt);
    const deadlineMs = startedAtMs + input.windowDays * DAY_MS;
    const reachedAt = [first.occurredAt];
    let previousMs = startedAtMs;
    for (let index = 1; index < steps.length; index++) {
      const next = events.find((event) => {
        const at = Date.parse(event.occurredAt);
        return at > previousMs && at <= deadlineMs && at <= cutoffMs
          && eventMatchesFunnelStep(event, steps[index]);
      });
      if (!next) break;
      reachedAt.push(next.occurredAt);
      previousMs = Date.parse(next.occurredAt);
    }
    const state: FunnelMemberEvaluation['state'] = reachedAt.length === steps.length
      ? 'completed'
      : cutoffMs < deadlineMs
        ? 'in_progress'
        : 'dropped';
    const groups = ['all', ...(input.friendGroups?.get(friendId) ?? [])];
    for (const groupKey of new Set(groups)) {
      members.push({
        friendId,
        groupKey,
        highestStepOrder: reachedAt.length,
        state,
        startedAt: first.occurredAt,
        lastReachedAt: reachedAt[reachedAt.length - 1],
        deadlineAt: new Date(deadlineMs).toISOString(),
        reachedAt,
      });
    }
  }

  const groupKeys = ['all', ...Object.keys(input.groupLabels ?? {})];
  const groups = groupKeys.map((key): FunnelGroupEvaluation => {
    const groupMembers = members.filter((member) => member.groupKey === key);
    return {
      key,
      label: key === 'all' ? '全体' : input.groupLabels?.[key] ?? key,
      entrants: groupMembers.length,
      completed: groupMembers.filter((member) => member.state === 'completed').length,
      steps: steps.map((step, index) => {
        const reached = groupMembers.filter((member) => member.highestStepOrder >= step.stepOrder);
        const previousReached = index === 0
          ? reached.length
          : groupMembers.filter((member) => member.highestStepOrder >= step.stepOrder - 1).length;
        const durations = index === 0
          ? []
          : reached.map((member) => (
            Date.parse(member.reachedAt[index]) - Date.parse(member.reachedAt[index - 1])
          ) / 1000);
        return {
          stepOrder: step.stepOrder,
          label: step.label,
          reached: reached.length,
          conversionFromPrevious: index === 0
            ? 1
            : previousReached === 0
              ? null
              : reached.length / previousReached,
          droppedAfter: groupMembers.filter((member) =>
            member.highestStepOrder === step.stepOrder && member.state === 'dropped').length,
          inProgressAfter: groupMembers.filter((member) =>
            member.highestStepOrder === step.stepOrder && member.state === 'in_progress').length,
          averageSecondsFromPrevious: durations.length === 0
            ? null
            : durations.reduce((sum, value) => sum + value, 0) / durations.length,
          medianSecondsFromPrevious: median(durations),
        };
      }),
    };
  });
  return { groups, members };
}

function parseStoredVersion(row: {
  id: string;
  funnel_id: string;
  line_account_id: string;
  version_number: number;
  window_days: number;
  steps_json: string;
  segment_json: string | null;
  comparison_groups_json: string;
  created_by: string | null;
  created_at: string;
}): FunnelVersion {
  return {
    id: row.id,
    funnelId: row.funnel_id,
    lineAccountId: row.line_account_id,
    versionNumber: row.version_number,
    windowDays: row.window_days,
    steps: validateV6FunnelSteps(JSON.parse(row.steps_json)),
    segment: row.segment_json ? validateFunnelAudienceFilter(JSON.parse(row.segment_json)) : { kind: 'all' },
    comparisonGroups: validateFunnelComparisonGroups(JSON.parse(row.comparison_groups_json)),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function getCurrentFunnelVersion(
  db: D1Database,
  lineAccountId: string,
  funnelId: string,
): Promise<FunnelVersion | null> {
  const row = await db.prepare(
    `SELECT * FROM analytics_funnel_versions
      WHERE line_account_id = ? AND funnel_id = ?
      ORDER BY version_number DESC LIMIT 1`,
  ).bind(lineAccountId, funnelId).first<{
    id: string; funnel_id: string; line_account_id: string; version_number: number;
    window_days: number; steps_json: string; segment_json: string | null;
    comparison_groups_json: string; created_by: string | null; created_at: string;
  }>();
  return row ? parseStoredVersion(row) : null;
}

/**
 * ファネル一覧と各ファネルの現在版を、件数に関係なく2問い合わせで返す。
 *
 * 一覧取得後に getCurrentFunnelVersion を1件ずつ呼ぶと、
 * ファネル数に比例してD1への往復が増える。現在版の決定はDB内のJOINで行う。
 */
export async function getFunnelsWithCurrentVersions(
  db: D1Database,
  lineAccountId: string,
  options: { page?: number; pageSize?: number; includeInactive?: boolean } = {},
): Promise<FunnelWithCurrentVersionPage> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(options.pageSize ?? 200)));
  const offset = (page - 1) * pageSize;
  const activeClause = options.includeInactive ? '' : ` AND f.status = 'active'`;

  const countPromise = db.prepare(
    `SELECT COUNT(*) AS total FROM funnels f
      WHERE f.line_account_id = ?${activeClause}`,
  ).bind(lineAccountId).first<{ total: number }>();
  const rowsPromise = db.prepare(
    `WITH latest_versions AS (
       SELECT funnel_id, MAX(version_number) AS version_number
         FROM analytics_funnel_versions
        WHERE line_account_id = ?
        GROUP BY funnel_id
     )
     SELECT f.*,
            v.id AS current_version_id,
            v.version_number AS current_version_number,
            v.created_at AS current_version_created_at
       FROM funnels f
       LEFT JOIN latest_versions latest ON latest.funnel_id = f.id
       LEFT JOIN analytics_funnel_versions v
         ON v.line_account_id = f.line_account_id
        AND v.funnel_id = f.id
        AND v.version_number = latest.version_number
      WHERE f.line_account_id = ?${activeClause}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ? OFFSET ?`,
  ).bind(lineAccountId, lineAccountId, pageSize, offset).all<Funnel & {
    current_version_id: string | null;
    current_version_number: number | null;
    current_version_created_at: string | null;
  }>();

  const [count, rows] = await Promise.all([countPromise, rowsPromise]);
  return {
    items: rows.results.map((row) => ({
      id: row.id,
      line_account_id: row.line_account_id,
      name: row.name,
      segment_json: row.segment_json,
      window_days: row.window_days,
      created_at: row.created_at,
      status: row.status,
      confirmation_revision: row.confirmation_revision,
      currentVersion: row.current_version_id === null
        ? null
        : {
            id: row.current_version_id,
            versionNumber: row.current_version_number!,
            createdAt: row.current_version_created_at!,
          },
    })),
    total: Number(count?.total ?? 0),
    page,
    pageSize,
  };
}

/** 編集画面が読む1件。現在版の全内容（段・絞り込み・比較条件）を返す。 */
export async function getFunnelWithCurrentVersion(
  db: D1Database,
  lineAccountId: string,
  funnelId: string,
): Promise<{ funnel: Funnel; currentVersion: FunnelVersion | null } | null> {
  const funnel = await getFunnelById(db, lineAccountId, funnelId);
  if (!funnel) return null;
  const currentVersion = await getCurrentFunnelVersion(db, lineAccountId, funnelId);
  return { funnel, currentVersion };
}

// 運用状態の遷移表。archived は終端で復帰しない。
const FUNNEL_STATUS_TRANSITIONS: Record<FunnelStatus, readonly FunnelStatus[]> = {
  active: ['stopped', 'archived'],
  stopped: ['active', 'archived'],
  archived: [],
};

/**
 * ファネルの運用状態を変える。expectedStatus に今の状態を書かせ、
 * 読み違えや二重操作を 409 として弾く。
 */
export async function setFunnelStatus(
  db: D1Database,
  input: {
    lineAccountId: string;
    funnelId: string;
    status: FunnelStatus;
    expectedStatus: FunnelStatus;
    expectedRevision?: number;
  },
): Promise<Funnel> {
  const funnel = await getFunnelById(db, input.lineAccountId, input.funnelId);
  if (!funnel) throw new Error('analytics_funnel_not_found');
  // 先に楽観ロック: 呼び出し側が見ていた状態と違えば競合。
  if (funnel.status !== input.expectedStatus) {
    throw new Error('analytics_funnel_status_conflict');
  }
  if (!FUNNEL_STATUS_TRANSITIONS[funnel.status].includes(input.status)) {
    throw new Error('analytics_funnel_invalid_transition');
  }
  const result = await db.prepare(
    `UPDATE funnels SET status = ?, confirmation_revision = confirmation_revision + 1
      WHERE id = ? AND line_account_id = ? AND status = ?
        AND (? IS NULL OR confirmation_revision = ?)`,
  ).bind(input.status, input.funnelId, input.lineAccountId, input.expectedStatus, input.expectedRevision ?? null, input.expectedRevision ?? null).run();
  if (!result.meta?.changes) throw new Error('analytics_funnel_status_conflict');
  return (await getFunnelById(db, input.lineAccountId, input.funnelId))!;
}

export async function createFunnelVersion(
  db: D1Database,
  input: {
    lineAccountId: string;
    funnelId: string;
    windowDays: number;
    steps: unknown;
    segment?: unknown;
    comparisonGroups?: unknown;
    // 編集者が見ていた現在版。ずれていたら新しい版を置かず競合として弾く。
    expectedVersionNumber?: number;
    // 名前は版ではなくファネル本体の属性なので、新版保存と同じ操作で更新する。
    name?: string;
    createdBy?: string | null;
    createdAt: string;
  },
): Promise<FunnelVersion> {
  const funnel = await getFunnelById(db, input.lineAccountId, input.funnelId);
  if (!funnel) throw new Error('analytics_funnel_not_found');
  if (funnel.status !== 'active') throw new Error('analytics_funnel_not_active');
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 365) {
    throw new Error('analytics_funnel_window_days_invalid');
  }
  const steps = validateV6FunnelSteps(input.steps);
  const segment = input.segment === undefined
    ? { kind: 'all' } as const
    : validateFunnelAudienceFilter(input.segment);
  const groups = validateFunnelComparisonGroups(input.comparisonGroups);
  const name = input.name === undefined
    ? null
    : requiredString(input.name, 'analytics_funnel_name_required');
  await assertFunnelReferences(db, input.lineAccountId, steps);
  await assertFunnelFilterReference(db, input.lineAccountId, segment);
  for (const group of groups) {
    await assertFunnelFilterReference(db, input.lineAccountId, group.filter);
  }
  const current = await db.prepare(
    `SELECT MAX(version_number) AS version_number
       FROM analytics_funnel_versions
      WHERE funnel_id = ? AND line_account_id = ?`,
  ).bind(input.funnelId, input.lineAccountId)
    .first<{ version_number: number | null }>();
  const currentVersionNumber = current?.version_number ?? 0;
  if (input.expectedVersionNumber !== undefined
      && input.expectedVersionNumber !== currentVersionNumber) {
    throw new Error('analytics_funnel_version_conflict');
  }
  const id = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    // 運用状態と読み取った現在版を、実際のINSERTと同時に照合する。
    // 停止・保管や別保存が先に確定した場合は新版を置かない。
    db.prepare(
      `INSERT INTO analytics_funnel_versions (
         id, funnel_id, line_account_id, version_number, window_days,
         steps_json, segment_json, comparison_groups_json, created_by, created_at
       ) SELECT ?, f.id, f.line_account_id, ?, ?, ?, ?, ?, ?, ?
           FROM funnels f
          WHERE f.id = ? AND f.line_account_id = ? AND f.status = 'active'
            AND COALESCE((SELECT MAX(version_number) FROM analytics_funnel_versions
                           WHERE funnel_id = f.id AND line_account_id = f.line_account_id), 0) = ?`,
    ).bind(
      id, currentVersionNumber + 1, input.windowDays,
      JSON.stringify(steps), JSON.stringify(segment), JSON.stringify(groups),
      input.createdBy ?? null, input.createdAt,
      input.funnelId, input.lineAccountId, currentVersionNumber,
    ),
    ...(name === null
      ? []
      : [db.prepare(
        `UPDATE funnels SET name = ?, confirmation_revision = confirmation_revision + 1 WHERE id = ? AND line_account_id = ? AND status = 'active'
           AND EXISTS (SELECT 1 FROM analytics_funnel_versions WHERE id = ? AND funnel_id = funnels.id)`,
      ).bind(name, input.funnelId, input.lineAccountId, id)]),
  ];
  try {
    const results = await db.batch(statements);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      const latest = await getFunnelById(db, input.lineAccountId, input.funnelId);
      if (!latest) throw new Error('analytics_funnel_not_found');
      if (latest.status !== 'active') throw new Error('analytics_funnel_not_active');
      throw new Error('analytics_funnel_version_conflict');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      throw new Error('analytics_funnel_version_conflict');
    }
    throw error;
  }
  const inserted = await db.prepare(
    `SELECT * FROM analytics_funnel_versions WHERE id = ? AND line_account_id = ?`,
  ).bind(id, input.lineAccountId).first<{
    id: string; funnel_id: string; line_account_id: string; version_number: number;
    window_days: number; steps_json: string; segment_json: string | null;
    comparison_groups_json: string; created_by: string | null; created_at: string;
  }>();
  if (!inserted) throw new Error('analytics_funnel_version_insert_failed');
  return parseStoredVersion(inserted);
}

export async function createVersionedFunnel(
  db: D1Database,
  input: {
    lineAccountId: string;
    name: string;
    windowDays: number;
    steps: unknown;
    segment?: unknown;
    comparisonGroups?: unknown;
    createdBy?: string | null;
    createdAt: string;
  },
): Promise<{ funnelId: string; version: FunnelVersion }> {
  const name = requiredString(input.name, 'analytics_funnel_name_required');
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 365) {
    throw new Error('analytics_funnel_window_days_invalid');
  }
  const steps = validateV6FunnelSteps(input.steps);
  const segment = input.segment === undefined
    ? { kind: 'all' } as const
    : validateFunnelAudienceFilter(input.segment);
  const groups = validateFunnelComparisonGroups(input.comparisonGroups);
  await assertFunnelReferences(db, input.lineAccountId, steps);
  await assertFunnelFilterReference(db, input.lineAccountId, segment);
  for (const group of groups) {
    await assertFunnelFilterReference(db, input.lineAccountId, group.filter);
  }
  const funnelId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO funnels (id, line_account_id, name, segment_json, window_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      funnelId, input.lineAccountId, name, JSON.stringify(segment),
      input.windowDays, input.createdAt,
    ),
    db.prepare(
      `INSERT INTO analytics_funnel_versions (
         id, funnel_id, line_account_id, version_number, window_days,
         steps_json, segment_json, comparison_groups_json, created_by, created_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId, funnelId, input.lineAccountId, input.windowDays,
      JSON.stringify(steps), JSON.stringify(segment), JSON.stringify(groups),
      input.createdBy ?? null, input.createdAt,
    ),
  ];
  await db.batch(statements);
  return {
    funnelId,
    version: {
      id: versionId,
      funnelId,
      lineAccountId: input.lineAccountId,
      versionNumber: 1,
      windowDays: input.windowDays,
      steps,
      segment,
      comparisonGroups: groups,
      createdBy: input.createdBy ?? null,
      createdAt: input.createdAt,
    },
  };
}

async function loadFilterFriendIds(
  db: D1Database,
  lineAccountId: string,
  filter: FunnelAudienceFilter,
): Promise<Set<string> | null> {
  if (filter.kind === 'all') return null;
  const result = filter.kind === 'tag'
    ? await db.prepare(
      `SELECT f.id FROM friends f JOIN friend_tags ft ON ft.friend_id = f.id
        WHERE f.line_account_id = ? AND ft.tag_id = ?`,
    ).bind(lineAccountId, filter.tagId).all<{ id: string }>()
    : await db.prepare(
      `SELECT f.id FROM friends f JOIN friend_field_values fv ON fv.friend_id = f.id
        WHERE f.line_account_id = ? AND fv.field_id = ?
          AND (? IS NULL OR fv.value = ?)`,
    ).bind(
      lineAccountId, filter.fieldId, filter.choiceKey ?? null, filter.choiceKey ?? null,
    ).all<{ id: string }>();
  return new Set(result.results.map((row) => row.id));
}

async function referenceExists(
  db: D1Database,
  query: string,
  values: unknown[],
): Promise<boolean> {
  const row = await db.prepare(query).bind(...values).first<{ id: string }>();
  return Boolean(row);
}

export async function assertFunnelReferences(
  db: D1Database,
  lineAccountId: string,
  steps: V6FunnelStep[],
): Promise<void> {
  for (const step of steps) {
    let valid = true;
    switch (step.kind) {
      case 'tag':
        valid = await referenceExists(
          db,
          `SELECT id FROM tags WHERE id = ? AND line_account_id = ?`,
          [step.match.tagId, lineAccountId],
        );
        break;
      case 'field':
        valid = await referenceExists(db, `SELECT id FROM friend_fields WHERE id = ?`, [step.match.fieldId]);
        break;
      case 'form':
        // 参照フォームのaccount所属をDBで確かめる。別account・
        // 存在なし・未割当legacy行はfail-closedにする(存在扱いにしない)。
        valid = await referenceExists(
          db,
          `SELECT f.id FROM forms f WHERE f.id = ?
             AND EXISTS (SELECT 1 FROM form_accounts fa
                         WHERE fa.form_id = f.id AND fa.line_account_id = ?)`,
          [step.match.formId, lineAccountId],
        );
        break;
      case 'link_click':
        valid = await referenceExists(
          db,
          `SELECT id FROM tracked_links WHERE id = ? AND line_account_id = ?`,
          [step.match.trackedLinkId, lineAccountId],
        );
        break;
      case 'conversion':
        valid = await referenceExists(
          db,
          `SELECT id FROM conversion_points WHERE id = ? AND line_account_id = ?`,
          [step.match.conversionPointId, lineAccountId],
        );
        break;
      case 'booking':
        valid = !step.match.menuId || await referenceExists(
          db,
          `SELECT id FROM menus WHERE id = ? AND line_account_id = ?`,
          [step.match.menuId, lineAccountId],
        );
        break;
      case 'automation':
        valid = await referenceExists(
          db,
          `SELECT id FROM automations WHERE id = ? AND line_account_id = ?`,
          [step.match.automationId, lineAccountId],
        );
        break;
      case 'site_event':
        valid = ['page_view', 'click', 'scroll_depth', 'custom', 'purchase']
          .includes(step.match.eventType);
        break;
      case 'message':
        valid = !step.match.messageType || [
          'text', 'image', 'video', 'audio', 'sticker', 'file', 'location',
        ].includes(step.match.messageType);
        break;
      case 'friend_add':
      case 'purchase':
        break;
    }
    if (!valid) throw new Error(`analytics_funnel_reference_missing:${step.stepOrder}`);
  }
}

export async function assertFunnelFilterReference(
  db: D1Database,
  lineAccountId: string,
  filter: FunnelAudienceFilter,
): Promise<void> {
  if (filter.kind === 'all') return;
  const valid = filter.kind === 'tag'
    ? await referenceExists(
      db,
      `SELECT id FROM tags WHERE id = ? AND line_account_id = ?`,
      [filter.tagId, lineAccountId],
    )
    : await referenceExists(db, `SELECT id FROM friend_fields WHERE id = ?`, [filter.fieldId]);
  if (!valid) throw new Error('analytics_funnel_filter_reference_missing');
}

function latestFollowupAt(cohortTo: string, windowDays: number, cutoffAt: string): string {
  const followup = Date.parse(cohortTo) + windowDays * DAY_MS;
  return new Date(Math.min(followup, Date.parse(cutoffAt))).toISOString();
}

export async function runChronologicalFunnel(
  db: D1Database,
  input: {
    lineAccountId: string;
    funnelId: string;
    cohortFrom: string;
    cohortTo: string;
    timeZone: string;
    dataCutoffAt: string;
    createdBy?: string | null;
    persist?: boolean;
  },
): Promise<FunnelRunResult> {
  const funnel = await getFunnelById(db, input.lineAccountId, input.funnelId);
  if (!funnel) throw new Error('analytics_funnel_not_found');
  // 停止・保管したファネルは新しい集計を受け付けない。過去の結果は読める。
  if (funnel.status !== 'active') throw new Error('analytics_funnel_not_active');
  let version = await getCurrentFunnelVersion(db, input.lineAccountId, input.funnelId);
  if (!version) {
    const legacySteps = await getFunnelSteps(db, input.funnelId);
    version = {
      id: '',
      funnelId: funnel.id,
      lineAccountId: input.lineAccountId,
      versionNumber: 0,
      windowDays: funnel.window_days,
      steps: validateV6FunnelSteps(legacySteps.map((step) => ({
        label: step.label,
        kind: step.kind as FunnelStepKind,
        match: parseJsonObject(step.match_json, 'analytics_funnel_step_match_invalid'),
      }))),
      segment: funnel.segment_json
        ? validateFunnelAudienceFilter(JSON.parse(funnel.segment_json))
        : { kind: 'all' },
      comparisonGroups: [],
      createdBy: null,
      createdAt: funnel.created_at,
    };
  }

  const cohortFromMs = Date.parse(input.cohortFrom);
  const cohortToMs = Date.parse(input.cohortTo);
  const cutoffMs = Date.parse(input.dataCutoffAt);
  if (![cohortFromMs, cohortToMs, cutoffMs].every(Number.isFinite)
      || cohortFromMs > cohortToMs || cohortToMs > cutoffMs) {
    throw new Error('analytics_funnel_range_invalid');
  }
  const maxCohortTo = new Date(cohortFromMs);
  maxCohortTo.setUTCMonth(maxCohortTo.getUTCMonth() + 13);
  if (cohortToMs > maxCohortTo.getTime()) {
    throw new Error('analytics_funnel_range_max_13_months');
  }
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone: input.timeZone }).format(new Date());
  } catch {
    throw new Error('analytics_funnel_timezone_invalid');
  }
  await assertFunnelReferences(db, input.lineAccountId, version.steps);
  await assertFunnelFilterReference(db, input.lineAccountId, version.segment);
  for (const group of version.comparisonGroups) {
    await assertFunnelFilterReference(db, input.lineAccountId, group.filter);
  }

  const followupTo = latestFollowupAt(input.cohortTo, version.windowDays, input.dataCutoffAt);
  const raw = await db.prepare(
    `SELECT id, friend_id, event_type, occurred_at, dimensions_json
       FROM analytics_events
      WHERE line_account_id = ? AND friend_id IS NOT NULL
        AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at, id`,
  ).bind(input.lineAccountId, input.cohortFrom, followupTo).all<{
    id: string; friend_id: string; event_type: AnalyticsEventType;
    occurred_at: string; dimensions_json: string;
  }>();
  const requiredEventTypes = [...new Set(version.steps.flatMap(funnelStepEventTypes))];
  const coverage = new Map<string, {
    available_from: string;
    state: 'available' | 'partial' | 'unavailable' | 'failed';
    reason: string | null;
  }>();
  for (const eventType of requiredEventTypes) {
    const row = await db.prepare(
      `SELECT available_from, state, reason FROM analytics_event_coverage
        WHERE line_account_id = ? AND event_type = ?`,
    ).bind(input.lineAccountId, eventType).first<{
      available_from: string;
      state: 'available' | 'partial' | 'unavailable' | 'failed';
      reason: string | null;
    }>();
    if (row) coverage.set(eventType, row);
  }
  const baseMembers = await loadFilterFriendIds(db, input.lineAccountId, version.segment);
  const groupMembers = new Map<string, Set<string> | null>();
  for (const group of version.comparisonGroups) {
    groupMembers.set(group.key, await loadFilterFriendIds(db, input.lineAccountId, group.filter));
  }
  const friendGroups = new Map<string, string[]>();
  const events: FunnelTimelineEvent[] = [];
  for (const row of raw.results) {
    if (baseMembers && !baseMembers.has(row.friend_id)) continue;
    if (!ANALYTICS_EVENT_TYPES.has(row.event_type)) {
      throw new Error(`analytics_funnel_event_type_unknown:${row.event_type}`);
    }
    const groups = version.comparisonGroups
      .filter((group) => groupMembers.get(group.key)?.has(row.friend_id) ?? true)
      .map((group) => group.key);
    friendGroups.set(row.friend_id, groups);
    events.push({
      id: row.id,
      friendId: row.friend_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      dimensions: parseJsonObject(
        row.dimensions_json,
        'analytics_funnel_event_dimensions_invalid',
      ) as Record<string, string | number | boolean>,
    });
  }
  const evaluation = evaluateChronologicalFunnel({
    events,
    steps: version.steps,
    windowDays: version.windowDays,
    cohortFrom: input.cohortFrom,
    cohortTo: input.cohortTo,
    dataCutoffAt: input.dataCutoffAt,
    groupLabels: Object.fromEntries(version.comparisonGroups.map((group) => [group.key, group.label])),
    friendGroups,
  });
  const missingCoverage = requiredEventTypes.filter((eventType) => !coverage.has(eventType));
  const failedCoverage = requiredEventTypes.filter((eventType) =>
    coverage.get(eventType)?.state === 'failed');
  const partialCoverage = requiredEventTypes.filter((eventType) => {
    const item = coverage.get(eventType);
    return item?.state === 'partial' || (item ? item.available_from > input.cohortFrom : false);
  });
  const unavailableCoverage = requiredEventTypes.filter((eventType) =>
    coverage.get(eventType)?.state === 'unavailable');
  const state: FunnelRunResult['state'] = failedCoverage.length > 0
    ? 'failed'
    : missingCoverage.length > 0 || unavailableCoverage.length > 0
      ? 'unavailable'
      : partialCoverage.length > 0
        ? 'partial'
        : 'available';
  const stateReason = state === 'failed'
    ? `取得に失敗したイベント: ${failedCoverage.join(', ')}`
    : state === 'unavailable'
      ? `取得できないイベント: ${[...missingCoverage, ...unavailableCoverage].join(', ')}`
      : state === 'partial'
        ? `一部期間のみのイベント: ${partialCoverage.join(', ')}`
        : null;
  const resultBase = {
    funnelId: funnel.id,
    versionId: version.id || null,
    versionNumber: version.versionNumber || null,
    lineAccountId: input.lineAccountId,
    cohortFrom: input.cohortFrom,
    cohortTo: input.cohortTo,
    timeZone: input.timeZone,
    dataCutoffAt: input.dataCutoffAt,
    state,
    stateReason,
    groups: evaluation.groups,
  } satisfies Omit<FunnelRunResult, 'runId'>;
  if (!input.persist) return { runId: null, ...resultBase };

  const runId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO analytics_funnel_runs (
       id, line_account_id, funnel_id, funnel_version_id, cohort_from, cohort_to,
       time_zone, data_cutoff_at, state, result_json, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?, ?)`,
  ).bind(
    runId, input.lineAccountId, funnel.id, version.id || null,
    input.cohortFrom, input.cohortTo, input.timeZone, input.dataCutoffAt,
    input.createdBy ?? null, createdAt,
  ).run();
  try {
    for (let index = 0; index < evaluation.members.length; index += 90) {
      await db.batch(evaluation.members.slice(index, index + 90).map((member) => db.prepare(
        `INSERT INTO analytics_funnel_run_members (
           run_id, line_account_id, friend_id, group_key, highest_step_order,
           state, started_at, last_reached_at, deadline_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        runId, input.lineAccountId, member.friendId, member.groupKey,
        member.highestStepOrder, member.state, member.startedAt,
        member.lastReachedAt, member.deadlineAt,
      )));
    }
    await db.prepare(
      `UPDATE analytics_funnel_runs SET state = ?, result_json = ?
        WHERE id = ? AND state = 'pending'`,
    ).bind(state, JSON.stringify(resultBase), runId).run();
  } catch (error) {
    await db.prepare(
      `UPDATE analytics_funnel_runs SET state = 'failed', result_json = ? WHERE id = ?`,
    ).bind(JSON.stringify({ error: 'analytics_funnel_run_failed' }), runId).run();
    throw error;
  }
  return { runId, ...resultBase };
}

/**
 * 一覧を開いただけで新しい結果を作らないため、最後に確定した実行結果を読む。
 * 結果JSONは実行時点で固定済みで、現在の定義から再計算しない。
 */
export async function getLatestFunnelRun(
  db: D1Database,
  lineAccountId: string,
  funnelId: string,
): Promise<FunnelRunResult | null> {
  const row = await db.prepare(
    `SELECT id, result_json
       FROM analytics_funnel_runs
      WHERE line_account_id = ? AND funnel_id = ?
        AND state IN ('available', 'partial', 'unavailable', 'failed')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
  ).bind(lineAccountId, funnelId).first<{ id: string; result_json: string }>();
  if (!row) return null;
  try {
    const result = JSON.parse(row.result_json) as Omit<FunnelRunResult, 'runId'>;
    return { runId: row.id, ...result };
  } catch {
    throw new Error('analytics_funnel_run_result_invalid');
  }
}

export async function createFunnelResultAudience(
  db: D1Database,
  input: {
    lineAccountId: string;
    runId: string;
    groupKey?: string;
    stepOrder: number;
    selection: 'reached' | 'stopped' | 'in_progress';
    createdBy?: string | null;
    now: Date;
  },
): Promise<{ id: string; memberCount: number; expiresAt: string }> {
  if (!Number.isInteger(input.stepOrder) || input.stepOrder < 1 || input.stepOrder > 10) {
    throw new Error('analytics_funnel_audience_step_invalid');
  }
  const run = await db.prepare(
    `SELECT id, funnel_id, result_json FROM analytics_funnel_runs
      WHERE id = ? AND line_account_id = ? AND state IN ('available', 'partial')`,
  ).bind(input.runId, input.lineAccountId)
    .first<{ id: string; funnel_id: string; result_json: string }>();
  if (!run) throw new Error('analytics_funnel_run_not_found');
  const funnel = await getFunnelById(db, input.lineAccountId, run.funnel_id);
  // 停止・保管したファネルからは新しい対象者を作らない。
  if (!funnel || funnel.status !== 'active') throw new Error('analytics_funnel_not_active');
  const groupKey = input.groupKey?.trim() || 'all';
  const result = JSON.parse(run.result_json) as { groups?: FunnelGroupEvaluation[] };
  const selectedGroup = result.groups?.find((group) => group.key === groupKey);
  if (!selectedGroup?.steps.some((step) => step.stepOrder === input.stepOrder)) {
    throw new Error('analytics_funnel_audience_selection_invalid');
  }
  const stateClause = input.selection === 'reached'
    ? 'highest_step_order >= ?'
    : input.selection === 'stopped'
      ? `highest_step_order = ? AND state = 'dropped'`
      : `highest_step_order = ? AND state = 'in_progress'`;
  const count = await db.prepare(
    `SELECT COUNT(DISTINCT friend_id) AS count FROM analytics_funnel_run_members
      WHERE run_id = ? AND line_account_id = ? AND group_key = ? AND ${stateClause}`,
  ).bind(input.runId, input.lineAccountId, groupKey, input.stepOrder)
    .first<{ count: number }>();
  const id = crypto.randomUUID();
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + DAY_MS).toISOString();
  const selectionKey = `${groupKey}:${input.stepOrder}:${input.selection}`;
  await db.batch([
    db.prepare(
      `INSERT INTO analytics_result_audiences (
         id, line_account_id, source_kind, source_result_id, selection_key,
         member_count, expires_at, created_by, created_at
       ) VALUES (?, ?, 'funnel', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.lineAccountId, input.runId, selectionKey,
      Number(count?.count ?? 0), expiresAt, input.createdBy ?? null, createdAt,
    ),
    db.prepare(
      `INSERT INTO analytics_result_audience_members (audience_id, friend_id)
       SELECT ?, friend_id FROM analytics_funnel_run_members
        WHERE run_id = ? AND line_account_id = ? AND group_key = ? AND ${stateClause}
       GROUP BY friend_id`,
    ).bind(id, input.runId, input.lineAccountId, groupKey, input.stepOrder),
  ]);
  return { id, memberCount: Number(count?.count ?? 0), expiresAt };
}
