import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { decorateTapExtras } from './tap-extra-links.js';
import {
  getScenarioById,
  getScenarioPublishedVersion,
  getStepsForDelivery,
  scenarioStepExists,
  getFriendById,
  computeNextDeliveryAt,
  advanceFriendScenario,
  completeFriendScenario,
  claimFriendScenarioForDelivery,
  enrollFriendInScenario,
  getLineAccountByChannelId,
  getLineAccountById,
  addTagToFriend,
  jstNow,
  toJstString,
} from '@line-crm/db';
import type { PinnedScenarioStep, ScenarioDeliverySource } from '@line-crm/db';
import { LineClient, type Message } from '@line-crm/line-sdk';

import { buildMessage } from './line-message.js';
import { expandVariables } from './message-interpolation.js';
import { resolveMetadata } from './step-metadata.js';
import { messageToLogPayload } from './message-log-payload.js';
import { decorateForFriendPush } from './auto-track.js';
import { resolveSendInterpolationExtra } from './interpolation-context.js';
import { buildQuestionMessages, parseQuestion } from '../features/scenarios/scenario-question/index.js';

export interface ImmediatePushContext {
  defaultAccessToken: string;
  /** 変数の URL 展開には利用可能なら WORKER_URL を渡す。未指定では expandVariables と同じく未展開を保つ。 */
  workerUrl?: string;
  accountChannelId?: string | null;
}

export interface EnrollmentRef {
  id: string;
  current_step_order: number;
  /** 開始時に固定した公開版。無いときは購読行から読み直す。 */
  published_version_id?: string | null;
}

export interface ImmediatePushOptions {
  /** once は既存の初回未送信購読を cron と共通の実行権で送る。every-click は再訪も送るが、初回の未送信分は実行権で競合を防ぎ、取得できなければ送らない。進行済みの再訪は購読の通番を変えない。 */
  mode?: 'once' | 'every-click';
  /** once で作成済みの購読を渡し、余分な再取得を省く。 */
  enrollment?: EnrollmentRef | null;
  /** follow 前でも送れるよう、LIFF/OAuth の検証済み ID トークンから分かる宛先で代替できる。 */
  targetLineUserId?: string;
  /** follow の無料 replyToken で送る。失敗時は実行権を返して cron の予定へ委ね、履歴の delivery_type は reply として記録する。 */
  reply?: { client: Pick<LineClient, 'replyMessage'>; replyToken: string };
  /** 新しい follow には60秒以内でも返信するため、履歴の間隔確認を省けるようにする。新規登録と実行権で同じフローの競合は防ぐ。 */
  skipCooldown?: boolean;
  /**
   * 送信の結末を呼ぶ側へ伝える。戻り値の false は「送っていない」と
   * 「送ったかどうか分からない」を区別できないため、台帳へ結末を残す
   * 呼び出し（友だち追加時配信）だけがこれを渡す。
   *
   *   delivered … LINE が受け付けた
   *   failed    … LINE が要求を断った（4xx）。届いていない
   *   unknown   … 通信断・タイムアウト・429・5xx。届いたかもしれない
   *
   * 送信そのものを試みなかったとき（配信対象外・再送見送りなど）は呼ばない。
   */
  onSendOutcome?: (outcome: 'delivered' | 'failed' | 'unknown') => void;
  /**
   * 結末の分からない送信（通信断・タイムアウト・429・5xx）のあと、
   * この登録をどう扱うか。
   *
   *   retry（既定） … claim を返し、cron が改めて1通目を送る。従来どおり。
   *   stop          … 1通目を送り終えた扱いにして先へ進め、cron に
   *                   送り直させない。届いていたときに2通目を出さない。
   *
   * 台帳へ「送達不明」を残して人が確かめる呼び出し（友だち追加時配信）は
   * stop を渡す。自動で送り直すと、同じ人に同じ案内が2通届く。
   */
  unknownSendPolicy?: 'retry' | 'stop';
  /**
   * LINE へ渡す再試行キー（`X-Line-Retry-Key`）。同じキーの2回目は LINE 側が
   * 受け付け済みとして 409 を返し、**二重に届かない**。予約と fence をすり抜けた
   * 万一の同時送信に対する最後の砦として、友だち追加の経路だけが渡す。
   * reply は token が1回きりなので不要。
   */
  retryKey?: string;
}

