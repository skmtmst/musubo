import { applyVideoMediaSelection } from './webinar-video-selection.js';
import { inputError } from '../lib/input-errors.js';

import { getWebinarById, getWebinarBySlug, createWebinar, updateWebinar, getWebinarCtas, getWebinarVideoAsset, advanceWebinarVideoAsset, getWebinarSession, setWebinarSessionCapacity, type WebinarVideoStage, recordWebinarFunnelEvent, getWebinarOverview, getWebinarList, countWebinarList, webinarListSort, type WebinarListFilters, getWebinarEditorSettings, saveWebinarEditorSettings, publishWebinarAndActivate, getFormById, formBelongsToLineAccount, getFolderById, getWebinarRegistration, type WebinarEditorSettingsInput } from '@line-crm/db';

import { resolveWebinarCaller } from '../features/webinars/webinar-caller/index.js';
import { getWebinarNotificationOverview, getWebinarNotificationSettings, saveWebinarNotificationSettings, type WebinarNotificationSettingsInput } from '../features/webinars/webinar-notifications/index.js';
import { verifyWebinarToken } from '../lib/webinar-token.js';
import type { Env } from '../worker-env.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';
import { FUNNEL_EVENT_TYPES, resolveWebinarDeliveryKind, nowEpoch, CONTENT_TYPES, adminAccountScope, serializeWebinarList, WebinarBody, validateWebinarBody, webinarErrorFields, serializeWebinarWithVideoMedia, getEditorPayload, buildPublishValidation, serializeWebinar, serializeVideoAsset, WEBINAR_VIDEO_NEXT_STAGE, parseJson } from './webinars-definition.js';
import type { Context } from 'hono';

export const post__api_liff_webinars_slug_funnel_event_1 = async (c: Context<Env, "/api/liff/webinars/:slug/funnel-event">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const body = await c.req.json<{
    sessionStartAt?: unknown;
    eventType?: unknown;
    ctaId?: unknown;
    formId?: unknown;
    fieldName?: unknown;
  }>();
  const sessionStartAt = Number(body.sessionStartAt);
  const eventType = typeof body.eventType === 'string' ? body.eventType : '';
  const ctaId = typeof body.ctaId === 'string' ? body.ctaId.slice(0, 128) : '';
  const formId = typeof body.formId === 'string' ? body.formId.slice(0, 128) : '';
  const fieldName = typeof body.fieldName === 'string' ? body.fieldName.slice(0, 64) : '';
  if (!Number.isInteger(sessionStartAt) || !FUNNEL_EVENT_TYPES.has(eventType)) {
    return inputError(c, { error: 'invalid_body' }, 422, ["sessionStartAt","eventType"]);
  }
  if (fieldName && !/^[A-Za-z0-9_]+$/.test(fieldName)) {
    return inputError(c, { error: 'invalid_field_name' }, 422, ["fieldName"]);
  }
  const registration = await getWebinarRegistration(
    c.env.DB, auth.webinar.id, auth.friendId, sessionStartAt,
  );
  // R96: オンデマンドは申込なしで入れるため、計測の申込必須を外す。
  if (!registration && (await resolveWebinarDeliveryKind(c.env.DB, auth.webinar)) !== 'on_demand') {
    return c.json({ error: 'not_registered' }, 409);
  }

  const ctas = await getWebinarCtas(c.env.DB, auth.webinar.id);
  if (ctaId && !ctas.some((cta) => cta.id === ctaId)) {
    return inputError(c, { error: 'invalid_cta' }, 422, ["ctaId"]);
  }
  if (formId && !ctas.some((cta) => cta.form_id === formId)) {
    return inputError(c, { error: 'invalid_form' }, 422, ["formId"]);
  }

  await recordWebinarFunnelEvent(c.env.DB, {
    webinarId: auth.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    eventType: eventType as Parameters<typeof recordWebinarFunnelEvent>[1]['eventType'],
    ctaId,
    formId,
    fieldName,
  });
  return c.json({ ok: true });
};

