import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import { stableUuid } from './mileage-delivery-key.js';
import {
  accountFeatureOffExclusionSql,
  claimRedemptionStep,
  claimRedemptionStepForRecovery,
  clearRedemptionStepIntent,
  decryptCredential,
  findIncompleteMileageRefunds,
  getMileageRewardDeliveryPlan,
  getReservedMileageRewardCode,
  hasSentRedemptionSteps,
  markRedemptionStepSent,
  MILEAGE_REWARD_RETRY_KEY_VALIDITY_MS,
  MileageRedemptionConfirmError,
  MileageRewardError,
  recordMileageRedemptionAttempt,
  refundMileageRewardRedemption,
  type MileageRewardFailurePolicy,
  activeTenantLineAccountSql,
} from '@line-crm/db';

import { stoppedTenantLineAccountSql } from '../../services/tenant-runtime-status.js';
import { createAutomationActionExecutors } from '../automations/automation-action-executors/index.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import { resolveMileageSource } from '../../services/mileage-ec-source.js';
import { selectMileageAccountBatch } from '@line-crm/db/src/mileage/index.js';
import { AutomationActionError, type ActionDefinition } from '../automations/automation-engine/index.js';

export interface MileageRewardDeliveryOptions {
  credentialEncryptionKey?: string;
  fetch?: typeof fetch;
  now?: () => string;
}

export interface MileageRewardDeliveryResult {
  status: 'succeeded' | 'delivery_failed' | 'pending';
  rewardName: string;
  customerMessage: string;
  rewardCode: string | null;
  retryAt: string | null;
  failurePolicy: MileageRewardFailurePolicy;
  message: string | null;
}

