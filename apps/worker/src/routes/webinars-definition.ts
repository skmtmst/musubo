import { sqlIdSet } from '@line-crm/db/id-queries';
import { type Context, type MiddlewareHandler } from 'hono';
import { getWebinarById, archiveWebinar, getWebinarCtas, getWebinarVideoAsset, isWebinarVideoReady, getWebinarEditorSettings, getWebinarMonitoringSummary, getWebinarPublicAccount, getWebinarActions, countInvalidWebinarActionReferences, getFormById, type Webinar, type WebinarListRow, type WebinarActionInput, type WebinarActionType, type WebinarEditorSettings, type WebinarEditorSettingsInput, type WebinarParticipantClassification, getMediaIdByR2Key } from '@line-crm/db';

import { parseScheduleRules } from '../features/webinars/webinar-schedule/index.js';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';

export const COMMENT_MAX = 500;
export /* さくらコメント一括置換の件数上限。CTA の 20 件と違い演出行は多いが、
   上限なしだと巨大配列で D1 batch 上限超過→500 になる。 */
const SAKURA_COMMENTS_MAX = 200;
export const SESSION_COMMENT_LIMIT = 60;
export const TOKEN_GRACE_SECONDS = 3600;
export // 開始後もこの秒数までは、その回を予約して途中参加できる。
// ただし未予約者へ再生トークンは一切返さず、必ず予約を先に通す。
const CURRENT_SESSION_JOIN_GRACE_SECONDS = 5 * 60;
export // 開始前「待機ルーム」を開く秒数。この窓内はサクラコメント (負の at_seconds)
// と視聴者コメントが動く。管理画面での編集余地を持たせて負方向は 1h まで許容。
const WAITING_ROOM_SECONDS = 600;
export const COMMENT_MIN_AT_SECONDS = -3600;
export const FUNNEL_EVENT_TYPES = new Set([
  'cta_impression',
  'form_open',
  'form_start',
  'field_complete',
  'submit_attempt',
  'submit_success',
  'submit_error',
]);

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export // 公開期間の窓。開始前・終了後は顧客向け入口（視聴・申込）で止める。
// 一覧の表示分類とは別に、顧客が入れるかどうかをここで決める。
function publicationWindowBlockReason(row: Webinar): 'not_started' | 'ended' | null {
  const now = Date.now();
  const startsAt = row.publication_starts_at ? Date.parse(row.publication_starts_at) : null;
  const endsAt = row.publication_ends_at ? Date.parse(row.publication_ends_at) : null;
  if (startsAt !== null && !Number.isNaN(startsAt) && startsAt > now) return 'not_started';
  if (endsAt !== null && !Number.isNaN(endsAt) && endsAt <= now) return 'ended';
  return null;
}

export type WebinarDeliveryKind = 'on_demand' | 'scheduled' | 'external';

export // 顧客向け処理が見る配信方法。保存が無い旧データは枠の有無から読み替える
// （枠なし＝いつでも視聴のオンデマンド、枠あり＝日時指定）。
async function resolveWebinarDeliveryKind(db: D1Database, row: Webinar): Promise<WebinarDeliveryKind> {
  const settings = await getWebinarEditorSettings(db, row.id);
  if (
    settings &&
    (settings.delivery_kind === 'on_demand' ||
      settings.delivery_kind === 'scheduled' ||
      settings.delivery_kind === 'external')
  ) {
    return settings.delivery_kind;
  }
  return parseScheduleRules(row.schedule_json).length === 0 ? 'on_demand' : 'scheduled';
}

export // オンデマンドの常設回。枠を持たないため、作った時点を全員の共通の回にする。
// 入場のたびに回を作ると視聴記録が散らばるので、この値に固定する。
function onDemandSessionStartAt(row: Webinar, now: number): number {
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) ? Math.floor(created / 1000) : now;
}

export // ----------------------------------------------------------------
// HLS アセット配信
// ----------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  aac: 'audio/aac',
};

export // ----------------------------------------------------------------
// Admin API (/api/webinars/*) — 既存 authMiddleware がカバー
// ----------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export async function adminAccountScope(c: Context<Env>) {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const column = 'account_id';
  const where = scope.allowedAccountIds.length
    ? `(${column} IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ` OR ${column} IS NULL` : ''})`
    : scope.canSeeUnassigned
      ? `${column} IS NULL`
      : '1 = 0';
  return { scope, where };
}

