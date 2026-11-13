import { buildCursorListResponse, listQueryNumber } from '../lib/list-paging.js';
import { applyVideoMediaSelection } from './webinar-video-selection.js';
import { inputError, validatedInputBody } from '../lib/input-errors.js';

import { getWebinarById, getWebinarBySlug, updateWebinar, getWebinarComments, getWebinarCtas, replaceWebinarCtas, replaceWebinarComments, getWebinarRetention, countWebinarStartedViewers, countWebinarHeartbeatRejects, getWebinarUserComments, getWebinarSessionStats, getWebinarDropoff, getWebinarParticipantStats, getWebinarAnalyticsSummary, getWebinarDailyStats, getWebinarFormFunnelStats, getWebinarEditorSettings, saveWebinarEditorSettings, getWebinarViewSegmentCoverage, getWebinarParticipantOperations, classifyWebinarParticipant, getWebinarActions, replaceWebinarActions, countInvalidWebinarActionReferences, getFormById, formBelongsToLineAccount, getFolderById, type WebinarParticipantClassification, type WebinarParticipantStat } from '@line-crm/db';

import { parseScheduleRules, upcomingSessions } from '../features/webinars/webinar-schedule/index.js';
import { sendWebinarNotificationTest } from '../features/webinars/webinar-notifications/index.js';
import { webinarTestRecipientPreview, WebinarTestRecipientsChanged } from '../features/webinars/webinar-notifications/index.js';
import { dispatchLineProxyLocally } from '../services/local-line-proxy.js';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';
import { nowEpoch, WebinarBody, validateWebinarBody, webinarErrorFields, serializeWebinarWithVideoMedia, serializeWebinarAction, parseWebinarActions, SAKURA_COMMENTS_MAX, COMMENT_MIN_AT_SECONDS, COMMENT_MAX, WEBINAR_PARTICIPANT_FILTERS, webinarParticipantMeasurement, WEBINAR_CLASSIFICATION_LABELS, csvCell } from './webinars-definition.js';
import type { Context } from 'hono';

export const getWebinarTestRecipients = async (c: Context<Env, '/api/webinars/:id/notifications/test'>) => {
  const webinar=await getWebinarById(c.env.DB,c.req.param('id'));
  if(!webinar)return c.json({success:false,error:'Not found'},404);
  if(!webinar.account_id)return inputError(c,{success:false,error:'missing_line_account'},400,[]);
  try {
    const {count,recipients,token}=await webinarTestRecipientPreview(c.env.DB,webinar.account_id);
    return c.json({success:true,data:{count,recipients,token,confirmationId:crypto.randomUUID()}});
  } catch(error) {
    if(error instanceof Error && ['no_test_recipients','invalid_test_recipients'].includes(error.message))return inputError(c,{success:false,error:error.message},400,[]);
    throw error;
  }
};

export const post__api_webinars_id_notifications_test_1 = async (c: Context<Env, "/api/webinars/:id/notifications/test">) => {
    try {
      const webinar = await getWebinarById(c.env.DB, c.req.param('id'));
      if (!webinar) return c.json({ success: false, error: 'Not found' }, 404);
      const body=(validatedInputBody(c)??{}) as {expectedRecipientToken?:string;confirmationId?:string};
      if(body.expectedRecipientToken!==undefined&&!/^[a-f0-9]{64}$/.test(body.expectedRecipientToken))return inputError(c,{success:false,error:'invalid_recipient_token'},400,[]);
      if((body.expectedRecipientToken===undefined)!==(body.confirmationId===undefined)||body.confirmationId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.confirmationId))return inputError(c,{success:false,error:'invalid_confirmation'},400,[]);
      const nextSession = upcomingSessions(
        parseScheduleRules(webinar.schedule_json),
        webinar.duration_seconds,
        nowEpoch(),
        1,
      )[0];
      if (!nextSession) return inputError(c, { success: false, error: 'no_upcoming_session' }, 400, []);
      const liffMatch = /liff\.line\.me\/([^/?]+)/.exec(c.env.LIFF_URL ?? '');
      const result = await sendWebinarNotificationTest(
        c.env.DB,
        {
          id: webinar.id,
          accountId: webinar.account_id,
          title: webinar.title,
          slug: webinar.slug,
        },
        nextSession,
        {
          proxyBaseUrl: c.env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
          defaultAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
          defaultLiffId: liffMatch?.[1] ?? null,
          proxyDispatch: (request) => dispatchLineProxyLocally(request, c.env, c.executionCtx),
          expectedRecipientToken: body.expectedRecipientToken,
          confirmationId: body.confirmationId,
        },
      );
      const editor = await getWebinarEditorSettings(c.env.DB, webinar.id);
      if (editor) {
        await saveWebinarEditorSettings(c.env.DB, webinar.id, editor.version, {
          notificationTest: {
            status: result.failed === 0 ? 'passed' : 'failed',
            sent: result.sent,
            failed: result.failed,
            testedAt: new Date().toISOString(),
          },
        });
      }
      return c.json({ success: true, data: result });
    } catch (err) {
      if(err instanceof WebinarTestRecipientsChanged)return c.json({success:false,code:err.code,error:err.message,data:err.current},409);
      const code = err instanceof Error ? err.message : 'test_send_failed';
      if(code==='webinar_test_already_started')return c.json({success:false,code,error:'この確認からのテスト送信は既に始まっています。結果を確認してください'},409);
      if ([
        'missing_line_account',
        'invalid_test_recipients',
        'no_test_recipients',
        'inactive_line_account',
        'missing_liff_id',
        'no_active_test_recipients',
      ].includes(code)) {
        return inputError(c, { success: false, error: code }, 400, []);
      }
      throw err;
    }
  };

