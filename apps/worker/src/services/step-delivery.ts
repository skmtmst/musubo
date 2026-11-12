import { jstCalendar as japanCalendar } from '@line-crm/shared';
export { messageToLogPayload } from './message-log-payload.js';
import { messageToLogPayload } from './message-log-payload.js';
export { expandVariables } from './message-interpolation.js';
import { expandVariables } from './message-interpolation.js';
import { logger } from '@line-crm/shared/server';
import { resolveMetadata } from './step-metadata.js';
export { resolveMetadata } from './step-metadata.js';
import { isFriendDeliverySuppressed } from '@line-crm/db/src/friend-delivery-consents.js';
import { createBroadcastRetryKey } from '../features/broadcasts/broadcast-retry-key/index.js';
import { reserveOutboundSend, hashOutboundPayload, completeOutboundSendStatement } from './outbound-idempotency.js';
import { decorateTapExtras } from './tap-extra-links.js';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
// メッセージの組み立ては一斉配信と共有する。ここからも取れるようにしておく（呼び出し側が多い）。
import { buildMessage } from './line-message.js';
export { buildMessage };
import { resolveSendInterpolationExtra } from './interpolation-context.js';
import {
  getFriendScenariosDueForDelivery,
  getStepsForDelivery,
  advanceFriendScenario,
  completeFriendScenario,
  pauseFriendScenario,
  claimFriendScenarioForDelivery,
  recoverStuckDeliveries,
  pauseFriendScenarioDelivery,
  getFriendById,
  jstNow,
  computeNextDeliveryAt,
  scenarioStepExists,
  addTagToFriend,
  type DeliveryMode,
  type Friend,
  listLineAccountsWithTenantStatus,
  recordSkippedDelivery,
} from '@line-crm/db';
import { isOperationCapabilityStopped } from '@line-crm/db';


import type { LineClient } from '@line-crm/line-sdk';
import { isStoppedTenantStatus } from './tenant-runtime-status.js';
import type { Message } from '@line-crm/line-sdk';
import { jitterDeliveryTime, addJitter, sleep } from './stealth.js';
import { getSendPermissionForAccount, type SendPermissionCache } from './send-entitlements.js';
import { matchesCondition, parseCondition } from './segment-query.js';
import { runScenarioActions, resumePreviousScenario, runScenarioOp, type RunActionRowsOptions } from '../features/scenarios/scenario-actions/index.js';
import { featureJobCanRun } from './feature-enforcement.js';

import { parseQuestion, buildQuestionMessages } from '../features/scenarios/scenario-question/index.js';
import { expandDateVariables } from './interpolation-date.js';

const MAX_SENDS_PER_CRON = 40; // Cloudflare 無料枠の50問い合わせに対し、ほかの処理の余裕を残す。
const MAX_ATTEMPTS_PER_CRON = 40; // 条件による省略や失敗も CPU と D1 を使うため、処理予算に含める。