export const get__webinar_assets_token_slug__2 = async (c: Context<Env, "/webinar-assets/:token/:slug/*">) => {
  const token = c.req.param('token');
  const slug = c.req.param('slug');

  const valid = await verifyWebinarToken(c.env.LINE_CHANNEL_SECRET, slug, token, nowEpoch());
  if (!valid) return c.json({ error: 'forbidden' }, 403);

  const webinar = await getWebinarBySlug(c.env.DB, slug, { activeAccountOnly: true });
  if (!webinar || !webinar.video_prefix) return c.json({ error: 'not_found' }, 404);

  const prefix = `/webinar-assets/${token}/${slug}/`;
  const rest = decodeURIComponent(c.req.path.slice(prefix.length));
  if (!rest || rest.includes('..') || rest.startsWith('/')) {
    return c.json({ error: 'bad_path' }, 400);
  }

  const object = await c.env.IMAGES.get(`${webinar.video_prefix}/${rest}`);
  if (!object) return c.json({ error: 'not_found' }, 404);

  const ext = rest.split('.').pop() ?? '';
  const headers = new Headers();
  headers.set('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');

  // ?at=<秒> 付きプレイリストは #EXT-X-START を注入し、途中参加位置からの
  // 再生を「配信側で」宣言する。iOS native HLS (LINE in-app) はクライアント側
  // currentTime シークが 0 に巻き戻ることがあるため、開始位置はプレイリスト
  // で示すのが確実。master 内の variant URI にも ?at= を伝播する。
  const atRaw = c.req.query('at');
  if (ext === 'm3u8' && atRaw !== undefined) {
    const at = Math.floor(Number(atRaw));
    if (!Number.isFinite(at) || at < 0 || at > webinar.duration_seconds) {
      return c.json({ error: 'bad_at' }, 400);
    }
    const text = await object.text();
    const isMaster = text.includes('#EXT-X-STREAM-INF');
    const out: string[] = [];
    for (const line of text.split('\n')) {
      out.push(
        isMaster && line.trim() !== '' && !line.startsWith('#')
          ? `${line.trim()}${line.includes('?') ? '&' : '?'}at=${at}`
          : line,
      );
      if (line.startsWith('#EXTM3U')) {
        out.push(`#EXT-X-START:TIME-OFFSET=${at},PRECISE=YES`);
      }
    }
    // 開始位置は視聴タイミング依存の動的レスポンスなのでキャッシュさせない
    headers.set('Cache-Control', 'private, no-store');
    return new Response(out.join('\n'), { headers });
  }

  headers.set(
    'Cache-Control',
    ext === 'm3u8' ? 'public, max-age=3600' : 'public, max-age=31536000, immutable',
  );
  headers.set('ETag', object.etag);
  return new Response(object.body as ReadableStream, { headers });
};

export const get__api_webinars_overview_3 = async (c: Context<Env, "/api/webinars/overview">) => {
  const accountId = c.req.query('account_id')?.trim();
  if (!accountId) {
    return c.json({ success: false, error: 'account_id_required' }, 400);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const overview = await getWebinarOverview(c.env.DB, accountId);
  return c.json({ success: true, data: overview });
};

export const get__api_webinars_4 = async (c: Context<Env, "/api/webinars">) => {
  const { scope } = await adminAccountScope(c);
  const requestedAccountId = c.req.query('account_id');
  if (requestedAccountId && !scope.allowedAccountIds.includes(requestedAccountId)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  /*
  * 大きな一覧を一度に転送しないよう、検索・フォルダ・状態・並びをサーバーで適用し、共通の offset 契約でページを区切る。
  */
  const paging = parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('limit') });
  const rawSort = c.req.query('sort');
  const sort = rawSort === 'created' || rawSort === 'name' ? rawSort : 'updated';
  const rawStatus = c.req.query('status');
  const status = rawStatus === 'active' || rawStatus === 'draft' || rawStatus === 'archived' ? rawStatus : undefined;
  const rawFolder = c.req.query('folder');
  const folderId = !rawFolder ? undefined : rawFolder === '__unfiled__' ? null : rawFolder;
  const q = (c.req.query('q') || '').trim() || undefined;
  const filters: WebinarListFilters = { q, folderId, status, sort };
  const listScope = {
    allowedAccountIds: scope.allowedAccountIds,
    canSeeUnassigned: scope.canSeeUnassigned,
    accountId: requestedAccountId || undefined,
  };
  const [items, total] = await Promise.all([
    getWebinarList(c.env.DB, listScope, { limit: paging.limit, offset: paging.offset }, filters),
    countWebinarList(c.env.DB, listScope, filters),
  ]);
  return c.json({
    success: true as const,
    data: buildOffsetListResponse({
      items: items.map(serializeWebinarList),
      total,
      paging,
      sort: webinarListSort(filters),
    }),
  });
};