export const put__api_webinars_id_2 = async (c: Context<Env, "/api/webinars/:id">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<WebinarBody>();
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion! < 0) return inputError(c, { success: false, code: 'EXPECTED_VERSION_REQUIRED', error: '確認した版が必要です' }, 400, ['expectedVersion']);
  // R95: 下書きから公開中への切替は通常更新では受けない。公開前検査と
  // 公開版の固定を通す公開専用口（POST /:id/publish）へ寄せる。
  // 公開中のまま他項目を直す保存は通す。
  if (body.status === 'active' && row.status !== 'active') {
    return c.json({ success: false, error: 'publish_via_publish_endpoint' }, 409);
  }
  if (body.accountId !== undefined && !await canAccessAllLineAccounts(
    c.env.DB, c.get('staff'), [body.accountId],
  )) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const input = validateWebinarBody(body, { requireCore: false });
  if (typeof input === 'string') {
    return inputError(c, { success: false, error: input }, input === 'invalid_duration' ? 422 : 400, webinarErrorFields(input));
  }
  const videoError = await applyVideoMediaSelection(
    c.env.DB, input, body.accountId ?? row.account_id,
  );
  if (videoError) return inputError(c, { success: false, error: videoError }, 400, ["title","slug","status","durationSeconds","folderId","publicationStartsAt","publicationEndsAt","schedule","cta","accountId","videoPrefix","videoMediaId","tagOnAttend","tagOnCtaClick"]);
  if (body.folderId) {
    const folder = await getFolderById(c.env.DB, body.folderId);
    const targetAccountId = body.accountId ?? row.account_id;
    if (!folder || folder.kind !== 'webinar' || folder.account_id !== targetAccountId) {
      return inputError(c, { success: false, error: 'invalid_folder' }, 400, ["folderId","accountId"]);
    }
  }
  if (body.slug && body.slug !== row.slug) {
    const dupe = await getWebinarBySlug(c.env.DB, body.slug);
    if (dupe) return c.json({ success: false, error: 'slug_taken' }, 409);
  }
  const updated = await updateWebinar(c.env.DB, id, input as Parameters<typeof updateWebinar>[2], body.expectedVersion);
  if (!updated) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に保存しました。読み直してください' }, 409);
  return c.json({ success: true, data: await serializeWebinarWithVideoMedia(c, updated!) });
};

export const get__api_webinars_id_actions_3 = async (c: Context<Env, "/api/webinars/:id/actions">) => {
  const actions = await getWebinarActions(c.env.DB, c.req.param('id'));
  return c.json({ success: true, data: actions.map(serializeWebinarAction) });
};

export const put__api_webinars_id_actions_4 = async (c: Context<Env, "/api/webinars/:id/actions">) => {
  const body = await c.req.json<{ actions?: unknown }>();
  const actions = parseWebinarActions(body.actions);
  if (!actions) return inputError(c, { success: false, error: 'invalid_actions' }, 400, ["actions"]);
  // 参照検証の基準は対象ウェビナーの account_id。可視性は middleware 済みだが、
  // ここで行を取り直して参照先の所属アカウントを確実にこの値へ固定する。
  const webinar = await getWebinarById(c.env.DB, c.req.param('id'));
  if (!webinar) return c.json({ success: false, error: 'Not found' }, 404);
  if (await countInvalidWebinarActionReferences(c.env.DB, webinar.account_id, actions) > 0) {
    return inputError(c, { success: false, error: 'invalid_action_reference' }, 422, ["actions"]);
  }
  const saved = await replaceWebinarActions(c.env.DB, c.req.param('id'), actions);
  return c.json({ success: true, data: saved.map(serializeWebinarAction) });
};