export function getLineApiErrorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^LINE API error:\s+(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

export function isPermanentLineDeliveryError(err: unknown): boolean {
  const status = getLineApiErrorStatus(err);
  return status !== null && status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

export async function processStepDeliveries(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
  credentialKey?: string,
): Promise<void> {
  const accountsWithStatus = await listLineAccountsWithTenantStatus(db);
  const tenantStatusByAccount = new Map(
    accountsWithStatus.map((account) => [account.id, account.tenant_status]),
  );
  // アカウントの稼働状態（X-1）。止めているアカウントの配信は
  // 「送らなかった」として pause して一覧に残す。
  const activeByAccount = new Map(
    accountsWithStatus.map((account) => [account.id, Boolean(account.is_active)]),
  );
  // 中断した delivering は active だけの取得で取り残されるため、5分後に実行権を回復する。送信予約は同じ LINE キーを使い、24時間超の結果不明は人の確認へ残す。
  const recovered = await recoverStuckDeliveries(db);
  if (recovered > 0) {
    logger.warn("services_step_delivery_warn");
  }

  const now = jstNow();
  const sendPermissions: SendPermissionCache = new Map();
  const dueFriendScenarios = await getFriendScenariosDueForDelivery(
    db,
    now,
    MAX_ATTEMPTS_PER_CRON,
  );

  let sendCount = 0;
  let attemptCount = 0;
  for (let i = 0; i < dueFriendScenarios.length; i++) {
    if (sendCount >= MAX_SENDS_PER_CRON || attemptCount >= MAX_ATTEMPTS_PER_CRON) break;
    const fs = dueFriendScenarios[i];
    attemptCount++;
    try {
      // 機能オフ中はclaimせずactiveのまま残す。再オンで再開する。
      // アカウント未割当の旧行は持ち主が分からないため従来どおり進める。
      const ownerRow = await db
        .prepare(`SELECT line_account_id FROM scenarios WHERE id = ?`)
        .bind(fs.scenario_id)
        .first<{ line_account_id: string | null }>();
      if (
        ownerRow?.line_account_id
        && activeByAccount.get(ownerRow.line_account_id) === false
      ) {
        // アカウント停止中（X-1）。claim せず、送らなかった記録を残して
        // 配列から外す。再開後も自動では送り直さない（pause で止める）。
        try {
          await recordSkippedDelivery(db, {
            lineAccountId: ownerRow.line_account_id,
            kind: 'scenario_step',
            refId: fs.id,
            title: `friend_scenario:${fs.scenario_id}`,
          });
        } catch (skipError) {
          logger.error("step_delivery.record_feature_skip_failed");
        }
        await db.prepare(
          `UPDATE friend_scenarios
              SET confirmation_revision = confirmation_revision + 1, status = 'paused', pause_reason = 'account_inactive',
                  next_delivery_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'active'`,
        ).bind(now, fs.id).run();
        continue;
      }
      if (ownerRow?.line_account_id && isStoppedTenantStatus(tenantStatusByAccount.get(ownerRow.line_account_id))) {
        // 停止中の期限到達は一時停止し、復旧後に古い通知を自動送信しない。
        await db.prepare(
          `UPDATE friend_scenarios
              SET confirmation_revision = confirmation_revision + 1, status = 'paused', pause_reason = 'tenant_suspended',
                  next_delivery_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'active'`,
        ).bind(now, fs.id).run();
        continue;
      }
      if (ownerRow?.line_account_id && !await featureJobCanRun(db, { accountId: ownerRow.line_account_id, featureId: 'scenarios', job: 'scenario deliveries' })) {
        continue;
      }
      // 緊急停止 : scenario_dispatch が止まっている統括は claim せず
      // active のまま残す。復旧すれば next_delivery_at を過ぎた分から順に届く。
      // アカウント未割当の旧行はグローバル停止 (*) だけに従う。
      if (await isOperationCapabilityStopped(db, ownerRow?.line_account_id ?? null, 'scenario_dispatch')) {
        continue;
      }
      // 短時間の集中を避けるため、配信間に小さいランダム遅延を入れる。
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }
      const sent = await processSingleDelivery(db, lineClient, fs, workerUrl, sendPermissions, credentialKey);
      if (sent) sendCount++;
    } catch (err) {
      logger.error("step_delivery.deliver_step_failed");
      // 不正宛先・本文・チャネルなどの恒久4xxは無限に回復しない。408/409/429は一時失敗として既存の5分回復を保つ。
      if (isPermanentLineDeliveryError(err)) {
        await pauseFriendScenarioDelivery(db, fs.id);
        logger.warn("step_delivery.deliver_permanent_failed");
      }
      // Continue with next one.
    }
  }
}

/** 同じアカウントの購読はその友だちを使い、UUID 連携ならシナリオ所属側の友だちへ解決する。follow 前の所属なしはその文脈のトークンで1回試し、恒久4xxなら停止する。明示的な別所属に連携先がなければ既定トークンで送らない。 */
export async function resolveScenarioDeliveryFriend(
  db: D1Database,
  enrolledFriend: Friend,
  scenarioAccountId: string | null,
): Promise<Friend | null> {
  if (!scenarioAccountId || enrolledFriend.line_account_id === scenarioAccountId) {
    return enrolledFriend;
  }

  if (enrolledFriend.user_id) {
    const linked = await db
      .prepare(
        `SELECT * FROM friends
         WHERE user_id = ? AND line_account_id = ?
         ORDER BY is_following DESC, updated_at DESC
         LIMIT 1`,
      )
      .bind(enrolledFriend.user_id, scenarioAccountId)
      .first<Friend>();
    if (linked) return linked.is_following ? linked : null;
  }

  return enrolledFriend.line_account_id === null ? enrolledFriend : null;
}

async function processSingleDelivery(
  db: D1Database,
  lineClient: LineClient,
  fs: {
    id: string;
    friend_id: string;
    scenario_id: string;
    current_step_order: number;
    status: string;
    next_delivery_at: string | null;
    published_version_id?: string | null;
    started_at: string;
  },
  workerUrl?: string,
  sendPermissions?: SendPermissionCache,
  credentialKey?: string,
): Promise<boolean> {
  // 課金の状態（トライアル終了・解約）で配信が止まっている統括は送らない。
  // 予約は触らず（claim もしない）、次の cron でまた確かめる。プランを選べば続きから届く。
  const scenarioAccount = await db
    .prepare('SELECT line_account_id FROM scenarios WHERE id = ?')
    .bind(fs.scenario_id)
    .first<{ line_account_id: string | null }>();
  const permission = await getSendPermissionForAccount(db, scenarioAccount?.line_account_id ?? null, sendPermissions);
  if (!permission.allowed) return false;

  // 並行 Worker の二重送信を防ぐため、楽観ロックで実行権を取る。
  const claimed = await claimFriendScenarioForDelivery(db, fs.id, fs.current_step_order);
  if (!claimed) return false;

  const enrolledFriend = await getFriendById(db, fs.friend_id);
  if (!enrolledFriend) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // アカウント固定のシナリオは、その所属の本人とトークンを使うため delivery_mode と一緒に取得する。
  const scenarioRow = await db
    .prepare(
      `SELECT delivery_mode, line_account_id, audience_condition_json,
              on_complete_mode, on_complete_scenario_id
         FROM scenarios WHERE id = ?`,
    )
    .bind(fs.scenario_id)
    .first<{
      delivery_mode: DeliveryMode;
      line_account_id: string | null;
      audience_condition_json: string | null;
      on_complete_mode: string | null;
      on_complete_scenario_id: string | null;
    }>();
  if (!scenarioRow) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  const friend = await resolveScenarioDeliveryFriend(
    db,
    enrolledFriend,
    scenarioRow.line_account_id,
  );
  if (!friend) {
    await pauseFriendScenarioDelivery(db, fs.id);
    logger.warn("step_delivery.resolve_friend_failed");
    return false;
  }
  if (await isFriendDeliverySuppressed(db, friend.id)) {
    await pauseFriendScenarioDelivery(db, fs.id);
    return false;
  }
  if (!friend.is_following) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  // 開始後の編集を混ぜないよう、購読に固定した公開版だけを読む。版がなければ live へ戻らず停止する。下書きの通は先に除き、次の公開通をそのまま探せるようにする。
  const source = await getStepsForDelivery(db, fs.scenario_id, fs.published_version_id ?? null);
  if (!source) {
    await pauseFriendScenarioDelivery(db, fs.id);
    logger.warn("step_delivery.resolve_published_steps_failed");
    return false;
  }
  const steps = source.steps.filter((s) => (s.is_draft ?? 0) === 0);
  if (steps.length === 0) {
    await completeFriendScenario(db, fs.id);
    return false;
  }

  /*
   * シナリオ全体の配信対象。
   *
   * 購読したあとに条件から外れることがある（タグを外した、対応マークが
   * 変わった等）。外れた人には**送らずに止める**。完了にしないのは、
   * 条件に戻ったときに人が再開できるようにするため。
   */
  const audience = parseCondition(source.audienceConditionJson);
  if (source.audienceConditionJson && !audience) {
    logger.error("step_delivery.parse_audience_failed");
    await pauseFriendScenarioDelivery(db, fs.id);
    return false;
  }
  if (audience && !(await matchesCondition(db, fs.friend_id, audience))) {
    await pauseFriendScenarioDelivery(db, fs.id);
    return false;
  }

  // computeNextDeliveryAt は「JST clock-time を UTC として表現する Date」前提
  // (setHours/getDate が JST clock 通りに動くようにオフセット済みの Date)。
  // fs.started_at は "+09:00" 付き ISO で本物の UTC instant として parse されるため、
  // +9h ずらして JST clock-time 表現に揃える必要がある。
  const enrolledAtDate = japanCalendar(new Date(new Date(fs.started_at).getTime()));
  const nowJstDate = japanCalendar();
  const nextDeliveryFor = (step: { delay_minutes: number; offset_days: number | null; offset_minutes: number | null; delivery_time: string | null }): Date =>
    computeNextDeliveryAt(
      { delivery_mode: source.deliveryMode },
      step,
      { enrolledAt: enrolledAtDate, previousDeliveredAt: nowJstDate, now: nowJstDate },
    );
  // 終了後の処理も固定した版の値で決める。開始後に変えた値は次版の購読から使う。
  const onComplete = {
    on_complete_mode: source.onCompleteMode,
    on_complete_scenario_id: source.onCompleteScenarioId,
  };

  // 通番は削除で飛ぶ場合があるため、現在の値より大きい最初の通を選ぶ。
  const currentStep = steps.find((s) => s.step_order > fs.current_step_order);

  if (!currentStep) {
    await finishScenario(db, fs.id, fs.scenario_id, fs.friend_id, onComplete, {executorDependencies:{credentialEncryptionKey:credentialKey}});
    return false;
  }


  if (currentStep.condition_type) {
    const conditionMet = await evaluateCondition(db, fs.friend_id, currentStep);
    if (!conditionMet) {
      if (currentStep.next_step_on_false !== null && currentStep.next_step_on_false !== undefined) {
        const jumpStep = steps.find((s) => s.step_order === currentStep.next_step_on_false);
        if (jumpStep) {
          const jitteredDate = jitterDeliveryTime(nextDeliveryFor(jumpStep));
          // 次の取得で指定した遷移先を選ぶため、その直前の通番まで進める。現在通のままでは順番の次へ送ってしまう。
          await advanceFriendScenario(db, fs.id, jumpStep.step_order - 1, jitteredDate.toISOString().slice(0, -1) + '+09:00');
          return false;
        }
      }
      const nextIndex = steps.indexOf(currentStep) + 1;
      if (nextIndex < steps.length) {
        const nextStep = steps[nextIndex];
        const jitteredDate = jitterDeliveryTime(nextDeliveryFor(nextStep));
        await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
      } else {
        await completeFriendScenario(db, fs.id);
      }
      return false;
    }
  }

  /*
   * 1通ごとの配信対象。
   *
   * 対象から外れている人には、この通だけ送らずに次へ進める。止めないのは、
   * 「今回はこの人向けではない」だけであって、シナリオそのものを降りた
   * わけではないため。Lステップの「配信対象の絞り込み」と同じ扱い。
   */
  const stepTarget = parseCondition(currentStep.target_condition_json);
  if (currentStep.target_condition_json && !stepTarget) {
    logger.error("step_delivery.parse_step_target_failed");
  }
  const stepTargeted = currentStep.target_condition_json
    ? stepTarget
      ? await matchesCondition(db, fs.friend_id, stepTarget)
      : false
    : true;
  if (!stepTargeted) {
    const skipIndex = steps.indexOf(currentStep) + 1;
    if (skipIndex < steps.length) {
      const jitteredDate = jitterDeliveryTime(nextDeliveryFor(steps[skipIndex]));
      await advanceFriendScenario(
        db,
        fs.id,
        currentStep.step_order,
        jitteredDate.toISOString().slice(0, -1) + '+09:00',
      );
    } else {
      await finishScenario(db, fs.id, fs.scenario_id, fs.friend_id, onComplete, {executorDependencies:{credentialEncryptionKey:credentialKey}});
    }
    return false;
  }

  // 実際に配信するアカウント。リンクの所有アカウント計算
  // (下の decorateForFriendPush 呼び出し)と同じ値を使う。
  const friendAccountId = friend.line_account_id;
  const deliveryAccountId = scenarioRow.line_account_id ?? friendAccountId;

  // 通の文面・質問は公開時に確定した写しを使う（351）。配信時に templates 表を
  // 読み直さないので、公開後の template 編集は固定済みの購読へ混入しない。
  //
  // テンプレートの公開版をシナリオの持ち主アカウントだけで解決するのは、
  // 公開時の写し作り（packages/db/src/scenarios.ts の版snapshot）へ移した。
  // 配信時にはもう templates 表を読まないので、ここでは解決しない。
  const resolved = {
    messageType: currentStep.message_type,
    messageContent: currentStep.message_content,
    templateIdAtSend: currentStep.template_id_at_send ?? null,
    questionJson: currentStep.question_json ?? null,
  };


  const resolvedMeta = await resolveMetadata(db, friend);
  const friendWithMeta = { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1];
  // 質問の前文・選択肢文にも expandVariables が効くので、共通情報の
  // 厳格スキャンは本文と質問JSONを合わせた全体で行う。
  const extra = await resolveSendInterpolationExtra(
    db, friend.id,
    `${resolved.messageContent}\n${resolved.questionJson ?? ''}`,
    { kind: 'scenario', id: fs.id },
  );
  /*
   * 日付の差し込みの起点は「いま」。
   *
   * 予定時刻ではなく実際に配る時刻を使う。cron は5分刻みなので予定から
   * 数分ずれることがあり、深夜0時前後の配信で予定と実際の日付が割れる。
   * 相手が受け取った日と、本文に書かれた日は合っていないといけない。
   */
  const expandedContent = expandVariables(
    resolved.messageContent,
    friendWithMeta,
    workerUrl,
    resolved.messageType,
    { ...extra, deliveredAt: new Date() },
  );
  // 即時初回文と同じ計測リンク・署名付き本人情報の加工を使い、リンク所有者を実際の送信アカウントへ合わせる。
  const { decorateForFriendPush } = await import('./auto-track.js');
  const tracked = await decorateForFriendPush(db, resolved.messageType, expandedContent, workerUrl, {
    lineAccountId: deliveryAccountId ?? null,
    friendId: friend.id,
    sourceContent: resolved.messageContent,
  });
  /*
   * 質問メッセージなら、本文の代わりに選択肢つきのメッセージを組み立てる。
   *
   * 前文があるぶん複数通になるので、以降は配列で扱う。差し込みは前文にも
   * 効かせたいので、質問の組み立ては差し込みのあとに置いている。
   */
  // live 側の通IDは履歴づけの控え。消されたあとは版所有の通IDに倒す。
  // 質問の回答受け・アクション・ログの突き合わせは、live が残っている間は
  // 従来どおり live の通IDで行う。
  const liveStepId = (await scenarioStepExists(db, currentStep.live_step_id ?? null))
    ? currentStep.live_step_id!
    : null;
  const question = parseQuestion(resolved.questionJson);
  const messages: Message[] = question
    ? buildQuestionMessages(
        {
          ...question,
          intro: question.intro
            ? expandVariables(question.intro, friendWithMeta, workerUrl, 'text', extra)
            : question.intro,
          text: expandVariables(question.text, friendWithMeta, workerUrl, 'text', extra),
        },
        // 押し口は、どちらの通IDを載せたかが分かる形で渡す。
        //
        // 文字列で渡すと `toQuestionStepRef` が無条件に旧形（下書きの通ID）
        // として扱う。下書きを消したあとは版所有の通ID（`<版ID>:<通番>`）が
        // 入るので、旧形として送ると受信側の `parseQuestionPostback` が
        // 「旧形にコロンは入らない」で弾き、押しても無反応になる。
        // 下書き削除後も配信が続くのはこの票で新しく作った振る舞いなので、
        // その経路の押し口もここで揃える。
        liveStepId
          ? { kind: 'live' as const, stepId: liveStepId }
          : { kind: 'version' as const, stepId: currentStep.id },
      )
    : [buildMessage(tracked.messageType, tracked.content)];
  if (question && JSON.stringify(messages).includes('\"tapExtras\"')) {
    const decorated = await decorateTapExtras(db, messages, workerUrl || '', deliveryAccountId ?? null);
      const { appendFriendToTrackedLinks } = await import('./auto-track.js');
      const personalized = JSON.parse(await appendFriendToTrackedLinks(db, JSON.stringify(decorated), workerUrl || '', friend.id));
    messages.splice(0, messages.length, ...(personalized as Message[]));
  }
  // 別アカウントの送信を防ぐため、友だちの所属に合う LINE クライアントを使う。
  let deliveryClient = lineClient;
  if (deliveryAccountId) {
    const { getLineAccountById } = await import('@line-crm/db');
    const account = await getLineAccountById(db, deliveryAccountId, credentialKey);
    if (!account) {
      await pauseFriendScenarioDelivery(db, fs.id);
      logger.warn("step_delivery.resolve_account_failed");
      return false;
    }
    const { LineClient: LC } = await import('@line-crm/line-sdk');
    deliveryClient = new LC(account.channel_access_token);
  }
  // 実行・友だち・固定版の通・開始時刻から同じUUIDを作る。
  // 再開で変わる予定時刻や文面をキーへ混ぜない。
  const sendKey = await createBroadcastRetryKey('scenario-step', fs.id, friend.id, currentStep.id, fs.started_at);
  const previous = await db.prepare(`SELECT status,created_at FROM outbound_send_requests WHERE idempotency_key=?`)
    .bind(sendKey).first<{status:string;created_at:string}>();
  if (previous && previous.status !== 'succeeded'
      && (!Number.isFinite(Date.parse(previous.created_at)) || Date.now()-Date.parse(previous.created_at) >= 24*60*60_000)) {
    const at = new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE outbound_send_requests SET status='unknown',failure_code='LINE_RETRY_KEY_EXPIRED',
        retryable=0,next_retry_at=NULL,last_failed_at=?,updated_at=?,lease_token=NULL,lease_expires_at=NULL
        WHERE idempotency_key=? AND status!='succeeded'`).bind(at,at,sendKey),
      db.prepare(`UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status='paused',pause_reason='delivery_unconfirmed',updated_at=? WHERE id=? AND status='delivering'`).bind(jstNow(),fs.id),
    ]);
    return false;
  }
  const reservation = await reserveOutboundSend(db, {
    key:sendKey,channel:'line',resourceId:`scenario-step:${fs.id}:${currentStep.id}`,
    lineAccountId:deliveryAccountId,payloadHash:await hashOutboundPayload(JSON.stringify(messages)),
    retryInProgress:true,now:new Date().toISOString(),
  });
  if (reservation.kind === 'conflict' || reservation.kind === 'unknown' || reservation.kind === 'failed') {
    await db.prepare(`UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status='paused',pause_reason='delivery_unconfirmed',updated_at=? WHERE id=? AND status='delivering'`).bind(jstNow(),fs.id).run();
    return false;
  }
  if (reservation.kind === 'in_progress') return false;
  if (reservation.kind !== 'replay') {
    await deliveryClient.pushMessage(friend.line_user_id, messages, sendKey);
    // 台帳のresponse_idは内部の受理記録ID。LINE要求IDを捏造しない。
    // 履歴と受理記録を同じbatchで残し、回復時は外へ送り直さず進行だけ続ける。
    await db.batch([
      ...messages.map((sent,index) => {
        const payload = messageToLogPayload(sent);
        return db.prepare(`INSERT OR IGNORE INTO messages_log
          (id,friend_id,direction,message_type,content,broadcast_id,scenario_step_id,scenario_version_step_id,source,template_id_at_send,line_account_id,created_at)
          VALUES (?,?,'outgoing',?,?,NULL,?,?,'scenario',?,?,?)`)
          .bind(`scenario:${sendKey}:${index}`,friend.id,payload.messageType,payload.content,liveStepId,currentStep.id,resolved.templateIdAtSend,deliveryAccountId,jstNow());
      }),
      completeOutboundSendStatement(db,{key:sendKey,responseId:`scenario:${sendKey}`,now:new Date().toISOString()}),
    ]);
  }


  const currentIndex = steps.indexOf(currentStep);
  const nextStep = currentIndex + 1 < steps.length ? steps[currentIndex + 1] : null;

  /*
   * この通に「送信後 一時停止」が付いていたら、次へ進めずに止める。
   *
   * 体調の記録をお願いして返事を待つ、といった流れで要る。止めておけば、
   * 返事が来てから人が再開できる。列が無かったころは送ったら必ず次へ進み、
   * 返事を待つあいだにも次の通が届いていた。
   *
   * 止めるのは送ったあと。送る前に止めると、この通そのものが届かない。
   */
  if ((currentStep.after_send ?? 'continue') === 'pause') {
    await pauseFriendScenario(db, fs.id, currentStep.step_order);
  } else if (nextStep) {
    const jitteredDate = jitterDeliveryTime(nextDeliveryFor(nextStep));
    await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
  } else {

    await finishScenario(db, fs.id, fs.scenario_id, fs.friend_id, onComplete, {executorDependencies:{credentialEncryptionKey:credentialKey}});
  }

  // 到達タグ付与 (advance / complete の後 = 再送が起きてもタグ付与は影響しない順序)
  // 失敗してもログに残すだけで配信フローは止めない。
  if (currentStep.on_reach_tag_id) {
    try {
      await addTagToFriend(db, friend.id, currentStep.on_reach_tag_id);
    } catch (err) {
      logger.error("step_delivery.attach_reach_tag_failed");
    }
  }

  /*
   * この通に紐づくアクション。
   *
   * 進行を決めたあとに動かす。先に動かすと、アクションが購読を止めたのに
   * そのあとの advance が起こして、止めたつもりが進む。
   *
   * 失敗しても配信フローは止めない（runScenarioActions が中で握りつぶす）。
   */
  await runScenarioActions(db, {
    scenarioId: fs.scenario_id,
    hook: 'step_sent',
    friendId: friend.id,
    stepId: liveStepId ?? currentStep.id,
    accountId: deliveryAccountId,
    sourceEventId: `scenario-step:${fs.id}:${currentStep.id}:${fs.next_delivery_at}`,
    executorDependencies: {resolveLineAccessToken:async()=> 'existing-client',createLineClient:()=>deliveryClient},
  });

  return true;
}

/**
 * 最終コンテンツを配り終えたあとの処理。
 *
 * Lステップの「最終コンテンツ配信後の処理」にあたる。
 *   pause           … 止める（これまでと同じ）
 *   resume_previous … 割り込む前に読んでいたシナリオへ戻す
 *   move            … 別のシナリオへ移す
 *
 * どれを選んでいても、まず完了にしてからアクションを動かす。完了にする前に
 * 別シナリオへ移すと、並行を許さない設定のときに「まだ読んでいる」と見なされて
 * 移動そのものが弾かれる。
 */
export async function finishScenario(
  db: D1Database,
  enrollmentId: string,
  scenarioId: string,
  friendId: string,
  scenario: { on_complete_mode: string | null; on_complete_scenario_id: string | null },
  runtime: RunActionRowsOptions = {},
): Promise<void> {
  const mode = scenario.on_complete_mode ?? 'pause';

  await completeFriendScenario(db, enrollmentId);

  try {
    if (mode === 'resume_previous') {
      await resumePreviousScenario(db, friendId, scenarioId);
    } else if (mode === 'move' && scenario.on_complete_scenario_id) {
      await runScenarioOp(db, friendId, scenarioId, {
        op: 'start',
        scenarioId: scenario.on_complete_scenario_id,
        restart: 'from_start',
      });
    }
  } catch (err) {
    logger.error("step_delivery.start_completion_scenario_failed");
  }

  await runScenarioActions(db, {
    scenarioId,
    hook: 'scenario_completed',
    friendId,
    ...runtime,
    sourceEventId: `scenario-complete:${enrollmentId}`,
  });
}

/** 配信時に評価できる、シナリオの条件種別。 */
export const SUPPORTED_CONDITION_TYPES = [
  'tag_exists',
  'tag_not_exists',
  'metadata_equals',
  'metadata_not_equals',
] as const;
export type ConditionType = (typeof SUPPORTED_CONDITION_TYPES)[number];

export function isSupportedConditionType(value: unknown): value is ConditionType {
  return typeof value === 'string' && (SUPPORTED_CONDITION_TYPES as readonly string[]).includes(value);
}

/** 条件なしは通常配信、条件ありで値なし・未知の種類・不正 JSON は省略して記録する。空の条件値を全員一致と解釈して過剰配信しないよう、有効な組だけを評価する。 */
export async function evaluateCondition(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  // 条件自体が設定されていなければ通常どおり配信する。
  if (!step.condition_type) return true;

  if (!isSupportedConditionType(step.condition_type)) {
    logger.error("step_delivery.validate_condition_type_failed");
    return false;
  }

  if (!step.condition_value) {
    logger.error("step_delivery.validate_condition_value_failed");
    return false;
  }

  switch (step.condition_type) {
    case 'tag_exists': {
      const tag = await db
        .prepare(
          `SELECT 1 FROM friend_tags ft
           INNER JOIN friends tagged_friend ON tagged_friend.id = ft.friend_id
           WHERE ft.tag_id = ?
             AND (
               tagged_friend.id = ?
               OR tagged_friend.user_id = (
                 SELECT user_id FROM friends WHERE id = ? AND user_id IS NOT NULL
               )
             )
           LIMIT 1`,
        )
        .bind(step.condition_value, friendId, friendId)
        .first();
      return !!tag;
    }
    case 'tag_not_exists': {
      const tag = await db
        .prepare(
          `SELECT 1 FROM friend_tags ft
           INNER JOIN friends tagged_friend ON tagged_friend.id = ft.friend_id
           WHERE ft.tag_id = ?
             AND (
               tagged_friend.id = ?
               OR tagged_friend.user_id = (
                 SELECT user_id FROM friends WHERE id = ? AND user_id IS NOT NULL
               )
             )
           LIMIT 1`,
        )
        .bind(step.condition_value, friendId, friendId)
        .first();
      return !tag;
    }
    case 'metadata_equals':
    case 'metadata_not_equals': {
      let raw: unknown;
      try {
        raw = JSON.parse(step.condition_value);
      } catch {
        logger.error("step_delivery.parse_metadata_condition_failed");
        return false;
      }
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        typeof (raw as { key?: unknown }).key !== 'string' ||
        !('value' in (raw as Record<string, unknown>))
      ) {
        // 既存行や直接 INSERT された行で {"key":"x"} のように value が欠落しているケースは
        // friend.metadata[x] === undefined と比較されて「key 不在の全友だち」に一致する
        // (= 同じ OSS issue  の over-delivery を再現する) ので明示的にスキップする。
        logger.error("step_delivery.validate_metadata_condition_failed");
        return false;
      }
      const parsed = raw as { key: string; value: unknown };
      const friend = await db
        .prepare('SELECT user_id, metadata, line_account_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ user_id: string | null; metadata: string | null; line_account_id: string | null }>();
      const metadata = await resolveMetadata(db, {
        user_id: friend?.user_id ?? null,
        metadata: friend?.metadata ?? null,
        line_account_id: friend?.line_account_id ?? null,
      });
      const actual = metadata[parsed.key];
      return step.condition_type === 'metadata_equals'
        ? actual === parsed.value
        : actual !== parsed.value;
    }
  }
}