export const post__api_webinars_5 = async (c: Context<Env, "/api/webinars">) => {
  const body = await c.req.json<WebinarBody>();
  if (!body.accountId) {
    return inputError(c, { success: false, error: 'account_id_required' }, 400, ["accountId"]);
  }
  // R95: 作った瞬間の公開は受けない。公開前検査と公開版の固定を通す
  // 公開専用口（POST /:id/publish）へ寄せるため、下書きで作る。
  if (body.status === 'active') {
    return inputError(c, { success: false, error: 'publish_via_publish_endpoint' }, 422, ["status"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const input = validateWebinarBody(body, { requireCore: true });
  if (typeof input === 'string') {
    return inputError(c, { success: false, error: input }, input === 'invalid_duration' ? 422 : 400, webinarErrorFields(input));
  }
  const videoError = await applyVideoMediaSelection(c.env.DB, input, body.accountId);
  if (videoError) return inputError(c, { success: false, error: videoError }, 400, ["title","slug","status","durationSeconds","folderId","publicationStartsAt","publicationEndsAt","schedule","cta","accountId","videoPrefix","videoMediaId","tagOnAttend","tagOnCtaClick"]);
  if (body.folderId) {
    const folder = await getFolderById(c.env.DB, body.folderId);
    if (!folder || folder.kind !== 'webinar' || folder.account_id !== body.accountId) {
      return inputError(c, { success: false, error: 'invalid_folder' }, 400, ["folderId","accountId"]);
    }
  }
  const existing = await getWebinarBySlug(c.env.DB, body.slug!);
  if (existing) return c.json({ success: false, error: 'slug_taken' }, 409);
  const created = await createWebinar(
    c.env.DB, input as unknown as Parameters<typeof createWebinar>[1],
  );
  await saveWebinarEditorSettings(c.env.DB, created.id, 0, {
    deliveryKind: body.deliveryKind,
    viewingCondition: body.viewingCondition,
    publicDescription: body.publicDescription,
    registrationFormId: body.registrationFormId,
  });
  return c.json({ success: true, data: await serializeWebinarWithVideoMedia(c, created) });
};

export const get__api_webinars_id_6 = async (c: Context<Env, "/api/webinars/:id">) => {
  const row = await getWebinarById(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, data: await serializeWebinarWithVideoMedia(c, row) });
};

export const get__api_webinars_id_editor_7 = async (c: Context<Env, "/api/webinars/:id/editor">) => {
  const row = await getWebinarById(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, data: await getEditorPayload(c, row) });
};

export const put__api_webinars_id_editor_8 = async (c: Context<Env, "/api/webinars/:id/editor">) => {
  const row = await getWebinarById(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<WebinarEditorSettingsInput & { expectedVersion?: unknown; expectedUpdatedAt?: unknown }>();
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
    return inputError(c, { success: false, error: 'expected_version_required' }, 400, ["expectedVersion"]);
  }
  /*
   * 同時編集の見分けは「最後に直した日時で比べる」。
   * expectedUpdatedAt が送られてきたときだけ照合し、違えば409で止めて
   * 今の中身を返す。送らなければ従来どおり版だけで比べる。
   */
  if (typeof body.expectedUpdatedAt === 'string') {
    const editorRow = await c.env.DB.prepare(
      `SELECT updated_at FROM webinar_editor_settings WHERE webinar_id = ?`,
    ).bind(row.id).first<{ updated_at: string }>();
    if (editorRow && editorRow.updated_at !== body.expectedUpdatedAt) {
      return c.json({
        success: false,
        code: 'VERSION_CONFLICT',
        error: 'ほかの人が先に変えました。最新の内容を確認してから保存し直してください。',
        data: { latest: await getEditorPayload(c, row) },
      }, 409);
    }
  }
  if (body.deliveryKind && !['on_demand', 'scheduled', 'external'].includes(body.deliveryKind)) {
    return inputError(c, { success: false, error: 'invalid_delivery_kind' }, 400, ["deliveryKind"]);
  }
  if (
    body.missingResultPolicy &&
    !['escalate', 'retry_next_day'].includes(body.missingResultPolicy)
  ) {
    return inputError(c, { success: false, error: 'invalid_missing_result_policy' }, 400, ["missingResultPolicy"]);
  }
  if (body.registrationFormId) {
    const form = await getFormById(c.env.DB, body.registrationFormId);
    if (!form || !form.is_active) {
      return inputError(c, { success: false, error: 'form_inactive_or_missing' }, 400, ["registrationFormId"]);
    }
    if (!row.account_id || !await formBelongsToLineAccount(c.env.DB, form.id, row.account_id)) {
      return inputError(c, { success: false, error: 'form_account_mismatch' }, 400, ["registrationFormId"]);
    }
  }
  const saved = await saveWebinarEditorSettings(
    c.env.DB,
    row.id,
    Number(body.expectedVersion),
    body,
  );
  if (!saved) return c.json({ success: false, error: 'version_conflict' }, 409);
  return c.json({ success: true, data: await getEditorPayload(c, row) });
};

export const post__api_webinars_id_public_page_test_9 = async (c: Context<Env, "/api/webinars/:id/public-page/test">) => {
  const row = await getWebinarById(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ expectedVersion?: unknown }>();
  const editor = await getEditorPayload(c, row);
  if (!Number.isInteger(body.expectedVersion) || editor.version !== Number(body.expectedVersion)) {
    return c.json({ success: false, error: 'version_conflict' }, 409);
  }
  const failures = [
    !editor.publicPage.url ? 'missing_liff_id' : null,
    !row.video_prefix ? 'video_not_ready' : null,
    !editor.publicPage.form?.active ? 'form_inactive_or_missing' : null,
  ].filter((value): value is string => Boolean(value));
  const saved = await saveWebinarEditorSettings(c.env.DB, row.id, editor.version, {
    publicPageTest: {
      status: failures.length === 0 ? 'passed' : 'failed',
      failures,
      testedAt: new Date().toISOString(),
    },
  });
  if (!saved) return c.json({ success: false, error: 'version_conflict' }, 409);
  return c.json({ success: true, data: await getEditorPayload(c, row) });
};

export const get__api_webinars_id_publish_validation_10 = async (c: Context<Env, "/api/webinars/:id/publish-validation">) => {
  const row = await getWebinarById(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, data: await buildPublishValidation(c, row) });
};