export const get__api_webinars_id_comments_5 = async (c: Context<Env, "/api/webinars/:id/comments">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const comments = await getWebinarComments(c.env.DB, id);
  return c.json({
    success: true,
    data: comments.map((cm) => ({
      id: cm.id, atSeconds: cm.at_seconds, authorName: cm.author_name, body: cm.body,
    })),
  });
};

export const put__api_webinars_id_comments_6 = async (c: Context<Env, "/api/webinars/:id/comments">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ comments?: unknown }>();
  if (!Array.isArray(body.comments)) {
    return inputError(c, { success: false, error: 'comments_required' }, 400, ["comments"]);
  }
  if (body.comments.length > SAKURA_COMMENTS_MAX) {
    return inputError(c, { success: false, error: 'too_many_comments' }, 400, ["comments"]);
  }
  const cleaned: Array<{ atSeconds: number; authorName: string; body: string }> = [];
  for (const raw of body.comments as Array<Record<string, unknown>>) {
    const atSeconds = Math.floor(Number(raw?.atSeconds));
    const authorName = typeof raw?.authorName === 'string' ? raw.authorName.trim() : '';
    const text = typeof raw?.body === 'string' ? raw.body.trim() : '';
    // 負の atSeconds = 開始前 (待機ルーム) コメント。-1h まで許容
    if (
      !Number.isFinite(atSeconds) || atSeconds < COMMENT_MIN_AT_SECONDS ||
      !authorName || authorName.length > 50 ||
      !text || text.length > COMMENT_MAX
    ) {
      return inputError(c, { success: false, error: 'invalid_comment' }, 400, ["comments"]);
    }
    cleaned.push({ atSeconds, authorName, body: text });
  }
  const count = await replaceWebinarComments(c.env.DB, id, cleaned);
  return c.json({ success: true, data: { count } });
};

export const get__api_webinars_id_ctas_7 = async (c: Context<Env, "/api/webinars/:id/ctas">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const ctas = await getWebinarCtas(c.env.DB, id);
  return c.json({
    success: true,
    version: row.cta_version ?? 0,
    updatedBy: row.cta_updated_by ?? null,
    updatedAt: row.cta_updated_at ?? null,
    data: ctas.map((ct) => ({
      id: ct.id,
      atSeconds: ct.at_seconds,
      kind: ct.kind,
      title: ct.title,
      body: ct.body,
      buttonLabel: ct.button_label,
      autoOpen: Boolean(ct.auto_open),
      formId: ct.form_id,
      url: ct.url,
    })),
  });
};