/**
 * 送信の例外を「届いていない」と「届いたかもしれない」に分ける。
 *
 * LINE が 4xx で断ったときは要求が受け付けられていないので届いていない。
 * 通信断・タイムアウト・429・5xx は、こちらが結果を知らないだけで
 * 届いていることがある。自動で送り直すと二重に届く。
 */
function classifySendFailure(error: unknown): 'failed' | 'unknown' {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) return 'failed';
  return 'unknown';
}

/** 即時初回文は全入口で同じ処理を使い、ネットワーク前に cron と共通の実行権を取る。成功後は購読を進めて二重送信を防ぐ。停止中と即時でない通は送らない。60秒の履歴確認で別経路の競合も抑え、once の間隔内は送らず通番だけ進める。送信前の失敗は実行権を返し、送信後の記録失敗でも可能な限り通番を進める。実際に送った場合だけ true を返す。 */
export async function pushImmediateFirstStep(
  db: D1Database,
  friendId: string,
  scenarioId: string,
  ctx: ImmediatePushContext,
  options?: ImmediatePushOptions,
): Promise<boolean> {
  const mode = options?.mode ?? 'once';
  // 外側の例外処理でも途中の配送を確定できるよう、関数スコープで保持する。
  let claimedEnrollmentId: string | null = null;
  let sent = false;
  let settleAfterSend: (() => Promise<void>) | null = null;
  try {
    const scenarioRow = await getScenarioById(db, scenarioId);
    if (!scenarioRow) return false;
    // 停止中のシナリオを経路の即時配信から動かさないよう、cron や友だち・タグ起点と同じ有効状態を確認する。
    if (!scenarioRow.is_active) return false;

    // 緊急停止 : scenario_dispatch が止まっているアカウントの
    // シナリオは1通目の即時送信もしない。登録行・claim には触れず、
    // cron 側 (processStepDeliveries も同じ停止を見る) が復旧後に届ける。
    const { isOperationCapabilityStopped } = await import('@line-crm/db');
    if (await isOperationCapabilityStopped(db, scenarioRow.line_account_id ?? null, 'scenario_dispatch')) {
      return false;
    }

    // 送る1通目は、購読開始時に固定した公開版だけから読む（351）。live の
    // 下書き表は読まない。版が無い・欠損しているときは送らない。
    const loadPinnedFirstStep = async (
      pinnedVersionId: string | null | undefined,
    ): Promise<{ source: ScenarioDeliverySource; firstStep: PinnedScenarioStep } | null> => {
      const source = await getStepsForDelivery(db, scenarioId, pinnedVersionId ?? null);
      if (!source) return null;
      const liveSteps = source.steps.filter((s) => (s.is_draft ?? 0) === 0);
      const firstStep = liveSteps[0];
      if (!firstStep) return null;
      return { source, firstStep };
    };

    const resolveEnrollmentVersionId = async (
      enrollment: EnrollmentRef,
    ): Promise<string | null> => {
      if (enrollment.published_version_id) return enrollment.published_version_id;
      const row = await db
        .prepare(`SELECT published_version_id FROM friend_scenarios WHERE id = ?`)
        .bind(enrollment.id)
        .first<{ published_version_id: string | null }>();
      return row?.published_version_id ?? null;
    };

    // 異なる購読や LIFF の重複表示の競合も防ぐため、同じ固定版の通 ID で送信履歴の間隔を確認する。版を持たない保存済み履歴は live の通 ID でも照合する。
    const isRecentDuplicate = async (firstStep: PinnedScenarioStep): Promise<boolean> => {
      const cutoff = toJstString(new Date(Date.now() - 60_000));
      const recent = await db
        .prepare(
          `SELECT 1 FROM messages_log
           WHERE friend_id = ? AND (scenario_version_step_id = ? OR scenario_step_id = ?)
             AND direction = 'outgoing' AND created_at > ?
           LIMIT 1`,
        )
        .bind(friendId, firstStep.id, firstStep.live_step_id ?? firstStep.id, cutoff)
        .first();
      return recent !== null;
    };

    const lookupEnrollment = () =>
      db
        .prepare(
          `SELECT id, current_step_order, published_version_id FROM friend_scenarios
           WHERE friend_id = ? AND scenario_id = ? AND status != 'completed'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .bind(friendId, scenarioId)
        .first<EnrollmentRef>();

    const advancePastFirstStep = async (
      enrollmentId: string,
      source: ScenarioDeliverySource,
      firstStep: PinnedScenarioStep,
    ) => {
      const nextStep = source.steps.filter((s) => (s.is_draft ?? 0) === 0)[1];
      if (nextStep) {
        const next = computeNextDeliveryAt(
          { delivery_mode: source.deliveryMode },
          nextStep,
          { enrolledAt: enrolledAtJst, previousDeliveredAt: enrolledAtJst, now: enrolledAtJst },
        );
        // next は既に日本時間へずらした計算値なので、toJstString で9時間を重ねず、ラベルだけを変更して保存する。
        await advanceFriendScenario(
          db,
          enrollmentId,
          firstStep.step_order,
          next.toISOString().slice(0, -1) + '+09:00',
        );
      } else {
        await completeFriendScenario(db, enrollmentId);
      }
    };

    const attachReachTag = async (firstStep: PinnedScenarioStep) => {
      if (!firstStep.on_reach_tag_id) return;
      try {
        await addTagToFriend(db, friendId, firstStep.on_reach_tag_id);
      } catch (err) {
        logger.error("immediate_first_step.attach_reach_tag_failed");
      }
    };

    // 時刻指定や経過時間の通は cron に任せ、登録・実行権取得より前に即時の相対遅延0だけを選ぶ。
    const enrolledAtJst = japanCalendar();
    const isImmediate = (source: ScenarioDeliverySource, firstStep: PinnedScenarioStep) => {
      const firstScheduledAt = computeNextDeliveryAt(
        { delivery_mode: source.deliveryMode },
        firstStep,
        { enrolledAt: enrolledAtJst, previousDeliveredAt: enrolledAtJst, now: enrolledAtJst },
      );
      return firstScheduledAt.getTime() <= enrolledAtJst.getTime();
    };

    // 進行済みの純粋な再訪では、送信後に通番を変更しない。
    let advanceTargetId: string | null = null;
    let pinned: { source: ScenarioDeliverySource; firstStep: PinnedScenarioStep } | null = null;

    if (mode === 'once') {
      const enrollmentRow = options?.enrollment ?? (await lookupEnrollment());
      if (!enrollmentRow) return false;
      pinned = await loadPinnedFirstStep(await resolveEnrollmentVersionId(enrollmentRow));
      if (!pinned) return false;
      if (enrollmentRow.current_step_order >= pinned.firstStep.step_order) return false;
      if (!isImmediate(pinned.source, pinned.firstStep)) return false;

      // 登録後から送信後の通番更新までを cron と同じ実行権で守り、先に取得した側だけが初回文を送る。
      const claimed = await claimFriendScenarioForDelivery(
        db,
        enrollmentRow.id,
        enrollmentRow.current_step_order,
      );
      if (!claimed) return false;
      claimedEnrollmentId = enrollmentRow.id;
      advanceTargetId = enrollmentRow.id;

      // 別経路が送った間隔内でも初回待ちを残さないよう、once は送らず通番を進め、到達タグも適用する。
      if (!options?.skipCooldown && (await isRecentDuplicate(pinned.firstStep))) {
        await advancePastFirstStep(enrollmentRow.id, pinned.source, pinned.firstStep);
        claimedEnrollmentId = null; // 通番の更新で実行権も解放済み。
        await attachReachTag(pinned.firstStep);
        return false;
      }
    } else {
      // LIFF の再読込だけで新規購読を残さないよう、every-click は登録より先に間隔を確認する。完了済みは部分 UNIQUE に掛からないため、この順序を守る。
      const currentVersion = await getScenarioPublishedVersion(db, scenarioId);
      const pre = currentVersion ? await loadPinnedFirstStep(currentVersion.id) : null;
      if (!pre || !isImmediate(pre.source, pre.firstStep)) return false;
      if (await isRecentDuplicate(pre.firstStep)) return false;

      // 再訪で INSERT OR IGNORE が行を作らなくても、クリック配信は続ける。
      const enrollment = await enrollFriendInScenario(db, friendId, scenarioId);
      const row = enrollment ?? (await lookupEnrollment());
      // 確認と登録の間に公開版が変わる場合があるため、登録後は購読自身の固定版を正本として読む。
      pinned = row ? await loadPinnedFirstStep(await resolveEnrollmentVersionId(row)) : null;
      if (!pinned) return false;
      if (row && row.current_step_order < pinned.firstStep.step_order) {
        // 初回をまだ配信する購読は、cron と follow の二重送信を防ぐため共通の実行権を取る。取得できなければ送らない。
        const claimed = await claimFriendScenarioForDelivery(db, row.id, row.current_step_order);
        if (!claimed) return false;
        claimedEnrollmentId = row.id;
        advanceTargetId = row.id;
      } else {
        // 最初の確認から登録の往復中に別の送信が起こり得るため、純粋な再訪でも間隔を再確認する。
        if (await isRecentDuplicate(pinned.firstStep)) return false;
      }
    }
    const { source, firstStep } = pinned;

    const releaseClaim = async () => {
      if (!claimedEnrollmentId) return;
      await releaseClaimById(db, claimedEnrollmentId);
      claimedEnrollmentId = null;
    };

    // 結び付け・ref・所属の更新後の値を差し込むため、送信前に友だちを読み直す。
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      await releaseClaim();
      return false;
    }

    // replyToken の有効時間を使い過ぎないよう、独立した D1 読取は並行に解決する。送信元とリンク所有者は解決済みアカウントを使い、文面・質問は固定版の写しを使って公開後の編集を混ぜない。
    const resolved = {
      messageType: firstStep.message_type,
      messageContent: firstStep.message_content,
      templateIdAtSend: firstStep.template_id_at_send ?? null,
      questionJson: firstStep.question_json ?? null,
    };
    const [resolvedMeta, ctxAccount] = await Promise.all([
      resolveMetadata(db, friend),
      ctx.accountChannelId ? getLineAccountByChannelId(db, ctx.accountChannelId) : null,
    ]);
    const friendWithMeta = { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1];
    // 質問の前文・選択肢文にも差し込みが効くので、スキャンは本文と
    // 質問JSONを合わせた全体で行う。
    const extra = await resolveSendInterpolationExtra(
      db, friend.id,
      `${resolved.messageContent}\n${resolved.questionJson ?? ''}`,
      { kind: 'first_step', id: firstStep.id },
    );
    const expanded = expandVariables(
      resolved.messageContent,
      friendWithMeta,
      ctx.workerUrl,
      resolved.messageType,
      extra,
    );
    // cron と同じ文面加工を使う。所属未保存の LIFF/OAuth でも別の同意画面へ送らないよう、リンクは友だちの所属または解決済みチャネルを使う。live の通 ID が消えていれば版所有の通 ID へ戻す。
    const liveStepId = (await scenarioStepExists(db, firstStep.live_step_id ?? null))
      ? firstStep.live_step_id!
      : null;
    const question = parseQuestion(resolved.questionJson);
    let messages: Message[];
    if (question) {
      messages = buildQuestionMessages(
        {
          ...question,
          intro: question.intro
            ? expandVariables(question.intro, friendWithMeta, ctx.workerUrl, 'text', extra)
            : question.intro,
          text: expandVariables(question.text, friendWithMeta, ctx.workerUrl, 'text', extra),
        },
        // 押し口は必ず版所有の通ID。live の通IDを載せると、公開後に直した
        // 返信・タグ・遷移が旧版の購読へ混入し、下書きの通を消した瞬間に
        // ボタンが無反応になる。
        { kind: 'version', stepId: firstStep.id },
      );
    } else {
      const decorated = await decorateForFriendPush(
        db,
        resolved.messageType,
        expanded,
        ctx.workerUrl,
        { lineAccountId: friend.line_account_id ?? ctxAccount?.id ?? null, friendId, sourceContent: resolved.messageContent },
      );
      messages = [buildMessage(decorated.messageType, decorated.content)];
    }

    if (question && JSON.stringify(messages).includes('\"tapExtras\"')) {
      const decorated = await decorateTapExtras(db, messages, ctx.workerUrl || '', friend.line_account_id ?? ctxAccount?.id ?? null);
      const { appendFriendToTrackedLinks } = await import('./auto-track.js');
      const personalized = JSON.parse(await appendFriendToTrackedLinks(db, JSON.stringify(decorated), ctx.workerUrl || '', friendId));
      messages.splice(0, messages.length, ...(personalized as Message[]));
    }
    // メッセージ組み立ての間に停止へ切り替わった分も、外部送信の直前に拾う。
    // claim は戻し、cron が復旧後に1通目を届ける。
    if (await isOperationCapabilityStopped(db, scenarioRow.line_account_id ?? null, 'scenario_dispatch')) {
      await releaseClaim();
      return false;
    }
    try {
      if (options?.reply) {
        await options.reply.client.replyMessage(options.reply.replyToken, messages);
      } else {
        const pushTarget = options?.targetLineUserId ?? friend.line_user_id;
        if (!pushTarget) {
          // 送信できなければ実行権を返し、cron で再試行できるようにする。
          await releaseClaim();
          return false;
        }
        // Token: caller-supplied account channel → friend's own account → env default.
        let accessToken = ctx.defaultAccessToken;
        if (ctx.accountChannelId) {
          if (ctxAccount?.channel_access_token) accessToken = ctxAccount.channel_access_token;
        } else if (friend.line_account_id) {
          const acct = await getLineAccountById(db, friend.line_account_id);
          if (acct?.channel_access_token) accessToken = acct.channel_access_token;
        }
        const lineClient = new LineClient(accessToken);
        await lineClient.pushMessage(pushTarget, messages, options?.retryKey);
      }
    } catch (err) {
      // 4xx は LINE が断ったので届いていない。それ以外は結末が分からない。
      const outcome = classifySendFailure(err);
      options?.onSendOutcome?.(outcome);
      if (outcome === 'unknown' && options?.unknownSendPolicy === 'stop' && advanceTargetId) {
        /*
         * 届いたかもしれないので cron に送り直させない。1通目を送り終えた
         * 扱いにして先へ進める。到達タグは付けない（届いた確証がない）。
         * 呼ぶ側は台帳へ送達不明を残し、人が確かめる。
         */
        logger.error("immediate_first_step.confirm_delivery_failed");
        // 進める先は、この購読が固定している版の通で決める（351）。live の
        // 下書きを見ると、公開後に順序を変えたぶんだけ飛ばし先がずれる。
        await advancePastFirstStep(advanceTargetId, source, firstStep);
        claimedEnrollmentId = null; // advance が claim を返している
        return false;
      }
      // 届いていない（4xx）・従来どおりの呼び出しは claim を返して cron へ。
      logger.error("immediate_first_step.send_first_step_failed");
      await releaseClaim();
      return false;
    }
    sent = true;
    options?.onSendOutcome?.('delivered');
    settleAfterSend = async () => {
      if (advanceTargetId) {
        await advancePastFirstStep(advanceTargetId, source, firstStep);
        claimedEnrollmentId = null; // 通番の更新で実行権も解放済み。
        await attachReachTag(firstStep);
      }
    };

    // 履歴と画面を実送信へ一致させるため、buildMessage 後の内容と実際の送信方式を記録する。重複照合は scenario_version_step_id を使い、削除済みの live 通 ID は NULL にして外部キーを壊さない。
    for (const sentMessage of messages) {
      const logPayload = messageToLogPayload(sentMessage);
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, template_id_at_send, created_at, scenario_version_step_id)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?, 'scenario', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          friendId,
          logPayload.messageType,
          logPayload.content,
          liveStepId,
          options?.reply ? 'reply' : null,
          resolved.templateIdAtSend,
          jstNow(),
          firstStep.id,
        )
        .run();
    }

    await settleAfterSend();
    settleAfterSend = null;
    return true;
  } catch (err) {
    logger.error("immediate_first_step.push_first_step_failed");
    try {
      if (sent && settleAfterSend) {
        // 送信後の記録・通番更新の失敗でも、cron の再送を防ぐため可能な限り購読を進める。
        await settleAfterSend();
      } else if (claimedEnrollmentId) {
        // 未送信なら実行権をすぐ返し、delivering のまま回復待ちにしない。
        await releaseClaimById(db, claimedEnrollmentId);
      }
    } catch (settleErr) {
      logger.error("immediate_first_step.settle_first_step_failed");
    }
    return sent;
  }
}

async function releaseClaimById(db: D1Database, enrollmentId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE friend_scenarios SET confirmation_revision = confirmation_revision + 1, status = 'active', updated_at = ?
       WHERE id = ? AND status = 'delivering'`,
    )
    .bind(jstNow(), enrollmentId)
    .run();
}