export const post__api_webinars_id_publish_11 = async (c: Context<Env, "/api/webinars/:id/publish">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ expectedVersion?: unknown }>();
  if (!Number.isInteger(body.expectedVersion)) {
    return inputError(c, { success: false, error: 'expected_version_required' }, 400, ["expectedVersion"]);
  }
  const currentSettings = await getWebinarEditorSettings(c.env.DB, id);
  if (!currentSettings || currentSettings.version !== Number(body.expectedVersion) || row.status === 'archived') {
    return c.json({ success: false, error: 'version_conflict', currentVersion: currentSettings?.version ?? null, currentStatus: row.status }, 409);
  }
  const validation = await buildPublishValidation(c, row);
  if (validation.blockers.length > 0) {
    return c.json({ success: false, error: 'publish_validation_failed', data: validation }, 409);
  }
  const published = await publishWebinarAndActivate(c.env.DB, id, Number(body.expectedVersion));
  if (!published) {
    const [current, webinar] = await Promise.all([getWebinarEditorSettings(c.env.DB, id), getWebinarById(c.env.DB, id)]);
    return c.json({ success: false, error: 'version_conflict', currentVersion: current?.version ?? null, currentStatus: webinar?.status ?? null }, 409);
  }
  const updated = await getWebinarById(c.env.DB, id);
  auditLog(c, 'webinar.publish', { kind: 'webinar', id });
  return c.json({ success: true, data: { webinar: serializeWebinar(updated!), validation } });
};

export const get__api_webinars_id_video_asset_12 = async (c: Context<Env, "/api/webinars/:id/video-asset">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, data: { asset: serializeVideoAsset(await getWebinarVideoAsset(c.env.DB, id)) } });
};

