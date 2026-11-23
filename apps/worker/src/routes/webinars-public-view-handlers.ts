import { recordKeyedWebinarComment } from '../services/webinar-comment-idempotency.js';
import { logger } from '@line-crm/shared/server';
import { isWebinarMissedInWindow, getWebinarWatchedSeconds } from '@line-crm/db';
import { inputError } from '../lib/input-errors.js';

import type { WebinarAudience } from '@line-crm/shared';
import { countRecentWebinarViewers, WEBINAR_AUDIENCE_WINDOW_SECONDS } from '../features/webinars/webinar-audience/index.js';
import { getWebinarComments, getWebinarCtas, upsertWebinarViewer, recordWebinarHeartbeat, parseWebinarHeartbeatPlayerState, recordWebinarCtaClick, recordWebinarFunnelEvent, insertWebinarUserComment, countSessionUserComments, getUpcomingWebinarRegistration, getWebinarRegistration, recordWebinarPickerOpen } from '@line-crm/db';
import { resolveWebinarCaller } from '../features/webinars/webinar-caller/index.js';
import { attachTagAndFireSideEffects } from '../features/friends/friend-tag-attach/index.js';
import { runWebinarTriggerActions } from '../features/webinars/webinar-action-runner/index.js';
import { recordConversionSourceEvent } from '@line-crm/db';
import { resolveSession, parseScheduleRules, upcomingSessions } from '../features/webinars/webinar-schedule/index.js';
import { sendWebinarRegistrationConfirmation } from '../features/webinars/webinar-reminders/index.js';
import { enqueueWebinarCompletedNotification, getWebinarNotificationSettings, registerWebinarSession } from '../features/webinars/webinar-notifications/index.js';
import { dispatchLineProxyLocally } from '../services/local-line-proxy.js';
import { signWebinarToken } from '../lib/webinar-token.js';
import { awardWebinarCtaMileage, awardWebinarPositionMileage } from '../features/webinars/webinar-mileage/index.js';
import type { Env } from '../worker-env.js';
import { nowEpoch, publicationWindowBlockReason, resolveWebinarDeliveryKind, onDemandSessionStartAt, TOKEN_GRACE_SECONDS, WAITING_ROOM_SECONDS, CURRENT_SESSION_JOIN_GRACE_SECONDS, COMMENT_MIN_AT_SECONDS, COMMENT_MAX, SESSION_COMMENT_LIMIT } from './webinars-definition.js';
import type { Context } from 'hono';