export const put__api_webinars_id_ctas_8 = async (c: Context<Env, "/api/webinars/:id/ctas">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{ ctas?: unknown; expectedVersion?: unknown }>();
  if (body.expectedVersion !== undefined && (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0)) {
    return inputError(c, { success: false, error: 'invalid_expected_version' }, 400, ["expectedVersion"]);
  }
  const expectedVersion = body.expectedVersion === undefined ? row.cta_version ?? 0 : Number(body.expectedVersion);
  if (expectedVersion !== (row.cta_version ?? 0)) return c.json({ success: false, error: 'version_conflict', currentVersion: row.cta_version ?? 0, updatedBy: row.cta_updated_by ?? null, updatedAt: row.cta_updated_at ?? null }, 409);
  if (!Array.isArray(body.ctas)) {
    return inputError(c, { success: false, error: 'ctas_required' }, 400, ["ctas"]);
  }
  if (body.ctas.length > 20) {
    return inputError(c, { success: false, error: 'too_many_ctas' }, 400, ["ctas"]);
  }
  const cleaned: Array<{
    atSeconds: number; kind: 'form' | 'url'; title: string; body: string | null;
    buttonLabel: string; autoOpen: boolean; formId: string | null; url: string | null;
  }> = [];
  const formIdsToCheck = new Set<string>();
  for (const raw of body.ctas as Array<Record<string, unknown>>) {
    const atSeconds = Math.floor(Number(raw?.atSeconds));
    const kind = raw?.kind;
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    const bodyText = typeof raw?.body === 'string' ? raw.body.trim() : '';
    const buttonLabel = typeof raw?.buttonLabel === 'string' ? raw.buttonLabel.trim() : '';
    const formId = typeof raw?.formId === 'string' && raw.formId ? raw.formId : null;
    const url = typeof raw?.url === 'string' && raw.url ? raw.url.trim() : null;
    if (
      !Number.isFinite(atSeconds) || atSeconds < 0 ||
      (kind !== 'form' && kind !== 'url') ||
      !title || title.length > 100 ||
      bodyText.length > 300 ||
      !buttonLabel || buttonLabel.length > 50
    ) {
      return inputError(c, { success: false, error: 'invalid_cta' }, 400, ["ctas"]);
    }
    if (kind === 'form') {
      if (!formId) return inputError(c, { success: false, error: 'form_id_required' }, 400, ["ctas"]);
      formIdsToCheck.add(formId);
    } else if (!url || !/^https:\/\//.test(url)) {
      return inputError(c, { success: false, error: 'invalid_url' }, 400, ["ctas"]);
    }
    cleaned.push({
      atSeconds, kind, title, body: bodyText || null, buttonLabel,
      autoOpen: Boolean(raw?.autoOpen),
      formId: kind === 'form' ? formId : null,
      url: kind === 'url' ? url : null,
    });
  }
  const forms = await Promise.all(
    [...formIdsToCheck].map((fid) => getFormById(c.env.DB, fid)),
  );
  if (forms.some((f) => !f)) {
    return inputError(c, { success: false, error: 'form_not_found' }, 400, ["ctas"]);
  }
  if (forms.some((f) => f && !f.is_active)) {
    return inputError(c, { success: false, error: 'form_inactive' }, 400, ["ctas"]);
  }
  if (
    formIdsToCheck.size > 0 &&
    (!row.account_id || !(await Promise.all(
      [...formIdsToCheck].map((formId) =>
        formBelongsToLineAccount(c.env.DB, formId, row.account_id!),
      ),
    )).every(Boolean))
  ) {
    return inputError(c, { success: false, error: 'form_account_mismatch' }, 400, ["ctas"]);
  }
  const count = await replaceWebinarCtas(c.env.DB, id, cleaned, { expectedVersion, updatedBy: c.get('staff').id });
  if (count === null) return c.json({ success: false, error: 'version_conflict' }, 409);
  return c.json({ success: true, data: { count, version: expectedVersion + 1 } });
};