export const requireVisibleWebinar: MiddlewareHandler<Env> = async (c, next) => {
  const webinar = await getWebinarById(c.env.DB, c.req.param('id') ?? '');
  if (!webinar || !await canAccessAllLineAccounts(
    c.env.DB, c.get('staff'), [webinar.account_id ?? null],
  )) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  await next();
};

export function publicationState(row: Webinar) {
  const startsAt = row.publication_starts_at ? Date.parse(row.publication_starts_at) : null;
  const endsAt = row.publication_ends_at ? Date.parse(row.publication_ends_at) : null;
  const now = Date.now();
  if (endsAt !== null && endsAt <= now) return 'ended' as const;
  if (startsAt !== null && startsAt > now) return 'scheduled' as const;
  if (row.status !== 'active') return 'unset' as const;
  if (startsAt === null && endsAt === null) return 'always' as const;
  return 'period' as const;
}

export function serializeWebinar(row: Webinar) {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    videoPrefix: row.video_prefix,
    durationSeconds: row.duration_seconds,
    schedule: parseScheduleRules(row.schedule_json),
    cta: row.cta_json ? (JSON.parse(row.cta_json) as unknown) : null,
    tagOnAttend: row.tag_on_attend,
    tagOnCtaClick: row.tag_on_cta_click,
    folderId: row.folder_id ?? null,
    publicationState: publicationState(row),
    publicationStartsAt: row.publication_starts_at ?? null,
    publicationEndsAt: row.publication_ends_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export /**
 * 管理APIの詳細・保存応答へ、動画の選択元メディアIDを添える。
 * video_prefix は r2_key の保存値なので、同じアカウントのメディアへ
 * 引き直して画面の選択状態へ戻す。ライブラリ外のprefixなら null。
 */
async function serializeWebinarWithVideoMedia(c: Context<Env>, row: Webinar) {
  return {
    ...serializeWebinar(row),
    videoMediaId: row.video_prefix
      ? await getMediaIdByR2Key(c.env.DB, row.video_prefix, row.account_id)
      : null,
  };
}

export function serializeWebinarList(row: WebinarListRow) {
  return {
    ...serializeWebinar(row),
    folderName: row.folder_name ?? null,
    registrationCount: Number(row.registration_count),
    viewerCount: row.viewer_count === null ? null : Number(row.viewer_count),
  };
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function defaultEditorSettings(row: Webinar): WebinarEditorSettings {
  return {
    webinar_id: row.id,
    version: 0,
    delivery_kind: row.schedule_json === '[]' ? 'on_demand' : 'scheduled',
    viewing_condition_json: JSON.stringify({ kind: 'registered', label: '申込者向け' }),
    public_description: '',
    registration_form_id: null,
    notification_messages_json: '{}',
    notification_test_json: null,
    action_template_body: '',
    missing_result_policy: 'escalate',
    public_page_test_json: null,
    published_version: null,
    published_at: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function formFieldLabels(form: Awaited<ReturnType<typeof getFormById>>): string[] {
  if (!form) return [];
  const fields = parseJson<Array<Record<string, unknown>>>(form.fields, []);
  return fields.map((field) => String(field.label ?? field.name ?? field.key ?? '').trim()).filter(Boolean);
}

export function formCompletionActions(form: Awaited<ReturnType<typeof getFormById>>): string[] {
  if (!form) return [];
  const actions: string[] = [];
  if (form.on_submit_tag_id) actions.push('タグを付ける');
  if (form.on_submit_scenario_id) actions.push('シナリオを開始する');
  if (form.on_submit_message_type) actions.push('完了メッセージを送る');
  if (form.on_submit_webhook_url) actions.push('Webhookへ送る');
  return actions;
}

export async function getEditorPayload(c: Context<Env>, row: Webinar) {
  const stored = await getWebinarEditorSettings(c.env.DB, row.id);
  const settings = stored ?? defaultEditorSettings(row);
  const [form, account, monitoring, ctas] = await Promise.all([
    settings.registration_form_id
      ? getFormById(c.env.DB, settings.registration_form_id)
      : Promise.resolve(null),
    getWebinarPublicAccount(c.env.DB, row.account_id),
    getWebinarMonitoringSummary(c.env.DB, row.id),
    getWebinarCtas(c.env.DB, row.id),
  ]);
  const liffId = account?.liff_id ?? null;
  const publicUrl = liffId
    ? `https://liff.line.me/${encodeURIComponent(liffId)}/webinar/${encodeURIComponent(row.slug)}`
    : null;
  return {
    version: settings.version,
    /* 同時編集の帯が読んだ版を見分ける更新日時。 */
    updatedAt: settings.updated_at ?? null,
    deliveryKind: settings.delivery_kind,
    viewingCondition: parseJson(settings.viewing_condition_json, { kind: 'registered', label: '申込者向け' }),
    publicDescription: settings.public_description,
    registrationFormId: settings.registration_form_id,
    /*
     * CTAカードの件数。旧 cta_json ではなくカード方式の正本を見る。
     * 段の印と最終確認が、カードを保存したのに「未設定」と出る退行を
     * 防ぐための口（編集本体は子タブが /ctas から持つ）。
     */
    ctaCount: ctas.length,
    notificationMessages: parseJson<Record<string, string>>(settings.notification_messages_json, {}),
    notificationTest: parseJson<Record<string, unknown> | null>(settings.notification_test_json, null),
    actionPolicy: {
      templateBody: settings.action_template_body,
      missingResultPolicy: settings.missing_result_policy,
    },
    publicPage: {
      liffId,
      url: publicUrl,
      unavailableReason: publicUrl ? null : 'LINE公式アカウントにLIFF IDが設定されていません',
      description: settings.public_description,
      test: parseJson<Record<string, unknown> | null>(settings.public_page_test_json, null),
      form: form ? {
        id: form.id,
        name: form.name,
        active: Boolean(form.is_active),
        fields: formFieldLabels(form),
        completionActions: formCompletionActions(form),
      } : null,
    },
    publication: {
      status: row.status,
      draftVersion: settings.version,
      publishedVersion: settings.published_version,
      publishedAt: settings.published_at,
    },
    monitoring: {
      notificationFailures: Number(monitoring.notification_failures),
      duplicateRegistrations: Number(monitoring.duplicate_registrations),
      viewSegmentFailures: Number(monitoring.view_segment_failures),
      actionFailures: Number(monitoring.action_failures),
    },
  };
}

export interface WebinarBody {
  accountId?: string | null;
  title?: string;
  slug?: string;
  status?: string;
  videoPrefix?: string | null;
  /**
   * 動画はメディアライブラリの選択で指定する。保存値（video_prefix）は
   * 選ばれたメディアの r2_key からサーバー側で生成し、自由入力させない。
   * null は動画の解除。videoPrefix と同時には送れない。
   */
  videoMediaId?: string | null;
  durationSeconds?: number;
  schedule?: unknown[];
  cta?: { label?: string; url?: string; showAtSeconds?: number } | null;
  tagOnAttend?: string | null;
  tagOnCtaClick?: string | null;
  folderId?: string | null;
  publicationStartsAt?: string | null;
  publicationEndsAt?: string | null;
  expectedVersion?: number;
  deliveryKind?: WebinarEditorSettingsInput['deliveryKind'];
  viewingCondition?: Record<string, unknown>;
  publicDescription?: string;
  registrationFormId?: string | null;
}

export const WEBINAR_ACTION_TYPES = new Set<WebinarActionType>([
  'add_tag', 'remove_tag',
  'start_scenario', 'stop_scenario', 'resume_scenario',
  'send_message', 'send_webhook',
  'switch_rich_menu', 'remove_rich_menu',
]);

export function serializeWebinarAction(row: Awaited<ReturnType<typeof getWebinarActions>>[number]) {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.config_json) as Record<string, unknown>; } catch { config = {}; }
  return {
    id: row.id,
    trigger: row.trigger,
    actionType: row.action_type,
    config,
    position: row.position,
    version: row.version,
  };
}

export function parseWebinarActions(value: unknown): WebinarActionInput[] | null {
  if (!Array.isArray(value) || value.length > 30) return null;
  const parsed: WebinarActionInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    if (!['completed', 'cta_clicked', 'unviewed'].includes(String(row.trigger))) return null;
    if (!WEBINAR_ACTION_TYPES.has(row.actionType as WebinarActionType)) return null;
    if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) return null;
    const actionType = row.actionType as WebinarActionType;
    const config = row.config as Record<string, unknown>;
    parsed.push({
      trigger: row.trigger as WebinarActionInput['trigger'],
      actionType,
      config,
    });
  }
  return parsed;
}

