import { restaurantWaitlistVariables,restaurantConfirmationVariables } from '../../services/restaurant-followup-delivery-variables.js';
export type { ScenarioSourceJob } from './source-job-types.js';
import type { ScenarioSourceJob } from './source-job-types.js';
import { scheduleRestaurantAnniversaries, restaurantAnniversaryState } from '../../services/restaurant-anniversary-followup.js';
import { parseBroadcastMessageParts } from '../broadcasts/broadcast-message-set/index.js';
import { reservationInstant } from '@line-crm/shared';
import { getLineAccountById, getFriendById, parseScenarioVersionSteps, activeTenantLineAccountSql, isOperationCapabilityStopped, type ScenarioVersion } from '@line-crm/db';

import type { Message } from '@line-crm/line-sdk';
import type { Env } from '../../worker-env.js';
import { dbFor } from '../../services/db-router.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import { restaurantTestEnabled } from '../../lib/environment-features.js';
import { expandVariables, resolveMetadata, buildMessage } from '../../services/step-delivery.js';
import { resolveSendInterpolationExtra } from '../../services/interpolation-context.js';
import { decorateForFriendPush } from '../../services/auto-track.js';
import { pushViaHarnessProxy } from '../../services/line-proxy-send.js';
import { dispatchLineProxyLocally } from '../../services/local-line-proxy.js';
import { deterministicLogId } from '../../routes/line-proxy.js';
import { getSendPermissionForAccount } from '../../services/send-entitlements.js';
import { formatStartsAtForStore } from '../booking/booking-notifier/index.js';
interface SourceState {
    store_id: string;
    trigger: string;
    template_version: number;
    starts_at: string;
    status: string;
    departed_at: string | null;
    customer_version: number;
    line_uid: string;
    ends_at: string;
    guest_count: number;
    course_name: string | null;
    store_name: string;
    hold_expires_at?: string;
    event_payload: string;
    timezone: string;
    approved_version_id: string;
}
/** 同じ予約でも結果通知・来店確認・退店後を区別。旧通知を注意の改版で落とさない。 */
async function sourceState(db: D1Database, j: ScenarioSourceJob): Promise<SourceState | null> {
    if(j.source_kind==='restaurant_anniversary')return restaurantAnniversaryState(db,j);
    const sql = `SELECT t.store_id,b.trigger,t.template_version,s.timezone,t.approved_version_id,
  e.payload_json event_payload,r.starts_at,r.status,r.departed_at,r.customer_version,r.line_uid,r.ends_at,r.guest_count,s.name store_name,
  (SELECT name FROM rt_menu_items m WHERE m.id=r.course_id AND m.store_id=r.store_id) course_name
  FROM rt_store_followup_templates t JOIN rt_stores s ON s.id=t.store_id
  JOIN scenarios sc ON sc.id=t.scenario_id AND sc.line_account_id=s.line_account_id
  JOIN scenario_versions v ON v.id=t.approved_version_id AND v.scenario_id=t.scenario_id AND v.status='published'
  JOIN rt_approval_requests a ON a.id=t.approval_id AND a.status='approved'
  JOIN rt_store_followup_step_bindings b ON b.store_id=t.store_id AND b.enabled=1
  JOIN rt_reservation_events e ON e.id=? AND e.store_id=s.id
  JOIN rt_reservations r ON r.id=? AND r.store_id=s.id
  JOIN friends f ON f.id=? AND f.line_account_id=s.line_account_id AND f.line_platform_user_id=r.line_uid AND f.is_following=1
  JOIN line_accounts la ON la.id=s.line_account_id AND la.is_active=1 AND la.archived_at IS NULL
  WHERE NOT EXISTS(SELECT 1 FROM rt_store_followup_targets ft WHERE ft.store_id=b.store_id AND ft.trigger=b.trigger AND ft.engine!='scenario') AND t.sending_status='active' AND s.status='active' AND s.line_account_id=?
  AND t.approved_version_id=? AND sc.current_published_version_id=t.approved_version_id
  AND json_extract(a.payload_json,'$.templateVersion')=t.template_version
  AND json_extract(a.payload_json,'$.scenarioVersionId')=t.approved_version_id
  AND json_extract(a.payload_json,'$.lineAccountId')=s.line_account_id
  AND EXISTS(SELECT 1 FROM json_each(v.steps_snapshot) st WHERE json_extract(st.value,'$.live_step_id')=b.step_id AND json_extract(st.value,'$.version_step_id')=?)
  AND ${activeTenantLineAccountSql('la.id')}`;
    if (j.source_kind === 'restaurant_reservation') {
        const r = await db.prepare(sql).bind(j.source_event_id, j.source_id, j.friend_id, j.line_account_id, j.scenario_version_id, j.step_id).first<SourceState>();
        if (!r || ['cancelled', 'no_show', 'pending'].includes(r.status))
            return null;
        const captured = JSON.parse(r.event_payload) as {
            startsAt: string;
            endsAt: string;
            guestCount: number;
        };
        if (instantMs(captured.startsAt) !== instantMs(r.starts_at) || instantMs(captured.endsAt) !== instantMs(r.ends_at) || captured.guestCount !== r.guest_count)
            return null;
        if (['reservation_24h', 'reservation_2h'].includes(r.trigger) && (r.status !== 'confirmed' || instantMs(r.starts_at) <= Date.now()))
            return null;
        if (['post_visit', 'review_request'].includes(r.trigger) && !r.departed_at)
            return null;
        // 予定の変更・取消・退店の訂正は元の仕事を無効にする。注意・来店だけの改版は結果通知を保つ。
        if (await db.prepare(`SELECT 1 FROM rt_reservation_events WHERE reservation_id=? AND reservation_version>?
    AND (event_type IN('restaurant.reservation.cancelled','restaurant.departure_undone') OR json_extract(payload_json,'$.scheduleChanged')=1)`).bind(j.source_id, j.source_version).first())
            return null;
        if (r.trigger === 'reservation_24h') {
            const prior = await db.prepare('SELECT reservation_version FROM rt_reservation_confirmations WHERE request_id=?').bind(j.id).first<{
                reservation_version: number;
            }>();
            if (prior && prior.reservation_version !== r.customer_version)
                return null;
        }
        return r;
    }
    if (j.source_kind === 'restaurant_waitlist') {
        const waitSql = sql.replace('r.departed_at,r.customer_version,r.line_uid', "NULL departed_at,0 customer_version,r.line_uid,r.hold_expires_at").replace('(SELECT name FROM rt_menu_items m WHERE m.id=r.course_id AND m.store_id=r.store_id)', "NULL").replace('JOIN rt_reservations r', 'JOIN rt_seat_waitlist r');
        const r = await db.prepare(waitSql).bind(j.source_event_id, j.source_id, j.friend_id, j.line_account_id, j.scenario_version_id, j.step_id).first<SourceState>();
        return r?.trigger === 'waitlist_invited' && r.status === 'invited' && instantMs(r.hold_expires_at!) > Date.now() ? r : null;
    }
    return null;
}
export type SourceJobSend = (env: Env['Bindings'], job: ScenarioSourceJob, messages: Message[]) => Promise<void>;
const defaultSend: SourceJobSend = async (env, j, messages) => {
    const account = await getLineAccountById(dbFor(env), j.line_account_id, env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    if (!await sourceState(dbFor(env), j))
        throw new Error('source_changed');
    if (!account?.channel_access_token)
        throw new Error('account_unavailable');
    const friend = await getFriendById(dbFor(env), j.friend_id);
    if (!friend)
        throw new Error('friend_unavailable');
    await pushViaHarnessProxy(env.WORKER_PUBLIC_URL || env.WORKER_URL || 'https://worker.invalid', account.channel_access_token, friend.line_user_id, messages, j.idempotency_key, req => dispatchLineProxyLocally(req, env));
};
/** 共通の公開版・差し込み・メッセージ組立・計測・Harness経路を使用する。 */
export async function processScenarioSourceJobs(env: Env['Bindings'], send: SourceJobSend = defaultSend) {
    if (!restaurantTestEnabled(env))
        return 0;
    const db = dbFor(env);
    await scheduleRestaurantAnniversaries(db);
    let sent = 0;
    const jobs = (await db.prepare(`SELECT * FROM scenario_source_jobs WHERE source_kind IN('restaurant_reservation','restaurant_waitlist','restaurant_anniversary')
  AND status IN('pending','running','failed') AND attempt_count<50 AND julianday(scheduled_at)<=julianday(?)
  AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?)) ORDER BY scheduled_at LIMIT 50`).bind(new Date().toISOString(), new Date().toISOString()).all<ScenarioSourceJob>()).results;
    for (const j of jobs) {
        const lease = new Date(Date.now() + 5 * 60000).toISOString();
        if (!(await db.prepare(`UPDATE scenario_source_jobs SET status='running',attempt_count=attempt_count+1,lease_until=?
   WHERE id=? AND status IN('pending','running','failed') AND attempt_count<50 AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?))`).bind(lease, j.id, new Date().toISOString()).run()).meta.changes)
            continue;
        try {
            const state = await sourceState(db, j);
            // LINE retry-keyの24時間より後は不明な送信を再実行せず止める。
            if (!state || Date.now() - instantMs(j.scheduled_at) >= 24 * 60 * 60000) {
                await db.prepare("UPDATE scenario_source_jobs SET status='cancelled',lease_until=NULL WHERE id=? AND lease_until=?").bind(j.id, lease).run();
                continue;
            }
            if (!(await getSendPermissionForAccount(db, j.line_account_id)).allowed || await isOperationCapabilityStopped(db, j.line_account_id, 'broadcast_dispatch') || !await featureJobCanRun(db, { accountId: j.line_account_id, featureId: 'restaurant_test', job: 'LINE来店フォロー' }))
                throw new Error('sending_stopped');
            const v = await db.prepare('SELECT * FROM scenario_versions WHERE id=?').bind(j.scenario_version_id).first<ScenarioVersion>();
            const step = v && parseScenarioVersionSteps(v).find(s => s.id === j.step_id && !s.is_draft);
            if (!step)
                throw new Error('step_unavailable');
            const friend = await getFriendById(db, j.friend_id);
            if (!friend)
                throw new Error('friend_unavailable');
            if (state.trigger === 'waitlist_invited' && !/^https:\/\//.test(env.LIFF_URL ?? ''))
                throw new Error('liff_unavailable');
            const vars: Record<string, string> = state.trigger==='anniversary_before' ? {store_name:state.store_name,anniversary_date:formatStartsAtForStore(reservationInstant(state.starts_at),state.timezone)} : { reservation_end: formatStartsAtForStore(reservationInstant(state.ends_at), state.timezone), guest_count: String(state.guest_count), course_name: state.course_name ?? '席のみ', store_name: state.store_name, reservation_datetime: formatStartsAtForStore(reservationInstant(state.starts_at), state.timezone),
                ...(j.source_kind==='restaurant_waitlist'?await restaurantWaitlistVariables(db,j.line_account_id,j.source_id,env.LIFF_URL):{}),
                restaurant_going: `rc:${j.id}:going`, restaurant_change: `rc:${j.id}:change_requested`, restaurant_cancel: `rc:${j.id}:cancel` };
            // 公開版の吹き出しだけを順番どおりに展開する。下書きは読み直さない。
            const parts = parseBroadcastMessageParts({ messageType: step.message_type, messageContent: step.message_content, messageBubblesJson: step.message_bubbles_json });
            const metadata = await resolveMetadata(db, friend as never);
            const messages: Message[] = [];
            for (const part of parts) {
                const scanned = part.messageContent.replace(/\{\{\s*var\.([a-z][a-z0-9_]*)\s*\}\}/g, (m, key: string) => key in vars ? '' : m);
                const extra = await resolveSendInterpolationExtra(db, friend.id, scanned, { kind: 'scenario', id: j.id });
                const content = expandVariables(part.messageContent, { ...friend, metadata } as never, env.WORKER_PUBLIC_URL, part.messageType, { ...extra, vars: { ...extra.vars, ...vars }, deliveredAt: new Date() });
                const tracked = await decorateForFriendPush(db, part.messageType, content, env.WORKER_PUBLIC_URL, { lineAccountId: j.line_account_id, friendId: j.friend_id, sourceContent: part.messageContent });
                messages.push(buildMessage(tracked.messageType, tracked.content));
            }
            // 返事の依頼はこの予約版で固定し、再試行は同じID・押し口を使う。
            if (state.trigger === 'reservation_24h')await restaurantConfirmationVariables(db,j.id,{
              ...state,reservation_id:j.source_id,line_account_id:j.line_account_id,friend_id:j.friend_id,
            },new Date().toISOString());
            const logId = await deterministicLogId(`line-proxy-send:${j.idempotency_key}:${j.friend_id}:0`);
            // 応答喪失のあともログが残れば再送しない。ログ無しなら同じretry keyで回収。
            if (!await db.prepare('SELECT id FROM messages_log WHERE id=?').bind(logId).first()) {
                const latest = await sourceState(db, j);
                const owned = await db.prepare("SELECT 1 FROM scenario_source_jobs WHERE id=? AND status='running' AND lease_until=? AND julianday(lease_until)>julianday(?)").bind(j.id, lease, new Date().toISOString()).first();
                if (!latest || latest.template_version !== state.template_version || !owned)
                    throw new Error('source_changed');
                if (state.trigger === 'reservation_24h' && latest.customer_version !== state.customer_version)
                    throw new Error('source_changed');
                await send(env, j, messages);
            }
            if (j.source_kind === 'restaurant_waitlist')
                await db.prepare("UPDATE rt_seat_waitlist SET notified_at=?,notification_claim_until=NULL WHERE id=? AND notification_retry_key=? AND status='invited'").bind(new Date().toISOString(), j.source_id, j.idempotency_key).run();
            if ((await db.prepare("UPDATE scenario_source_jobs SET status='sent',lease_until=NULL,message_log_id=? WHERE id=? AND lease_until=? AND status='running'").bind(logId, j.id, lease).run()).meta.changes)
                sent++;
        }
        catch {
            await db.prepare("UPDATE scenario_source_jobs SET status='failed',lease_until=? WHERE id=? AND status='running' AND lease_until=?").bind(new Date(Date.now() + 60000).toISOString(), j.id, lease).run();
        }
    }
    return sent;
}
function instantMs(value: string): number { return Date.parse(reservationInstant(value)); }