export const get__api_webinars_id_analytics_9 = async (c: Context<Env, "/api/webinars/:id/analytics">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  // 個人の視聴履歴(participants)はオーナー・管理者だけ。staff には
  // summary/daily/dropoff などの集計だけ返し、個人配列は取りに行かない。
  const staff = c.get('staff');
  const canSeeIndividuals = staff?.role === 'owner' || staff?.role === 'admin' || staff?.hqRole === 'operator';
  const completionThreshold = Math.max(1, Math.floor(row.duration_seconds * 0.9));
  const [sessions, dropoff, participants, summary, daily, formFunnel, viewSegments, editor, retention, startedViewers, heartbeatRejects, ctas] = await Promise.all([
    getWebinarSessionStats(c.env.DB, id),
    getWebinarDropoff(c.env.DB, id),
    canSeeIndividuals
      ? getWebinarParticipantStats(c.env.DB, id, 200)
      : Promise.resolve<WebinarParticipantStat[]>([]),
    getWebinarAnalyticsSummary(c.env.DB, id, completionThreshold),
    getWebinarDailyStats(c.env.DB, id),
    getWebinarFormFunnelStats(c.env.DB, id),
    getWebinarViewSegmentCoverage(c.env.DB, id),
    getWebinarEditorSettings(c.env.DB, id),
    // J : 維持率の線・視聴開始（有効区間30秒以上）・異常の除外件数
    getWebinarRetention(c.env.DB, id),
    countWebinarStartedViewers(c.env.DB, id),
    countWebinarHeartbeatRejects(c.env.DB, id),
    // J-1: 申し込みボタンが出た時刻に縦の線を引く
    getWebinarCtas(c.env.DB, id),
  ]);
  const ctaAtSeconds = ctas.length === 0
    ? null
    : Math.min(...ctas.map((cta) => cta.at_seconds));
  return c.json({
    success: true,
    data: {
      summary: {
        reservations: summary.reservations,
        viewers: summary.viewers,
        registeredAndJoined: summary.registered_and_joined,
        watched5m: summary.watched_5m,
        watched15m: summary.watched_15m,
        completed: summary.completed,
        avgWatchedSeconds: summary.avg_watched_seconds,
        ctaClicks: summary.cta_clicks,
        formSubmissions: summary.form_submissions,
      },
      daily: daily.map((d) => ({
        date: d.stat_date,
        reservations: d.reservations,
        viewers: d.viewers,
        ctaClicks: d.cta_clicks,
        formSubmissions: d.form_submissions,
      })),
      participants: participants.map((p) => ({
        friendId: p.friend_id,
        friendName: p.friend_name,
        pictureUrl: p.picture_url,
        sessions: p.sessions,
        firstJoinedAt: p.first_joined_at,
        latestJoinedAt: p.latest_joined_at,
        maxWatchedSeconds: p.max_watched_seconds,
        ctaClickedAt: p.cta_clicked_at,
        registered: Boolean(p.registered),
        formSubmittedAt: p.form_submitted_at,
      })),
      sessions: sessions.map((s) => ({
        sessionStartAt: s.session_start_at,
        viewers: s.viewers,
        avgWatchedSeconds: s.avg_watched_seconds,
        ctaClicks: s.cta_clicks,
      })),
      dropoff: dropoff.map((d) => ({ bucketStart: d.bucket_start, viewers: d.viewers })),
      viewSegments: viewSegments.map((segment) => ({
        startSeconds: segment.start_seconds,
        endSeconds: segment.end_seconds,
        viewers: Number(segment.viewers),
      })),
      // J : J-1「どこまで見られたか」の線と3つの数字の材料
      retention: {
        bucketSeconds: retention.bucketSeconds,
        started: retention.started,
        points: retention.points.map((point) => ({
          atSeconds: point.at_seconds,
          viewers: point.viewers,
        })),
      },
      startedViewers,
      heartbeatRejects,
      ctaAtSeconds,
      measurement: editor?.delivery_kind === 'external'
        ? { state: 'unavailable', reason: '外部動画では個人の視聴区間を取得できません' }
        : viewSegments.length > 0
          ? { state: 'available', reason: null }
          : { state: 'unavailable', reason: '実視聴区間がまだ記録されていません' },
      formFunnel: {
        ctaImpressions: formFunnel.cta_impressions,
        ctaClicks: formFunnel.cta_clicks,
        formOpens: formFunnel.form_opens,
        formStarts: formFunnel.form_starts,
        submitAttempts: formFunnel.submit_attempts,
        submitSuccesses: formFunnel.submit_successes,
        submitErrors: formFunnel.submit_errors,
        fieldCompletions: formFunnel.field_completions.map((field) => ({
          fieldName: field.field_name,
          users: field.users,
        })),
      },
    },
  });
};

export const get__api_webinars_id_participants_10 = async (c: Context<Env, "/api/webinars/:id/participants">) => {
  const id = c.req.param('id');
  const filterRaw = c.req.query('filter');
  if (filterRaw !== undefined && !WEBINAR_PARTICIPANT_FILTERS.has(filterRaw as WebinarParticipantClassification)) {
    return c.json({ success: false, error: 'invalid_filter' }, 400);
  }
  const classification = (filterRaw ?? null) as WebinarParticipantClassification | null;
  const limit = Math.min(200, Math.max(1, listQueryNumber(c.req.query('limit'), 50) || 50));
  const offset = Math.max(0, listQueryNumber(c.req.query('cursor'), 0) || 0);
  const [webinar, measurement] = await Promise.all([
    getWebinarById(c.env.DB, id),
    webinarParticipantMeasurement(c.env.DB, id),
  ]);
  if (!webinar) return c.json({ success: false, error: 'Not found' }, 404);
  const completionThresholdSeconds = Math.max(1, Math.floor(webinar.duration_seconds * 0.9));
  const rows = await getWebinarParticipantOperations(c.env.DB, id, limit + 1, offset, {
    durationSeconds: webinar.duration_seconds,
    completionThresholdSeconds,
    measured: measurement.measured,
    classification,
  });
  const hasNext = rows.length > limit;
  return c.json({
    success: true,
    data: buildCursorListResponse({ items: rows.slice(0, limit).map((row) => ({
        friendId: row.friend_id,
        friendName: row.friend_name,
        pictureUrl: row.picture_url,
        sessions: Number(row.sessions),
        firstJoinedAt: row.first_joined_at || null,
        latestJoinedAt: row.latest_joined_at || null,
        maxWatchedSeconds: Number(row.max_watched_seconds),
        ctaClickedAt: row.cta_clicked_at,
        registered: Boolean(row.registered),
        formSubmittedAt: row.form_submitted_at,
        actionStatus: row.action_status,
        errorDetail: row.action_error,
        staffIntegrationStatus: row.integration_status,
        classification: classifyWebinarParticipant(row, {
          measured: measurement.measured,
          completionThresholdSeconds,
        }),
        liveSessions: Number(row.live_sessions),
        replaySessions: Number(row.replay_sessions),
        lastJoinKind: row.last_join_kind,
      })),
      nextCursor: hasNext ? String(offset + limit) : null,
      // 分類の根拠を応答へ載せ、画面側が推測で別ルールを作らないようにする。
      measurement: measurement.measured
        ? { state: 'available' as const, reason: null }
        : { state: 'unavailable' as const, reason: measurement.reason },
      rule: {
        completionThresholdSeconds,
        durationSeconds: webinar.duration_seconds,
      }, paging: { limit }, sort: [] }),
  });
  };