export const get__api_liff_webinars_slug_1 = async (c: Context<Env, "/api/liff/webinars/:slug">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const { webinar } = auth;

  const now = nowEpoch();
  // 公開開始前・終了後は顧客の入口で止める。予約済み本人が
  // 終わった回を専用リンクで開く録画視聴だけは例外として通す。
  if (publicationWindowBlockReason(webinar)) {
    const requestedRaw = c.req.query('sessionStartAt');
    const requestedStart = requestedRaw === undefined ? null : Number(requestedRaw);
    const replayReg =
      requestedStart !== null && Number.isInteger(requestedStart) && requestedStart > 0
        ? await getWebinarRegistration(c.env.DB, webinar.id, auth.friendId, requestedStart)
        : null;
    const replayEligible =
      replayReg !== null && requestedStart !== null &&
      now >= requestedStart + webinar.duration_seconds
      && await isWebinarMissedInWindow(c.env.DB, webinar.id, requestedStart, now);
    if (!replayEligible) return c.json({ error: 'not_found' }, 404);
  }
  // オンデマンドは枠を持たない。入場そのものを開始として録画の
  // 常設回を開く。申込の有無では止めない。
  if ((await resolveWebinarDeliveryKind(c.env.DB, webinar)) === 'on_demand') {
    const sessionStartAt = onDemandSessionStartAt(webinar, now);
    await upsertWebinarViewer(c.env.DB, webinar.id, auth.friendId, sessionStartAt);
    if (webinar.tag_on_attend) {
      c.executionCtx.waitUntil(
        Promise.resolve(
          attachTagAndFireSideEffects(c.env.DB, auth.friendId, webinar.tag_on_attend),
        ).catch((err) => logger.error("webinars.liff_webinars_slug_get_failed")),
      );
    }
    const exp = now + webinar.duration_seconds + TOKEN_GRACE_SECONDS;
    const token = await signWebinarToken(c.env.LINE_CHANNEL_SECRET, webinar.slug, exp);
    const [comments, ctas] = await Promise.all([
      getWebinarComments(c.env.DB, webinar.id),
      getWebinarCtas(c.env.DB, webinar.id),
    ]);
    return c.json({
      live: true,
      replay: true,
      title: webinar.title,
      durationSeconds: webinar.duration_seconds,
      sessionStartAt,
      offsetSeconds: 0,
      upcoming: [],
      registeredSessionAt: null,
      registeredForThisSession: true,
      playlistUrl: `/webinar-assets/${token}/${webinar.slug}/master.m3u8`,
      cta: webinar.cta_json ? (JSON.parse(webinar.cta_json) as unknown) : null,
      comments: comments.map((cm) => ({
        atSeconds: cm.at_seconds,
        authorName: cm.author_name,
        body: cm.body,
      })),
      ctas: ctas.map((ct) => ({
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
  }
  const rules = parseScheduleRules(webinar.schedule_json);
  const session = resolveSession(rules, webinar.duration_seconds, now);

  // 予約後に発行した専用リンクは sessionStartAt を含む。
  // LIFF で本人確認した上で、同じ webinar×friend×session の予約行が
  // 実在する場合だけ予約パスとして扱う。URL を転送しても他人は通らない。
  const requestedSessionRaw = c.req.query('sessionStartAt');
  const requestedSessionStartAt = requestedSessionRaw === undefined
    ? null
    : Number(requestedSessionRaw);
  const admissionReg =
    requestedSessionStartAt !== null &&
    Number.isInteger(requestedSessionStartAt) &&
    requestedSessionStartAt > 0
      ? await getWebinarRegistration(
          c.env.DB, webinar.id, auth.friendId, requestedSessionStartAt,
        )
      : null;

  // 配信終了後でも、専用リンクを持つ予約済み本人には
  // その回を先頭から再生する。アセットトークンは開くたびに再発行するため、
  // 見逃し配信を許可した期間内だけ入場できる。
  if (
    admissionReg &&
    requestedSessionStartAt !== null &&
    now >= requestedSessionStartAt + webinar.duration_seconds
    && await isWebinarMissedInWindow(c.env.DB, webinar.id, requestedSessionStartAt, now)
  ) {
    await upsertWebinarViewer(
      c.env.DB, webinar.id, auth.friendId, requestedSessionStartAt,
    );
    if (webinar.tag_on_attend) {
      c.executionCtx.waitUntil(
        Promise.resolve(
          attachTagAndFireSideEffects(c.env.DB, auth.friendId, webinar.tag_on_attend),
        ).catch((err) => logger.error("webinars.liff_webinars_slug_get_failed")),
      );
    }

    const exp = now + webinar.duration_seconds + TOKEN_GRACE_SECONDS;
    const token = await signWebinarToken(c.env.LINE_CHANNEL_SECRET, webinar.slug, exp);
    const [comments, ctas] = await Promise.all([
      getWebinarComments(c.env.DB, webinar.id),
      getWebinarCtas(c.env.DB, webinar.id),
    ]);
    return c.json({
      live: true,
      replay: true,
      title: webinar.title,
      durationSeconds: webinar.duration_seconds,
      sessionStartAt: requestedSessionStartAt,
      offsetSeconds: 0,
      upcoming: upcomingSessions(rules, webinar.duration_seconds, now, 48),
      registeredSessionAt: null,
      registeredForThisSession: true,
      playlistUrl: `/webinar-assets/${token}/${webinar.slug}/master.m3u8`,
      cta: webinar.cta_json ? (JSON.parse(webinar.cta_json) as unknown) : null,
      comments: comments.map((cm) => ({
        atSeconds: cm.at_seconds,
        authorName: cm.author_name,
        body: cm.body,
      })),
      ctas: ctas.map((ct) => ({
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
  }

  if (!session.live) {
    const reg = await getUpcomingWebinarRegistration(c.env.DB, webinar.id, auth.friendId, now);
    // 開始 WAITING_ROOM_SECONDS 前からは「待機ルーム」: 開始前サクラコメント
    // (負の at_seconds) を流すためのペイロードを返す。ハートビート・attend
    // タグ・再生トークンはライブ開始まで発行しない。未予約者は待機ルームへ
    // 直行させず、必ずセッション選択メニューを表示する。
    const next = session.nextSessionAt;
    if (
      next !== null &&
      next - now <= WAITING_ROOM_SECONDS &&
      reg?.session_start_at === next
    ) {
      const comments = await getWebinarComments(c.env.DB, webinar.id);
      return c.json({
        live: false,
        waiting: true,
        title: webinar.title,
        nextSessionAt: next,
        offsetSeconds: now - next,
        comments: comments.map((cm) => ({
          atSeconds: cm.at_seconds,
          authorName: cm.author_name,
          body: cm.body,
        })),
      });
    }
    // 30分間隔・24時間開催の1日分。クライアントは直近6件から段階表示し、
    // 48件を一度に並べて離脱を招かない。
    const upcoming = upcomingSessions(rules, webinar.duration_seconds, now, 48);
    if (!reg && upcoming.length > 0) {
      await recordWebinarPickerOpen(c.env.DB, webinar.id, auth.friendId);
    }
    return c.json({
      live: false,
      title: webinar.title,
      nextSessionAt: next,
      upcoming,
      registeredSessionAt: reg?.session_start_at ?? null,
    });
  }

  const [currentReg, liveReg] = await Promise.all([
    getWebinarRegistration(c.env.DB, webinar.id, auth.friendId, session.sessionStartAt!),
    getUpcomingWebinarRegistration(c.env.DB, webinar.id, auth.friendId, now),
  ]);
  const withinJoinGrace = (session.offsetSeconds ?? Infinity) <= CURRENT_SESSION_JOIN_GRACE_SECONDS;
  const liveUpcoming = upcomingSessions(rules, webinar.duration_seconds, now, 48);

  // 直リンクを含め、未予約者へは動画 URL / 再生トークンを返さない。
  // 開始5分以内だけ現在回を新規予約できる。一方、すでにこの回を
  // 予約済みの本人は、LIFF を閉じた後でも配信終了まで再入場できる。
  if (!currentReg) {
    const bookable = withinJoinGrace
      ? [session.sessionStartAt!, ...liveUpcoming].slice(0, 48)
      : liveUpcoming;
    if (!liveReg && bookable.length > 0) {
      await recordWebinarPickerOpen(c.env.DB, webinar.id, auth.friendId);
    }
    return c.json({
      live: false,
      title: webinar.title,
      nextSessionAt: bookable[0] ?? session.nextSessionAt,
      upcoming: bookable,
      registeredSessionAt: liveReg?.session_start_at ?? null,
    });
  }

  await upsertWebinarViewer(c.env.DB, webinar.id, auth.friendId, session.sessionStartAt!);
  if (webinar.tag_on_attend) {
    c.executionCtx.waitUntil(
      Promise.resolve(
        attachTagAndFireSideEffects(c.env.DB, auth.friendId, webinar.tag_on_attend),
      ).catch((err) => logger.error("webinars.liff_webinars_slug_get_failed")),
    );
  }

  const exp = session.sessionStartAt! + webinar.duration_seconds + TOKEN_GRACE_SECONDS;
  const token = await signWebinarToken(c.env.LINE_CHANNEL_SECRET, webinar.slug, exp);
  const [comments, ctas] = await Promise.all([
    getWebinarComments(c.env.DB, webinar.id),
    getWebinarCtas(c.env.DB, webinar.id),
  ]);

  return c.json({
    live: true,
    title: webinar.title,
    durationSeconds: webinar.duration_seconds,
    sessionStartAt: session.sessionStartAt,
    offsetSeconds: session.offsetSeconds,
    upcoming: liveUpcoming,
    registeredSessionAt: liveReg?.session_start_at ?? null,
    registeredForThisSession: true,
    playlistUrl: `/webinar-assets/${token}/${webinar.slug}/master.m3u8`,
    cta: webinar.cta_json ? (JSON.parse(webinar.cta_json) as unknown) : null,
    comments: comments.map((cm) => ({
      atSeconds: cm.at_seconds,
      authorName: cm.author_name,
      body: cm.body,
    })),
    ctas: ctas.map((ct) => ({
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

export const get__api_liff_webinars_slug_audience_2 = async (c: Context<Env, "/api/liff/webinars/:slug/audience">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const { webinar } = auth;
  if (publicationWindowBlockReason(webinar)) return c.json({ error: 'not_found' }, 404);
  const kind = await resolveWebinarDeliveryKind(c.env.DB, webinar);
  const now = nowEpoch();
  let sessionStartAt: number | null = null;
  if (kind === 'on_demand') {
    sessionStartAt = onDemandSessionStartAt(webinar, now);
  } else if (kind === 'scheduled') {
    const session = resolveSession(parseScheduleRules(webinar.schedule_json), webinar.duration_seconds, now);
    if (session.live && session.sessionStartAt !== null) {
      const registration = await getWebinarRegistration(c.env.DB, webinar.id, auth.friendId, session.sessionStartAt);
      if (registration) sessionStartAt = session.sessionStartAt;
    }
  }
  const data: WebinarAudience = {
    live: sessionStartAt !== null,
    sessionStartAt,
    viewerCount: sessionStartAt === null ? null
      : await countRecentWebinarViewers(c.env.DB, webinar.id, sessionStartAt, now),
    activeWindowSeconds: WEBINAR_AUDIENCE_WINDOW_SECONDS,
    lecturerName: null,
  };
  return c.json(data);
};

export const post__api_liff_webinars_slug_heartbeat_3 = async (c: Context<Env, "/api/liff/webinars/:slug/heartbeat">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const loaded = { webinar: auth.webinar };

  // J : 再生中だけ15秒ごとに送る。状態・速度・申告時刻も受け、
  // 受信はサーバー時刻基準で異常を除外する（recordWebinarHeartbeat）。
  const body = await c.req.json<{
    sessionStartAt?: unknown; positionSeconds?: unknown;
    playerState?: unknown; playbackRate?: unknown; clientAtMs?: unknown;
  }>();
  const sessionStartAt = Number(body.sessionStartAt);
  const positionSeconds = Math.floor(Number(body.positionSeconds));
  const playbackRate = body.playbackRate === undefined || body.playbackRate === null
    ? 1
    : Number(body.playbackRate);
  const clientAtMs = body.clientAtMs === undefined || body.clientAtMs === null
    ? null
    : Math.floor(Number(body.clientAtMs));
  if (
    !Number.isFinite(sessionStartAt) ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0 ||
    positionSeconds > loaded.webinar.duration_seconds + 60 ||
    !Number.isFinite(playbackRate) ||
    (clientAtMs !== null && !Number.isFinite(clientAtMs))
  ) {
    return inputError(c, { error: 'invalid_body' }, 422, ["sessionStartAt","positionSeconds","playbackRate","clientAtMs"]);
  }
  if (parseWebinarHeartbeatPlayerState(body.playerState) === null) {
    return inputError(c, { error: 'invalid_body' }, 422, ["playerState"]);
  }
  const at = nowEpoch();
  if (at >= sessionStartAt + loaded.webinar.duration_seconds) {
    const registration = await getWebinarRegistration(c.env.DB, loaded.webinar.id, auth.friendId, sessionStartAt);
    if (!registration || !await isWebinarMissedInWindow(c.env.DB, loaded.webinar.id, sessionStartAt, at)) return c.json({ error: 'not_found' }, 404);
  } else if (publicationWindowBlockReason(loaded.webinar)) return c.json({ error: 'not_found' }, 404);
  const heartbeat = await recordWebinarHeartbeat(c.env.DB, {
    webinarId: loaded.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    positionSeconds,
    playerState: parseWebinarHeartbeatPlayerState(body.playerState) ?? 'playing',
    playbackRate,
    clientAtMs,
  });
  if (heartbeat.status === 'rejected') {
    return c.json({ ok: true, counted: false, reason: heartbeat.reason });
  }
  c.executionCtx.waitUntil(awardWebinarPositionMileage(c.env.DB, {
    webinarId: loaded.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    positionSeconds,
    durationSeconds: loaded.webinar.duration_seconds,
  }));
  const watchedSeconds = heartbeat.status === 'recorded'
    ? await getWebinarWatchedSeconds(c.env.DB, loaded.webinar.id, auth.friendId, sessionStartAt) : 0;
  if (watchedSeconds >= Math.max(1, Math.ceil(loaded.webinar.duration_seconds * 0.9))) {
    c.executionCtx.waitUntil(enqueueWebinarCompletedNotification(
      c.env.DB,
      loaded.webinar.id,
      auth.friendId,
      sessionStartAt,
    ));
    // 視聴完了を成果計測へ接続する。同じ視聴の再送は冪等キーで1件にまとまる。
    c.executionCtx.waitUntil(recordConversionSourceEvent(c.env.DB, {
      sourceType: 'webinar_completed',
      lineAccountId: loaded.webinar.account_id,
      friendId: auth.friendId,
      sourceEventId: `${loaded.webinar.id}:${auth.friendId}:complete`,
      metadata: { webinarId: loaded.webinar.id, sessionStartAt },
    }).catch((err) => logger.error("webinars.liff_webinars_slug_heartbeat_post_failed")));
    // 保存した視聴後アクション（完了のきっかけ）を実行口へ接続する。
    // 同じ視聴の再送は実行記録の冪等キーで1件にまとまる。
    c.executionCtx.waitUntil(runWebinarTriggerActions(c.env.DB, {
      webinarId: loaded.webinar.id,
      friendId: auth.friendId,
      sessionStartAt,
      trigger: 'completed',
      executorDependencies: { credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY, operatorMailEnv: c.env },
    }).catch((err) => logger.error("webinars.liff_webinars_slug_heartbeat_post_failed")));
  }
  return c.json({ ok: true });
};

export const post__api_liff_webinars_slug_comments_4 = async (c: Context<Env, "/api/liff/webinars/:slug/comments">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const loaded = { webinar: auth.webinar };

  const body = await c.req.json<{
    sessionStartAt?: unknown; atSeconds?: unknown; body?: unknown; requestId?: unknown;
  }>();
  const sessionStartAt = Number(body.sessionStartAt);
  const atSeconds = Math.floor(Number(body.atSeconds));
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const requestId = body.requestId;
  if (
    !Number.isFinite(sessionStartAt) || !Number.isFinite(atSeconds) ||
    atSeconds < COMMENT_MIN_AT_SECONDS || text.length === 0 || text.length > COMMENT_MAX ||
    (requestId !== undefined && (typeof requestId !== 'string' || !/^u-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)))
  ) {
    return inputError(c, { error: 'invalid_body' }, 422, ["sessionStartAt","atSeconds","body"]);
  }
  // sessionStartAt はクライアント申告値。サーバー側で現在のセッションを再計算し、
  // ライブ外や偽装 sessionStartAt でのコメント投稿（60件上限バイパス含む）を防ぐ。
  // 待機ルーム中 (次回開始まで WAITING_ROOM_SECONDS 以内) は次回セッション帰属で
  // 負の atSeconds を受ける。
  const session = resolveSession(
    parseScheduleRules(loaded.webinar.schedule_json),
    loaded.webinar.duration_seconds,
    nowEpoch(),
  );
  // オンデマンドは枠を持たない。常設回への投稿だけ受ける。
  if ((await resolveWebinarDeliveryKind(c.env.DB, loaded.webinar)) === 'on_demand') {
    if (sessionStartAt !== onDemandSessionStartAt(loaded.webinar, nowEpoch())) {
      return c.json({ error: 'not_live' }, 409);
    }
  } else if (session.live) {
    if (sessionStartAt !== session.sessionStartAt) {
      return c.json({ error: 'not_live' }, 409);
    }
  } else {
    const next = session.nextSessionAt;
    const inWaitingRoom = next !== null && next - nowEpoch() <= WAITING_ROOM_SECONDS;
    if (!inWaitingRoom || sessionStartAt !== next) {
      return c.json({ error: 'not_live' }, 409);
    }
  }
  if (typeof requestId === 'string') {
    const result = await recordKeyedWebinarComment(c.env.DB, {
      webinarId: loaded.webinar.id, friendId: auth.friendId, sessionStartAt, atSeconds, body: text,
    }, requestId, SESSION_COMMENT_LIMIT);
    if (result === 'limit') return c.json({ error: 'too_many_comments' }, 429);
    if (result === 'conflict') return c.json({ error: 'comment_request_conflict' }, 409);
    return c.json({ ok: true });
  }
  const count = await countSessionUserComments(
    c.env.DB, loaded.webinar.id, auth.friendId, sessionStartAt,
  );
  if (count >= SESSION_COMMENT_LIMIT) {
    return c.json({ error: 'too_many_comments' }, 429);
  }
  await insertWebinarUserComment(c.env.DB, {
    webinarId: loaded.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    atSeconds,
    body: text,
  });
  return c.json({ ok: true });
};

export const post__api_liff_webinars_slug_register_5 = async (c: Context<Env, "/api/liff/webinars/:slug/register">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const loaded = { webinar: auth.webinar };
  const { webinar } = loaded;

  // 公開開始前・終了後は新しい申込を受けない（録画視聴の例外は作らない）。
  if (publicationWindowBlockReason(webinar)) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json<{ sessionStartAt?: unknown }>();
  const sessionStartAt = Number(body.sessionStartAt);
  const now = nowEpoch();
  // オンデマンドは枠を持たない。常設回への申込だけ受け、
  // 確認通知は送らない（入場そのものが開始のため）。
  if ((await resolveWebinarDeliveryKind(c.env.DB, webinar)) === 'on_demand') {
    const onDemandStart = onDemandSessionStartAt(webinar, now);
    if (!Number.isFinite(sessionStartAt) || sessionStartAt !== onDemandStart) {
      return inputError(c, { error: 'invalid_session' }, 400, ["sessionStartAt"]);
    }
    try {
      const registered = await registerWebinarSession(
        c.env.DB, webinar.id, auth.friendId, sessionStartAt,
      );
      return c.json({
        ok: true,
        sessionStartAt,
        rescheduled: registered.rescheduled,
        confirmationQueued: false,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'session_full') {
        return c.json({ error: 'session_full' }, 409);
      }
      throw err;
    }
  }
  const rules = parseScheduleRules(webinar.schedule_json);
  const session = resolveSession(rules, webinar.duration_seconds, now);
  const upcoming = upcomingSessions(rules, webinar.duration_seconds, now, 48);
  const currentIsBookable =
    session.live &&
    session.sessionStartAt === sessionStartAt &&
    (session.offsetSeconds ?? Infinity) <= CURRENT_SESSION_JOIN_GRACE_SECONDS;
  if (
    !Number.isFinite(sessionStartAt) ||
    (!currentIsBookable && !upcoming.includes(sessionStartAt))
  ) {
    return inputError(c, { error: 'invalid_session' }, 400, ["sessionStartAt"]);
  }
  let registered: Awaited<ReturnType<typeof registerWebinarSession>>;
  try {
    registered = await registerWebinarSession(
      c.env.DB,
      webinar.id,
      auth.friendId,
      sessionStartAt,
    );
  } catch (err) {
    // N: 定員は申込の時に確保する。満員なら申込を受けない。
    if (err instanceof Error && err.message === 'session_full') {
      return c.json({ error: 'session_full' }, 409);
    }
    throw err;
  }
  const notificationSettings = await getWebinarNotificationSettings(c.env.DB, webinar.id);
  const liffMatch = /liff\.line\.me\/([^/?]+)/.exec(c.env.LIFF_URL ?? '');
  if (registered.created && (notificationSettings?.registrationEnabled ?? true)) c.executionCtx.waitUntil(
    sendWebinarRegistrationConfirmation(
      c.env.DB,
      webinar,
      auth.friendId,
      sessionStartAt,
      {
        proxyBaseUrl: new URL(c.req.url).origin,
        defaultAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
        defaultLiffId: liffMatch?.[1] ?? null,
        proxyDispatch: (request) =>
          dispatchLineProxyLocally(request, c.env, c.executionCtx),
      },
      registered.registration.id,
      notificationSettings
        ? [
            notificationSettings.dayBeforeEnabled ? `前日${notificationSettings.dayBeforeTime}` : '',
            notificationSettings.hourBeforeEnabled ? `${notificationSettings.hourBeforeMinutes}分前` : '',
            notificationSettings.startEnabled ? '開始時' : '',
          ].filter(Boolean).join('・') || '設定した時刻'
        : '開始5分前',
    ),
  );
  return c.json({
    ok: true,
    sessionStartAt,
    rescheduled: registered.rescheduled,
    confirmationQueued: registered.created && (notificationSettings?.registrationEnabled ?? true),
  });
};

export const post__api_liff_webinars_slug_cta_click_6 = async (c: Context<Env, "/api/liff/webinars/:slug/cta-click">) => {
  const auth = await resolveWebinarCaller(c, c.req.param('slug'));
  if (auth instanceof Response) return auth;
  const loaded = { webinar: auth.webinar };

  const body = await c.req.json<{ sessionStartAt?: unknown; ctaId?: unknown }>();
  const sessionStartAt = Number(body.sessionStartAt);
  const ctaId = typeof body.ctaId === 'string' ? body.ctaId.slice(0, 128) : '';
  if (!Number.isFinite(sessionStartAt)) return inputError(c, { error: 'invalid_body' }, 422, ["sessionStartAt"]);

  if (ctaId) {
    const ctas = await getWebinarCtas(c.env.DB, loaded.webinar.id);
    if (!ctas.some((cta) => cta.id === ctaId)) {
      return inputError(c, { error: 'invalid_cta' }, 422, ["ctaId"]);
    }
  }

  await recordWebinarCtaClick(c.env.DB, loaded.webinar.id, auth.friendId, sessionStartAt);
  await recordWebinarFunnelEvent(c.env.DB, {
    webinarId: loaded.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    eventType: 'cta_click',
    ctaId,
  });
  c.executionCtx.waitUntil(awardWebinarCtaMileage(c.env.DB, {
    webinarId: loaded.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    ctaId,
  }));
  if (loaded.webinar.tag_on_cta_click) {
    c.executionCtx.waitUntil(
      Promise.resolve(
        attachTagAndFireSideEffects(
          c.env.DB, auth.friendId, loaded.webinar.tag_on_cta_click,
        ),
      ).catch((err) => logger.error("webinars.liff_webinars_slug_cta_click_post_failed")),
    );
  }
  // 保存した視聴後アクション（CTAクリックのきっかけ）を実行口へ接続する。
  c.executionCtx.waitUntil(runWebinarTriggerActions(c.env.DB, {
    webinarId: loaded.webinar.id,
    friendId: auth.friendId,
    sessionStartAt,
    trigger: 'cta_clicked',
    executorDependencies: { credentialEncryptionKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY, operatorMailEnv: c.env },
  }).catch((err) => logger.error("webinars.liff_webinars_slug_cta_click_post_failed")));
  return c.json({ ok: true });
};