export const post__api_webinars_id_video_asset_advance_13 = async (c: Context<Env, "/api/webinars/:id/video-asset/advance">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ stage?: unknown; errorCode?: unknown; durationSeconds?: unknown }>();
  const stage = typeof body.stage === 'string' ? body.stage : '';
  if (!['uploaded', 'inspecting', 'converting', 'packaging', 'thumbnail', 'ready', 'failed'].includes(stage)) {
    return inputError(c, { success: false, error: 'invalid_stage' }, 400, ["stage"]);
  }
  const current = await getWebinarVideoAsset(c.env.DB, id);
  const allowed = current ? WEBINAR_VIDEO_NEXT_STAGE[current.stage] ?? [] : ['uploaded'];
  if (!allowed.includes(stage)) {
    return c.json({ success: false, error: 'invalid_stage_transition' }, 409);
  }
  const durationSeconds = body.durationSeconds === undefined || body.durationSeconds === null
    ? null
    : Math.floor(Number(body.durationSeconds));
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    return inputError(c, { success: false, error: 'invalid_body' }, 400, ["durationSeconds"]);
  }
  const advanced = await advanceWebinarVideoAsset(c.env.DB, id, stage as WebinarVideoStage, {
    errorCode: typeof body.errorCode === 'string' ? body.errorCode.slice(0, 64) : null,
    durationSeconds,
  });
  if (!advanced) return c.json({ success: false, error: 'invalid_stage_transition' }, 409);
  auditLog(c, 'webinar.video_stage', { kind: 'webinar', id });
  return c.json({ success: true, data: { asset: serializeVideoAsset(advanced) } });
};

export const get__api_webinars_id_sessions_startAt_14 = async (c: Context<Env, "/api/webinars/:id/sessions/:startAt">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const startAt = Math.floor(Number(c.req.param('startAt')));
  if (!Number.isFinite(startAt)) return c.json({ success: false, error: 'invalid_body' }, 400);
  const session = await getWebinarSession(c.env.DB, id, startAt);
  return c.json({
    success: true,
    data: {
      session: session
        ? {
          sessionStartAt: session.session_start_at,
          capacity: session.capacity,
          reservedCount: session.reserved_count,
          state: session.state,
          remaining: session.capacity === null ? null : Math.max(0, session.capacity - session.reserved_count),
        }
        : null,
    },
  });
};

export const put__api_webinars_id_sessions_startAt_15 = async (c: Context<Env, "/api/webinars/:id/sessions/:startAt">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const startAt = Math.floor(Number(c.req.param('startAt')));
  const body = await c.req.json<{ capacity?: unknown }>();
  const capacity = body.capacity === undefined || body.capacity === null ? null : Math.floor(Number(body.capacity));
  if (!Number.isFinite(startAt) || (capacity !== null && (!Number.isInteger(capacity) || capacity < 1))) {
    return inputError(c, { success: false, error: 'invalid_body' }, 400, ["capacity"]);
  }
  const session = await setWebinarSessionCapacity(c.env.DB, id, startAt, capacity);
  auditLog(c, 'webinar.session_capacity', { kind: 'webinar', id });
  return c.json({
    success: true,
    data: {
      session: {
        sessionStartAt: session.session_start_at,
        capacity: session.capacity,
        reservedCount: session.reserved_count,
        state: session.state,
        remaining: session.capacity === null ? null : Math.max(0, session.capacity - session.reserved_count),
      },
    },
  });
};

export const post__api_webinars_id_pause_16 = async (c: Context<Env, "/api/webinars/:id/pause">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ expectedVersion?: unknown }>();
  const settings = await getWebinarEditorSettings(c.env.DB, id);
  if (!Number.isInteger(body.expectedVersion) || settings?.version !== Number(body.expectedVersion)) {
    return c.json({ success: false, error: 'version_conflict', currentVersion: settings?.version ?? null, currentStatus: row.status }, 409);
  }
  const updated = await updateWebinar(c.env.DB, id, { status: 'draft' }, Number(body.expectedVersion), 'active');
  if (!updated) {
    const [current, webinar] = await Promise.all([getWebinarEditorSettings(c.env.DB, id), getWebinarById(c.env.DB, id)]);
    return c.json({ success: false, error: 'version_conflict', currentVersion: current?.version ?? null, currentStatus: webinar?.status ?? null }, 409);
  }
  auditLog(c, 'webinar.pause', { kind: 'webinar', id });
  return c.json({ success: true, data: serializeWebinar(updated!) });
};