export // body → createWebinar/updateWebinar input。不正なら string (エラーコード) を返す
function webinarErrorFields(code: string): string[] {
  const keys: Record<string, string[]> = {
    title_required: ['title'], invalid_slug: ['slug'], invalid_status: ['status'],
    invalid_duration: ['durationSeconds'], invalid_folder: ['folderId'],
    invalid_publication_period: ['publicationStartsAt', 'publicationEndsAt'],
    invalid_schedule: ['schedule'], invalid_cta: ['cta'],
    ambiguous_video_source: ['videoPrefix', 'videoMediaId'],
  };
  return keys[code] ?? [];
}

export function validateWebinarBody(
  body: WebinarBody,
  { requireCore }: { requireCore: boolean },
): string | Record<string, unknown> {
  if (requireCore) {
    if (!body.title?.trim()) return 'title_required';
    if (!body.slug || !SLUG_RE.test(body.slug)) return 'invalid_slug';
  } else {
    if (body.title !== undefined && !body.title.trim()) return 'title_required';
    if (body.slug !== undefined && !SLUG_RE.test(body.slug)) return 'invalid_slug';
  }
  if (body.status !== undefined && !['draft', 'active', 'archived'].includes(body.status)) {
    return 'invalid_status';
  }
  if (requireCore && body.durationSeconds === undefined) {
    return 'invalid_duration';
  }
  if (body.durationSeconds !== undefined) {
    if (!Number.isFinite(body.durationSeconds) || body.durationSeconds < 1) {
      return 'invalid_duration';
    }
  }
  if (
    body.folderId !== undefined && body.folderId !== null &&
    (typeof body.folderId !== 'string' || !body.folderId.trim())
  ) {
    return 'invalid_folder';
  }
  for (const value of [body.publicationStartsAt, body.publicationEndsAt]) {
    if (
      value !== undefined && value !== null &&
      (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    ) {
      return 'invalid_publication_period';
    }
  }
  if (
    body.publicationStartsAt && body.publicationEndsAt &&
    Date.parse(body.publicationStartsAt) > Date.parse(body.publicationEndsAt)
  ) {
    return 'invalid_publication_period';
  }
  let scheduleJson: string | undefined;
  if (body.schedule !== undefined) {
    if (!Array.isArray(body.schedule)) return 'invalid_schedule';
    const parsed = parseScheduleRules(JSON.stringify(body.schedule));
    if (parsed.length !== body.schedule.length) return 'invalid_schedule';
    scheduleJson = JSON.stringify(parsed);
  }
  let ctaJson: string | null | undefined;
  if (body.cta === null) {
    ctaJson = null;
  } else if (body.cta !== undefined) {
    const { label, url, showAtSeconds } = body.cta;
    if (
      !label?.trim() || !url?.trim() || !/^https?:\/\//.test(url) ||
      !Number.isFinite(showAtSeconds) || (showAtSeconds as number) < 0
    ) {
      return 'invalid_cta';
    }
    ctaJson = JSON.stringify({ label: label.trim(), url: url.trim(), showAtSeconds });
  }
  const input: Record<string, unknown> = {};
  if (body.accountId !== undefined) input.accountId = body.accountId;
  if (body.title !== undefined) input.title = body.title.trim();
  if (body.slug !== undefined) input.slug = body.slug;
  if (body.status !== undefined) input.status = body.status;
  if (body.videoPrefix !== undefined && body.videoMediaId !== undefined) {
    // 動画の指定元が2つあるとどちらが保存されたか読めないため拒否する。
    return 'ambiguous_video_source';
  }
  if (body.videoPrefix !== undefined) {
    input.videoPrefix = body.videoPrefix?.replace(/^\/+|\/+$/g, '') || null;
  }
  if (body.videoMediaId !== undefined) input.videoMediaId = body.videoMediaId;
  if (body.durationSeconds !== undefined) {
    input.durationSeconds = Math.floor(body.durationSeconds);
  }
  if (scheduleJson !== undefined) input.scheduleJson = scheduleJson;
  if (ctaJson !== undefined) input.ctaJson = ctaJson;
  if (body.tagOnAttend !== undefined) input.tagOnAttend = body.tagOnAttend;
  if (body.tagOnCtaClick !== undefined) input.tagOnCtaClick = body.tagOnCtaClick;
  if (body.folderId !== undefined) input.folderId = body.folderId;
  if (body.publicationStartsAt !== undefined) {
    input.publicationStartsAt = body.publicationStartsAt;
  }
  if (body.publicationEndsAt !== undefined) input.publicationEndsAt = body.publicationEndsAt;
  return input;
}

export async function buildPublishValidation(c: Context<Env>, row: Webinar) {
  const [editor, ctas, actions] = await Promise.all([
    getEditorPayload(c, row),
    getWebinarCtas(c.env.DB, row.id),
    getWebinarActions(c.env.DB, row.id),
  ]);
  // 保存後に参照先が消えた（または旧版が残った）設定でも、公開前に同じ検証で
  // 安全側に止める。保存時と同じ関数を使い、account_id の基準も合わせる。
  const invalidActionRefs = actions.length === 0
    ? 0
    : await countInvalidWebinarActionReferences(
      c.env.DB,
      row.account_id,
      actions.map(serializeWebinarAction),
    );
  const notificationTest = editor.notificationTest as { status?: unknown } | null;
  const publicPageTest = editor.publicPage.test as { status?: unknown } | null;
  const videoAsset = await getWebinarVideoAsset(c.env.DB, row.id);
  // N: 準備（ready）が済むまで配信に選べない。資産の行が無い従来の
  // 動画（video_prefix だけ）はそのまま通す。準備中の資産がある時は止める。
  const videoReady = videoAsset
    ? await isWebinarVideoReady(c.env.DB, row.id)
    : Boolean(row.video_prefix);
  const checks = [
    {
      key: 'video_ready',
      label: '動画の準備ができています',
      status: videoReady ? 'passed' : 'failed',
      detail: videoAsset
        ? (videoReady ? '動画を配信できます' : `動画は「${videoAsset.stage}」の段です。準備が済むまで公開できません`)
        : row.video_prefix ? '動画を配信できます' : '動画が設定されていません',
    },
    {
      key: 'form_active',
      label: '申込フォームが公開中です',
      status: editor.publicPage.form?.active ? 'passed' : 'failed',
      detail: editor.publicPage.form?.active ? editor.publicPage.form.name : '公開中の回答フォームを選んでください',
    },
    {
      key: 'cta_range',
      label: 'CTAの表示時刻とURLが有効です',
      status: ctas.length > 0 && ctas.every((cta) =>
        cta.at_seconds >= 0 && cta.at_seconds <= row.duration_seconds &&
        (cta.kind !== 'url' || Boolean(cta.url && /^https:\/\//.test(cta.url)))
      ) ? 'passed' : 'failed',
      detail: 'CTAは動画の長さ以内、外部URLはhttpsで検査します',
    },
    // 日時指定の配信は枠が無いと「次の回」が出ない。枠なしで
    // 公開できるのはオンデマンド（いつでも視聴）だけにする。
    {
      key: 'delivery_schedule',
      label: '配信方法に合った枠が設定されています',
      status: editor.deliveryKind === 'scheduled' &&
        parseScheduleRules(row.schedule_json).length === 0 ? 'failed' : 'passed',
      detail: editor.deliveryKind === 'scheduled' &&
        parseScheduleRules(row.schedule_json).length === 0
        ? '日時指定の配信には配信枠を1件以上設定してください'
        : '配信方法と枠の組み合わせは正しいです',
    },
    {
      key: 'notification_test',
      label: '通知のテスト送信が成功しています',
      status: notificationTest?.status === 'passed' ? 'passed' : 'failed',
      detail: notificationTest?.status === 'passed' ? '最後のテスト送信は成功です' : '通知をテスト送信してください',
    },
    {
      key: 'public_page_test',
      label: '公開ページを確認済みです',
      status: publicPageTest?.status === 'passed' && editor.publicPage.url ? 'passed' : 'failed',
      detail: editor.publicPage.url ? '公開ページの表示結果を確認します' : editor.publicPage.unavailableReason,
    },
    {
      key: 'notification_duplicates',
      label: '通知の重複がありません',
      status: editor.monitoring.duplicateRegistrations === 0 ? 'passed' : 'failed',
      detail: editor.monitoring.duplicateRegistrations === 0
        ? '同じ人・版・開催回・通知種別は1回です'
        : `${editor.monitoring.duplicateRegistrations}件の重複候補があります`,
    },
    {
      key: 'action_dependencies',
      label: '視聴後アクションの参照先が有効です',
      status: actions.length === 0
        ? 'warning'
        : invalidActionRefs > 0 ? 'failed' : 'passed',
      detail: actions.length === 0
        ? '視聴後アクションは未設定です'
        : invalidActionRefs > 0
          ? `${invalidActionRefs}件のアクションの参照先が確認できません`
          : `${actions.length}件のアクションを確認しました`,
    },
  ];
  return {
    version: editor.version,
    checks,
    blockers: checks.filter((check) => check.status === 'failed').map((check) => check.key),
    warnings: checks.filter((check) => check.status === 'warning').map((check) => check.key),
  };
}

export // N: 動画の準備の段を見る。段の名前は運用者の言葉で返す。
const WEBINAR_VIDEO_STAGE_LABELS: Record<string, string> = {
  uploaded: '受け付け',
  inspecting: '検査',
  converting: '変換',
  packaging: '配信の形',
  thumbnail: '表紙',
  ready: '準備完了',
  failed: '失敗',
};

export function serializeVideoAsset(asset: {
  id: string; stage: string; provider: string; duration_seconds: number;
  error_code: string | null; expires_at: string | null; purged_at: string | null;
  created_at: string; updated_at: string;
} | null) {
  if (!asset) return null;
  return {
    id: asset.id,
    stage: asset.stage,
    stageLabel: WEBINAR_VIDEO_STAGE_LABELS[asset.stage] ?? asset.stage,
    provider: asset.provider,
    durationSeconds: asset.duration_seconds,
    errorCode: asset.error_code,
    expiresAt: asset.expires_at,
    purgedAt: asset.purged_at,
    createdAt: asset.created_at,
    updatedAt: asset.updated_at,
  };
}

export const WEBINAR_VIDEO_NEXT_STAGE: Record<string, string[]> = {
  uploaded: ['inspecting', 'failed'],
  inspecting: ['converting', 'failed'],
  converting: ['packaging', 'failed'],
  packaging: ['thumbnail', 'failed'],
  thumbnail: ['ready', 'failed'],
  ready: [],
  failed: [],
};

export async function archiveVisibleWebinar(c: Context<Env>) {
  const id = c.req.param('id') ?? '';
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  if (row.status === 'active') {
    return c.json({ success: false, error: 'webinar_pause_required' }, 409);
  }
  const archived = await archiveWebinar(c.env.DB, id);
  auditLog(c, 'webinar.archive', { kind: 'webinar', id });
  return c.json({ success: true, data: serializeWebinar(archived!) });
}

export // 参加者の分類フィルタ。未参加=申込のみ・入場記録なし、途中離脱=入場したが
// 完了未満、完了=最大視聴が閾値以上、計測外=外部動画などで個人視聴を
// 取得できない人（分類しない）。
const WEBINAR_PARTICIPANT_FILTERS = new Set<WebinarParticipantClassification>([
  'unviewed', 'dropped_off', 'completed', 'unmeasured',
]);

export async function webinarParticipantMeasurement(
  db: D1Database,
  webinarId: string,
): Promise<{ measured: boolean; reason: string | null }> {
  const editor = await getWebinarEditorSettings(db, webinarId);
  return editor?.delivery_kind === 'external'
    ? { measured: false, reason: '外部動画では個人の視聴区間を取得できません' }
    : { measured: true, reason: null };
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // 表計算ソフトで式として実行されないようにする。
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export const WEBINAR_CLASSIFICATION_LABELS: Record<WebinarParticipantClassification, string> = {
  unviewed: '未参加',
  dropped_off: '途中離脱',
  completed: '視聴完了',
  unmeasured: '計測外',
};