export const get__api_webinars_id_participants_csv_11 = async (c: Context<Env, "/api/webinars/:id/participants.csv">) => {
    const id = c.req.param('id');
    const filterRaw = c.req.query('filter');
    if (filterRaw !== undefined && !WEBINAR_PARTICIPANT_FILTERS.has(filterRaw as WebinarParticipantClassification)) {
      return c.json({ success: false, error: 'invalid_filter' }, 400);
    }
    const classification = (filterRaw ?? null) as WebinarParticipantClassification | null;
    const [webinar, measurement] = await Promise.all([
      getWebinarById(c.env.DB, id),
      webinarParticipantMeasurement(c.env.DB, id),
    ]);
    if (!webinar) return c.json({ success: false, error: 'Not found' }, 404);
    const completionThresholdSeconds = Math.max(1, Math.floor(webinar.duration_seconds * 0.9));
    // 申込だけで入場していない人も含めて書き出す（未参加の絞り込み先に使える）。
    const participants = await getWebinarParticipantOperations(c.env.DB, id, 10_000, 0, {
      durationSeconds: webinar.duration_seconds,
      completionThresholdSeconds,
      measured: measurement.measured,
      classification,
    });
    c.set('outputAudit', { count: participants.length, accountId: webinar.account_id ?? undefined, targetId: id });
    const rows = participants.map((participant) => [
      participant.friend_name ?? '',
      participant.first_joined_at,
      participant.latest_joined_at,
      participant.max_watched_seconds,
      participant.registered ? '申込あり' : '申込なし',
      participant.cta_clicked_at ? 'クリック済み' : '未クリック',
      participant.form_submitted_at ? '送信済み' : '未送信',
      WEBINAR_CLASSIFICATION_LABELS[classifyWebinarParticipant(participant, {
        measured: measurement.measured,
        completionThresholdSeconds,
      })],
      participant.live_sessions,
      participant.replay_sessions,
    ].map(csvCell).join(','));
    const csv = [
      ['参加者', '初回視聴', '最終視聴', '最大視聴秒数', '申込', 'CTA', 'フォーム', '分類', 'ライブ参加回数', '録画視聴回数'].map(csvCell).join(','),
      ...rows,
    ].join('\r\n');
    auditLog(c, 'webinar.participant.export', { kind: 'webinar', id });
    // ファイル名に埋める id は英数・-_だけ残す。引用符・改行入りで応答頭が壊れるのを防ぐ。
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, '') || 'webinar';
    return new Response(`\uFEFF${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="webinar-${safeId}-participants.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  };

export const get__api_webinars_id_user_comments_12 = async (c: Context<Env, "/api/webinars/:id/user-comments">) => {
  const id = c.req.param('id');
  const row = await getWebinarById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  const items = await getWebinarUserComments(c.env.DB, id);
  return c.json({
    success: true,
    data: items.map((cm) => ({
      id: cm.id,
      friendId: cm.friend_id,
      friendName: cm.friend_name ?? null,
      pictureUrl: cm.picture_url ?? null,
      sessionStartAt: cm.session_start_at,
      atSeconds: cm.at_seconds,
      body: cm.body,
      createdAt: cm.created_at,
    })),
  });
};