function parseActions(raw: string | null): ActionDefinition[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('交換後の動きを読み込めませんでした'); }
  if (!Array.isArray(value)) throw new Error('交換後の動きを読み込めませんでした');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${index + 1}番目の交換後アクションが不正です`);
    const action = item as Record<string, unknown>;
    if (typeof action.id !== 'string' || typeof action.type !== 'string'
      || !action.params || typeof action.params !== 'object' || Array.isArray(action.params)) {
      throw new Error(`${index + 1}番目の交換後アクションが不正です`);
    }
    if (action.type === 'wait' || action.type === 'common_action') {
      throw new Error('待ち時間を含む交換後アクションは実行できません');
    }
    return {
      id: action.id,
      type: action.type,
      params: action.params as Record<string, unknown>,
      onFailure: action.onFailure === 'continue' ? 'continue' : 'stop',
    };
  });
}

function publicFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof AutomationActionError) {
    const permanent = new Set([
      'friend_required', 'friend_not_found', 'tag_not_found', 'scenario_not_found',
      'template_not_found', 'message_content_missing', 'rich_menu_not_found',
      'webhook_url_unsafe', 'idempotency_key_conflict',
    ]);
    return {
      code: error.code,
      message: permanent.has(error.code)
        ? '特典の設定を確認できないため、交換を完了できませんでした。運用者へお問い合わせください。'
        : '特典を渡せませんでした。時間をおいてもう一度お試しください。',
      retryable: error.retryable,
    };
  }
  return {
    code: 'reward_delivery_failed',
    message: '特典を渡せませんでした。時間をおいてもう一度お試しください。',
    retryable: true,
  };
}

function nextRetry(now: string, attemptCount: number): string | null {
  // 共通基盤 §6-2: 初回後は1分・5分・30分の3回まで。
  const delays = [1, 5, 30];
  if (attemptCount >= delays.length) return null;
  const date = new Date(now);
  date.setMinutes(date.getMinutes() + delays[attemptCount]);
  return date.toISOString();
}

/**
 * 取り残し配送の貸出期限。確定書き込みに失敗した交換は `delivering` のまま
 * 残し、この期限を過ぎたら別の試行が引き継ぐ。証言つきの手順は
 * 引き継いでも送り直さず、照合待ちに残す。
 */
const STALE_DELIVERY_LEASE_MS = 5 * 60 * 1000;

/** 一瞬の書き込み失敗は、その場で数回だけやり直す。長引く障害は待つ。 */
const CONFIRM_RETRIES = 3;

/**
 * 別の実行者が貸出を保持していて外部へ送っていない場合は、送信完了と区別する。
 * MileageRedemptionConfirmError と混ぜると事実と異なる応答を返し、delivering のまま失敗一覧から取り残すため、専用の合図で交換を元へ戻す。
 */
class RedemptionStepBusyError extends Error {
  constructor() {
    super('ほかの処理が同じ交換を送信中です');
    this.name = 'RedemptionStepBusyError';
  }
}

/**
 * 最初の送信から24時間を過ぎた手順の合図。
 * 同じキーで送り直すと LINE 側が新規受付して二重に届くので、
 * 送らず・確定もせず、人が確かめる照合待ちに残す。
 * 確定失敗と同じ扱い（失敗に落とさない・返却しない）。
 * db の親クラスは継承しない。最上位で参照すると db を mock した
 * 試験が読み込み時に落ちるため、Error 継承＋code・名前で見分ける。
 */
class RedemptionRetryKeyExpiredError extends Error {
  readonly code = 'retry_key_expired';
  constructor() {
    super('LINEの重複防止期限（24時間）を過ぎたため自動送信を止めました');
    this.name = 'RedemptionRetryKeyExpiredError';
  }
}

/**  の合図かどうか。code・名前でも見る。 */
function isRetryKeyExpiredError(error: unknown): error is RedemptionRetryKeyExpiredError {
  if (error instanceof RedemptionRetryKeyExpiredError) return true;
  return error instanceof Error
    && (error.name === 'RedemptionRetryKeyExpiredError'
      || (error as { code?: unknown }).code === 'retry_key_expired');
}

/**
 * 照合待ちの手順のうち、送り直しても安全な種類。
 * Webhook は受け先で二重に処理されるため、自動では回復しない。
 * タグ・属性・シナリオ・リッチメニューは何度実行しても同じ結果、
 * メッセージは同じキーで LINE 側が重複を防ぐ（期限内のみ）。
 */
function isRecoverableStepType(type: string): boolean {
  return type !== 'send_webhook';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 証言つき確定を数回試す。通らなければ照合待ちとして投げる。
 * DB障害の生エラーはここで確定失敗に包む。包まないと「失敗」扱いになり、
 * やり直しで送り直して二重に届く。
 */
async function confirmStepSentWithRetry(
  db: D1Database,
  input: { redemptionId: string; stepKey: string; owner: string; fenceToken: string; now: string },
): Promise<void> {
  for (let attempt = 0; attempt < CONFIRM_RETRIES; attempt += 1) {
    try {
      await markRedemptionStepSent(db, input);
      return;
    } catch {
      if (attempt + 1 < CONFIRM_RETRIES) await sleep(50 * (attempt + 1));
    }
  }
  throw new MileageRedemptionConfirmError();
}

/** 証言消しを数回試す。消せなければ照合待ちとして投げる(同上)。 */
async function clearStepIntentWithRetry(
  db: D1Database,
  input: { redemptionId: string; stepKey: string; owner: string; fenceToken: string; now: string },
): Promise<void> {
  for (let attempt = 0; attempt < CONFIRM_RETRIES; attempt += 1) {
    try {
      await clearRedemptionStepIntent(db, input);
      return;
    } catch {
      if (attempt + 1 < CONFIRM_RETRIES) await sleep(50 * (attempt + 1));
    }
  }
  throw new MileageRedemptionConfirmError();
}

export async function deliverMileageReward(
  db: D1Database,
  redemptionId: string,
  options: MileageRewardDeliveryOptions = {},
): Promise<MileageRewardDeliveryResult> {
  const plan = await getMileageRewardDeliveryPlan(db, redemptionId);
  // 手渡しの交換は店舗が確認するまで自動配送の対象にしない。
  if (plan.isHandgift) {
    const handgift = await db.prepare(
      'SELECT delivered_at, cancelled_at FROM mileage_handgifts WHERE redemption_id = ?',
    ).bind(redemptionId).first<{ delivered_at: string | null; cancelled_at: string | null }>();
    const delivered = Boolean(handgift?.delivered_at && !handgift.cancelled_at && plan.redemption.status === 'succeeded');
    return {
      status: delivered ? 'succeeded' : plan.redemption.status === 'refunded' || handgift?.cancelled_at ? 'delivery_failed' : 'pending', rewardName: plan.rewardName,
      customerMessage: plan.customerMessage, rewardCode: null, retryAt: null,
      failurePolicy: plan.failurePolicy,
      message: delivered ? null : plan.redemption.status === 'refunded' || handgift?.cancelled_at
        ? '交換は取り消されています。' : '店舗でのお渡しをお待ちください。',
    };
  }

  let source: 'ec' | 'musubo' | null = null;
  try { if (plan.redemption.lineAccountId) source = await resolveMileageSource(db, plan.redemption.lineAccountId); } catch { /* 読めない場合も保留 */ }
  if (source !== 'musubo') return {
    status: 'delivery_failed', rewardName: plan.rewardName, customerMessage: plan.customerMessage,
    rewardCode: null, retryAt: plan.redemption.nextRetryAt, failurePolicy: plan.failurePolicy,
    message: source === 'ec' ? 'マイルはECで管理しています。交換は保留しています。' : 'マイルの管理元を確認できないため保留しています。',
  };
  // 機能オフ中はclaim・attempt・付与・状態戻しのいずれもしない。
  // 状態は不変のまま残し、再ON後の再試行で再開する。
  if (plan.redemption.lineAccountId && !await featureJobCanRun(db, {
    accountId: plan.redemption.lineAccountId,
    featureId: 'mileage',
    job: 'mileage reward delivery',
  })) {
    return {
      status: 'delivery_failed',
      rewardName: plan.rewardName,
      customerMessage: plan.customerMessage,
      rewardCode: null,
      retryAt: plan.redemption.nextRetryAt,
      failurePolicy: plan.failurePolicy,
      message: 'マイル機能がオフのため保留しています。再開後に処理します。',
    };
  }
  if (plan.redemption.status === 'succeeded') {
    const code = await getReservedMileageRewardCode(db, redemptionId);
    return {
      status: 'succeeded',
      rewardName: plan.rewardName,
      customerMessage: plan.customerMessage,
      rewardCode: code
        ? await decryptCredential(code.ciphertext, options.credentialEncryptionKey)
        : null,
      retryAt: null,
      failurePolicy: plan.failurePolicy,
      message: null,
    };
  }
  if (plan.redemption.status === 'refunded') {
    /*
     * 返却確定後に台帳・ロットの書き込みが中断した行は、
     * ここで欠けた分を足してから案内する。残高・台帳・状態が
     * 一致するまで復旧する。直せなくても案内は変えない
     * （cron・再試行の回復に任せる）。
     */
    try {
      await refundMileageRewardRedemption(db, {
        redemptionId,
        reason: '中断した返却の再開',
      });
    } catch {
      /* 回復は再試行・cronに任せる */
    }
    return {
      status: 'delivery_failed', rewardName: plan.rewardName,
      customerMessage: plan.customerMessage, rewardCode: null, retryAt: null,
      failurePolicy: plan.failurePolicy, message: '交換したマイルは戻されています。',
    };
  }

  const now = options.now?.() ?? new Date().toISOString();
  const leaseCutoff = new Date(new Date(now).getTime() - STALE_DELIVERY_LEASE_MS).toISOString();
  // この走者の名札。手順の貸出はこの名札で取り、確定も名札と fence で通す。
  const stepOwner = crypto.randomUUID();
  const stepLeaseExpiresAt = new Date(new Date(now).getTime() + STALE_DELIVERY_LEASE_MS).toISOString();
  // 押す前の状態。送らずに譲るときはここへ戻す(一覧から消さないため)。
  const statusBeforeClaim = plan.redemption.status;
  const claim = await db.prepare(
    `UPDATE mileage_redemptions SET status = 'delivering', updated_at = ?
      WHERE id = ? AND (status IN ('reserved', 'delivery_failed')
        OR (status = 'delivering' AND updated_at < ?))`,
  ).bind(now, redemptionId, leaseCutoff).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return {
      status: 'delivery_failed', rewardName: plan.rewardName,
      customerMessage: plan.customerMessage, rewardCode: null,
      retryAt: plan.redemption.nextRetryAt,
      failurePolicy: plan.failurePolicy,
      message: '交換処理を確認しています。少し待ってから読み直してください。',
    };
  }
  try {
    let rewardCode: string | null = null;
    if (plan.rewardKind === 'coupon') {
      const code = await getReservedMileageRewardCode(db, redemptionId);
      if (!code) throw new Error('交換コードを確保できませんでした');
      rewardCode = await decryptCredential(code.ciphertext, options.credentialEncryptionKey);
    } else {
      const actions = parseActions(plan.actionConfig);
      if (!actions.length) throw new Error('交換後の動きがありません');
      const executors = createAutomationActionExecutors({
        webhookDeliveryMode: 'immediate',
        credentialEncryptionKey: options.credentialEncryptionKey,
        fetch: options.fetch,
        now: options.now,
      });
      // 最初の送信から24時間を過ぎた手順は同じキーで送らない。
      const retryKeyExpiresAt = new Date(
        new Date(now).getTime() - MILEAGE_REWARD_RETRY_KEY_VALIDITY_MS,
      ).toISOString();
      for (const [index, action] of actions.entries()) {
        const executor = executors[action.type];
        if (!executor) throw new Error('交換後の動きを実行できません');
        const stepExecutionId = await stableUuid(`${redemptionId}:${action.id}:${index}`);
        const stepKey = `${index}:${action.id}`;
        const stepFence = crypto.randomUUID();
        const stepLease = {
          redemptionId, stepKey, idempotencyKey: stepExecutionId,
          owner: stepOwner, fenceToken: stepFence,
          leaseExpiresAt: stepLeaseExpiresAt, now, retryKeyExpiresAt,
        };
        const stepConfirmation = {
          redemptionId, stepKey, owner: stepOwner, fenceToken: stepFence, now,
        };
        const runStep = async (recovery: boolean): Promise<void> => {
          try {
            await executor({
              db,
              runId: redemptionId,
              lineAccountId: plan.redemption.lineAccountId,
              automationId: `mileage-reward:${plan.redemption.rewardId}`,
              automationVersionId: plan.redemption.rewardVersionId,
              friendId: plan.redemption.beneficiaryFriendId,
              sourceEventId: redemptionId,
              inputEvent: { kind: 'mileage_reward_redeemed', rewardId: plan.redemption.rewardId },
              action,
              stepExecutionId,
              idempotencyKey: stepExecutionId,
              attemptNumber: plan.redemption.attemptCount + 1,
              commonActionVersionId: plan.commonActionVersionId,
              isTest: false,
            });
          } catch (error) {
            if (error instanceof AutomationActionError && error.code === 'delivery_unconfirmed') {
              // 外部送信は終わっている。証言は送る前に残してあるので、
              // そのまま照合待ちに残し、送り直さない。
              throw new MileageRedemptionConfirmError();
            }
            if (recovery) {
              /*
               * 回復のやり直しで失敗したら、送ったか分からないので
               * 照合待ちのまま残す。証言は消さない（消すことは
               * 「送っていないことの確定」であり、回復時は言えない）。
               * 失敗にも落とさない（返却の素にしない）。
               */
              throw new MileageRedemptionConfirmError();
            }
            /*
             * 送る前の失敗：証言を消して、やり直し可能に戻す。
             * 消せなければ送ったか分からないので、照合待ちに残す。
             */
            try {
              await clearStepIntentWithRetry(db, stepConfirmation);
            } catch {
              throw new MileageRedemptionConfirmError();
            }
            throw error;
          }
          // 証言つき確定を数回試す。通らなければ照合待ちに残す。
          await confirmStepSentWithRetry(db, stepConfirmation);
        };
        /*
         * 送り直さない：送信済みの手順は飛ばす。貸出中の手順は待つ。
         * 期限切れの手順は送らず照合待ちへ回す。
         * 証言つき(照合待ち)の手順は、送り直しても安全な種類だけ
         * 期限内に回復を試みる。それ以外は送らず勝手に確定もせず待つ。
         * 受け手側にも同じ冪等キーを渡す。
         */
        const step = await claimRedemptionStep(db, stepLease);
        if (step === 'sent') continue;
        if (step === 'busy') {
          // 別の走者が貸出を握っている。こちらは送っていない。
          // 送ったとは言わず、交換も押す前の状態へ戻す。
          throw new RedemptionStepBusyError();
        }
        if (step === 'expired') {
          throw new RedemptionRetryKeyExpiredError();
        }
        if (step === 'reconcile') {
          if (!isRecoverableStepType(action.type)) {
            // 送ったか確かめられない行。送らず、勝手に確定もせず待つ。
            throw new MileageRedemptionConfirmError();
          }
          const recovery = await claimRedemptionStepForRecovery(db, stepLease);
          if (recovery === 'sent') continue;
          if (recovery === 'busy') throw new RedemptionStepBusyError();
          if (recovery === 'expired') throw new RedemptionRetryKeyExpiredError();
          if (recovery !== 'send') {
            throw new MileageRedemptionConfirmError();
          }
          await runStep(true);
          continue;
        }
        await runStep(false);
      }
    }
    try {
      await recordMileageRedemptionAttempt(db, { redemptionId, status: 'succeeded' });
    } catch {
      throw new MileageRedemptionConfirmError();
    }
    return {
      status: 'succeeded', rewardName: plan.rewardName,
      customerMessage: plan.customerMessage, rewardCode, retryAt: null,
      failurePolicy: plan.failurePolicy, message: null,
    };
  } catch (error) {
    if (error instanceof RedemptionStepBusyError) {
      /*
       * 送っていない。失敗中の交換を `delivering` に残すと一覧から
       * 消えて追跡が切れ、次に押しても409で閉じ込められる。
       * 押す前の状態へ戻し、そのまま失敗中として見えるようにする。
       */
      await db.prepare(
        `UPDATE mileage_redemptions SET status = ?, updated_at = ?
          WHERE id = ? AND status = 'delivering'`,
      ).bind(statusBeforeClaim, now, redemptionId).run();
      return {
        status: 'delivery_failed', rewardName: plan.rewardName,
        customerMessage: plan.customerMessage, rewardCode: null,
        retryAt: plan.redemption.nextRetryAt,
        failurePolicy: plan.failurePolicy,
        message: 'ほかの処理が同じ交換を進めています。少し待ってからもう一度お試しください。',
      };
    }
    if (isRetryKeyExpiredError(error)) {
      // 期限切れは自動で送らない。理由だけ残し、人が確かめる。
      await db.prepare(
        `UPDATE mileage_redemptions
            SET failure_code = 'retry_key_expired',
                failure_message = 'LINEの重複防止期限（24時間）を過ぎたため自動送信を止めました。内容を確かめてください。',
                updated_at = ?
          WHERE id = ? AND status = 'delivering'`,
      ).bind(now, redemptionId).run();
      return {
        status: 'delivery_failed', rewardName: plan.rewardName,
        customerMessage: plan.customerMessage, rewardCode: null,
        retryAt: null,
        failurePolicy: plan.failurePolicy,
        message: 'LINEの重複防止期限（24時間）を過ぎたため自動送信を止めました。内容を確かめてください。',
      };
    }
    if (error instanceof MileageRedemptionConfirmError) {
      /*
       * 外部送信は終わっているかもしれない。失敗に落とすとやり直しで
       * 再送するので、`delivering` のまま残して回収(cron・貸出期限)に任せる。
       * 呼び出し側には202相当の「確認中」で返す。
       */
      return {
        status: 'delivery_failed', rewardName: plan.rewardName,
        customerMessage: plan.customerMessage, rewardCode: null,
        retryAt: nextRetry(now, plan.redemption.attemptCount),
        failurePolicy: plan.failurePolicy,
        message: '特典の送信は終わっています。確定を確認しています。',
      };
    }
    const failure = publicFailure(error);
    const retryAt = failure.retryable && plan.failurePolicy === 'retry'
      ? nextRetry(now, plan.redemption.attemptCount)
      : null;
    await recordMileageRedemptionAttempt(db, {
      redemptionId,
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
      retryAt,
    });
    if (plan.failurePolicy === 'refund') {
      /*
       * 一部の手順を渡し終えていたら、全額は返さない。
       * 渡し終えた分は返さず、未完了の手順だけやり直せるよう
       * 失敗のまま残す。返却の判断は提供済み内容と一緒に人が行う。
       */
      const partial = plan.rewardKind !== 'coupon'
        && await hasSentRedemptionSteps(db, redemptionId);
      if (partial) {
        const partialRetryAt = nextRetry(now, plan.redemption.attemptCount);
        await recordMileageRedemptionAttempt(db, {
          redemptionId,
          status: 'failed',
          errorCode: failure.code,
          errorMessage: '一部の特典は渡し済みのため、マイルは戻していません。',
          retryAt: partialRetryAt,
        });
        return {
          status: 'delivery_failed', rewardName: plan.rewardName,
          customerMessage: plan.customerMessage, rewardCode: null, retryAt: partialRetryAt,
          failurePolicy: plan.failurePolicy,
          message: '一部の特典は渡し済みのため、マイルは戻していません。残りの手順をやり直せます。',
        };
      }
      try {
        await refundMileageRewardRedemption(db, {
          redemptionId,
          reason: '特典を渡せなかったためマイルを自動で戻す',
        });
      } catch (refundError) {
        // 返却より先に再試行が成功していたら、成功を返す。
        // 遅れた返却で成功済みの交換を書き換えない。
        if (refundError instanceof MileageRewardError && refundError.code === 'already_delivered') {
          return {
            status: 'succeeded', rewardName: plan.rewardName,
            customerMessage: plan.customerMessage, rewardCode: null, retryAt: null,
            failurePolicy: plan.failurePolicy, message: null,
          };
        }
        throw refundError;
      }
    }
    return {
      status: 'delivery_failed', rewardName: plan.rewardName,
      customerMessage: plan.customerMessage, rewardCode: null, retryAt,
      failurePolicy: plan.failurePolicy,
      message: plan.failurePolicy === 'refund'
        ? '特典を渡せなかったため、交換したマイルを戻しました。'
        : failure.message,
    };
  }
}

/**
 * Cronから、再試行時刻を過ぎた交換と、確定されず残った交換を処理する。
 * 後者は貸出期限切れの `delivering` で、引き継いだ試行が outbox を見る。
 * 証言つきの手順は送り直さず、照合待ちに残す。claimはdeliver側で行う。
 */
export async function processDueMileageRewardDeliveries(
  db: D1Database,
  options: Omit<MileageRewardDeliveryOptions, 'now'> & { now: string; limit?: number },
): Promise<{ processed: number; succeeded: number; failed: number; recovered: number }> {
  const requested = Math.min(100, Math.max(1, options.limit ?? 50));
  const limit = Math.min(30, requested);
  const leaseCutoff = new Date(
    new Date(options.now).getTime() - STALE_DELIVERY_LEASE_MS,
  ).toISOString();
  const dueWhere = `status = 'delivery_failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`;
  const owners = await db.prepare(`SELECT DISTINCT line_account_id FROM mileage_redemptions
    WHERE status IN ('delivery_failed','delivering','refunded') AND line_account_id IS NOT NULL ORDER BY line_account_id`).bind()
    .all<{ line_account_id: string }>();
  const accountBatch = selectMileageAccountBatch(owners.results.map(row => row.line_account_id), options.now);
  if (accountBatch.length < owners.results.length) logger.warn('mileage_delivery.accounts_deferred');
  const eligible: string[] = [];
  let unreadable = 0;
  for (const accountId of accountBatch) {
    try { if (await resolveMileageSource(db, accountId) === 'musubo') eligible.push(accountId); }
    catch { unreadable++; logger.error('mileage_delivery.source_unavailable'); }
  }
  if (accountBatch.length && unreadable === accountBatch.length) throw new Error('mileage_delivery_all_sources_unavailable');
  const eligibleJson = JSON.stringify(eligible);
  // ECの交換はテナント停止中でも行を更新しない。
  await db.prepare(`UPDATE mileage_redemptions SET next_retry_at = NULL, failure_code = 'tenant_suspended',
      failure_message = '契約先の利用停止中に再試行時刻を過ぎたため自動送信しませんでした', updated_at = ?
      WHERE ${dueWhere} AND line_account_id IN (SELECT value FROM json_each(?))
        AND ${stoppedTenantLineAccountSql('mileage_redemptions.line_account_id')}`)
    .bind(options.now, options.now, eligibleJson).run();
  const mileageOff = accountFeatureOffExclusionSql('mileage_redemptions.line_account_id', 'mileage');
  const findEligible = async (where: string, order: string, date: string, cap: number) => {
    return db.prepare(`SELECT id FROM mileage_redemptions
        WHERE ${where} AND NOT ${mileageOff} AND line_account_id IS NOT NULL
          AND line_account_id IN (SELECT value FROM json_each(?))
          AND ${activeTenantLineAccountSql('mileage_redemptions.line_account_id')}
        ORDER BY ${order}, id LIMIT ?`).bind(date, eligibleJson, cap).all<{ id: string }>();
  };
  const due = await findEligible(dueWhere, 'next_retry_at, created_at', options.now, limit);
  // 止めた事実は監査に残す。行は読むだけで状態は変えない。
  const offOwners = await db.prepare(
    `SELECT DISTINCT line_account_id FROM mileage_redemptions
      WHERE ${dueWhere} AND line_account_id IS NOT NULL AND ${mileageOff}
      ORDER BY line_account_id LIMIT ?`,
  ).bind(options.now, limit).all<{ line_account_id: string }>();
  // 貸出期限切れの delivering も、機能オフのアカウントは SQL で先に外す。
  const remaining = Math.max(0, limit - due.results.length);
  const stalled = remaining > 0
    ? await findEligible("status = 'delivering' AND updated_at < ?", 'updated_at, created_at', leaseCutoff, remaining)
    : { results: [] as { id: string }[] };
  if (requested > limit && due.results.length + stalled.results.length === limit) logger.warn('mileage_delivery.events_deferred');
  let succeeded = 0;
  let failed = 0;
  for (const owner of offOwners.results) {
    await featureJobCanRun(db, {
      accountId: owner.line_account_id, featureId: 'mileage', job: 'mileage reward delivery retry',
    });
  }
  for (const item of [...due.results, ...stalled.results]) {
    // 機能オフ中は再試行せずdelivery_failedのまま残す。再オンで再開する。
    const ownerRow = await db
      .prepare(`SELECT line_account_id FROM mileage_redemptions WHERE id = ?`)
      .bind(item.id)
      .first<{ line_account_id: string | null }>();
    if (ownerRow?.line_account_id && !await featureJobCanRun(db, { accountId: ownerRow.line_account_id, featureId: 'mileage', job: 'mileage reward delivery retry' })) {
      failed += 1;
      continue;
    }
    const result = await deliverMileageReward(db, item.id, {
      credentialEncryptionKey: options.credentialEncryptionKey,
      fetch: options.fetch,
      now: () => options.now,
    });
    if (result.status === 'succeeded') succeeded += 1;
    else failed += 1;
  }
  /*
   * 返却確定後に書き込みが中断した交換（台帳なしの refunded）。
   * 期限待ちの一覧にも要対応にも出ない取り残しなので、cron が
   * 見つけて残高・台帳・状態が一致するまで再開する。
   * 機能オフ中は触らず残す。再オンで再開する。
   */
  const recoveryLimit = Math.max(0, limit - due.results.length - stalled.results.length);
  let recovered = 0;
  if (recoveryLimit > 0) {
    const incomplete = await findIncompleteMileageRefunds(db, { limit: recoveryLimit, lineAccountIds: eligible });
    for (const target of incomplete) {
      try { if (!target.lineAccountId || await resolveMileageSource(db, target.lineAccountId) !== 'musubo') continue; }
      catch { logger.error('mileage_delivery.source_unavailable'); continue; }
      if (target.lineAccountId && !await featureJobCanRun(db, { accountId: target.lineAccountId, featureId: 'mileage', job: 'mileage reward delivery retry' })) continue;
      try {
        await refundMileageRewardRedemption(db, { redemptionId: target.id, reason: '中断した返却の再開' });
        recovered += 1;
      } catch (error) {
        if (error instanceof MileageRewardError && error.code === 'already_delivered') { recovered += 1; continue; }
        failed += 1;
      }
    }
    return {
      processed: due.results.length + stalled.results.length + incomplete.length,
      succeeded, failed, recovered,
    };
  }
  return { processed: due.results.length + stalled.results.length, succeeded, failed, recovered };
}