export const post__api_webinars_id_duplicate_17 = async (c: Context<Env, "/api/webinars/:id/duplicate">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ expectedVersion?: unknown }>();
  const settings = await getWebinarEditorSettings(c.env.DB, id);
  if (!settings || !Number.isInteger(body.expectedVersion) || settings.version !== Number(body.expectedVersion)) {
    return c.json({ success: false, error: 'version_conflict' }, 409);
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const duplicate = await createWebinar(c.env.DB, {
    accountId: row.account_id,
    title: `${row.title}（複製）`,
    slug: `${row.slug.slice(0, 54)}-${suffix}`,
    status: 'draft',
    videoPrefix: row.video_prefix,
    durationSeconds: row.duration_seconds,
    scheduleJson: row.schedule_json,
    ctaJson: row.cta_json,
    tagOnAttend: row.tag_on_attend,
    tagOnCtaClick: row.tag_on_cta_click,
    folderId: row.folder_id,
    publicationStartsAt: row.publication_starts_at,
    publicationEndsAt: row.publication_ends_at,
  });
  await saveWebinarEditorSettings(c.env.DB, duplicate.id, 0, {
    deliveryKind: settings.delivery_kind,
    viewingCondition: parseJson(settings.viewing_condition_json, {}),
    publicDescription: settings.public_description,
    registrationFormId: settings.registration_form_id,
    notificationMessages: parseJson(settings.notification_messages_json, {}),
    actionTemplateBody: settings.action_template_body,
    missingResultPolicy: settings.missing_result_policy,
  });
  auditLog(c, 'webinar.duplicate', { kind: 'webinar', id });
  return c.json({ success: true, data: serializeWebinar(duplicate) }, 201);
};

export const get__api_webinars_id_notifications_18 = async (c: Context<Env, "/api/webinars/:id/notifications">) => {
  const id = c.req.param('id') ?? '';
  const [settings, overview] = await Promise.all([
    getWebinarNotificationSettings(c.env.DB, id),
    getWebinarNotificationOverview(c.env.DB, id),
  ]);
  return c.json({ success: true, data: { settings, overview } });
};

export const put__api_webinars_id_notifications_19 = async (c: Context<Env, "/api/webinars/:id/notifications">) => {
    try {
      const body = await c.req.json<Partial<WebinarNotificationSettingsInput>>();
      const required = [
        'registrationEnabled',
        'dayBeforeEnabled',
        'dayBeforeTime',
        'hourBeforeEnabled',
        'hourBeforeMinutes',
        'startEnabled',
        'missedEnabled',
        'missedTime',
        'completedEnabled',
      ] as const;
      if (required.some((key) => body[key] === undefined)) {
        return inputError(c, { success: false, error: 'invalid_settings' }, 400, required.filter((key) => body[key] === undefined));
      }
      const booleans = [
        body.registrationEnabled,
        body.dayBeforeEnabled,
        body.hourBeforeEnabled,
        body.startEnabled,
        body.missedEnabled,
        body.completedEnabled,
      ];
      if (
        booleans.some((value) => typeof value !== 'boolean') ||
        typeof body.dayBeforeTime !== 'string' ||
        typeof body.missedTime !== 'string' ||
        typeof body.hourBeforeMinutes !== 'number' ||
        (body.missedWindowDays !== undefined && typeof body.missedWindowDays !== 'number')
      ) {
        return inputError(c, { success: false, error: 'invalid_settings' }, 400, ["registrationEnabled","dayBeforeEnabled","hourBeforeEnabled","startEnabled","missedEnabled","completedEnabled","dayBeforeTime","missedTime","hourBeforeMinutes","missedWindowDays"]);
      }
      const result = await saveWebinarNotificationSettings(
        c.env.DB,
        c.req.param('id'),
        body as WebinarNotificationSettingsInput,
      );
      return c.json({ success: true, data: result });
    } catch (err) {
      const code = err instanceof Error ? err.message : 'invalid_settings';
      if (code === 'invalid_time' || code === 'invalid_hour_before' || code === 'invalid_missed_window') {
        return inputError(c, { success: false, error: code }, 400, code === 'invalid_time' ? ['dayBeforeTime', 'missedTime'] : code === 'invalid_hour_before' ? ['hourBeforeMinutes'] : ['missedWindowDays']);
      }
      throw err;
    }
  };
